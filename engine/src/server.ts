// Live engine: real clock, exchange prices, HTTP + WebSocket, bots, relayer, append-only log per lobby.
// npm run dev -- --bots 20 --preset stage [--port 8787] [--open 15] [--countdown 10] [--seed S] [--loop] [--resume]
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { Lobby } from "./lobby.ts";
import { Bots, botAddress, botCallsign } from "./bots.ts";
import { CoinbaseFeed, FallbackPrices, KrakenFeed, fetchSettlementMarks, settlementMinute, type PriceSource } from "./prices.ts";
import { Driver, realClock } from "./driver.ts";
import { makeChain } from "./chain.ts";
import { parseOrderRequest, verifyOrder } from "./orders.ts";
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
const DATA = resolve(import.meta.dirname, "../data");
mkdirSync(DATA, { recursive: true });

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const chain = makeChain(process.env, log);
const prices: PriceSource = new FallbackPrices(new CoinbaseFeed(log).start()!, new KrakenFeed(log).start()!);

// ---------- matches
type Match = { lobby: Lobby; driver: Driver; bots: Bots; seed: number; nBots: number; logFile: string; clients: Set<WebSocket>; finishing: boolean; pendingJoins: Set<string> };
const matches = new Map<number, Match>();
let current: Match | null = null;
let localId = 0;

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
  const m: Match = { lobby, driver, bots, seed, nBots, logFile: resolve(DATA, `lobby-${id}.jsonl`), clients: new Set(), finishing: false, pendingJoins: new Set() };
  // Ticks are inputs too: record the marks each one used so a crash can be replayed.
  driver.onTick = (k, marks) => record(m, { in: "tick", k, marks });
  driver.onStart = () => {
    chain.start(id).catch((e) => log(`[chain] start ${id} failed: ${e.message}`));
  };
  matches.set(id, m);
  return m;
}

async function createLobby(): Promise<Match> {
  const chainId = await chain.createLobby(preset.duration, ENTRY_UNITS, MAX_PLAYERS);
  const id = chainId ?? ++localId;
  localId = Math.max(localId, id);
  const m = newMatch(id, preset, SEED + id, N_BOTS);
  // A fresh run reusing an id keeps the old log beside it rather than appending to it.
  if (existsSync(m.logFile)) renameSync(m.logFile, m.logFile.replace(/\.jsonl$/, `.${Date.now()}.jsonl.old`));
  record(m, { in: "create", id, preset: preset.name, seed: m.seed, maxPlayers: MAX_PLAYERS });
  wire(m);
  m.lobby.emitLobby();
  current = m;
  for (let i = 0; i < N_BOTS; i++) {
    const addr = botAddress(m.seed, i);
    const r = await join(m, addr, botCallsign(i), true);
    if ("error" in r) log(`[lobby ${id}] bot ${i} could not join: ${r.error}`);
    else m.bots.add(addr, i);
  }
  scheduleCountdown(m, Date.now() + OPEN_S * 1000);
  return m;
}

async function join(m: Match, player: string, callsign: string, bot: boolean): Promise<{ txHash: string | null } | { error: string }> {
  player = player.toLowerCase();
  const l = m.lobby;
  if (l.status !== "open") return { error: `lobby is ${l.status}` };
  if (l.find(player) || m.pendingJoins.has(player)) return { error: "already joined" };
  if (l.players.length + m.pendingJoins.size >= l.maxPlayers) return { error: "lobby is full" };
  if (!/^0x[0-9a-f]{40}$/.test(player)) return { error: "player must be an address" };
  if (!String(callsign ?? "").trim()) return { error: "callsign required" };
  m.pendingJoins.add(player);
  try {
    const txHash = await chain.joinFor(l.id, player);
    const r = l.join(player, callsign, bot);
    if (!r.ok) return { error: r.error };
    record(m, { in: "join", player, callsign, bot });
    return { txHash };
  } catch (e) {
    return { error: `joinFor failed: ${(e as Error).message}` };
  } finally {
    m.pendingJoins.delete(player);
  }
}

function scheduleCountdown(m: Match, at: number) {
  const check = () => {
    const l = m.lobby;
    if (l.status !== "open") return;
    if (Date.now() < at || l.players.length < 4 || m.pendingJoins.size || !prices.current()) return void setTimeout(check, 500);
    const startsAt = Math.ceil(Date.now() / 1000) + COUNTDOWN_S;
    l.countdown(startsAt);
    record(m, { in: "countdown", startsAt });
  };
  check();
}

// ---------- the clock
function loop() {
  for (const m of matches.values()) {
    const l = m.lobby;
    if (l.status !== "countdown" && l.status !== "live") continue;
    const done = m.driver.advance();
    if (done && !m.finishing) finish(m);
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
    for (let attempt = 1; attempt <= 6; attempt++) {
      try { marks = await fetchSettlementMarks(PRICE_URL, l.endTime!); break; } catch (e) {
        log(`[lobby ${l.id}] settlement candle attempt ${attempt} failed: ${(e as Error).message}`);
        if (attempt === 6) log(`[lobby ${l.id}] falling back to the last live mark`);
        else await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  record(m, { in: "final", marks });
  l.finalize(marks);
  if (args.loop && current === m) setTimeout(() => createLobby().catch((e) => log(`create failed: ${e.message}`)), 5000);
}

// ---------- replay a crashed match from its log
function resume(): Match | null {
  const files = readdirSync(DATA).filter((f) => /^lobby-\d+\.jsonl$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const last = files.pop();
  if (!last) return null;
  const inputs = readFileSync(resolve(DATA, last), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.in);
  const create = inputs.find((x) => x.in === "create");
  if (!create || inputs.some((x) => x.in === "final")) return null;
  const m = newMatch(create.id, PRESETS[create.preset as Preset["name"]], create.seed, 0);
  localId = Math.max(localId, create.id);
  const l = m.lobby;
  l.emitLobby();
  let botIndex = 0;
  for (const x of inputs) {
    if (x.in === "join") { l.join(x.player, x.callsign, x.bot); if (x.bot) m.bots.add(x.player.toLowerCase(), botIndex++); }
    else if (x.in === "countdown") l.countdown(x.startsAt);
    else if (x.in === "tick") { if (l.status === "countdown") l.start(); l.step(x.k, x.marks); m.bots.act(l, x.marks, x.k / 4); }
    else if (x.in === "order") { l.order(x.player, x.order, x.marks, x.t); const p = l.find(x.player); if (p) p.lastNonce = BigInt(x.nonce); }
  }
  wire(m);
  current = m;
  log(`[lobby ${l.id}] resumed from ${last} at tick ${l.k} (${l.status})`);
  if (l.status === "open") scheduleCountdown(m, Date.now() + OPEN_S * 1000);
  else if (l.status === "settling" && !m.finishing) finish(m);
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
      const m = matches.get(parts[1] === "current" ? current?.lobby.id ?? -1 : Number(parts[1]));
      if (!m) return send(res, 404, { error: "no such lobby" });
      if (req.method === "GET" && parts.length === 2) return send(res, 200, { ...m.lobby.snapshot(), now: Date.now(), pricesStale: prices.ageMs(Date.now()) > STALE_MS });
      if (req.method === "GET" && parts[2] === "final" && parts.length === 3) {
        return m.lobby.bookJson ? send(res, 200, m.lobby.bookJson, true) : send(res, 404, { error: "no final book yet" });
      }
      if (req.method === "POST" && parts[2] === "join" && parts.length === 3) {
        const body = await readJson(req);
        const r = await join(m, String(body.player ?? ""), String(body.callsign ?? ""), false);
        return "error" in r ? send(res, 400, r) : send(res, 200, r);
      }
    }
    if (req.method === "POST" && url.pathname === "/orders") {
      const r = parseOrderRequest(await readJson(req));
      if (typeof r === "string") return send(res, 400, { error: r });
      const m = matches.get(r.lobbyId);
      if (!m) return send(res, 404, { error: "no such lobby" });
      const now = Date.now();
      if (Math.abs(now - r.ts) > 30_000) return send(res, 400, { error: "ts is more than 30 s from server time" });
      const p = m.lobby.find(r.player);
      if (!p) return send(res, 400, { error: "unknown player" });
      if (BigInt(r.nonce) <= p.lastNonce) return send(res, 400, { error: "nonce must increase" });
      if (!SIG_OFF && !(await verifyOrder(r))) return send(res, 401, { error: "bad signature" });
      if (prices.ageMs(now) > STALE_MS) return send(res, 503, { error: "prices are stale; orders paused" });
      const marks = m.driver.marks();
      if (!marks) return send(res, 503, { error: "no prices yet" });
      const t = m.driver.fillT();
      const out = m.lobby.order(r.player, r.order as Order, marks, t);
      if (!out.ok) return send(res, 400, { error: out.error });
      p.lastNonce = BigInt(r.nonce);
      record(m, { in: "order", player: r.player, nonce: String(r.nonce), order: r.order, marks, t });
      return send(res, 200, { ok: true, t, price: marks[r.order.market] });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
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
  if (!(args.resume && resume())) await createLobby();
});
