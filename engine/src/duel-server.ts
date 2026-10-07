// Stickman Duel in the live engine (CLAUDE.md "Stickman Duel > Engine"): queue, pairing, the free bot fight, the
// 60 Hz authoritative loop, WS /ws?duel=:id, the book at GET /duels/:id/final, on-chain flow on DuelEscrow and
// settlement. Mounted by server.ts, sharing its chain client (one tx queue, local nonces), stats and data dir.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { keccak256, toBytes, type Hex } from "viem";
import type { WebSocket, WebSocketServer } from "ws";
import { DUEL_CANCELLED, DUEL_LIVE, DUEL_OPEN, DUEL_SETTLED, failReason, type Chain, type DuelChain } from "./chain.ts";
import { DUEL_STAKE_UNITS, DuelMatch, type DuelPlayer } from "./duel.ts";
import { verifyDuelQueue } from "./orders.ts";
import type { Stats } from "./stats.ts";
import type { EngineEvent, SettleVia } from "./types.ts";

export const BOT_OFFER_MS = 10_000; // a player alone this long may take a free bot fight
const COUNTDOWN_S = 3; // matched -> live, so both phones are on the WebSocket before tick 0
const TICK_HZ = 60;
const TICKET_IDLE_MS = 30_000; // a waiting ticket nobody polled for this long leaves the queue
const JOIN_WINDOW_MS = 120_000; // a ranked duel's on-chain joins must land within this of the pairing
const KEEP_FINISHED = 100; // finished duels kept in memory; older ones are served from their log
const DEPLOYED_SETTLE_WAIT_MS = 15 * 60_000;
const HOUSE_BOT_LEVEL = 2;
export const HOUSE_BOT = ("0x" + keccak256(toBytes("royale-duel-house-bot")).slice(-40)).toLowerCase();

type Ticket = {
  ticket: string; player: string; callsign: string; queuedAt: number; lastPoll: number;
  status: "waiting" | "pairing" | "matched"; duelId: number | null; side: 0 | 1 | null; sessionToken: string | null; ranked: boolean | null;
};
type Run = {
  duel: DuelMatch; logFile: string; clients: Set<WebSocket>; tokens: [string | null, string | null]; lastSeq: [number, number];
  holder: [WebSocket | null, WebSocket | null]; chainOn: boolean; chainError: string | null; createTx: string | null; startTx: string | null;
  liveAt: number; stepped: number; finishing: boolean; endedAt: number | null;
};
export type DuelDeps = {
  chain: Chain; dataDir: string; log: (m: string) => void; stats: Stats; sigOff: boolean; settleMode: string; chainSelector: string;
  send: (res: ServerResponse, code: number, body: unknown, raw?: boolean) => void; readJson: (req: IncomingMessage) => Promise<any>; wss: WebSocketServer;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parseLines = (text: string): any[] => text.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

export function mountDuels(d: DuelDeps) {
  const { chain, log, stats } = d;
  const duelChain: DuelChain | null = chain.duel;
  if (chain.on && !duelChain) log("[duel] DUEL_ESCROW_ADDRESS is not set: ranked duels run without the chain and settle offline");
  // One directory per DuelEscrow (its ids restart at 1 on a redeploy); CHAIN=off duels in `duels/`.
  const DIR = resolve(d.dataDir, duelChain ? `duel-${duelChain.address}` : "duels");
  mkdirSync(DIR, { recursive: true });
  const logOf = (id: number) => resolve(DIR, `duel-${id}.jsonl`);
  const bookOf = (id: number) => resolve(DIR, `duel-${id}.final.json`);

  // Books: written once at the end of the match, loaded at boot, served from here.
  const books = new Map<number, string>();
  let localId = duelChain ? 1_000_000 : 0; // engine-only ids (bot fights; every duel with CHAIN=off); with a DuelEscrow, ranked ids are its ids
  for (const f of readdirSync(DIR)) {
    const m = /^duel-(\d+)\.(final\.json|jsonl)$/.exec(f);
    if (!m) continue;
    const id = Number(m[1]);
    if (m[2] === "final.json") books.set(id, readFileSync(resolve(DIR, f), "utf8"));
    if (!duelChain || id > 1_000_000) localId = Math.max(localId, id);
  }
  function persistBook(id: number, json: string): string {
    const have = books.get(id);
    if (have !== undefined) return have;
    writeFileSync(bookOf(id) + ".tmp", json);
    renameSync(bookOf(id) + ".tmp", bookOf(id));
    books.set(id, json);
    return json;
  }

  // Recent results from before this start (GET /duels `recent`), rebuilt from the logs once at boot.
  type Recent = Record<string, unknown> & { duelId: number };
  const bootRecent: Recent[] = [];
  for (const f of readdirSync(DIR).filter((x) => /^duel-\d+\.jsonl$/.test(x))) {
    const id = Number(/\d+/.exec(f)![0]);
    const ev: Record<string, any> = {};
    for (const e of parseLines(readFileSync(resolve(DIR, f), "utf8"))) if (e.type) ev[e.type] = e;
    if (!ev.dfinal || !ev.duel) continue;
    const last = ev.dround; // the last round played
    bootRecent.push({
      duelId: id, status: ev.settled ? "settled" : ev.duel.status, ranked: ev.duel.ranked, stakeUnits: ev.duel.stakeUnits, players: ev.duel.players,
      round: last?.round ?? null, hp: last?.hp ?? null, rounds: ev.dfinal.rounds, startsAt: ev.duel.startsAt,
      winner: ev.dfinal.winner, bookHash: ev.dfinal.bookHash, payoutUnits: ev.dfinal.payoutUnits, settled: !!ev.settled,
    });
  }
  bootRecent.sort((a, b) => b.duelId - a.duelId).splice(10);

  // DuelQueue nonces, persisted so a signed queue request cannot be replayed after a restart.
  const NONCE_FILE = resolve(DIR, "queue-nonces.json");
  const nonces = new Map<string, bigint>(existsSync(NONCE_FILE)
    ? Object.entries(JSON.parse(readFileSync(NONCE_FILE, "utf8")) as Record<string, string>).map(([k, v]) => [k, BigInt(v)]) : []);
  function saveNonce(player: string, n: bigint) {
    nonces.set(player, n);
    writeFileSync(NONCE_FILE + ".tmp", JSON.stringify(Object.fromEntries([...nonces].map(([k, v]) => [k, v.toString()]))));
    renameSync(NONCE_FILE + ".tmp", NONCE_FILE);
  }

  const tickets = new Map<string, Ticket>();
  const runs = new Map<number, Run>();
  const record = (r: { logFile: string }, line: unknown) => appendFileSync(r.logFile, JSON.stringify(line) + "\n");
  const token = () => randomBytes(24).toString("hex");
  const finished = (s: string) => s === "settled" || s === "cancelled";

  function newRun(id: number, ranked: boolean, chainOn: boolean, players: [DuelPlayer, DuelPlayer], botSide: boolean, createTx: string | null): Run {
    const duel = new DuelMatch({ id, ranked, stakeUnits: ranked ? DUEL_STAKE_UNITS : 0n, players, botLevel: botSide ? [null, HOUSE_BOT_LEVEL] : [null, null] });
    const r: Run = {
      duel, logFile: logOf(id), clients: new Set(), tokens: [null, null], lastSeq: [-1, -1], holder: [null, null], chainOn,
      chainError: null, createTx, startTx: null, liveAt: 0, stepped: 0, finishing: false, endedAt: null,
    };
    if (existsSync(r.logFile)) renameSync(r.logFile, r.logFile.replace(/\.jsonl$/, `.${Date.now()}.jsonl.old`));
    if (books.has(id) || existsSync(bookOf(id))) {
      if (existsSync(bookOf(id))) renameSync(bookOf(id), bookOf(id).replace(/\.json$/, `.${Date.now()}.json.old`));
      books.delete(id);
      log(`[duel ${id}] moved a stored book for this id aside`);
    }
    runs.set(id, r);
    record(r, { in: "create", id, ranked, chain: chainOn, stakeUnits: duel.stakeUnits.toString(), players, createTx });
    duel.onEvent((e, line) => {
      appendFileSync(r.logFile, line + "\n");
      for (const c of r.clients) if (c.readyState === c.OPEN) c.send(line);
      if (e.type === "duel") log(`[duel ${id}] ${e.status}${ranked ? " ranked" : " free"} ${players.map((p) => p.callsign).join(" vs ")}`);
      else if (e.type === "dfinal" || e.type === "cancelled" || e.type === "settled") log(`[duel ${id}] ${line.slice(0, 300)}`);
      if (e.type === "settled" && ranked) {
        const at = Date.now();
        record(r, { in: "settled", at });
        stats.record("duel", id, (duel.finalEvent?.bookHash as string) ?? null, e as unknown as { txHash: string; winners: string[]; amounts: string[] },
          new Map(players.map((p) => [p.player, { callsign: p.callsign, bot: p.bot }])), at);
      }
    });
    duel.emitDuel();
    return r;
  }

  function beginCountdown(r: Run) {
    if (r.duel.status !== "matching") return;
    r.duel.countdown(Math.ceil(Date.now() / 1000 + COUNTDOWN_S));
  }

  function matchTicket(t: Ticket, r: Run, side: 0 | 1) {
    t.status = "matched";
    t.duelId = r.duel.id;
    t.side = side;
    t.ranked = r.duel.ranked;
    t.sessionToken = r.tokens[side] = token();
  }

  // ---------- pairing
  function tryPair() {
    const waiting = [...tickets.values()].filter((t) => t.status === "waiting").sort((a, b) => a.queuedAt - b.queuedAt);
    for (let i = 0; i + 1 < waiting.length; i += 2) void pair(waiting[i], waiting[i + 1]);
  }

  async function pair(a: Ticket, b: Ticket) {
    a.status = b.status = "pairing";
    const players: [DuelPlayer, DuelPlayer] = [{ player: a.player, callsign: a.callsign, bot: false }, { player: b.player, callsign: b.callsign, bot: false }];
    let made: { id: number; txHash: string } | null = null;
    if (duelChain) {
      try { made = await duelChain.createDuel(DUEL_STAKE_UNITS); } catch (e) {
        log(`[duel] createDuel failed for ${a.callsign} vs ${b.callsign}, both back in the queue: ${failReason(e)}`);
        for (const t of [a, b]) if (tickets.get(t.ticket) === t) t.status = "waiting";
        setTimeout(tryPair, 5000);
        return;
      }
    }
    const r = newRun(made?.id ?? ++localId, true, !!duelChain, players, false, made?.txHash ?? null);
    matchTicket(a, r, 0);
    matchTicket(b, r, 1);
    if (!duelChain) return beginCountdown(r);
    // Stakes are taken only now, both players known: side 0 joins first (playerA), then side 1, then start.
    const until = Date.now() + JOIN_WINDOW_MS;
    try {
      for (const p of players) await duelChain.joinFor(r.duel.id, p.player, until);
      if (r.duel.status === "cancelled") return;
      r.startTx = await duelChain.start(r.duel.id);
      r.chainError = null;
      beginCountdown(r);
    } catch (e) {
      await cancelRun(r, `chain setup failed: ${failReason(e)}`);
    }
  }

  function botFight(t: Ticket): Run {
    t.status = "pairing";
    const r = newRun(++localId, false, false, [{ player: t.player, callsign: t.callsign, bot: false }, { player: HOUSE_BOT, callsign: "BOT", bot: true }], true, null);
    matchTicket(t, r, 0);
    beginCountdown(r);
    return r;
  }

  /** Stop a duel and, for a ranked one on chain, cancel it there (refunds every stake paid). Retries with backoff. */
  async function cancelRun(r: Run, why: string) {
    r.duel.cancel(why);
    r.endedAt = Date.now();
    if (!r.chainOn || !duelChain) return;
    for (let n = 1; ; n++) {
      try {
        const on = await duelChain.getDuel(r.duel.id);
        if (on.status === DUEL_CANCELLED) { r.chainError = `${why}; cancelled on chain`; break; }
        if (on.status !== DUEL_OPEN && on.status !== DUEL_LIVE) { r.chainError = `${why}; escrow status ${on.status}, not cancellable`; break; }
        if (on.status === DUEL_OPEN && on.pot === 0n) { r.chainError = `${why}; no stakes on chain, nothing to refund`; break; }
        const tx = await duelChain.cancel(r.duel.id);
        r.chainError = `${why}; cancelled on chain, stakes refunded (${tx})`;
        break;
      } catch (e) {
        if (n >= 12) { r.chainError = `${why}; cancel failed ${n} times: ${failReason(e)}`.slice(0, 500); break; }
        await sleep(Math.min(60, 2 ** n) * 1000);
      }
    }
    record(r, { in: "cancel-done", why: r.chainError });
    log(`[duel ${r.duel.id}] ${r.chainError}`);
  }

  // ---------- the 60 Hz loop
  function loop() {
    const now = Date.now();
    for (const t of [...tickets.values()]) {
      if (t.status === "waiting" && now - t.lastPoll > TICKET_IDLE_MS) { tickets.delete(t.ticket); log(`[duel] ${t.callsign} left the queue (no poll for ${TICKET_IDLE_MS / 1000} s)`); }
      if (t.status === "matched" && t.duelId !== null) {
        const r = runs.get(t.duelId);
        if (!r || (r.endedAt !== null && now - r.endedAt > 10 * 60_000)) tickets.delete(t.ticket);
      }
    }
    for (const r of runs.values()) {
      const duel = r.duel;
      if (duel.status === "countdown" && now >= duel.startsAt! * 1000) { duel.start(); r.liveAt = now; r.stepped = 0; }
      if (duel.status !== "live") continue;
      const target = Math.floor(((now - r.liveAt) * TICK_HZ) / 1000);
      for (let n = 0; r.stepped < target && n < 30; n++) {
        r.stepped++;
        if (duel.advance()) { void finish(r); break; }
      }
    }
    pruneFinished();
  }

  function pruneFinished() {
    const done = [...runs.values()].filter((r) => finished(r.duel.status));
    if (done.length <= KEEP_FINISHED) return;
    done.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const r of done.slice(0, done.length - KEEP_FINISHED)) { for (const c of r.clients) c.close(); runs.delete(r.duel.id); }
  }

  async function finish(r: Run) {
    if (r.finishing) return;
    r.finishing = true;
    const duel = r.duel;
    persistBook(duel.id, duel.freezeBook(books.get(duel.id)));
    if (!duel.ranked) {
      // A free bot fight: no stake, nothing on chain, nothing paid, not in /stats.
      duel.emitFinal(0n);
      duel.markSettled("free", "simulated", "offline", [], [], { free: true });
      r.endedAt = Date.now();
      return;
    }
    let pot = duel.potUnits;
    if (r.chainOn && duelChain) {
      for (let n = 1; ; n++) {
        try { pot = (await duelChain.getDuel(duel.id)).pot; break; } catch (e) { log(`[duel ${duel.id}] getDuel for the pot failed (attempt ${n}): ${failReason(e)}`); await sleep(3000); }
      }
      if (pot !== duel.potUnits) log(`[duel ${duel.id}] warning: on-chain pot ${pot} != engine pot ${duel.potUnits}; dfinal uses the on-chain pot`);
    }
    record(r, { in: "final", potUnits: pot.toString() });
    const fin = duel.emitFinal(pot);
    if (r.chainOn && duelChain) await settleOnChain(r, duelChain).catch((e) => { r.chainError = `settle: ${failReason(e)}`.slice(0, 500); log(`[duel ${duel.id}] ${r.chainError}`); });
    else settleOffline(duel, fin);
    r.endedAt = Date.now();
  }

  /** CHAIN=off (or no DuelEscrow): `settled` follows `dfinal` with its provisional payout; a draw lists nobody and the refunds. */
  function settleOffline(duel: DuelMatch, fin: EngineEvent) {
    const w = fin.winner as string | null;
    if (w) duel.markSettled("offline", "simulated", "offline", [w], [fin.payoutUnits as string]);
    else duel.markSettled("offline", "simulated", "offline", [], [], { refunds: { players: duel.players.map((p) => p.player), amounts: duel.players.map(() => duel.stakeUnits.toString()) } });
  }

  async function duelReport(book: string, on: { playerA: string; playerB: string; stake: bigint }) {
    // workflow/src/report.ts buildDuelReport (duel-contracts track); resolved at call time so the engine runs before it lands.
    const mod = (await import("../../workflow/src/report.ts")) as Record<string, unknown>;
    const build = mod.buildDuelReport as undefined | ((raw: Uint8Array, sel: bigint, onchain: unknown) => { winner: string; winnerIndex: 0 | 1 | null; payoutUnits: bigint; bookHash: string; report: Hex });
    if (typeof build !== "function") throw new Error("workflow/src/report.ts has no buildDuelReport yet");
    return build(new TextEncoder().encode(book), BigInt(d.chainSelector), on);
  }

  /**
   * Ranked duel on DuelEscrow, by SETTLE_MODE: simulated and cre: the owner's settleFallback with buildDuelReport's bytes
   * (the CRE settler does not take duels); deployed: watch for the escrow's Settled(id) (the deployed workflow), 15 min.
   */
  async function settleOnChain(r: Run, dc: DuelChain) {
    const duel = r.duel;
    const id = duel.id;
    const on = await dc.getDuel(id);
    const rep = await duelReport(books.get(id)!, on);
    const winners = rep.winnerIndex === null ? [] : [rep.winner.toLowerCase()];
    const amounts = rep.winnerIndex === null ? [] : [rep.payoutUnits.toString()];
    const extra = rep.winnerIndex === null ? { refunds: { players: duel.players.map((p) => p.player), amounts: duel.players.map(() => on.stake.toString()) } } : {};
    const fromBlock = (await chain.blockNumber()) - 600n;
    const done = (hash: string, via: SettleVia) => {
      r.chainError = null;
      duel.markSettled(hash, d.settleMode === "deployed" ? "deployed" : "simulated", via, winners, amounts, extra);
    };
    if (on.status === DUEL_SETTLED) {
      const hash = await dc.findSettled(id, fromBlock > 0n ? fromBlock : 0n);
      if (!hash) throw new Error("escrow says settled but no Settled log found");
      return done(hash, "owner-fallback");
    }
    if (d.settleMode === "deployed") {
      const until = Date.now() + DEPLOYED_SETTLE_WAIT_MS;
      while (Date.now() < until) {
        await sleep(10_000);
        const now = await dc.getDuel(id).catch(() => null);
        if (now?.status === DUEL_SETTLED) {
          const hash = await dc.findSettled(id, fromBlock > 0n ? fromBlock : 0n).catch(() => null);
          if (hash) return done(hash, "cre-don");
        }
      }
      r.chainError = `no Settled log within ${DEPLOYED_SETTLE_WAIT_MS / 60_000} min; settle by hand`;
      return;
    }
    let last = "";
    for (let attempt = 1; attempt <= 10; attempt++) {
      try { return done(await dc.settleFallback(rep.report), "owner-fallback"); } catch (e) {
        const now = await dc.getDuel(id).catch(() => null);
        if (now?.status === DUEL_SETTLED) {
          const hash = await dc.findSettled(id, fromBlock > 0n ? fromBlock : 0n).catch(() => null);
          if (hash) return done(hash, "owner-fallback");
        }
        const why = failReason(e);
        r.chainError = `settleFallback attempt ${attempt} failed: ${why}`.slice(0, 500);
        log(`[duel ${id}] ${r.chainError}`);
        if (why === last) return;
        last = why;
        await sleep(5000);
      }
    }
  }

  // ---------- restart: duels are not replayed
  async function recover() {
    for (const f of readdirSync(DIR).filter((x) => /^duel-\d+\.jsonl$/.test(x))) {
      const id = Number(/\d+/.exec(f)![0]);
      const file = resolve(DIR, f);
      const lines = parseLines(readFileSync(file, "utf8"));
      if (lines.some((x) => x.type === "settled")) continue;
      const create = lines.find((x) => x.in === "create");
      const chainOn = !!create?.chain && !!duelChain;
      if (lines.some((x) => x.type === "cancelled")) continue;
      const fin = lines.find((x) => x.type === "dfinal");
      if (fin && books.has(id) && create?.ranked) {
        log(`[duel ${id}] restart: reached dfinal before the restart; settling from the stored book`);
        const players: DuelPlayer[] = create.players;
        const r: Run = {
          duel: null as unknown as DuelMatch, logFile: file, clients: new Set(), tokens: [null, null], lastSeq: [-1, -1], holder: [null, null],
          chainOn, chainError: null, createTx: null, startTx: null, liveAt: 0, stepped: 0, finishing: true, endedAt: Date.now(),
        };
        const sink = {
          id, players, stakeUnits: BigInt(create.stakeUnits),
          markSettled: (txHash: string, mode: string, via: SettleVia, winners: string[], amounts: string[], extra: Record<string, unknown> = {}) => {
            appendFileSync(file, JSON.stringify({ type: "settled", duelId: id, txHash, mode, via, winners, amounts, ...extra }) + "\n");
            const at = Date.now();
            appendFileSync(file, JSON.stringify({ in: "settled", at }) + "\n");
            stats.record("duel", id, fin.bookHash ?? null, { txHash, winners, amounts }, new Map(players.map((p) => [p.player, { callsign: p.callsign, bot: p.bot }])), at);
          },
        };
        r.duel = sink as unknown as DuelMatch;
        if (chainOn && duelChain) await settleOnChain(r, duelChain).catch((e) => log(`[duel ${id}] restart settle failed: ${failReason(e)}`));
        else settleOffline(sink as unknown as DuelMatch, fin);
        continue;
      }
      const reason = "engine restarted mid-duel";
      appendFileSync(file, JSON.stringify({ type: "cancelled", duelId: id, reason }) + "\n");
      log(`[duel ${id}] restart: cancelled (${reason})`);
      if (chainOn && duelChain && create?.ranked) {
        const r = { duel: { id, cancel: () => {} }, chainOn, chainError: null, logFile: file, endedAt: null } as unknown as Run;
        await cancelRun(r, reason);
      }
    }
  }

  // ---------- HTTP
  function ticketView(t: Ticket) {
    const matched = t.status === "matched";
    return {
      ticket: t.ticket, status: matched ? "matched" : "waiting", duelId: matched ? t.duelId : null, side: matched ? t.side : null,
      sessionToken: matched ? t.sessionToken : null, ranked: matched ? t.ranked : null, pairing: t.status === "pairing",
      queuedAt: t.queuedAt, botAfter: t.queuedAt + BOT_OFFER_MS,
    };
  }

  async function queue(body: any): Promise<[number, unknown]> {
    const player = String(body?.player ?? "").toLowerCase();
    const callsign = String(body?.callsign ?? "");
    if (!/^0x[0-9a-f]{40}$/.test(player)) return [400, { error: "player must be an address" }];
    if (!callsign.trim() || callsign.length > 24) return [400, { error: "callsign must be 1 to 24 characters" }];
    if (player === HOUSE_BOT) return [400, { error: "that address is the house bot" }];
    if (!/^\d{1,30}$/.test(String(body.nonce))) return [400, { error: "nonce must be a non-negative integer" }];
    const nonce = BigInt(body.nonce);
    const last = () => nonces.get(player) ?? -1n;
    if (nonce <= last()) return [400, { error: "nonce must increase" }];
    if (!d.sigOff && !(await verifyDuelQueue(player, callsign, String(body.nonce), body.signature))) return [401, { error: "bad signature" }];
    if (nonce <= last()) return [400, { error: "nonce must increase" }];
    saveNonce(player, nonce);
    // Already queued, or in a duel that has not finished: the same ticket (a reloaded phone picks up where it was).
    for (const t of tickets.values()) {
      if (t.player !== player) continue;
      if (t.status !== "matched") { t.lastPoll = Date.now(); return [200, ticketView(t)]; }
      const r = t.duelId !== null ? runs.get(t.duelId) : undefined;
      if (r && !finished(r.duel.status)) return [200, ticketView(t)];
    }
    const now = Date.now();
    const t: Ticket = { ticket: token(), player, callsign, queuedAt: now, lastPoll: now, status: "waiting", duelId: null, side: null, sessionToken: null, ranked: null };
    tickets.set(t.ticket, t);
    log(`[duel] ${callsign} queued (${[...tickets.values()].filter((x) => x.status === "waiting").length} waiting)`);
    tryPair();
    return [200, ticketView(t)];
  }

  async function archived(id: number) {
    const text = await readFile(logOf(id), "utf8").catch(() => null);
    if (text === null) return null;
    const ev: Record<string, any> = {};
    const drounds: unknown[] = [];
    for (const e of parseLines(text)) { if (e.type) ev[e.type] = e; if (e.type === "dround") drounds.push(e); }
    const status = ev.settled ? "settled" : ev.cancelled ? "cancelled" : ev.duel?.status ?? "unknown";
    return { ...(ev.duel ?? {}), duelId: id, archived: true, status, drounds, dfinal: ev.dfinal ?? null, settled: ev.settled ?? null, cancelReason: ev.cancelled?.reason ?? null, now: Date.now() };
  }

  /** Handles /duels routes; false when the path is not one of them. */
  async function handle(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> {
    if (parts[0] !== "duels") return false;
    const { send } = d;
    if (parts[1] === "queue") {
      if (req.method === "POST" && parts.length === 2) { const [c, o] = await queue(await d.readJson(req)); send(res, c, o); return true; }
      const t = parts[2] ? tickets.get(parts[2]) : undefined;
      if (!t) { send(res, 404, { error: "no such ticket" }); return true; }
      t.lastPoll = Date.now();
      if (req.method === "GET" && parts.length === 3) { send(res, 200, ticketView(t)); return true; }
      if (req.method === "POST" && parts[3] === "bot" && parts.length === 4) {
        if (t.status === "matched") { send(res, 200, ticketView(t)); return true; } // already in a duel (or this bot fight)
        if (t.status !== "waiting") { send(res, 409, { error: "already paired with a player" }); return true; }
        const left = t.queuedAt + BOT_OFFER_MS - Date.now();
        if (left > 0) { send(res, 400, { error: `the bot fight opens after ${BOT_OFFER_MS / 1000} s alone (${Math.ceil(left / 1000)} s left)` }); return true; }
        botFight(t);
        send(res, 200, ticketView(t));
        return true;
      }
      send(res, 404, { error: "not found" });
      return true;
    }
    if (req.method === "GET" && parts.length === 1) {
      const all = [...runs.values()].map((r) => r.duel);
      const live = all.filter((x) => x.status === "countdown" || x.status === "live" || (x.status === "settling" && !x.finalEvent)).sort((a, b) => a.id - b.id);
      const recent = all.filter((x) => x.finalEvent).sort((a, b) => b.id - a.id).slice(0, 10).map((x) => ({
        ...x.summary(), winner: x.finalEvent!.winner, bookHash: x.finalEvent!.bookHash, payoutUnits: x.finalEvent!.payoutUnits, settled: x.status === "settled",
      }));
      for (const x of bootRecent) if (!recent.some((y) => y.duelId === x.duelId)) recent.push(x as never);
      recent.sort((a, b) => b.duelId - a.duelId).splice(10);
      send(res, 200, { queue: [...tickets.values()].filter((t) => t.status !== "matched").length, live: live.map((x) => x.summary()), recent, botOfferMs: BOT_OFFER_MS, stakeUnits: DUEL_STAKE_UNITS.toString(), now: Date.now() });
      return true;
    }
    const id = Number(parts[1]);
    if (req.method === "GET" && parts[2] === "final" && parts.length === 3) {
      const book = books.get(id);
      if (book) send(res, 200, book, true); else send(res, 404, { error: "no final book yet" });
      return true;
    }
    if (req.method === "GET" && parts.length === 2) {
      const r = runs.get(id);
      if (r) { send(res, 200, { ...r.duel.snapshot(), chainError: r.chainError, createTx: r.createTx, startTx: r.startTx, escrow: r.chainOn ? duelChain?.address : null, now: Date.now() }); return true; }
      const old = Number.isSafeInteger(id) && id > 0 ? await archived(id) : null;
      if (old) send(res, 200, old); else send(res, 404, { error: "no such duel" });
      return true;
    }
    send(res, 404, { error: "not found" });
    return true;
  }

  // ---------- WS /ws?duel=:id
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, q: string): void {
    const r = runs.get(Number(q));
    if (!r) return void socket.destroy();
    d.wss.handleUpgrade(req, socket, head, (ws) => {
      r.clients.add(ws);
      for (const e of r.duel.catchUp()) ws.send(JSON.stringify(e));
      ws.on("message", (data) => {
        let m: any;
        try { m = JSON.parse(String(data)); } catch { return; }
        if (m?.type !== "input" || typeof m.sessionToken !== "string") return;
        const side = r.tokens[0] === m.sessionToken ? 0 : r.tokens[1] === m.sessionToken ? 1 : null;
        if (side === null || !Number.isInteger(m.seq) || !Number.isInteger(m.bits) || m.bits < 0 || m.bits > 63) return;
        if (m.seq <= r.lastSeq[side]) return;
        r.lastSeq[side] = m.seq;
        r.holder[side] = ws;
        r.duel.setInput(side, m.bits);
      });
      ws.on("close", () => {
        r.clients.delete(ws);
        // The phone that was playing a side went away: stop holding its last buttons down.
        for (const side of [0, 1] as const) if (r.holder[side] === ws) { r.holder[side] = null; r.duel.setInput(side, 0); }
      });
    });
  }

  /** Human players in duels that have not finished (for /stats `playing`). */
  function playing(): string[] {
    return [...runs.values()].filter((r) => !finished(r.duel.status) && !(r.duel.status === "settling" && r.chainError))
      .flatMap((r) => r.duel.players.filter((p) => !p.bot).map((p) => p.player));
  }

  return { loop, handle, upgrade, recover, playing };
}
