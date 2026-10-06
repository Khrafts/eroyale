// End to end: a 20-bot stage match with the chain on, settled through settleFallback, then checks every winner's
// MockUSDC balance change in the settlement block against the `final` event's provisionalPayoutUnits.
// Env (process env, then ../.env for unset keys): CHAIN, RPC_URL, PRIVATE_KEY_DEPLOYER, PRIVATE_KEY_RELAYER,
// TOKEN_ADDRESS, ESCROW_ADDRESS, CHAIN_SELECTOR, PRICE_SOURCE_URL. Optional E2E_PORT, E2E_TIMEOUT_S.
// Secrets are passed to the engine through the environment and never printed: every error and every engine line
// goes through redact(), which replaces any URL (RPC URLs carry API keys) with <rpc>.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { createPublicClient, http, parseAbi, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import WebSocket from "ws";
import { failReason, redact } from "../src/chain.ts";

// Before anything can throw: an uncaught viem error prints its full request URL.
let stopEngine: (code: number) => never = (code) => process.exit(code);
const die = (e: unknown): never => { console.error(`e2e: ${failReason(e)}`); return stopEngine(1); };
process.on("uncaughtException", die);
process.on("unhandledRejection", die);

const ENGINE = resolve(import.meta.dirname, "..");
const envFile = resolve(ENGINE, "../.env");
if (existsSync(envFile)) for (const [k, v] of Object.entries(parseEnv(readFileSync(envFile, "utf8")))) if (process.env[k] === undefined) process.env[k] = v;
for (const k of ["CHAIN", "RPC_URL", "PRIVATE_KEY_DEPLOYER", "PRIVATE_KEY_RELAYER", "TOKEN_ADDRESS", "ESCROW_ADDRESS", "CHAIN_SELECTOR", "PRICE_SOURCE_URL"]) {
  if (!process.env[k]) { console.error(`e2e: ${k} is not set`); process.exit(2); }
}
if (process.env.CHAIN === "off") { console.error("e2e: CHAIN must not be off"); process.exit(2); }
// On anvil, engine reads answer 6 s behind the head, like a lagging load-balanced RPC node, so a local run exercises
// the engine's lag handling. Never on a testnet. ENGINE_READ_LAG_MS=0 turns it off.
if (process.env.CHAIN === "anvil") process.env.ENGINE_READ_LAG_MS ??= "6000";
else delete process.env.ENGINE_READ_LAG_MS;
const PORT = Number(process.env.E2E_PORT ?? 8799);
const TIMEOUT_S = Number(process.env.E2E_TIMEOUT_S ?? 600);
const say = (m: string) => console.log(`[e2e] ${m}`);

const pub = createPublicClient({ transport: http(process.env.RPC_URL) });
const token = process.env.TOKEN_ADDRESS as Address;
const escrow = process.env.ESCROW_ADDRESS as Address;
// Testnets and local anvil only: refuse before the engine sends anything.
const ALLOWED_CHAIN_IDS = [84532, 11155111, 31337];
const rpcChainId = await pub.getChainId().catch(() => { console.error("e2e: cannot read the RPC chain id"); process.exit(2); });
if (!ALLOWED_CHAIN_IDS.includes(rpcChainId)) { console.error(`e2e: RPC chain id ${rpcChainId} is not one of ${ALLOWED_CHAIN_IDS.join(", ")}`); process.exit(2); }
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const ESCROW = parseAbi(["function treasury() view returns (address)"]);

// Refuse a busy port: /health would answer from someone else's engine and the run would watch the wrong lobby.
const portFree = await new Promise<boolean>((r) => { const s = createServer().once("error", () => r(false)).listen(PORT, () => s.close(() => r(true))); });
if (!portFree) { console.error(`e2e: port ${PORT} is in use; set E2E_PORT to a free port`); process.exit(2); }

// A fresh data dir: a new anvil reuses lobby ids, and a book is never rewritten once on disk.
const data = mkdtempSync(join(tmpdir(), "royale-e2e-"));
const engine = spawn("npx", ["tsx", "src/server.ts", "--bots", "20", "--preset", "stage", "--port", String(PORT), "--open", "5", "--countdown", "10"], {
  cwd: ENGINE,
  env: { ...process.env, SETTLE_MODE: "simulated", ENGINE_DATA_DIR: data, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true, // own process group, so stop() takes down npx, tsx and the server together
});
// Whole lines only, so a URL split across two chunks is still redacted; an endless line is flushed at 64 KiB.
function relay(from: NodeJS.ReadableStream, to: NodeJS.WriteStream, tag: string) {
  let buf = "";
  const out = (line: string) => to.write(`  engine ${tag} ${redact(line)}\n`);
  from.on("data", (b: Buffer) => {
    buf += b.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { out(buf.slice(0, i)); buf = buf.slice(i + 1); }
    if (buf.length > 65536) { out(buf); buf = ""; }
  });
  from.on("end", () => { if (buf) out(buf); });
}
relay(engine.stdout, process.stdout, "|");
relay(engine.stderr, process.stderr, "!");
let exiting = false;
engine.on("exit", (code) => { if (!exiting) { console.error(`e2e: engine exited early (${code})`); process.exit(1); } });
const stop = (code: number): never => {
  exiting = true;
  try { process.kill(-engine.pid!, "SIGTERM"); } catch { /* already gone */ }
  process.exit(code);
};
stopEngine = stop;
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
    let e;
    try { e = JSON.parse(raw.toString()); } catch { say(`skipped an unparsable event (${raw.toString().length} bytes)`); return; }
    if (!e || typeof e !== "object") return;
    if (e.type === "lobby" && e.status !== "live") say(`lobby ${e.lobbyId} ${e.status}, ${e.players?.length} players`);
    if (e.type === "eliminated") say(`checkpoint ${e.checkpoint}: ${e.players?.length} out`);
    if (e.type === "final") { final = e; say(`final: ${e.finalists.length} finalists, bookHash ${e.bookHash}`); }
    if (e.type === "settled" && final) { ws.close(); res({ final, settled: e }); }
  });
});

say(`settlement tx ${settled.txHash} (${settled.mode})`);
const rc = await pub.waitForTransactionReceipt({ hash: settled.txHash });
if (rc.status !== "success") { console.error("e2e: settlement receipt is not success"); stop(1); }
const before = rc.blockNumber - 1n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A load-balanced RPC may not have the settlement block yet ("Requested resource not found"): retry.
async function retry<T>(what: string, f: () => Promise<T>, tries = 10): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await f(); } catch (e) {
      if (i >= tries) throw e;
      say(`${what} failed (attempt ${i}/${tries}), retrying in 2 s: ${failReason(e)}`);
      await sleep(2000);
    }
  }
}
const treasury = (await retry("treasury()", () => pub.readContract({ address: escrow, abi: ESCROW, functionName: "treasury" }))).toLowerCase() as Address;

// Token movement per address inside the settlement tx, from its Transfer logs: the fallback when the node cannot
// answer historical balanceOf, and a cross-check otherwise.
const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
function logDeltas(r: TransactionReceipt): Map<string, bigint> {
  const m = new Map<string, bigint>();
  const add = (a: string, v: bigint) => m.set(a.toLowerCase(), (m.get(a.toLowerCase()) ?? 0n) + v);
  for (const l of parseEventLogs({ abi: TRANSFER, logs: r.logs })) {
    if (l.address.toLowerCase() !== token.toLowerCase()) continue;
    add(l.args.from, -l.args.value);
    add(l.args.to, l.args.value);
  }
  return m;
}
const fromLogs = logDeltas(rc);
let source = "balanceOf";
async function delta(a: Address): Promise<bigint> {
  if (source === "balanceOf") {
    try {
      const bal = (blockNumber: bigint) => retry(`balanceOf(${a}) at ${blockNumber}`, () => pub.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [a], blockNumber }));
      return (await bal(rc.blockNumber)) - (await bal(before));
    } catch (e) {
      say(`historical balanceOf unavailable (${failReason(e)}); using the settlement receipt's Transfer logs`);
      source = "Transfer logs";
    }
  }
  return fromLogs.get(a.toLowerCase()) ?? 0n;
}

let ok = true;
const expectedWinners = final.finalists.filter((f) => BigInt(f.provisionalPayoutUnits) > 0n).map((f) => f.player.toLowerCase()).sort();
const settledWinners = settled.winners.map((w) => w.toLowerCase());
if (JSON.stringify(expectedWinners) !== JSON.stringify(settledWinners)) { ok = false; console.error(`winners differ: final ${expectedWinners} settled ${settledWinners}`); }
const cell = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "~" : s);
const rows: string[][] = [["finalist", "callsign", "equity", "expected (final)", "balance change", "match"]];
for (const f of final.finalists) {
  const want = BigInt(f.provisionalPayoutUnits);
  const d = await delta(f.player as Address);
  const match = d === want;
  ok &&= match;
  rows.push([f.player, cell(String(f.callsign), 16), f.equity, want.toString(), d.toString(), match ? "yes" : "NO"]);
}
const td = await delta(treasury);
const tmatch = td === BigInt(final.feeUnits);
ok &&= tmatch;
rows.push([treasury, "(treasury fee)", "", final.feeUnits, td.toString(), tmatch ? "yes" : "NO"]);
const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
console.log("");
for (const r of rows) console.log("  " + r.map((v, c) => (c >= 2 && c <= 4 ? v.padStart(widths[c]) : v.padEnd(widths[c]))).join("  "));
console.log(`  (balance change from ${source})\n`);
say(ok ? "PASS: every balance change equals the final event's payout" : "FAIL: balance changes differ from the final event");
stop(ok ? 0 : 1);
