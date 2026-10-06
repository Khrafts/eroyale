// End to end: a 20-bot stage match with the chain on, settled through settleFallback, then checks every winner's
// MockUSDC balance change in the settlement block against the `final` event's provisionalPayoutUnits.
// Env (process env, then ../.env for unset keys): CHAIN, RPC_URL, PRIVATE_KEY_DEPLOYER, PRIVATE_KEY_RELAYER,
// TOKEN_ADDRESS, ESCROW_ADDRESS, CHAIN_SELECTOR, PRICE_SOURCE_URL. Optional E2E_PORT, E2E_TIMEOUT_S.
// Secrets are passed to the engine through the environment and never printed.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import WebSocket from "ws";

const ENGINE = resolve(import.meta.dirname, "..");
const envFile = resolve(ENGINE, "../.env");
if (existsSync(envFile)) for (const [k, v] of Object.entries(parseEnv(readFileSync(envFile, "utf8")))) if (process.env[k] === undefined) process.env[k] = v;
for (const k of ["CHAIN", "RPC_URL", "PRIVATE_KEY_DEPLOYER", "PRIVATE_KEY_RELAYER", "TOKEN_ADDRESS", "ESCROW_ADDRESS", "CHAIN_SELECTOR", "PRICE_SOURCE_URL"]) {
  if (!process.env[k]) { console.error(`e2e: ${k} is not set`); process.exit(2); }
}
if (process.env.CHAIN === "off") { console.error("e2e: CHAIN must not be off"); process.exit(2); }
const PORT = Number(process.env.E2E_PORT ?? 8799);
const TIMEOUT_S = Number(process.env.E2E_TIMEOUT_S ?? 600);
const say = (m: string) => console.log(`[e2e] ${m}`);

const pub = createPublicClient({ transport: http(process.env.RPC_URL) });
const token = process.env.TOKEN_ADDRESS as Address;
const escrow = process.env.ESCROW_ADDRESS as Address;
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const ESCROW = parseAbi(["function treasury() view returns (address)"]);

// A fresh data dir: a new anvil reuses lobby ids, and a book is never rewritten once on disk.
const data = mkdtempSync(join(tmpdir(), "royale-e2e-"));
const engine = spawn("npx", ["tsx", "src/server.ts", "--bots", "20", "--preset", "stage", "--port", String(PORT), "--open", "5", "--countdown", "10"], {
  cwd: ENGINE,
  env: { ...process.env, SETTLE_MODE: "simulated", ENGINE_DATA_DIR: data, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true, // own process group, so stop() takes down npx, tsx and the server together
});
engine.stdout.on("data", (b: Buffer) => process.stdout.write(b.toString().replace(/^(?=.)/gm, "  engine | ")));
engine.stderr.on("data", (b: Buffer) => process.stderr.write(b.toString().replace(/^(?=.)/gm, "  engine ! ")));
let exiting = false;
engine.on("exit", (code) => { if (!exiting) { console.error(`e2e: engine exited early (${code})`); process.exit(1); } });
const stop = (code: number): never => {
  exiting = true;
  try { process.kill(-engine.pid!, "SIGTERM"); } catch { /* already gone */ }
  process.exit(code);
};
process.on("SIGINT", () => stop(130));
setTimeout(() => { console.error(`e2e: timed out after ${TIMEOUT_S}s`); stop(1); }, TIMEOUT_S * 1000).unref();

type Final = { bookHash: string; finalists: { player: string; callsign: string; equity: string; provisionalPayoutUnits: string }[]; feeUnits: string };
type Settled = { txHash: Hex; mode: string; winners: string[]; amounts: string[] };

async function waitHealth() {
  for (;;) {
    // The WebSocket needs a current lobby, which exists once createLobby has been mined.
    try { const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json(); if (h.current !== null) return h.current as number; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const lobbyId = await waitHealth();
const { final, settled } = await new Promise<{ final: Final; settled: Settled }>((res, rej) => {
  let final: Final | null = null;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?lobby=${lobbyId}`);
  ws.on("error", rej);
  ws.on("message", (raw) => {
    const e = JSON.parse(raw.toString());
    if (e.type === "lobby" && e.status !== "live") say(`lobby ${e.lobbyId} ${e.status}, ${e.players.length} players`);
    if (e.type === "eliminated") say(`checkpoint ${e.checkpoint}: ${e.players.length} out`);
    if (e.type === "final") { final = e; say(`final: ${e.finalists.length} finalists, bookHash ${e.bookHash}`); }
    if (e.type === "settled" && final) { ws.close(); res({ final, settled: e }); }
  });
});

say(`settlement tx ${settled.txHash} (${settled.mode})`);
const rc = await pub.waitForTransactionReceipt({ hash: settled.txHash });
if (rc.status !== "success") { console.error("e2e: settlement receipt is not success"); stop(1); }
const before = rc.blockNumber - 1n;
const bal = (a: Address, blockNumber: bigint) => pub.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [a], blockNumber });
const treasury = await pub.readContract({ address: escrow, abi: ESCROW, functionName: "treasury" });

let ok = true;
const payouts = final.finalists.filter((f) => BigInt(f.provisionalPayoutUnits) > 0n);
const expected = payouts.map((f) => f.player).sort();
if (JSON.stringify(expected) !== JSON.stringify(settled.winners)) { ok = false; console.error(`winners differ: final ${expected} settled ${settled.winners}`); }
console.log("\n  winner                                      callsign      equity      payout (final)  balance change  match");
for (const f of payouts) {
  const d = (await bal(f.player as Address, rc.blockNumber)) - (await bal(f.player as Address, before));
  const match = d === BigInt(f.provisionalPayoutUnits);
  ok &&= match;
  console.log(`  ${f.player}  ${f.callsign.padEnd(12)}  ${f.equity.padStart(9)}  ${f.provisionalPayoutUnits.padStart(14)}  ${d.toString().padStart(14)}  ${match ? "yes" : "NO"}`);
}
const td = (await bal(treasury, rc.blockNumber)) - (await bal(treasury, before));
const tmatch = td === BigInt(final.feeUnits);
ok &&= tmatch;
console.log(`  treasury ${treasury}                fee   ${final.feeUnits.padStart(14)}  ${td.toString().padStart(14)}  ${tmatch ? "yes" : "NO"}\n`);
say(ok ? "PASS: every balance change equals the final event's payout" : "FAIL: balance changes differ from the final event");
stop(ok ? 0 : 1);
