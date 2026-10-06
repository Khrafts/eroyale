// CRE settler: settles the hosted engine's finished lobbies and rounds by running the royale-settle workflow in the CRE
// CLI simulator with --broadcast (report written through Chainlink's MockKeystoneForwarder to the escrow's onReport).
// Runs on an operator's machine: the CLI needs `cre login` (or CRE_API_KEY), which the hosted engine does not have.
// The engine runs with SETTLE_MODE=cre: it waits CRE_WAIT_MS after `final` for this settlement, then falls back to
// settleFallback.
//
//   npm run cre-settler                       # repo root; polls ENGINE_URL every 10 s
//   npm run cre-settler -- --lobby 7          # settle one lobby and exit
//   npm run cre-settler -- --lobby 7 --dry    # no --broadcast: run the workflow, print the report, send nothing
//
// Env (process env, then ../.env for unset keys): ENGINE_URL (default the hosted engine), CHAIN (base-sepolia), RPC_URL,
// ESCROW_ADDRESS, PRIVATE_KEY_CRE (dedicated key that pays the forwarder tx; refused if it equals PRIVATE_KEY_DEPLOYER
// or PRIVATE_KEY_RELAYER), optional CRE_CLI, CRE_WASM, CRE_RUN_TIMEOUT_MS, LOGS_BLOCK_SPAN. Only reads chain state
// itself; the one transaction per lobby is sent by the simulator from PRIVATE_KEY_CRE. Logs redact URLs; keys are never
// printed.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { LOBBY_LIVE, LOBBY_SETTLED, escrowReader, failReason, redact } from "../src/chain.ts";
import { creConfig, prebuilt, runCreSettle } from "../src/cre.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} ${redact(m)}`);
const die = (e: unknown): never => { console.error(`cre-settler: ${failReason(e)}`); process.exit(1); };
process.on("uncaughtException", die);
process.on("unhandledRejection", die);

const { values: cli } = parseArgs({ options: { lobby: { type: "string" }, dry: { type: "boolean", default: false } } });
const envFile = resolve(import.meta.dirname, "../../.env");
if (existsSync(envFile)) for (const [k, v] of Object.entries(parseEnv(readFileSync(envFile, "utf8")))) if (process.env[k] === undefined) process.env[k] = v;
const ENGINE_URL = (process.env.ENGINE_URL ?? "https://eroyale-production.up.railway.app").replace(/\/+$/, "");
for (const k of ["RPC_URL", "ESCROW_ADDRESS"]) if (!process.env[k]) die(new Error(`${k} is not set`));
const ESCROW = process.env.ESCROW_ADDRESS!.trim().toLowerCase() as Address;
const cfg = creConfig(process.env, log);
const pub = createPublicClient({ transport: http(process.env.RPC_URL) });
const chain = escrowReader(pub, ESCROW, process.env, log);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ATTEMPTS = 2;
const CONFIRM_MS = 120_000;

/** One lobby: wait for block time past the on-chain end, run the simulator, confirm on chain. True once Settled. */
async function settleLobby(id: number): Promise<boolean> {
  const l = await chain.getLobby(id);
  // A dry run always runs the workflow (it checks the lobby itself), so it can exercise the plumbing on any lobby.
  if (cli.dry) log(`[lobby ${id}] on-chain status ${l.status}, endTime ${l.endTime}; dry run`);
  else if (l.status === LOBBY_SETTLED) { log(`[lobby ${id}] already settled on chain`); return true; }
  else if (l.status !== LOBBY_LIVE) { log(`[lobby ${id}] on-chain status ${l.status}, not Live; skipping`); return true; }
  for (let t = await chain.blockTime(); !cli.dry && t <= l.endTime; t = await chain.blockTime()) {
    log(`[lobby ${id}] block time ${t} not past on-chain end ${l.endTime}; waiting`);
    await sleep(Math.min(Number(l.endTime - t) + 2, 10) * 1000);
  }
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const run = await runCreSettle(cfg, id, ENGINE_URL, ESCROW, log, !cli.dry);
    if (cli.dry) {
      const report = run.userLogs.find((x) => x.startsWith("report 0x"));
      log(`[lobby ${id}] dry run: ${run.error ? `workflow error: ${run.error}` : "workflow finished"}${report ? `; ${report.slice(0, 80)}...` : ""}`);
      return true;
    }
    if (run.txHash) {
      const until = Date.now() + CONFIRM_MS;
      for (;;) {
        const rc = await chain.settlementReceipt(id, run.txHash).catch((e) => { log(`[lobby ${id}] receipt read failed: ${failReason(e)}`); return null; });
        if (rc && !rc.ok) { log(`[lobby ${id}] ${rc.reason}`); break; }
        if (rc?.ok && (await chain.getLobby(id)).status === LOBBY_SETTLED) {
          log(`[lobby ${id}] settled via the CRE simulator: tx ${run.txHash} (forwarder ${rc.to}), bookHash ${rc.bookHash}` +
            (run.result?.winners ? `, winners ${run.result.winners.join(",")}, amounts ${run.result.amounts?.join(",")}` : ""));
          return true;
        }
        if (Date.now() > until) { log(`[lobby ${id}] tx ${run.txHash} not confirmed as Settled within ${CONFIRM_MS / 1000}s`); break; }
        await sleep(3000);
      }
    } else log(`[lobby ${id}] attempt ${attempt}/${ATTEMPTS}: ${run.error ?? "no txHash in the simulator output"}`);
    const now = await chain.getLobby(id).catch(() => null);
    if (now?.status === LOBBY_SETTLED) { log(`[lobby ${id}] settled on chain (by another path)`); return true; }
    if (attempt < ATTEMPTS) await sleep(5000);
  }
  log(`[lobby ${id}] giving up after ${ATTEMPTS} attempts; the engine falls back to settleFallback`);
  return false;
}

if (cli.lobby) process.exit((await settleLobby(Number(cli.lobby))) ? 0 : 1);

await prebuilt(cfg, log); // compile once now, so the first settlement does not wait for it
log(`[settler] watching ${ENGINE_URL.startsWith("http://localhost") ? ENGINE_URL : "<engine>"} for finished lobbies; escrow ${ESCROW}`);
const handled = new Set<number>();
for (;;) {
  try {
    const res = await fetch(`${ENGINE_URL}/settlements/pending`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`GET /settlements/pending: HTTP ${res.status}`);
    const body = await res.json() as { escrow: string | null; settleMode: string; pending: { lobbyId: number; mode: string }[] };
    if (body.escrow && body.escrow !== ESCROW) throw new Error(`engine escrow ${body.escrow} != ESCROW_ADDRESS ${ESCROW}`);
    for (const p of body.pending) {
      if (handled.has(p.lobbyId)) continue;
      handled.add(p.lobbyId); // one pass per lobby; the engine's fallback covers a failure
      log(`[lobby ${p.lobbyId}] ${p.mode} reached final; settling (engine SETTLE_MODE=${body.settleMode})`);
      await settleLobby(p.lobbyId).catch((e) => log(`[lobby ${p.lobbyId}] ${failReason(e)}`));
    }
  } catch (e) { log(`[settler] ${failReason(e)}`); }
  await sleep(10_000);
}
