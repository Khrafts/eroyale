// End to end: a 20-bot stage match with the chain on, settled through settleFallback, then checks every winner's
// MockUSDC balance change in the settlement block against the `final` event's provisionalPayoutUnits.
// --mode predict: one protocol round (20 engine bots) and one signed user round (creator fee 300 bps, 20 burner
// wallets generated here that sign their joins and predictions), both settled; every winner's, the creator's, the
// treasury's and the escrow's balance change must equal the round's `final` event.
// Env (process env, then ../.env for unset keys): CHAIN, RPC_URL, PRIVATE_KEY_DEPLOYER, PRIVATE_KEY_RELAYER,
// TOKEN_ADDRESS, ESCROW_ADDRESS, CHAIN_SELECTOR, PRICE_SOURCE_URL. Optional E2E_PORT, E2E_TIMEOUT_S.
// Secrets are passed to the engine through the environment and never printed: every error and every engine line
// goes through redact(), which replaces any URL (RPC URLs carry API keys) with <rpc>.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { createPublicClient, http, parseAbi, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";
import { failReason, redact } from "../src/chain.ts";
import { CREATE_ROUND_TYPES, JOIN_TYPES, ORDER_DOMAIN, PREDICTION_TYPES, createRoundMessage, joinMessage, predictionMessage } from "../src/orders.ts";

// Before anything can throw: an uncaught viem error prints its full request URL.
let stopEngine: (code: number) => never = (code) => process.exit(code);
const die = (e: unknown): never => { console.error(`e2e: ${failReason(e)}`); return stopEngine(1); };
process.on("uncaughtException", die);
process.on("unhandledRejection", die);

const { values: cli } = parseArgs({ options: { mode: { type: "string", default: "royale" } } });
const MODE = cli.mode;
if (MODE !== "royale" && MODE !== "predict") { console.error(`e2e: --mode must be royale or predict, got ${MODE}`); process.exit(2); }

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
const TIMEOUT_S = Number(process.env.E2E_TIMEOUT_S ?? (MODE === "predict" ? 1500 : 600));
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
// predict: protocol rounds only, 20 bots each, and only one of them (each extra round costs 20 joinFor on chain).
const engineArgs = MODE === "royale"
  ? ["--bots", "20", "--preset", "stage", "--open", "5", "--countdown", "10"]
  : ["--predict-only", "--predict-bots", "20", "--predict-rounds", "1"];
const engine = spawn("npx", ["tsx", "src/server.ts", ...engineArgs, "--port", String(PORT)], {
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

type Expect = { addr: string; label: string; info: string; want: bigint };
type Settled = { txHash: Hex; mode: string; winners: string[]; amounts: string[] };
/**
 * Checks each address's MockUSDC change across the settlement block (balanceOf at the block and the one before,
 * retried; Transfer logs of the settlement tx when the node cannot answer, or when `blockShared` says another
 * settlement landed in the same block) against what `final` promised. Prints the table; returns pass/fail.
 */
async function checkBalances(title: string, settled: Settled, expected: Expect[], expectedWinners: string[], blockShared = false): Promise<boolean> {
  say(`${title}: settlement tx ${settled.txHash} (${settled.mode})`);
  const rc = await pub.waitForTransactionReceipt({ hash: settled.txHash });
  if (rc.status !== "success") { console.error(`e2e: ${title}: settlement receipt is not success`); return false; }
  const before = rc.blockNumber - 1n;
  const fromLogs = logDeltas(rc);
  let source = blockShared ? "Transfer logs (another settlement shares the block)" : "balanceOf";
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
  const settledWinners = settled.winners.map((w) => w.toLowerCase());
  if (JSON.stringify(expectedWinners) !== JSON.stringify(settledWinners)) { ok = false; console.error(`${title}: winners differ: final ${expectedWinners} settled ${settledWinners}`); }
  const cell = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "~" : s);
  const rows: string[][] = [["address", "who", "info", "expected (final)", "balance change", "match"]];
  for (const x of expected) {
    const d = await delta(x.addr as Address);
    const match = d === x.want;
    ok &&= match;
    rows.push([x.addr, cell(x.label, 16), x.info, x.want.toString(), d.toString(), match ? "yes" : "NO"]);
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  console.log(`\n  ${title} (block ${rc.blockNumber}, tx ${settled.txHash})`);
  for (const r of rows) console.log("  " + r.map((v, c) => (c >= 2 && c <= 4 ? v.padStart(widths[c]) : v.padEnd(widths[c]))).join("  "));
  console.log(`  (balance change from ${source})\n`);
  return ok;
}

type Final = { bookHash: string; finalists: { player: string; callsign: string; equity: string; provisionalPayoutUnits: string }[]; feeUnits: string };

async function royale(): Promise<boolean> {
  async function waitHealth() {
    for (;;) {
      // The WebSocket needs a current lobby, which exists once createLobby has been mined.
      try { const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json(); if (h.current !== null) return h.current as number; } catch { /* not up yet */ }
      await sleep(500);
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
  const expected: Expect[] = final.finalists.map((f) => ({ addr: f.player, label: String(f.callsign), info: f.equity, want: BigInt(f.provisionalPayoutUnits) }));
  expected.push({ addr: treasury, label: "(treasury fee)", info: "", want: BigInt(final.feeUnits) });
  const winners = final.finalists.filter((f) => BigInt(f.provisionalPayoutUnits) > 0n).map((f) => f.player.toLowerCase()).sort();
  return checkBalances(`lobby ${lobbyId}`, settled, expected, winners);
}

// ---------- prediction rounds
type PFinal = {
  settlementPrice: string; bookHash: string; creatorFeeUnits: string; feeUnits: string;
  winners: { player: string; callsign: string; price: string; distance: string; rank: number; provisionalPayoutUnits: string }[];
};
type RoundResult = { final: PFinal; settled: Settled };
const base = `http://127.0.0.1:${PORT}`;
const get = async (p: string) => (await fetch(base + p)).json();
const post = async (p: string, b: unknown): Promise<[number, any]> => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return [r.status, await r.json()];
};

/** Follows one round over the WebSocket until `settled`; rejects on `cancelled`. `onLocked` fires at the lock. */
function watchRound(id: number, tag: string, onLocked?: () => void): Promise<RoundResult> {
  return new Promise((res, rej) => {
    let final: PFinal | null = null;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?lobby=${id}`);
    ws.on("error", rej);
    ws.on("message", (raw) => {
      let e;
      try { e = JSON.parse(raw.toString()); } catch { say(`skipped an unparsable event (${raw.toString().length} bytes)`); return; }
      if (!e || typeof e !== "object") return;
      if (e.type === "round") say(`${tag} round ${id}: ${e.params.market}, lock ${e.lockTime}, end ${e.endTime}, ${e.params.split}, creator fee ${e.params.creatorFeeBps}`);
      if (e.type === "locked") { say(`${tag} round ${id} locked with ${e.predictions.length} predictions`); onLocked?.(); }
      if (e.type === "cancelled") { ws.close(); rej(new Error(`${tag} round ${id} cancelled: ${e.reason}`)); }
      if (e.type === "final") { final = e; say(`${tag} round ${id} final: settlement ${e.settlementPrice}, ${e.winners.length} winners, creatorFeeUnits ${e.creatorFeeUnits}, bookHash ${e.bookHash}`); }
      if (e.type === "settled" && final) { ws.close(); res({ final, settled: e }); }
    });
  });
}

/** A signed user round with a fresh creator; 20 burner wallets join and predict, each signing its own messages. */
async function userRound(): Promise<{ id: number; creator: string; done: Promise<RoundResult> }> {
  const creator = privateKeyToAccount(generatePrivateKey());
  const params = {
    creator: creator.address.toLowerCase(), market: "ETH", entryUnits: "2000000", maxPlayers: 20, lockAfter: 120, resolveAfter: 60,
    winnerBps: 2500, split: "linear", creatorFeeBps: 300,
  };
  const signature = await creator.signTypedData({ domain: ORDER_DOMAIN, types: CREATE_ROUND_TYPES, primaryType: "CreateRound", message: createRoundMessage(params, 1) });
  const [code, made] = await post("/rounds", { params, nonce: 1, signature });
  if (code !== 200) throw new Error(`POST /rounds -> ${code} ${JSON.stringify(made)}`);
  const id: number = made.lobbyId;
  say(`user round ${id} created by ${params.creator} (createRound ${made.txHash})`);
  const done = watchRound(id, "user");
  const marks = await get("/marks");
  const mark = String(marks.marks?.ETH ?? "");
  if (!/^\d+(\.\d+)?$/.test(mark)) throw new Error(`no live ETH mark (${JSON.stringify(marks)})`);
  const [w, f = ""] = mark.split(".");
  const markCents = BigInt(w) * 100n + BigInt((f + "00").slice(0, 2));
  const step = markCents / 5000n + 1n; // about 2 bp apart, so the field spans roughly the mark +- 0.2%
  const players = Array.from({ length: 20 }, (_, i) => ({ acct: privateKeyToAccount(generatePrivateKey()), callsign: `E2E-${String(i + 1).padStart(2, "0")}`, i }));
  const results = await Promise.all(players.map(async (p) => {
    const player = p.acct.address.toLowerCase();
    const js = await p.acct.signTypedData({ domain: ORDER_DOMAIN, types: JOIN_TYPES, primaryType: "Join", message: joinMessage(id, player, p.callsign) });
    const [jc, jr] = await post(`/lobbies/${id}/join`, { player, callsign: p.callsign, signature: js });
    if (jc !== 200) return `${p.callsign} join -> ${jc} ${JSON.stringify(jr)}`;
    const cents = markCents + BigInt(p.i - 10) * step + BigInt(p.i); // distinct prices
    const price = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
    const ps = await p.acct.signTypedData({ domain: ORDER_DOMAIN, types: PREDICTION_TYPES, primaryType: "Prediction", message: predictionMessage(id, player, price, 1) });
    const [pc, pr] = await post("/predictions", { lobbyId: id, player, price, nonce: 1, ts: Date.now(), signature: ps });
    if (pc !== 200) return `${p.callsign} prediction -> ${pc} ${JSON.stringify(pr)}`;
    return null;
  }));
  const bad = results.filter((x): x is string => x !== null);
  if (bad.length) throw new Error(`user round ${id}: ${bad.join("; ")}`);
  say(`user round ${id}: 20 signed joins and predictions accepted`);
  return { id, creator: params.creator, done };
}

async function predict(): Promise<boolean> {
  let protocolId: number | null = null;
  while (protocolId === null) {
    try { protocolId = (await get("/health")).protocolRound ?? null; } catch { /* not up yet */ }
    if (protocolId === null) await sleep(500);
  }
  // The user round starts once the protocol round has locked, so its createRound and 20 joinFor do not queue
  // ahead of the protocol round's on-chain start (one serialized relayer/owner queue).
  let locked!: () => void;
  const protocolLocked = new Promise<void>((r) => (locked = r));
  const protocolDone = watchRound(protocolId, "protocol", () => locked());
  protocolDone.catch(() => undefined);
  await Promise.race([protocolLocked, protocolDone]);
  const user = await userRound();
  const [p, u] = await Promise.all([protocolDone, user.done]);

  const rcs = await Promise.all([p, u].map((r) => pub.waitForTransactionReceipt({ hash: r.settled.txHash })));
  const shared = rcs[0].blockNumber === rcs[1].blockNumber;
  const expectFor = (r: RoundResult, creator: string | null): { expected: Expect[]; winners: string[] } => {
    const expected: Expect[] = r.final.winners.map((w) => ({ addr: w.player, label: String(w.callsign), info: `#${w.rank} ${w.price} d=${w.distance}`, want: BigInt(w.provisionalPayoutUnits) }));
    const paid = expected.reduce((a, x) => a + x.want, 0n) + BigInt(r.final.creatorFeeUnits) + BigInt(r.final.feeUnits);
    if (creator) expected.push({ addr: creator, label: "(creator fee)", info: "", want: BigInt(r.final.creatorFeeUnits) });
    expected.push({ addr: treasury, label: "(treasury fee)", info: "", want: BigInt(r.final.feeUnits) });
    expected.push({ addr: escrow.toLowerCase(), label: "(escrow pot)", info: "", want: -paid });
    return { expected, winners: r.final.winners.map((w) => w.player.toLowerCase()).sort() };
  };
  const pe = expectFor(p, null);
  const ue = expectFor(u, user.creator);
  const okP = await checkBalances(`protocol round ${protocolId}`, p.settled, pe.expected, pe.winners, shared);
  const okU = await checkBalances(`user round ${user.id}`, u.settled, ue.expected, ue.winners, shared);
  say(`settlement txs: protocol round ${protocolId} ${p.settled.txHash}, user round ${user.id} ${u.settled.txHash}`);
  return okP && okU;
}

const ok = MODE === "royale" ? await royale() : await predict();
say(ok ? "PASS: every balance change equals the final event's payout" : "FAIL: balance changes differ from the final event");
stop(ok ? 0 : 1);
