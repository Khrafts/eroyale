// Live engine: real clock, exchange prices, HTTP + WebSocket, bots, relayer, append-only log per lobby.
// npm run dev -- --bots 20 --preset stage [--port 8787] [--open 15] [--countdown 10] [--seed S] [--loop] [--resume]
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { Lobby } from "./lobby.ts";
import { Bots, botAddress, botCallsign } from "./bots.ts";
import { CoinbaseFeed, FallbackPrices, KrakenFeed, fetchSettlementMarks, settlementMinute, type PriceSource } from "./prices.ts";
import { Driver, PredictDriver, realClock } from "./driver.ts";
import { PredictRound, checkUserSpec, protocolSpec, type RoundSpec } from "./predict.ts";
import { PredictBots } from "./predict-bots.ts";
import { LOBBY_CANCELLED, LOBBY_LIVE, LOBBY_OPEN, LOBBY_SETTLED, failReason, makeChain, redact } from "./chain.ts";
import { buildReport } from "../../workflow/src/report.ts";
import { parseOrderRequest, verifyCreateRound, verifyJoin, verifyOrder, verifyPrediction, type CreateRoundParams } from "./orders.ts";
import { ENTRY_UNITS, MARKETS, PRESETS, type EngineEvent, type Order, type Preset, type Prices, type SettleVia } from "./types.ts";
import type { Hex } from "viem";

// ---------- config
const ROOT = resolve(import.meta.dirname, "../..");
const envFile = resolve(ROOT, ".env");
if (existsSync(envFile)) {
  // Fill only keys not already set, so command-line values (CHAIN=off) win.
  for (const [k, v] of Object.entries(parseEnv(readFileSync(envFile, "utf8")))) if (process.env[k] === undefined) process.env[k] = v;
}
const { values: args } = parseArgs({
  options: {
    bots: { type: "string", default: "0" }, preset: { type: "string", default: "stage" }, port: { type: "string" },
    open: { type: "string", default: "15" }, countdown: { type: "string", default: "10" }, seed: { type: "string" },
    max: { type: "string", default: "50" }, loop: { type: "boolean", default: false }, resume: { type: "boolean", default: false },
    predict: { type: "boolean", default: false }, "predict-bots": { type: "string", default: "0" }, "predict-only": { type: "boolean", default: false },
    "predict-rounds": { type: "string", default: "0" },
  },
});
const preset = PRESETS[args.preset as Preset["name"]];
if (!preset) throw new Error(`unknown preset ${args.preset}`);
const N_BOTS = Number(args.bots);
const PORT = Number(args.port ?? process.env.PORT ?? 8787);
const OPEN_S = Number(args.open);
const COUNTDOWN_S = Number(args.countdown);
const MAX_PLAYERS = Number(args.max);
const SEED = Number(args.seed ?? Date.now() % 2 ** 31);
const PRICE_URL = (process.env.PRICE_SOURCE_URL ?? "").trim();
const SIG_OFF = process.env.ORDER_SIG === "off";
const STALE_MS = 3000;
const SETTLE_MODE = (process.env.SETTLE_MODE ?? "simulated").trim();
const FEE_BPS = 500n;
// Prediction mode: on with --predict, --predict-bots N (N > 0) or --predict-only (no royale lobby).
const PREDICT_BOTS = Number(args["predict-bots"]);
const PREDICT_ON = args.predict || args["predict-only"] || PREDICT_BOTS > 0;
const ROYALE_ON = !args["predict-only"];
if (!Number.isInteger(PREDICT_BOTS) || PREDICT_BOTS < 0 || PREDICT_BOTS > 50) throw new Error("--predict-bots must be 0 to 50");
// Test only (e2e): stop opening protocol rounds after this many; 0 = the normal endless loop.
const PREDICT_ROUNDS = Number(args["predict-rounds"]);
if (!Number.isInteger(PREDICT_ROUNDS) || PREDICT_ROUNDS < 0) throw new Error("--predict-rounds must be a non-negative integer");
const moreProtocolRounds = () => PREDICT_ROUNDS === 0 || protocolCount < PREDICT_ROUNDS;

const BOT_RETRY_MS = 3000; // retry a bot whose joinFor failed this often while joins are open
const JOIN_CLOSE_MS = 7000; // joins close this long before startsAt
const START_LEAD_MS = 6000; // first on-chain start() this long before startsAt, so the chain end lands near the book's
const START_DEADLINE_MS = 1500; // no new start attempt after startsAt minus this; cancel instead
const START_LATE_MS = 50_000; // an on-chain start landing this long after startsAt / the lock is cancelled (workflow allows 60 s skew)
const MAX_CHAIN_PROTOCOL_BOTS = 20; // protocol-round bots with the chain on, whatever --predict-bots says (joins share one tx queue)
const DEPLOYED_SETTLE_WAIT_MS = 15 * 60_000; // SETTLE_MODE=deployed: stop watching for Settled after this
// Every engine line goes through redact(): RPC URLs carry API keys.
const log = (m: string) => console.log(`${new Date().toISOString()} ${redact(m)}`);
const fatal = (e: unknown): never => { console.error(`engine: fatal: ${failReason(e)}`); process.exit(1); };
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
const chain = await makeChain(process.env, log).catch(fatal);
// Store for logs and books. With the chain on, one directory per escrow, so a new escrow (whose lobby ids restart at 1)
// never serves or resumes another escrow's lobby. ENGINE_DATA_DIR overrides (e2e uses a temp dir).
const DATA = process.env.ENGINE_DATA_DIR
  ? resolve(process.env.ENGINE_DATA_DIR)
  : chain.on
    ? resolve(import.meta.dirname, "../data", `${process.env.CHAIN!.trim()}-${process.env.ESCROW_ADDRESS!.trim().toLowerCase()}`)
    : resolve(import.meta.dirname, "../data");
mkdirSync(DATA, { recursive: true });
// With the chain on, the final marks must be the settlement candle the workflow reads; never live marks.
if (chain.on && !PRICE_URL) throw new Error("PRICE_SOURCE_URL is required when CHAIN is not off");
if (SETTLE_MODE !== "simulated" && SETTLE_MODE !== "deployed" && SETTLE_MODE !== "cre") throw new Error(`SETTLE_MODE must be simulated, cre or deployed, got ${SETTLE_MODE}`);
// SETTLE_MODE=cre: how long after `final` the engine waits for the CRE settler before its own settleFallback.
const CRE_WAIT_MS = Number(process.env.CRE_WAIT_MS ?? 360_000);
const ESCROW = (process.env.ESCROW_ADDRESS ?? "").trim().toLowerCase();
const CHAIN_SELECTOR = (process.env.CHAIN_SELECTOR ?? "").trim();
if (chain.on && !/^\d+$/.test(CHAIN_SELECTOR)) throw new Error("CHAIN_SELECTOR is required when CHAIN is not off");
const prices: PriceSource = new FallbackPrices(new CoinbaseFeed(log).start()!, new KrakenFeed(log).start()!);

// ---------- matches
type Match = {
  lobby: Lobby; driver: Driver; bots: Bots; seed: number; nBots: number; logFile: string; clients: Set<WebSocket>;
  finishing: boolean; pendingJoins: Set<string>; chainError: string | null; startTx: string | null;
};
const matches = new Map<number, Match>();
let localId = 0;

// ---------- final books: written once to disk at the end tick, served from here first
const books = new Map<number, string>();
const bookFile = (id: number) => resolve(DATA, `lobby-${id}.final.json`);
for (const f of readdirSync(DATA)) {
  const mm = /^lobby-(\d+)\.final\.json$/.exec(f);
  if (mm) books.set(Number(mm[1]), readFileSync(resolve(DATA, f), "utf8"));
}
// CHAIN=off ids are local: continue after any lobby already on disk so a restart never reuses a finished id.
for (const f of readdirSync(DATA)) { const mm = /^(?:lobby|round)-(\d+)\./.exec(f); if (mm) localId = Math.max(localId, Number(mm[1])); }
function persistBook(id: number, json: string): string {
  const have = books.get(id);
  if (have !== undefined) return have; // written once, never changed
  const tmp = bookFile(id) + ".tmp";
  writeFileSync(tmp, json);
  renameSync(tmp, bookFile(id));
  books.set(id, json);
  return json;
}
let current: Match | null = null;

const record = (m: { logFile: string }, line: unknown) => appendFileSync(m.logFile, JSON.stringify(line) + "\n");

function wire(m: Match) {
  m.lobby.onEvent((e, line) => {
    appendFileSync(m.logFile, line + "\n");
    for (const c of m.clients) if (c.readyState === c.OPEN) c.send(line);
    if (e.type === "lobby") log(`[lobby ${m.lobby.id}] ${e.status}, ${(e.players as unknown[]).length} players, startsAt ${e.startsAt}`);
    else if (e.type === "eliminated" || e.type === "final" || e.type === "warning") log(`[lobby ${m.lobby.id}] ${line.slice(0, 400)}`);
  });
}

function newMatch(id: number, p: Preset, seed: number, nBots: number): Match {
  const lobby = new Lobby({ id, preset: p, maxPlayers: MAX_PLAYERS });
  const bots = new Bots(seed);
  const driver = new Driver(lobby, realClock, prices, bots);
  const m: Match = {
    lobby, driver, bots, seed, nBots, logFile: resolve(DATA, `lobby-${id}.jsonl`), clients: new Set(),
    finishing: false, pendingJoins: new Set(), chainError: null, startTx: null,
  };
  // Ticks are inputs too: record the marks each one used so a crash can be replayed.
  driver.onTick = (k, marks) => record(m, { in: "tick", k, marks });
  matches.set(id, m);
  return m;
}

/** Create the next lobby; on a chain error, log it and retry instead of crashing the process. */
async function createLobbyRetrying(): Promise<void> {
  for (;;) {
    try { await createLobby(); return; } catch (e) {
      log(`[chain] createLobby failed, retrying in 10 s: ${failReason(e)}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

async function createLobby(): Promise<Match> {
  const chainId = await chain.createLobby(preset.duration, ENTRY_UNITS, MAX_PLAYERS);
  const id = chainId ?? ++localId;
  localId = Math.max(localId, id);
  const m = newMatch(id, preset, SEED + id, N_BOTS);
  // A fresh run reusing an id keeps the old log beside it rather than appending to it.
  if (existsSync(m.logFile)) renameSync(m.logFile, m.logFile.replace(/\.jsonl$/, `.${Date.now()}.jsonl.old`));
  // A new on-chain lobby is a new match: never serve a stored book left under the same id.
  if (chainId !== null && (books.has(id) || existsSync(bookFile(id)))) {
    if (existsSync(bookFile(id))) renameSync(bookFile(id), bookFile(id).replace(/\.json$/, `.${Date.now()}.json.old`));
    books.delete(id);
    log(`[lobby ${id}] moved a stored book for this id aside`);
  }
  record(m, { in: "create", id, preset: preset.name, seed: m.seed, maxPlayers: MAX_PLAYERS });
  wire(m);
  m.lobby.emitLobby();
  current = m;
  const failed: number[] = [];
  for (let i = 0; i < N_BOTS; i++) if (!(await joinBot(m, i))) failed.push(i);
  if (failed.length) void retryBots(m, failed);
  scheduleCountdown(m, Date.now() + OPEN_S * 1000);
  return m;
}

async function joinBot(m: Match, i: number): Promise<boolean> {
  const addr = botAddress(m.seed, i);
  const r = await join(m, addr, botCallsign(i), i);
  if ("error" in r) { log(`[lobby ${m.lobby.id}] bot ${i} could not join: ${r.error}`); return false; }
  m.bots.add(addr, i);
  return true;
}

/** Bots whose join failed are retried every BOT_RETRY_MS while the lobby still takes joins, never dropped early. */
async function retryBots(m: Match, failed: number[]) {
  const l = m.lobby;
  const open = () => l.status === "open" || (l.status === "countdown" && Date.now() < l.startsAt! * 1000 - JOIN_CLOSE_MS);
  while (failed.length && open()) {
    await new Promise((r) => setTimeout(r, BOT_RETRY_MS));
    for (const i of [...failed]) {
      if (!open()) break;
      if (l.find(botAddress(m.seed, i)) || (await joinBot(m, i))) failed.splice(failed.indexOf(i), 1);
    }
  }
  if (failed.length) log(`[lobby ${l.id}] ${failed.length} bots never joined: seats ${failed.join(", ")}`);
}

/** botIndex is the bot's seat index (null for a human); replay uses it to rebuild the same bot. */
async function join(m: Match, player: string, callsign: string, botIndex: number | null): Promise<{ txHash: string | null } | { error: string }> {
  const bot = botIndex !== null;
  player = player.toLowerCase();
  const l = m.lobby;
  // Joins stay open through the countdown, closing JOIN_CLOSE_MS before startsAt (before the on-chain start is sent).
  if (l.status !== "open" && l.status !== "countdown") return { error: `lobby is ${l.status}` };
  if (l.status === "countdown" && Date.now() > l.startsAt! * 1000 - JOIN_CLOSE_MS) return { error: "lobby is about to start" };
  if (l.find(player) || m.pendingJoins.has(player)) return { error: "already joined" };
  if (l.players.length + m.pendingJoins.size >= l.maxPlayers) return { error: "lobby is full" };
  if (!/^0x[0-9a-f]{40}$/.test(player)) return { error: "player must be an address" };
  if (!String(callsign ?? "").trim()) return { error: "callsign required" };
  m.pendingJoins.add(player);
  try {
    const txHash = await chain.joinFor(l.id, player, l.startsAt !== null ? l.startsAt * 1000 - JOIN_CLOSE_MS : undefined);
    const r = l.join(player, callsign, bot);
    if (!r.ok) return { error: r.error };
    record(m, { in: "join", player, callsign, bot, botIndex });
    return { txHash };
  } catch (e) {
    return { error: `joinFor failed: ${failReason(e)}` };
  } finally {
    m.pendingJoins.delete(player);
  }
}

function scheduleCountdown(m: Match, at: number) {
  const check = () => {
    const l = m.lobby;
    if (l.status !== "open") return;
    if (Date.now() < at || l.players.length < 4 || m.pendingJoins.size || !prices.current()) return void setTimeout(check, 500);
    // Go live on a minute boundary so endTime % 60 == 0 and the settlement candle is the match's last minute.
    const startsAt = Math.ceil((Date.now() / 1000 + COUNTDOWN_S) / 60) * 60;
    l.countdown(startsAt);
    record(m, { in: "countdown", startsAt });
    scheduleChainStart(m);
  };
  check();
}

/**
 * Send escrow start() just before startsAt so the chain's end time lands within seconds of the book's. Retries until
 * START_DEADLINE_MS before startsAt; after the last failure, cancels the lobby (engine first, so it never goes live,
 * then on chain, which refunds every entry). A start that lands more than START_LATE_MS after startsAt (queued behind
 * other transactions) is cancelled too: the on-chain end would be too far from the book's for the workflow.
 */
function scheduleChainStart(m: Match) {
  if (!chain.on) return;
  const l = m.lobby;
  const late = () => Date.now() > l.startsAt! * 1000 + START_LATE_MS;
  const attempt = async (n: number) => {
    if (l.status === "cancelled" || m.startTx) return;
    try {
      m.startTx = await chain.start(l.id);
      m.chainError = null;
      log(`[lobby ${l.id}] chain start ${m.startTx}`);
      if (late()) await cancelMatch(m, `chain start landed more than ${START_LATE_MS / 1000} s after startsAt`);
    } catch (e) {
      m.chainError = `start attempt ${n} failed: ${failReason(e)}`.slice(0, 500);
      log(`[lobby ${l.id}] ${m.chainError}`);
      if (n < 10 && Date.now() + 1000 < l.startsAt! * 1000 - START_DEADLINE_MS) setTimeout(() => attempt(n + 1), 1000);
      else await cancelMatch(m, `chain start failed ${n} times`);
    }
  };
  setTimeout(() => attempt(1), Math.max(0, l.startsAt! * 1000 - START_LEAD_MS - Date.now()));
}

/** Cancel a match whose escrow never went live: stop it here, then refund the entries on chain. */
async function cancelMatch(m: Match, why: string) {
  const l = m.lobby;
  if (l.status === "open" || l.status === "countdown" || l.status === "live") {
    l.cancel();
    record(m, { in: "cancel", why });
  }
  log(`[lobby ${l.id}] cancelled: ${why}`);
  try {
    const tx = await chain.cancel(l.id);
    m.chainError = `${why}; lobby cancelled, entries refunded (${tx})`;
  } catch (e) {
    m.chainError = `${why}; cancel failed too: ${failReason(e)}`.slice(0, 500);
  }
  log(`[lobby ${l.id}] ${m.chainError}`);
  if (args.loop && current === m) setTimeout(() => void createLobbyRetrying(), 5000);
}

// ---------- the clock
function loop() {
  roundsLoop();
  for (const m of matches.values()) {
    const l = m.lobby;
    if (l.status !== "countdown" && l.status !== "live") continue;
    const done = m.driver.advance();
    if (done && !m.finishing) {
      // The book does not depend on marks: freeze, persist and serve it at the end tick.
      persistBook(l.id, l.freezeBook(books.get(l.id)));
      finish(m);
    }
  }
}

async function finish(m: Match) {
  m.finishing = true;
  const l = m.lobby;
  let marks: Prices = l.marks!;
  if (PRICE_URL) {
    const S = settlementMinute(l.endTime!);
    const wait = (S + 120) * 1000 - Date.now();
    if (wait > 0) {
      log(`[lobby ${l.id}] waiting ${Math.ceil(wait / 1000)}s for the settlement candle at ${S}`);
      await new Promise((r) => setTimeout(r, wait + 1500));
    }
    // With the chain on, keep retrying: the report uses the candle, so `final` must too.
    for (let attempt = 1; ; attempt++) {
      try { marks = await fetchSettlementMarks(PRICE_URL, l.endTime!); break; } catch (e) {
        log(`[lobby ${l.id}] settlement candle attempt ${attempt} failed: ${failReason(e)}`);
        if (!chain.on && attempt >= 6) { log(`[lobby ${l.id}] CHAIN=off: falling back to the last live mark`); break; }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  // With the chain on, payouts in `final` use the escrow's pot, the same number the report is built from.
  const pot = chain.on ? await onchainPot(l.id) : l.potUnits;
  if (pot !== l.potUnits) log(`[lobby ${l.id}] warning: on-chain pot ${pot} != engine pot ${l.potUnits}; final and report use the on-chain pot`);
  record(m, { in: "final", marks, potUnits: pot.toString() });
  l.emitFinal(marks, pot);
  if (chain.on) await settle(m, l, marks, pot).catch((e) => { m.chainError = `settle: ${failReason(e)}`.slice(0, 500); log(`[lobby ${l.id}] ${m.chainError}`); });
  if (args.loop && current === m) setTimeout(() => void createLobbyRetrying(), 5000);
}

// ---------- settlement
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The escrow's pot for a lobby; retries until the RPC answers (final waits on it, as it waits on the candle). */
async function onchainPot(id: number): Promise<bigint> {
  for (let attempt = 1; ; attempt++) {
    try { return (await chain.getLobby(id)).pot; } catch (e) {
      log(`[lobby ${id}] getLobby for the pot failed (attempt ${attempt}), retrying: ${failReason(e)}`);
      await sleep(5000);
    }
  }
}

/**
 * simulated: build the report from the exact book bytes with workflow's buildReport, wait for block time past the
 * on-chain end, owner calls settleFallback. cre: wait CRE_WAIT_MS for an external CRE settlement (the royale-settle
 * workflow run in the CRE CLI simulator by `npm run cre-settler`, written through the MockKeystoneForwarder); if no
 * Settled shows up, settle with settleFallback. deployed: the CRE workflow writes the report; we only watch for Settled.
 * settleFallback retries every 5 s; gives up when one failure reason repeats.
 */
type Settles = { readonly id: number; markSettled(txHash: string, mode: "deployed" | "simulated", via: SettleVia, winners: string[], amounts: string[]): void };
async function settle(m: { chainError: string | null }, l: Settles, marks: Prices, pot: bigint) {
  let onchain = null;
  for (let attempt = 1; !onchain; attempt++) {
    try { onchain = await chain.getLobby(l.id); } catch (e) {
      if (attempt >= 5) throw e;
      log(`[lobby ${l.id}] getLobby failed, retrying: ${failReason(e)}`);
      await sleep(3000);
    }
  }
  const book = books.get(l.id)!;
  // `pot` is the on-chain pot `final` was computed from; once Live it cannot change, so this is the report's pot too.
  if (onchain.pot !== pot && onchain.status !== LOBBY_SETTLED) throw new Error(`on-chain pot moved from ${pot} to ${onchain.pot} after final`);
  // Every lobby passes the on-chain values: buildReport checks a predict book's creator, fee, entry and player count
  // (and a royale book's absence of a creator) against the escrow.
  const r = buildReport(new TextEncoder().encode(book), marks, pot, FEE_BPS, BigInt(CHAIN_SELECTOR),
    { creator: onchain.creator, creatorFeeBps: onchain.creatorFeeBps, entry: onchain.entry, playerCount: onchain.playerCount });
  if (BigInt(r.lobbyId) !== BigInt(l.id)) throw new Error(`book lobbyId ${r.lobbyId} != ${l.id}`);
  // Where to look for a Settled log: from a little before the lobby ended (counting >= 1 s per block).
  const head = await chain.blockNumber();
  const behind = BigInt(Math.max(0, Math.floor(Date.now() / 1000) - Number(onchain.endTime))) + 300n;
  const scanFrom = head > behind ? head - behind : 0n;
  const mode: "deployed" | "simulated" = SETTLE_MODE === "deployed" ? "deployed" : "simulated";
  const done = (hash: string, via: SettleVia) => {
    m.chainError = null;
    l.markSettled(hash, mode, via, r.winners, r.amounts.map(String));
    log(`[lobby ${l.id}] settled (${mode} via ${via}) ${hash}`);
  };
  /** A settlement this engine did not send (or whose call errored): checked receipt, and which path sent it. */
  const pickUp = async (hash: string) => {
    const rc = await chain.settlementReceipt(l.id, hash as Hex).catch(() => null);
    if (rc && !rc.ok) log(`[lobby ${l.id}] warning: ${rc.reason}`);
    if (rc?.ok && rc.bookHash !== r.bookHash) log(`[lobby ${l.id}] warning: Settled bookHash ${rc.bookHash} != engine book ${r.bookHash}`);
    done(hash, rc?.to === ESCROW ? "owner-fallback" : SETTLE_MODE === "deployed" ? "cre-don" : "cre-simulator");
  };
  if (onchain.status === LOBBY_SETTLED) {
    const hash = await chain.findSettled(l.id, scanFrom);
    if (hash) return pickUp(hash);
    throw new Error("escrow says settled but no Settled log found");
  }
  if (SETTLE_MODE === "deployed" || SETTLE_MODE === "cre") {
    // deployed: triggering the deployed workflow's HTTP trigger needs a signed gateway request that is not wired here.
    // cre: the CRE CLI needs a logged-in user, so the simulator runs on an operator's machine (npm run cre-settler).
    const wait = SETTLE_MODE === "deployed" ? DEPLOYED_SETTLE_WAIT_MS : CRE_WAIT_MS;
    log(`[lobby ${l.id}] SETTLE_MODE=${SETTLE_MODE}: waiting up to ${wait / 1000}s for royale-settle {"lobbyId": ${l.id}} to settle it`);
    const hash = await watchSettled(l.id, scanFrom, Date.now() + wait);
    if (hash) return pickUp(hash);
    if (SETTLE_MODE === "deployed") {
      m.chainError = `no Settled log within ${wait / 60_000} min; settle by hand (contracts/NOTES.md)`;
      log(`[lobby ${l.id}] ${m.chainError}`);
      return;
    }
    log(`[lobby ${l.id}] no CRE settlement within ${wait / 1000}s; settling with settleFallback`);
  }
  for (;;) {
    const now = await chain.blockTime();
    if (now > onchain.endTime) break;
    log(`[lobby ${l.id}] block time ${now} not past on-chain end ${onchain.endTime}; waiting`);
    await sleep(Math.min(Number(onchain.endTime - now) + 2, 10) * 1000);
  }
  let last = "";
  for (let attempt = 1; attempt <= 10; attempt++) {
    try { return done(await chain.settleFallback(r.report), "owner-fallback"); } catch (e) {
      // Settled meanwhile (by the CRE settler racing us, or our tx landed although this call errored): pick it up.
      const now = await chain.getLobby(l.id).catch(() => null);
      if (now?.status === LOBBY_SETTLED) {
        const hash = await chain.findSettled(l.id, scanFrom).catch((e2) => { log(`[lobby ${l.id}] Settled log search failed: ${failReason(e2)}`); return null; });
        if (hash) return pickUp(hash);
      }
      const why = failReason(e);
      m.chainError = `settleFallback attempt ${attempt} failed: ${why}`.slice(0, 500);
      log(`[lobby ${l.id}] ${m.chainError}`);
      if (why === last) { log(`[lobby ${l.id}] settleFallback failed twice for the same reason; giving up`); return; }
      last = why;
      await sleep(5000);
    }
  }
}

/**
 * Watches for Settled(id) until `until`: every 10 s scans the blocks it has not scanned yet (the RPC caps eth_getLogs
 * at a few blocks per call, so each block is read once) and checks the lobby status. Errors are logged, not swallowed.
 */
async function watchSettled(id: number, from: bigint, until: number): Promise<string | null> {
  let next = from;
  while (Date.now() < until) {
    try {
      const top = await chain.blockNumber();
      if (top >= next) {
        const hash = await chain.findSettled(id, next, top);
        if (hash) return hash;
        next = top + 1n;
      }
      if ((await chain.getLobby(id)).status === LOBBY_SETTLED) {
        const hash = await chain.findSettled(id, from, next - 1n);
        if (hash) return hash;
        log(`[lobby ${id}] escrow says Settled but no Settled log since block ${from}`);
      }
    } catch (e) { log(`[lobby ${id}] watching for Settled: ${failReason(e)}`); }
    await sleep(10_000);
  }
  return null;
}

// ---------- prediction rounds (the spec "Prediction mode")
type RoundMatch = {
  round: PredictRound; driver: PredictDriver; bots: PredictBots; seed: number; logFile: string; clients: Set<WebSocket>;
  pendingJoins: Set<string>; chainError: string | null; startTx: string | null; createTx: string | null;
  locked: boolean; finishing: boolean; startSent: boolean; starting: Promise<void> | null;
  nextLobby: Promise<number | null> | null; // the next protocol round's on-chain lobby, created before this one locks
};
const rounds = new Map<number, RoundMatch>();
let protocolRound: RoundMatch | null = null;
let protocolCount = 0; // markets rotate BTC, ETH, SOL
const PRECREATE_MS = 20_000; // create the next protocol round's on-chain lobby this long before the current lock
// A protocol round that can only open more than this long after the previous lock (the engine fell behind: a stalled
// tx queue, a slow createLobby, a paused process) opens at now instead, with its full lockAfter. Never backdated.
const PROTOCOL_LATE_MS = 2_000;
// The lock waits at most this long past the lock time for joins still in flight; then it goes ahead without them
// (a join that lands later makes the escrow disagree with the book, and finishRound refunds the round).
const LOCK_HOLD_MAX_MS = 15_000;
// The one protocol-round createLobby in flight (the early one for the next round, or the one at the lock). Protocol
// lobbies are interchangeable on chain (same duration, entry and max), so whoever asks next shares it.
let protocolCreate: Promise<number | null> | null = null;
function createProtocolLobby(): Promise<number | null> {
  if (!protocolCreate) {
    const spec = protocolSpec(MARKETS[0]);
    protocolCreate = chain.createLobby(spec.resolveAfter, spec.entryUnits, spec.maxPlayers).finally(() => { protocolCreate = null; });
  }
  return protocolCreate;
}
let openingProtocol = false; // openProtocolRound is running
const MAX_USER_ROUNDS = 5; // open user rounds at once, globally
const creating = new Set<string>(); // creators whose createRound is in flight
// CreateRound nonces, persisted so a signed create cannot be replayed after a restart.
const NONCE_FILE = resolve(DATA, "creator-nonces.json");
const creatorNonces = new Map<string, bigint>(
  existsSync(NONCE_FILE) ? Object.entries(JSON.parse(readFileSync(NONCE_FILE, "utf8")) as Record<string, string>).map(([k, v]) => [k, BigInt(v)]) : [],
);
function saveCreatorNonce(creator: string, nonce: bigint) {
  creatorNonces.set(creator, nonce);
  writeFileSync(NONCE_FILE + ".tmp", JSON.stringify(Object.fromEntries([...creatorNonces].map(([k, v]) => [k, v.toString()]))));
  renameSync(NONCE_FILE + ".tmp", NONCE_FILE);
}

/**
 * Cancel a round on chain (refunds every entry). Retries with backoff; an escrow that already says Cancelled is done.
 * Once the escrow is Cancelled (or an Open lobby holds no entries) it appends {"in":"cancel-done"} to the round's log,
 * so a restart retries any round whose log has `cancelled` without it. Returns the line for chainError.
 */
async function cancelOnChain(id: number, why: string, logFile: string): Promise<string> {
  const done = (line: string, tx: string | null) => { record({ logFile }, { in: "cancel-done", tx }); return line; };
  for (let n = 1; ; n++) {
    try {
      const l = await chain.getLobby(id);
      if (l.status === LOBBY_CANCELLED) return done(`${why}; cancelled on chain`, null);
      if (l.status !== LOBBY_OPEN && l.status !== LOBBY_LIVE) return `${why}; escrow status ${l.status}, not cancellable`;
      // An empty Open lobby holds no money: nothing to refund, no transaction.
      if (l.status === LOBBY_OPEN && l.playerCount === 0) return done(`${why}; no entries on chain, nothing to refund`, null);
      const tx = await chain.cancel(id);
      return done(`${why}; cancelled on chain, entries refunded (${tx})`, tx);
    } catch (e) {
      if (n >= 12) return `${why}; cancel failed ${n} times: ${failReason(e)}`.slice(0, 500);
      const wait = Math.min(60, 2 ** n);
      log(`[round ${id}] cancel attempt ${n} failed, retrying in ${wait} s: ${failReason(e)}`);
      await sleep(wait * 1000);
    }
  }
}

function wireRound(m: RoundMatch) {
  m.round.onEvent((e, line) => {
    appendFileSync(m.logFile, line + "\n");
    for (const c of m.clients) if (c.readyState === c.OPEN) c.send(line);
    if (e.type === "lobby") log(`[round ${m.round.id}] ${e.status}, ${(e.players as unknown[]).length} players, lock ${m.round.lockTime}, end ${m.round.endTime}`);
    else if (e.type === "locked" || e.type === "cancelled") log(`[round ${m.round.id}] ${e.type}${e.type === "cancelled" ? `: ${e.reason}` : `, ${(e.predictions as unknown[]).length} predictions`}`);
    else if (e.type === "final") log(`[round ${m.round.id}] ${line.slice(0, 400)}`);
  });
}

/** Open a round (protocol or user). The on-chain lobby must already exist (or CHAIN=off). */
function openRound(id: number, spec: RoundSpec, protocol: boolean, openTime: number, nBots: number, createTx: string | null): RoundMatch {
  localId = Math.max(localId, id);
  const round = new PredictRound({ id, spec, protocol, openTime });
  const seed = SEED + id;
  const m: RoundMatch = {
    round, driver: null as unknown as PredictDriver, bots: null as unknown as PredictBots, seed, logFile: resolve(DATA, `round-${id}.jsonl`),
    clients: new Set(), pendingJoins: new Set(), chainError: null, startTx: null, createTx, locked: false, finishing: false,
    startSent: false, starting: null, nextLobby: null,
  };
  m.bots = new PredictBots(seed, (player, price) => void submitPrediction(m, player, price));
  m.driver = new PredictDriver(round, realClock, prices, m.bots);
  m.driver.holdLock = () => m.pendingJoins.size > 0 && Date.now() < m.round.lockTime * 1000 + LOCK_HOLD_MAX_MS;
  m.driver.onTick = (k, mark) => record(m, { in: "tick", k, mark });
  if (existsSync(m.logFile)) renameSync(m.logFile, m.logFile.replace(/\.jsonl$/, `.${Date.now()}.jsonl.old`));
  if (books.has(id) || existsSync(bookFile(id))) {
    if (existsSync(bookFile(id))) renameSync(bookFile(id), bookFile(id).replace(/\.json$/, `.${Date.now()}.json.old`));
    books.delete(id);
    log(`[round ${id}] moved a stored book for this id aside`);
  }
  rounds.set(id, m);
  record(m, { in: "create", id, protocol, openTime, seed, spec: { ...spec, entryUnits: spec.entryUnits.toString() } });
  wireRound(m);
  round.emitLobby();
  round.emitRound();
  // All bot joins are queued at once (the chain queue still sends them one by one, in seat order).
  void Promise.all(Array.from({ length: nBots }, (_, i) => joinRoundBot(m, i))).then((ok) => {
    const failed = ok.flatMap((x, i) => (x ? [] : [i]));
    if (failed.length) log(`[round ${id}] ${failed.length} bots could not join: seats ${failed.join(", ")}`);
  });
  return m;
}

async function joinRoundBot(m: RoundMatch, i: number): Promise<boolean> {
  const addr = botAddress(m.seed, i);
  const r = await joinRound(m, addr, botCallsign(i), i);
  if ("error" in r) { log(`[round ${m.round.id}] bot ${i} could not join: ${r.error}`); return false; }
  m.bots.add(m.round, addr, i);
  return true;
}

/** Joins close JOIN_CLOSE_MS before the lock, so every joinFor has landed before the lock (and the on-chain start). */
async function joinRound(m: RoundMatch, player: string, callsign: string, botIndex: number | null): Promise<{ txHash: string | null } | { error: string }> {
  player = player.toLowerCase();
  const r = m.round;
  if (r.status !== "open") return { error: `round is ${r.status}` };
  if (Date.now() > r.lockTime * 1000 - JOIN_CLOSE_MS) return { error: "round is about to lock" };
  if (r.find(player) || m.pendingJoins.has(player)) return { error: "already joined" };
  if (r.players.length + m.pendingJoins.size >= r.maxPlayers) return { error: "round is full" };
  if (!/^0x[0-9a-f]{40}$/.test(player)) return { error: "player must be an address" };
  if (!String(callsign ?? "").trim()) return { error: "callsign required" };
  m.pendingJoins.add(player);
  try {
    const txHash = await chain.joinFor(r.id, player, r.lockTime * 1000 - JOIN_CLOSE_MS);
    const j = r.join(player, callsign, botIndex !== null);
    if (!j.ok) {
      // Paid on chain but the round moved on: the on-chain pot is what final and the report use; say so loudly.
      log(`[round ${r.id}] warning: ${player} joined on chain but not in the round: ${j.error}`);
      return { error: j.error };
    }
    record(m, { in: "join", player, callsign, bot: botIndex !== null, botIndex });
    return { txHash };
  } catch (e) {
    return { error: `joinFor failed: ${failReason(e)}` };
  } finally {
    m.pendingJoins.delete(player);
  }
}

/** Seconds since the round opened, never before the last processed tick. */
function roundT(m: RoundMatch): number {
  const raw = (Date.now() - m.round.openTime * 1000) / 1000;
  return Math.round(Math.max(raw, Math.max(m.round.k, 0) / 4) * 1000) / 1000;
}

function submitPrediction(m: RoundMatch, player: string, price: string): { ok: true } | { ok: false; error: string } {
  const r = m.round;
  if (Date.now() >= r.lockTime * 1000) return { ok: false, error: "round is locked" };
  const t = roundT(m);
  const out = r.predict(player, price, t);
  if (out.ok) record(m, { in: "predict", player: player.toLowerCase(), price, t });
  return out;
}

/**
 * The next protocol round opens when the current one locks (or at boot); markets rotate. Back to back it opens at the
 * previous lock time, so it locks one lockAfter later on a minute boundary. If it cannot open within PROTOCOL_LATE_MS
 * of that (the engine fell behind), it opens at now with its full join window: one fresh round, never a chain of
 * backdated catch-up rounds that lock (and cancel) as soon as they open. One call at a time; one createLobby at a time.
 */
async function openProtocolRound(openAt: number | null, pre: Promise<number | null> | null = null) {
  if (openingProtocol) return log("[round] a protocol round is already being opened");
  openingProtocol = true;
  try {
    const market = MARKETS[protocolCount++ % MARKETS.length];
    const spec = protocolSpec(market);
    for (;;) {
      try {
        const preId = pre ? await pre : null;
        pre = null;
        const chainId = preId ?? (await createProtocolLobby());
        const id = chainId ?? ++localId;
        const now = Date.now();
        let openTime = Math.floor(now / 1000);
        if (openAt !== null && now <= openAt * 1000 + PROTOCOL_LATE_MS) openTime = openAt;
        else if (openAt !== null) log(`[round ${id}] the previous protocol round locked ${Math.round((now - openAt * 1000) / 1000)} s ago; opening at now with the full join window`);
        protocolRound = openRound(id, spec, true, openTime, chain.on ? Math.min(PREDICT_BOTS, MAX_CHAIN_PROTOCOL_BOTS) : PREDICT_BOTS, null);
        return;
      } catch (e) {
        log(`[chain] protocol round createLobby failed, retrying in 10 s: ${failReason(e)}`);
        openAt = null;
        await sleep(10_000);
      }
    }
  } finally { openingProtocol = false; }
}

/**
 * START_LEAD_MS before the lock (joins closed at JOIN_CLOSE_MS), start the on-chain lobby with duration resolveAfter,
 * so its end time lands within seconds of the book's endTime (the workflow refuses more than 60 s apart). Queued
 * behind any joinFor still in flight. If it never lands, the round is cancelled and refunded.
 */
async function startRoundOnChain(m: RoundMatch) {
  const r = m.round;
  const late = () => Date.now() > r.lockTime * 1000 + START_LATE_MS;
  // Settling but before `final` still pays nobody: a start that lands that late is refunded too.
  const cancellable = () => r.status === "open" || r.status === "live" || (r.status === "settling" && !r.finalEvent);
  for (let n = 1; n <= 5 && !late(); n++) {
    try {
      m.startTx = await chain.start(r.id);
      m.chainError = null;
      log(`[round ${r.id}] chain start ${m.startTx}`);
      // The on-chain end would be too far past the book's for the workflow: refund instead.
      if (late() && cancellable()) r.cancel(`chain start landed more than ${START_LATE_MS / 1000} s after the lock`);
      return;
    } catch (e) {
      m.chainError = `start attempt ${n} failed: ${failReason(e)}`.slice(0, 500);
      log(`[round ${r.id}] ${m.chainError}`);
      if (r.status === "cancelled") return;
      await sleep(2000);
    }
  }
  if (cancellable()) r.cancel("chain start failed");
}

/** At the lock: the next protocol round opens; a cancelled round is cancelled on chain too, which refunds every entry. */
async function onRoundLocked(m: RoundMatch) {
  const r = m.round;
  if (chain.on && r.status === "live" && !m.startSent) { m.startSent = true; m.starting = startRoundOnChain(m); }
  if (m.round.protocol && protocolRound === m && PREDICT_ON && moreProtocolRounds()) void openProtocolRound(r.lockTime, m.nextLobby);
  if (!chain.on) return;
  await m.starting;
  if (r.status !== "cancelled") return;
  m.chainError = await cancelOnChain(r.id, r.cancelReason ?? "cancelled", m.logFile);
  log(`[round ${r.id}] ${m.chainError}`);
}

async function finishRound(m: RoundMatch) {
  m.finishing = true;
  const r = m.round;
  if (chain.on) {
    // Book vs escrow: a joinFor that timed out but landed, or a direct public join(), leaves the escrow with players
    // the book does not have. Nobody can be paid from such a book: cancel and refund instead of `final`.
    let l = null;
    for (let attempt = 1; !l; attempt++) {
      try { l = await chain.getLobby(r.id); } catch (e) { log(`[round ${r.id}] getLobby failed (attempt ${attempt}), retrying: ${failReason(e)}`); await sleep(5000); }
    }
    if (l.playerCount !== r.players.length || l.pot !== r.potUnits || l.entry !== r.entryUnits) {
      r.cancel(`escrow has ${l.playerCount} players and pot ${l.pot}, the book ${r.players.length} and ${r.potUnits}`);
      record(m, { in: "cancel", why: r.cancelReason });
      m.chainError = await cancelOnChain(r.id, r.cancelReason!, m.logFile);
      log(`[round ${r.id}] ${m.chainError}`);
      return;
    }
  }
  let price = r.mark!;
  if (PRICE_URL) {
    const S = settlementMinute(r.endTime);
    const wait = (S + 120) * 1000 - Date.now();
    if (wait > 0) {
      log(`[round ${r.id}] waiting ${Math.ceil(wait / 1000)}s for the settlement candle at ${S}`);
      await sleep(wait + 1500);
    }
    for (let attempt = 1; ; attempt++) {
      try { price = (await fetchSettlementMarks(PRICE_URL, r.endTime))[r.market]; break; } catch (e) {
        log(`[round ${r.id}] settlement candle attempt ${attempt} failed: ${failReason(e)}`);
        if (!chain.on && attempt >= 6) { log(`[round ${r.id}] CHAIN=off: falling back to the last live mark`); break; }
        await sleep(5000);
      }
    }
  }
  // A start still in flight may cancel the round (it landed too late); onRoundLocked refunds it, nobody is paid.
  await m.starting;
  if (r.status === "cancelled") return;
  const pot = chain.on ? await onchainPot(r.id) : r.potUnits;
  if (pot !== r.potUnits) log(`[round ${r.id}] warning: on-chain pot ${pot} != engine pot ${r.potUnits}; final and report use the on-chain pot`);
  record(m, { in: "final", settlementPrice: price, potUnits: pot.toString() });
  r.emitFinal(price, pot);
  if (chain.on) {
    // buildReport takes the {BTC, ETH, SOL} map and reads the round's market from it.
    const marks = { BTC: price, ETH: price, SOL: price } as Prices;
    await settle(m, r, marks, pot).catch((e) => { m.chainError = `settle: ${failReason(e)}`.slice(0, 500); log(`[round ${r.id}] ${m.chainError}`); });
  }
}

function roundsLoop() {
  for (const m of rounds.values()) {
    const r = m.round;
    let done = false;
    if (r.status === "open" || r.status === "live") {
      if (chain.on && !m.startSent && r.status === "open" && Date.now() >= r.lockTime * 1000 - START_LEAD_MS) {
        m.startSent = true;
        if (r.players.length + m.pendingJoins.size >= 4) m.starting = startRoundOnChain(m);
      }
      if (chain.on && PREDICT_ON && m === protocolRound && !m.nextLobby && !protocolCreate && moreProtocolRounds() && Date.now() >= r.lockTime * 1000 - PRECREATE_MS) {
        m.nextLobby = createProtocolLobby().catch((e) => {
          log(`[chain] early createLobby for the next protocol round failed: ${failReason(e)}`);
          return null;
        });
      }
      done = m.driver.advance();
    }
    // Locked, or cancelled at or before the lock (a failed on-chain start): open the next protocol round, refund.
    if (!m.locked && (r.k >= r.lockK || r.status === "cancelled")) { m.locked = true; void onRoundLocked(m); }
    if (done && !m.finishing) {
      persistBook(r.id, r.freezeBook(books.get(r.id)));
      void finishRound(m);
    }
  }
}

/** POST /rounds body -> a validated spec, or an error. */
function parseRoundParams(p: any): { spec: RoundSpec; signed: CreateRoundParams } | string {
  if (!p || typeof p !== "object") return "params must be an object";
  if (typeof p.creator !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(p.creator)) return "params.creator must be an address";
  const entry = String(p.entryUnits ?? "");
  if (!/^\d{1,20}$/.test(entry)) return "params.entryUnits must be an integer string";
  const signed: CreateRoundParams = {
    creator: p.creator.toLowerCase(), market: p.market, entryUnits: entry, maxPlayers: p.maxPlayers, lockAfter: p.lockAfter,
    resolveAfter: p.resolveAfter, winnerBps: p.winnerBps, split: p.split, creatorFeeBps: p.creatorFeeBps,
  };
  const spec: RoundSpec = {
    creator: signed.creator, market: p.market, entryUnits: BigInt(entry), maxPlayers: p.maxPlayers, lockAfter: p.lockAfter,
    resolveAfter: p.resolveAfter, winnerBps: p.winnerBps, split: p.split, creatorFeeBps: p.creatorFeeBps,
  };
  const err = checkUserSpec(spec);
  return err ?? { spec, signed };
}

async function createUserRound(body: any): Promise<[number, unknown]> {
  const parsed = parseRoundParams(body?.params);
  if (typeof parsed === "string") return [400, { error: parsed }];
  const { spec, signed } = parsed;
  if (!/^\d{1,30}$/.test(String(body.nonce))) return [400, { error: "nonce must be a non-negative integer" }];
  const nonce = BigInt(body.nonce);
  const creator = spec.creator!;
  if (nonce <= (creatorNonces.get(creator) ?? -1n)) return [400, { error: "nonce must increase" }];
  if (!SIG_OFF && !(await verifyCreateRound(signed, String(body.nonce), body.signature))) return [401, { error: "bad signature" }];
  if (nonce <= (creatorNonces.get(creator) ?? -1n)) return [400, { error: "nonce must increase" }];
  const openUser = [...rounds.values()].filter((x) => !x.round.protocol && x.round.status === "open");
  if (creating.has(creator) || openUser.some((x) => x.round.spec.creator === creator)) return [429, { error: "this creator already has an open round" }];
  if (openUser.length + creating.size >= MAX_USER_ROUNDS) return [429, { error: `${MAX_USER_ROUNDS} user rounds are already open` }];
  saveCreatorNonce(creator, nonce);
  creating.add(creator);
  let made: Awaited<ReturnType<typeof chain.createRound>>;
  try { made = await chain.createRound(spec.resolveAfter, spec.entryUnits, spec.maxPlayers, creator, spec.creatorFeeBps); } finally { creating.delete(creator); }
  const id = made?.id ?? ++localId;
  const m = openRound(id, spec, false, Math.floor(Date.now() / 1000), 0, made?.txHash ?? null);
  log(`[round ${id}] user round by ${creator}: ${spec.market} entry ${spec.entryUnits} max ${spec.maxPlayers} winners ${spec.winnerBps} ${spec.split} creator fee ${spec.creatorFeeBps}`);
  return [200, { lobbyId: id, txHash: made?.txHash ?? null, lockTime: m.round.lockTime, endTime: m.round.endTime }];
}

/** GET /rounds: open rounds (protocol first, then user rounds by lock time), plus live and recent ones for the arena. */
function listRounds() {
  const all = [...rounds.values()].map((m) => m.round);
  const order = (a: PredictRound, b: PredictRound) => (a.protocol !== b.protocol ? (a.protocol ? -1 : 1) : a.lockTime - b.lockTime || a.id - b.id);
  const open = all.filter((r) => r.status === "open").sort(order);
  const active = all.filter((r) => r.status === "live" || r.status === "settling").sort(order);
  const recent = all.filter((r) => r.status === "settled" || r.status === "cancelled" || (r.status === "settling" && r.finalEvent))
    .sort((a, b) => b.endTime - a.endTime).slice(0, 10);
  const withMark = (r: PredictRound) => ({ ...r.summary(), mark: prices.current()?.[r.market] ?? r.mark });
  return { protocol: protocolRound?.round.id ?? null, rounds: open.map(withMark), active: active.map(withMark), recent: recent.map(withMark) };
}

/**
 * Rounds are not replayed after a restart. Any round whose log has no settled or cancelled event is closed out:
 * a round that already reached `final` is settled from its stored book; any other is marked cancelled (a cancelled
 * event appended to its log) and, with the chain on, cancelled on chain so every entry is refunded. A round whose log
 * has `cancelled` but no `cancel-done` is cancelled on chain again if the escrow still says Open or Live.
 */
async function recoverRounds() {
  const files = readdirSync(DATA).filter((f) => /^round-\d+\.jsonl$/.test(f));
  for (const f of files) {
    const id = Number(/\d+/.exec(f)![0]);
    const file = resolve(DATA, f);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    if (lines.some((x) => x.type === "settled")) continue;
    if (lines.some((x) => x.type === "cancelled")) {
      // Cancelled here, but the on-chain cancel never confirmed (gave up, or the engine stopped first): try again.
      if (chain.on && !lines.some((x) => x.in === "cancel-done")) {
        const reason = lines.find((x) => x.type === "cancelled")?.reason ?? "cancelled";
        log(`[round ${id}] restart: cancelled before the restart, cancel not confirmed on chain; retrying`);
        log(`[round ${id}] ${await cancelOnChain(id, reason, file)}`);
      }
      continue;
    }
    const final = lines.find((x) => x.type === "final");
    const fin = lines.find((x) => x.in === "final");
    const book = books.get(id);
    const m = { chainError: null as string | null };
    if (final && fin && book) {
      if (!chain.on) continue; // finished; nothing to pay with CHAIN=off
      log(`[round ${id}] restart: reached final before the restart, settling from the stored book`);
      const price = final.settlementPrice as string;
      const target = {
        id, markSettled: (txHash: string, mode: "deployed" | "simulated", via: SettleVia, winners: string[], amounts: string[]) =>
          appendFileSync(file, JSON.stringify({ type: "settled", lobbyId: id, txHash, mode, via, winners, amounts }) + "\n"),
      };
      await settle(m, target, { BTC: price, ETH: price, SOL: price }, BigInt(fin.potUnits))
        .catch((e) => log(`[round ${id}] restart settle failed: ${failReason(e)}`));
      continue;
    }
    const reason = "engine restarted mid-round";
    appendFileSync(file, JSON.stringify({ type: "cancelled", lobbyId: id, reason }) + "\n");
    log(`[round ${id}] restart: cancelled (${reason})`);
    if (chain.on) log(`[round ${id}] ${await cancelOnChain(id, reason, file)}`);
  }
}

// ---------- replay a crashed match from its log
function resume(): Match | null {
  const files = readdirSync(DATA).filter((f) => /^lobby-\d+\.jsonl$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const last = files.pop();
  if (!last) return null;
  const inputs = readFileSync(resolve(DATA, last), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.in);
  const create = inputs.find((x) => x.in === "create");
  if (!create || inputs.some((x) => x.in === "final" || x.in === "cancel")) return null; // finished: its book is served from disk
  const m = newMatch(create.id, PRESETS[create.preset as Preset["name"]], create.seed, 0);
  localId = Math.max(localId, create.id);
  const l = m.lobby;
  l.emitLobby();
  for (const x of inputs) {
    if (x.in === "join") { l.join(x.player, x.callsign, x.bot); if (x.bot) m.bots.add(x.player.toLowerCase(), x.botIndex); }
    else if (x.in === "countdown") l.countdown(x.startsAt);
    else if (x.in === "tick") { if (l.status === "countdown") l.start(); l.step(x.k, x.marks); m.bots.act(l, x.marks, x.k / 4); }
    else if (x.in === "order") { l.order(x.player, x.order, x.marks, x.t); const p = l.find(x.player); if (p) p.lastNonce = BigInt(x.nonce); }
  }
  wire(m);
  current = m;
  log(`[lobby ${l.id}] resumed from ${last} at tick ${l.k} (${l.status})`);
  if (l.status === "open") scheduleCountdown(m, Date.now() + OPEN_S * 1000);
  else if (l.status === "countdown") scheduleChainStart(m);
  else if (l.status === "settling" && !m.finishing) {
    m.finishing = true;
    persistBook(l.id, l.freezeBook(books.get(l.id)));
    finish(m);
  }
  return m;
}

// ---------- HTTP
function send(res: ServerResponse, code: number, body: unknown, raw = false) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
  res.end(raw ? (body as string) : JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
async function readJson(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const chunk of req) { s += chunk; if (s.length > 1e5) throw new Error("body too large"); }
  return JSON.parse(s || "{}");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "OPTIONS") return send(res, 204, "", true);
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, chain: chain.on, current: current?.lobby.id ?? null, protocolRound: protocolRound?.round.id ?? null, priceAgeMs: prices.ageMs(Date.now()) });
    if (req.method === "GET" && url.pathname === "/lobbies") {
      return send(res, 200, { current: current?.lobby.id ?? null, lobbies: [...matches.values()].map((m) => ({ lobbyId: m.lobby.id, status: m.lobby.status, players: m.lobby.players.length, startsAt: m.lobby.startsAt })) });
    }
    if (parts[0] === "lobbies" && parts[1]) {
      const id = parts[1] === "current" ? current?.lobby.id ?? -1 : Number(parts[1]);
      if (req.method === "GET" && parts[2] === "final" && parts.length === 3) {
        const book = books.get(id) ?? matches.get(id)?.lobby.bookJson;
        return book ? send(res, 200, book, true) : send(res, 404, { error: "no final book yet" });
      }
      const rm = rounds.get(id);
      if (rm) {
        if (req.method === "GET" && parts.length === 2) {
          return send(res, 200, { ...rm.round.snapshot(), mark: prices.current()?.[rm.round.market] ?? rm.round.mark, now: Date.now(), pricesStale: prices.ageMs(Date.now()) > STALE_MS, chainError: rm.chainError, createTx: rm.createTx, startTx: rm.startTx });
        }
        if (req.method === "POST" && parts[2] === "join" && parts.length === 3) {
          const body = await readJson(req);
          const player = String(body.player ?? "").toLowerCase();
          const callsign = String(body.callsign ?? "");
          if (!/^0x[0-9a-f]{40}$/.test(player)) return send(res, 400, { error: "player must be an address" });
          if (!callsign.trim() || callsign.length > 24) return send(res, 400, { error: "callsign must be 1 to 24 characters" });
          if (!SIG_OFF && !(await verifyJoin(id, player, callsign, body.signature))) return send(res, 401, { error: "bad signature" });
          const r = await joinRound(rm, player, callsign, null);
          return "error" in r ? send(res, 400, r) : send(res, 200, r);
        }
        return send(res, 404, { error: "not found" });
      }
      const m = matches.get(id);
      if (!m) return send(res, 404, { error: "no such lobby" });
      if (req.method === "GET" && parts.length === 2) {
        return send(res, 200, { ...m.lobby.snapshot(), now: Date.now(), pricesStale: prices.ageMs(Date.now()) > STALE_MS, chainError: m.chainError, startTx: m.startTx });
      }
      if (req.method === "POST" && parts[2] === "join" && parts.length === 3) {
        const body = await readJson(req);
        const player = String(body.player ?? "").toLowerCase();
        const callsign = String(body.callsign ?? "");
        if (!/^0x[0-9a-f]{40}$/.test(player)) return send(res, 400, { error: "player must be an address" });
        if (!callsign.trim() || callsign.length > 24) return send(res, 400, { error: "callsign must be 1 to 24 characters" });
        if (!SIG_OFF && !(await verifyJoin(m.lobby.id, player, callsign, body.signature))) return send(res, 401, { error: "bad signature" });
        const r = await join(m, player, callsign, null);
        return "error" in r ? send(res, 400, r) : send(res, 200, r);
      }
    }
    if (req.method === "GET" && url.pathname === "/rounds") return send(res, 200, listRounds());
    // Lobbies and rounds that reached `final` and are not settled yet: what `npm run cre-settler` settles.
    if (req.method === "GET" && url.pathname === "/settlements/pending") {
      const pending = [
        ...[...matches.values()].filter((m) => m.lobby.status === "settling" && m.lobby.finalEvent).map((m) => ({ lobbyId: m.lobby.id, mode: "royale", endTime: m.lobby.endTime })),
        ...[...rounds.values()].filter((m) => m.round.status === "settling" && m.round.finalEvent).map((m) => ({ lobbyId: m.round.id, mode: "predict", endTime: m.round.endTime })),
      ].sort((a, b) => a.lobbyId - b.lobbyId);
      return send(res, 200, { chain: chain.on ? process.env.CHAIN : "off", escrow: chain.on ? ESCROW : null, settleMode: SETTLE_MODE, pending });
    }
    if (req.method === "GET" && url.pathname === "/marks") return send(res, 200, { marks: prices.current(), stale: prices.ageMs(Date.now()) > STALE_MS, now: Date.now() });
    if (req.method === "POST" && url.pathname === "/rounds") {
      const [code, out] = await createUserRound(await readJson(req));
      return send(res, code, out);
    }
    if (req.method === "POST" && url.pathname === "/predictions") {
      const body = await readJson(req);
      if (!Number.isInteger(body?.lobbyId)) return send(res, 400, { error: "lobbyId must be an integer" });
      const rm = rounds.get(body.lobbyId);
      if (!rm) return send(res, 404, { error: "no such round" });
      const player = String(body.player ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(player)) return send(res, 400, { error: "player must be an address" });
      const price = body.price;
      if (typeof price !== "string" || !/^\d{1,12}\.\d{2}$/.test(price)) return send(res, 400, { error: "price must be a positive 2-decimal string" });
      if (!/^\d{1,30}$/.test(String(body.nonce))) return send(res, 400, { error: "nonce must be a non-negative integer" });
      // ts is not part of the signed message; checked like an order's when present.
      if (body.ts !== undefined && (!Number.isInteger(body.ts) || Math.abs(Date.now() - body.ts) > 30_000)) return send(res, 400, { error: "ts is more than 30 s from server time" });
      if (!rm.round.find(player)) return send(res, 400, { error: "join the round first" });
      const nonce = BigInt(body.nonce);
      const last = () => rm.round.lastNonce.get(player) ?? -1n;
      if (nonce <= last()) return send(res, 400, { error: "nonce must increase" });
      if (!SIG_OFF && !(await verifyPrediction(rm.round.id, player, price, String(body.nonce), body.signature))) return send(res, 401, { error: "bad signature" });
      if (nonce <= last()) return send(res, 400, { error: "nonce must increase" });
      const out = submitPrediction(rm, player, price);
      if (!out.ok) return send(res, 400, { error: out.error });
      rm.round.lastNonce.set(player, nonce);
      return send(res, 200, { ok: true, count: rm.round.predictedCount, price });
    }
    if (req.method === "POST" && url.pathname === "/orders") {
      const r = parseOrderRequest(await readJson(req));
      if (typeof r === "string") return send(res, 400, { error: r });
      const m = matches.get(r.lobbyId);
      if (!m) return send(res, 404, { error: "no such lobby" });
      const now = Date.now();
      if (m.lobby.endTime !== null && now >= m.lobby.endTime * 1000) return send(res, 400, { error: "match has ended" });
      if (Math.abs(now - r.ts) > 30_000) return send(res, 400, { error: "ts is more than 30 s from server time" });
      const p = m.lobby.find(r.player);
      if (!p) return send(res, 400, { error: "unknown player" });
      if (BigInt(r.nonce) <= p.lastNonce) return send(res, 400, { error: "nonce must increase" });
      if (!SIG_OFF && !(await verifyOrder(r))) return send(res, 401, { error: "bad signature" });
      // Re-check after the await: another order with the same nonce may have landed meanwhile.
      if (BigInt(r.nonce) <= p.lastNonce) return send(res, 400, { error: "nonce must increase" });
      if (Date.now() >= (m.lobby.endTime ?? Infinity) * 1000) return send(res, 400, { error: "match has ended" });
      if (prices.ageMs(now) > STALE_MS) return send(res, 503, { error: "prices are stale; orders paused" });
      const marks = m.driver.marks();
      if (!marks) return send(res, 503, { error: "no prices yet" });
      const t = m.driver.fillT();
      const out = m.lobby.order(r.player, r.order as Order, marks, t);
      if (!out.ok) return send(res, 400, { error: out.error });
      if (BigInt(r.nonce) > p.lastNonce) p.lastNonce = BigInt(r.nonce);
      record(m, { in: "order", player: r.player, nonce: String(r.nonce), order: r.order, marks, t });
      return send(res, 200, { ok: true, t, price: marks[r.order.market] });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 400, { error: failReason(e) });
  }
});

const wss = new WebSocketServer({ noServer: true });
const markClients = new Set<WebSocket>();
setInterval(() => {
  if (!markClients.size) return;
  const line = JSON.stringify({ type: "marks", marks: prices.current(), at: Date.now() });
  for (const c of markClients) if (c.readyState === c.OPEN) c.send(line);
}, 250);
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/ws") return socket.destroy();
  const q = url.searchParams.get("lobby");
  if (url.searchParams.get("feed") === "marks") {
    // Live marks for the predict screen before the lock (no lobby events carry a price until then).
    return wss.handleUpgrade(req, socket, head, (ws) => { markClients.add(ws); ws.on("close", () => markClients.delete(ws)); });
  }
  const rm = q ? rounds.get(Number(q)) : null;
  if (rm) {
    return wss.handleUpgrade(req, socket, head, (ws) => {
      rm.clients.add(ws);
      ws.on("close", () => rm.clients.delete(ws));
      for (const e of rm.round.catchUp()) ws.send(JSON.stringify(e));
    });
  }
  const m = q ? matches.get(Number(q)) : current;
  if (!m) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    m.clients.add(ws);
    ws.on("close", () => m.clients.delete(ws));
    // Catch up a reloaded client with the latest state.
    const l = m.lobby;
    for (const e of [l.lastLobby, l.lastTick, l.lastBoard, l.finalEvent, l.settledEvent] as (EngineEvent | null)[]) if (e) ws.send(JSON.stringify(e));
  });
});

server.listen(PORT, async () => {
  log(`engine on :${PORT} royale=${ROYALE_ON} predict=${PREDICT_ON} predictBots=${PREDICT_BOTS} preset=${preset.name} bots=${N_BOTS} chain=${chain.on ? process.env.CHAIN : "off"} settle=${chain.on ? SETTLE_MODE : "-"} priceSource=${PRICE_URL ? "coinbase-candles" : "last-live-mark"} sig=${SIG_OFF ? "off" : "on"}`);
  setInterval(loop, 20);
  void recoverRounds().catch((e) => log(`round recovery failed: ${failReason(e)}`));
  if (PREDICT_ON) void openProtocolRound(null);
  if (ROYALE_ON && !(args.resume && resume())) await createLobbyRetrying();
});
