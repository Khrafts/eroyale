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
import { Driver, realClock } from "./driver.ts";
import { LOBBY_SETTLED, failReason, makeChain, redact } from "./chain.ts";
import { buildReport } from "../../workflow/src/report.ts";
import { parseOrderRequest, verifyJoin, verifyOrder } from "./orders.ts";
import { ENTRY_UNITS, PRESETS, type EngineEvent, type Order, type Preset, type Prices } from "./types.ts";

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

const BOT_RETRY_MS = 3000; // retry a bot whose joinFor failed this often while joins are open
const JOIN_CLOSE_MS = 7000; // joins close this long before startsAt
const START_LEAD_MS = 6000; // first on-chain start() this long before startsAt, so the chain end lands near the book's
const START_DEADLINE_MS = 1500; // no new start attempt after startsAt minus this; cancel instead
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
if (SETTLE_MODE !== "simulated" && SETTLE_MODE !== "deployed") throw new Error(`SETTLE_MODE must be simulated or deployed, got ${SETTLE_MODE}`);
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
for (const f of readdirSync(DATA)) { const mm = /^lobby-(\d+)\./.exec(f); if (mm) localId = Math.max(localId, Number(mm[1])); }
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

const record = (m: Match, line: unknown) => appendFileSync(m.logFile, JSON.stringify(line) + "\n");

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
    const txHash = await chain.joinFor(l.id, player);
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
 * then on chain, which refunds every entry).
 */
function scheduleChainStart(m: Match) {
  if (!chain.on) return;
  const l = m.lobby;
  const attempt = async (n: number) => {
    if (l.status === "cancelled" || m.startTx) return;
    try {
      m.startTx = await chain.start(l.id);
      m.chainError = null;
      log(`[lobby ${l.id}] chain start ${m.startTx}`);
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
  if (chain.on) await settle(m, marks, pot).catch((e) => { m.chainError = `settle: ${failReason(e)}`.slice(0, 500); log(`[lobby ${l.id}] ${m.chainError}`); });
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
 * on-chain end, owner calls settleFallback. deployed: the CRE workflow writes the report; we watch for Settled.
 * Retries every 5 s; gives up when one failure reason repeats.
 */
async function settle(m: Match, marks: Prices, pot: bigint) {
  const l = m.lobby;
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
  const r = buildReport(new TextEncoder().encode(book), marks, pot, FEE_BPS, BigInt(CHAIN_SELECTOR), {
    creator: onchain.creator, creatorFeeBps: onchain.creatorFeeBps, entry: onchain.entry, playerCount: onchain.playerCount,
  });
  if (BigInt(r.lobbyId) !== BigInt(l.id)) throw new Error(`book lobbyId ${r.lobbyId} != ${l.id}`);
  const done = (hash: string) => {
    m.chainError = null;
    l.markSettled(hash, SETTLE_MODE as "simulated" | "deployed", r.winners, r.amounts.map(String));
    log(`[lobby ${l.id}] settled (${SETTLE_MODE}) ${hash}`);
  };
  if (SETTLE_MODE === "deployed") {
    // Triggering the deployed workflow's HTTP trigger needs a signed gateway request that contracts/NOTES.md does
    // not document, so it is not wired: the workflow must be triggered outside the engine. We only watch for it.
    log(`[lobby ${l.id}] SETTLE_MODE=deployed: CRE trigger not wired; trigger royale-settle with {"lobbyId": ${l.id}} and the engine will pick up Settled`);
    const deadline = Date.now() + DEPLOYED_SETTLE_WAIT_MS;
    while (Date.now() < deadline) {
      const hash = await chain.findSettled(l.id, 5_000n).catch(() => null);
      if (hash) return done(hash);
      await sleep(10_000);
    }
    m.chainError = `no Settled log within ${DEPLOYED_SETTLE_WAIT_MS / 60_000} min; settle by hand (contracts/NOTES.md)`;
    log(`[lobby ${l.id}] ${m.chainError}`);
    return;
  }
  if (onchain.status === LOBBY_SETTLED) {
    const hash = await chain.findSettled(l.id, 50_000n);
    if (hash) return done(hash);
    throw new Error("escrow says settled but no Settled log found");
  }
  for (;;) {
    const now = await chain.blockTime();
    if (now > onchain.endTime) break;
    log(`[lobby ${l.id}] block time ${now} not past on-chain end ${onchain.endTime}; waiting`);
    await sleep(Math.min(Number(onchain.endTime - now) + 2, 10) * 1000);
  }
  let last = "";
  for (let attempt = 1; attempt <= 10; attempt++) {
    try { return done(await chain.settleFallback(r.report)); } catch (e) {
      // The tx may have landed even though this call failed (dropped receipt, RPC error): pick it up instead of retrying.
      const now = await chain.getLobby(l.id).catch(() => null);
      if (now?.status === LOBBY_SETTLED) {
        const hash = await chain.findSettled(l.id, 50_000n).catch(() => null);
        if (hash) return done(hash);
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
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, chain: chain.on, current: current?.lobby.id ?? null, priceAgeMs: prices.ageMs(Date.now()) });
    if (req.method === "GET" && url.pathname === "/lobbies") {
      return send(res, 200, { current: current?.lobby.id ?? null, lobbies: [...matches.values()].map((m) => ({ lobbyId: m.lobby.id, status: m.lobby.status, players: m.lobby.players.length, startsAt: m.lobby.startsAt })) });
    }
    if (parts[0] === "lobbies" && parts[1]) {
      const id = parts[1] === "current" ? current?.lobby.id ?? -1 : Number(parts[1]);
      if (req.method === "GET" && parts[2] === "final" && parts.length === 3) {
        const book = books.get(id) ?? matches.get(id)?.lobby.bookJson;
        return book ? send(res, 200, book, true) : send(res, 404, { error: "no final book yet" });
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
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/ws") return socket.destroy();
  const q = url.searchParams.get("lobby");
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
  log(`engine on :${PORT} preset=${preset.name} bots=${N_BOTS} chain=${chain.on ? process.env.CHAIN : "off"} priceSource=${PRICE_URL ? "coinbase-candles" : "last-live-mark"} sig=${SIG_OFF ? "off" : "on"}`);
  setInterval(loop, 20);
  if (!(args.resume && resume())) await createLobbyRetrying();
});
