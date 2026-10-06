// Prediction round state machine. No clock, no I/O: the driver feeds it times and marks, so the offline sim and the
// live server run the same code. Every payout comes from predictSettle in shared/scoring.ts.
import { fromCents, predictSettle, toCents } from "../../shared/scoring.ts";
import type { Market, PredictBook, PredictParams, Prediction, Split } from "../../shared/scoring.ts";
import { keccak256, toBytes } from "viem";
import { FEE_BPS, MARKETS, TICKS_PER_SEC, type EngineEvent } from "./types.ts";

export type { PredictParams, Split };
export type RoundStatus = "open" | "live" | "settling" | "settled" | "cancelled";

/** CLAUDE.md "Prediction mode": protocol values and user-created ranges. */
export const PROTOCOL = {
  entryUnits: 5_000000n, maxPlayers: 50, lockAfter: 60, resolveAfter: 120, winnerBps: 2500, split: "linear" as Split, creatorFeeBps: 0,
};
export const RANGES = {
  entryUnits: [1_000000n, 50_000000n], maxPlayers: [4, 50], lockAfter: [30, 600], resolveAfter: [60, 3600],
  winnerBps: [1000, 5000], creatorFeeBps: [0, 500],
} as const;
export const SPLITS: Split[] = ["equal", "linear", "steep"];
export const MIN_PLAYERS = 4;

/** What a creator signs (CreateRound) and the engine validates. */
export type RoundSpec = {
  creator: string | null; market: Market; entryUnits: bigint; maxPlayers: number; lockAfter: number; resolveAfter: number;
  winnerBps: number; split: Split; creatorFeeBps: number;
};

export function protocolSpec(market: Market): RoundSpec {
  return {
    creator: null, market, entryUnits: PROTOCOL.entryUnits, maxPlayers: PROTOCOL.maxPlayers, lockAfter: PROTOCOL.lockAfter,
    resolveAfter: PROTOCOL.resolveAfter, winnerBps: PROTOCOL.winnerBps, split: PROTOCOL.split, creatorFeeBps: 0,
  };
}

/** Range check for a user-created round. Returns an error message, or null when every parameter is in range. */
export function checkUserSpec(s: RoundSpec): string | null {
  const intIn = (v: number, [lo, hi]: readonly [number, number], name: string) =>
    Number.isInteger(v) && v >= lo && v <= hi ? null : `${name} must be an integer ${lo} to ${hi}`;
  if (s.creator === null || !/^0x[0-9a-f]{40}$/.test(s.creator)) return "creator must be a lowercase address";
  if (/^0x0{40}$/.test(s.creator)) return "creator must not be the zero address";
  if (!MARKETS.includes(s.market)) return "market must be BTC, ETH or SOL";
  if (typeof s.entryUnits !== "bigint" || s.entryUnits < RANGES.entryUnits[0] || s.entryUnits > RANGES.entryUnits[1])
    return `entryUnits must be ${RANGES.entryUnits[0]} to ${RANGES.entryUnits[1]}`;
  if (!SPLITS.includes(s.split)) return "split must be equal, linear or steep";
  return intIn(s.maxPlayers, RANGES.maxPlayers, "maxPlayers") ?? intIn(s.lockAfter, RANGES.lockAfter, "lockAfter")
    ?? intIn(s.resolveAfter, RANGES.resolveAfter, "resolveAfter") ?? intIn(s.winnerBps, RANGES.winnerBps, "winnerBps")
    ?? intIn(s.creatorFeeBps, RANGES.creatorFeeBps, "creatorFeeBps");
}

/**
 * Lock and resolve times for a round opened at `openTime`. The resolve time is pushed up to a whole minute (the
 * settlement candle is the minute before endTime), keeping resolveAfter exact; lockAfter may grow by up to 59 s.
 */
export function roundTimes(openTime: number, lockAfter: number, resolveAfter: number) {
  const endTime = Math.ceil((openTime + lockAfter + resolveAfter) / 60) * 60;
  return { lockTime: endTime - resolveAfter, endTime };
}

const PRICE_IN = /^\d+\.\d{2}$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const byAddr = (a: { player: string }, b: { player: string }) => (a.player < b.player ? -1 : a.player > b.player ? 1 : 0);

export type RoundPlayer = { player: string; callsign: string; bot: boolean; joinIndex: number };
export type Result = { ok: true } | { ok: false; error: string };

/** Display ranking against a price: distance ascending, ties by earlier joiner (the order predictSettle uses). */
export function rankAgainst(preds: Prediction[], priceCents: bigint) {
  return preds
    .map((p) => { const d = toCents(p.price) - priceCents; return { ...p, d: d < 0n ? -d : d }; })
    .sort((a, b) => (a.d !== b.d ? (a.d < b.d ? -1 : 1) : a.joinIndex - b.joinIndex));
}

export type RoundConfig = { id: number; spec: RoundSpec; protocol: boolean; openTime: number; feeBps?: number };

export class PredictRound {
  readonly id: number;
  readonly spec: RoundSpec;
  readonly params: PredictParams;
  readonly protocol: boolean;
  readonly openTime: number;
  readonly lockTime: number;
  readonly endTime: number;
  status: RoundStatus = "open";
  players: RoundPlayer[] = [];
  private preds = new Map<string, string>(); // player -> latest price
  lastNonce = new Map<string, bigint>();
  k = -1; // last processed tick index since open
  mark: string | null = null;
  lastLobby: EngineEvent | null = null;
  roundEvent: EngineEvent | null = null;
  lastPredicted: EngineEvent | null = null;
  lockedEvent: EngineEvent | null = null;
  lastPtick: EngineEvent | null = null;
  finalEvent: EngineEvent | null = null;
  settledEvent: EngineEvent | null = null;
  cancelReason: string | null = null;
  bookJson: string | null = null;
  private frozen: Prediction[] | null = null;
  private lines: string[] = [];
  private sinks: ((e: EngineEvent, line: string) => void)[] = [];

  constructor(cfg: RoundConfig) {
    this.id = cfg.id;
    this.spec = cfg.spec;
    this.protocol = cfg.protocol;
    this.openTime = cfg.openTime;
    const t = roundTimes(cfg.openTime, cfg.spec.lockAfter, cfg.spec.resolveAfter);
    this.lockTime = t.lockTime;
    this.endTime = t.endTime;
    this.params = {
      market: cfg.spec.market, entryUnits: cfg.spec.entryUnits.toString(), winnerBps: cfg.spec.winnerBps, split: cfg.spec.split,
      creator: cfg.spec.creator, creatorFeeBps: cfg.spec.creator === null ? 0 : cfg.spec.creatorFeeBps, feeBps: cfg.feeBps ?? Number(FEE_BPS),
    };
  }

  onEvent(fn: (e: EngineEvent, line: string) => void) { this.sinks.push(fn); }

  get market(): Market { return this.spec.market; }
  get maxPlayers() { return this.spec.maxPlayers; }
  get entryUnits() { return this.spec.entryUnits; }
  get potUnits() { return BigInt(this.players.length) * this.spec.entryUnits; }
  get lockT() { return this.lockTime - this.openTime; }
  get endT() { return this.endTime - this.openTime; }
  get lockK() { return this.lockT * TICKS_PER_SEC; }
  get endK() { return this.endT * TICKS_PER_SEC; }
  get predictedCount() { return this.preds.size; }
  /** Unix ms of tick k (k ticks of 1/4 s since open). */
  tickAtMs(k: number) { return this.openTime * 1000 + (k * 1000) / TICKS_PER_SEC; }
  hasPredicted(player: string) { return this.preds.has(player.toLowerCase()); }
  /** The player's own prediction (only ever shown back to that player before the lock). */
  predictionOf(player: string) { return this.preds.get(player.toLowerCase()) ?? null; }
  find(player: string) { return this.players.find((p) => p.player === player.toLowerCase()); }

  private emit(e: EngineEvent) {
    const line = JSON.stringify(e);
    this.lines.push(line);
    const slot: Record<string, string> = {
      lobby: "lastLobby", round: "roundEvent", predicted: "lastPredicted", locked: "lockedEvent", ptick: "lastPtick", final: "finalEvent", settled: "settledEvent",
    };
    const s = slot[e.type];
    if (s) (this as any)[s] = e;
    for (const f of this.sinks) f(e, line);
  }

  emitLobby() {
    this.emit({
      type: "lobby", lobbyId: this.id, mode: "predict", status: this.status, market: this.market,
      players: this.players.map((p) => ({ player: p.player, callsign: p.callsign, bot: p.bot })),
      startsAt: this.lockTime, lockTime: this.lockTime, endTime: this.endTime, potUnits: this.potUnits.toString(),
    });
  }

  emitRound() {
    this.emit({ type: "round", lobbyId: this.id, params: this.params, lockTime: this.lockTime, endTime: this.endTime, protocol: this.protocol });
  }

  /** Joins are taken while the round is open (the caller closes them a little before the lock). */
  join(player: string, callsign: string, bot: boolean): Result {
    player = player.toLowerCase();
    if (this.status !== "open") return { ok: false, error: `round is ${this.status}` };
    if (!ADDR.test(player)) return { ok: false, error: "player must be an address" };
    if (this.find(player)) return { ok: false, error: "already joined" };
    if (this.players.length >= this.maxPlayers) return { ok: false, error: "round is full" };
    const cs = String(callsign ?? "").trim().slice(0, 24);
    if (!cs) return { ok: false, error: "callsign required" };
    this.players.push({ player, callsign: cs, bot, joinIndex: this.players.length });
    this.emitLobby();
    return { ok: true };
  }

  /** Submit or replace a prediction. `t` is seconds since open. Only the latest one before the lock counts. */
  predict(player: string, price: string, t: number): Result {
    player = player.toLowerCase();
    if (this.status !== "open" || t >= this.lockT) return { ok: false, error: "round is locked" };
    if (!this.find(player)) return { ok: false, error: "join the round first" };
    if (typeof price !== "string" || !PRICE_IN.test(price) || toCents(price) <= 0n) return { ok: false, error: "price must be a positive 2-decimal string" };
    if (price.length > 20) return { ok: false, error: "price too large" };
    this.preds.set(player, price);
    this.emit({ type: "predicted", lobbyId: this.id, t, count: this.preds.size });
    return { ok: true };
  }

  /** The predictions as frozen at the lock, ascending by address. */
  predictions(): Prediction[] {
    if (this.frozen) return this.frozen;
    const join = new Map(this.players.map((p) => [p.player, p.joinIndex]));
    return [...this.preds.entries()].map(([player, price]) => ({ player, price, joinIndex: join.get(player)! })).sort(byAddr);
  }

  /** k for these predictions: max(1, floor(n * winnerBps / 10000)), capped at the number of predictions. */
  winnersK(): number {
    let k = Math.floor((this.players.length * this.params.winnerBps) / 10000);
    if (k < 1) k = 1;
    return Math.min(k, this.predictions().length);
  }

  /** At the lock: cancel under four players or with no prediction, otherwise reveal. Returns false when cancelled. */
  lock(t: number): boolean {
    if (this.status !== "open") throw new Error(`cannot lock from ${this.status}`);
    if (this.players.length < MIN_PLAYERS) { this.cancel(`${this.players.length} players at the lock (needs ${MIN_PLAYERS})`); return false; }
    if (this.preds.size === 0) { this.cancel("no predictions at the lock"); return false; }
    this.frozen = this.predictions();
    this.status = "live";
    this.emitLobby();
    const byPlayer = new Map(this.players.map((p) => [p.player, p]));
    this.emit({
      type: "locked", lobbyId: this.id, t,
      predictions: this.frozen.map((x) => ({ player: x.player, callsign: byPlayer.get(x.player)!.callsign, bot: byPlayer.get(x.player)!.bot, price: x.price })),
    });
    return true;
  }

  /** Open or live; also settling before `final` (the book disagrees with the escrow, so nobody is paid from it). */
  cancel(reason: string) {
    if (this.status !== "open" && this.status !== "live" && !(this.status === "settling" && !this.finalEvent)) throw new Error(`cannot cancel from ${this.status}`);
    this.status = "cancelled";
    this.cancelReason = reason;
    this.emit({ type: "cancelled", lobbyId: this.id, reason });
    this.emitLobby();
  }

  /** Process tick k (k/4 seconds since open) with the round market's mark. Locks at lockK; pticks lockK..endK. */
  step(k: number, mark: string) {
    if (this.status !== "open" && this.status !== "live") return;
    if (k !== this.k + 1) throw new Error(`tick ${k} out of order after ${this.k}`);
    this.k = k;
    this.mark = mark;
    const t = k / TICKS_PER_SEC;
    if (k === this.lockK && !this.lock(t)) return;
    if (this.status !== "live") return;
    const k0 = this.winnersK();
    const top = rankAgainst(this.frozen!, toCents(mark)).slice(0, k0);
    const ps = top.map((x) => toCents(x.price));
    const lo = ps.reduce((a, b) => (b < a ? b : a)), hi = ps.reduce((a, b) => (b > a ? b : a));
    this.emit({
      type: "ptick", lobbyId: this.id, t, mark, band: { low: fromCents(lo), high: fromCents(hi) },
      leaders: top.map((x, i) => ({ player: x.player, rank: i + 1, distance: fromCents(x.d) })),
    });
    if (k === this.endK) {
      this.status = "settling";
      this.emitLobby();
    }
  }

  logHash(): `0x${string}` { return keccak256(toBytes(this.lines.map((l) => l + "\n").join(""))); }

  /** Freeze the book at the resolve tick (written once). `stored` restores a book persisted before a restart. */
  freezeBook(stored?: string): string {
    if (this.status !== "settling") throw new Error("freezeBook needs a settling round");
    if (this.bookJson) return this.bookJson;
    if (stored) return (this.bookJson = stored);
    const book: PredictBook = {
      lobbyId: this.id, mode: "predict", lockTime: this.lockTime, endTime: this.endTime, params: this.params,
      players: this.players.map((p) => ({ player: p.player, joinIndex: p.joinIndex })).sort(byAddr),
      predictions: this.predictions(), logHash: this.logHash(),
    };
    this.bookJson = JSON.stringify(book);
    return this.bookJson;
  }

  /** `final` for the frozen book at the settlement price. `potUnits`: the on-chain pot when the chain is on. */
  emitFinal(settlementPrice: string, potUnits: bigint = this.potUnits): EngineEvent {
    if (!this.bookJson) throw new Error("emitFinal needs a frozen book");
    if (this.finalEvent) return this.finalEvent;
    const book = JSON.parse(this.bookJson) as PredictBook;
    const s = predictSettle(book, settlementPrice, potUnits);
    const pay = new Map(s.winners.map((w, i) => [w, s.amounts[i]]));
    const byPlayer = new Map(this.players.map((p) => [p.player, p]));
    const winners = rankAgainst(book.predictions, toCents(settlementPrice))
      .map((x, i) => ({ x, rank: i + 1 }))
      .filter(({ x }) => pay.has(x.player))
      .map(({ x, rank }) => ({
        player: x.player, callsign: byPlayer.get(x.player)?.callsign ?? "", price: x.price, distance: fromCents(x.d), rank,
        provisionalPayoutUnits: pay.get(x.player)!.toString(),
      }));
    const final: EngineEvent = {
      type: "final", lobbyId: this.id, settlementPrice, bookHash: keccak256(toBytes(this.bookJson)), winners,
      creatorFeeUnits: s.creatorFeeUnits.toString(), feeUnits: s.feeUnits.toString(),
    };
    this.emit(final);
    return final;
  }

  markSettled(txHash: string, mode: "deployed" | "simulated", winners: string[], amounts: string[]) {
    this.status = "settled";
    this.emit({ type: "settled", lobbyId: this.id, txHash, mode, winners, amounts });
    this.emitLobby();
  }

  /** Catch-up events for a WebSocket client that connects late. */
  catchUp(): EngineEvent[] {
    return [this.lastLobby, this.roundEvent, this.lastPredicted, this.lockedEvent, this.lastPtick, this.finalEvent, this.settledEvent]
      .filter((e): e is EngineEvent => e !== null);
  }

  /** Full state for reloads. Prediction prices only after the lock. */
  snapshot() {
    return {
      lobbyId: this.id, mode: "predict", protocol: this.protocol, status: this.status, params: this.params, maxPlayers: this.maxPlayers,
      lockAfter: this.lockT, resolveAfter: this.spec.resolveAfter, openTime: this.openTime, lockTime: this.lockTime, endTime: this.endTime,
      potUnits: this.potUnits.toString(), predictedCount: this.predictedCount, mark: this.mark, cancelReason: this.cancelReason,
      players: this.players.map((p) => ({ player: p.player, callsign: p.callsign, bot: p.bot, predicted: this.preds.has(p.player) })),
      locked: this.lockedEvent, ptick: this.lastPtick, final: this.finalEvent, settled: this.settledEvent,
    };
  }

  /** One row of GET /rounds. */
  summary() {
    return {
      lobbyId: this.id, protocol: this.protocol, status: this.status, params: this.params, maxPlayers: this.maxPlayers,
      lockAfter: this.lockT, resolveAfter: this.spec.resolveAfter, openTime: this.openTime, lockTime: this.lockTime, endTime: this.endTime,
      players: this.players.length, predicted: this.predictedCount, potUnits: this.potUnits.toString(), mark: this.mark,
    };
  }
}
