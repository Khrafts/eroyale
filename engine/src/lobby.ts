// Lobby state machine. No clock, no I/O: the driver feeds it tick indexes and marks,
// so the offline sim and the live server run the same code.
import { cut, equityCents, fromCents, settle, toCents } from "../../shared/scoring.ts";
import type { Finalist, FinalBook, Position } from "../../shared/scoring.ts";
import { keccak256, toBytes } from "viem";
import {
  ENTRY_UNITS, FEE_BPS, MARKETS, START_BALANCE, TICKS_PER_SEC, ZONE_START_CENTS,
  type EngineEvent, type Market, type Order, type Preset, type Prices, type SettleVia, type Status,
} from "./types.ts";

type Pos = { side: 1 | -1; notional: bigint; entry: bigint; margin: bigint; leverage: number };

export type PlayerState = {
  player: string;
  callsign: string;
  bot: boolean;
  joinIndex: number;
  cash: bigint;
  positions: Map<Market, Pos>;
  alive: boolean;
  elimOrder: number; // 0 while alive; higher = eliminated later
  elimEquity: bigint;
  elimReason: "cut" | "zone" | "liquidated" | null;
  lastNonce: bigint;
};

export type LobbyConfig = { id: number; preset: Preset; maxPlayers: number; entryUnits?: bigint; feeBps?: bigint };
export type OrderResult = { ok: true } | { ok: false; error: string };

const MONEY_IN = /^\d+(\.\d{1,2})?$/;
const ADDR = /^0x[0-9a-f]{40}$/;

export class Lobby {
  readonly id: number;
  readonly preset: Preset;
  readonly maxPlayers: number;
  readonly entryUnits: bigint;
  readonly feeBps: bigint;
  status: Status = "open";
  startsAt: number | null = null; // unix seconds
  players: PlayerState[] = [];
  k = -1; // last processed tick index
  lastT = 0;
  marks: Prices | null = null;
  zone = ZONE_START_CENTS;
  lastTick: EngineEvent | null = null;
  lastBoard: EngineEvent | null = null;
  lastLobby: EngineEvent | null = null;
  finalEvent: EngineEvent | null = null;
  settledEvent: EngineEvent | null = null;
  bookJson: string | null = null;
  private lines: string[] = [];
  private elimCounter = 0;
  private sinks: ((e: EngineEvent, line: string) => void)[] = [];

  constructor(cfg: LobbyConfig) {
    this.id = cfg.id;
    this.preset = cfg.preset;
    this.maxPlayers = cfg.maxPlayers;
    this.entryUnits = cfg.entryUnits ?? ENTRY_UNITS;
    this.feeBps = cfg.feeBps ?? FEE_BPS;
  }

  onEvent(fn: (e: EngineEvent, line: string) => void) { this.sinks.push(fn); }

  get endK() { return this.preset.duration * TICKS_PER_SEC; }
  get endTime() { return this.startsAt === null ? null : this.startsAt + this.preset.duration; }
  get potUnits() { return BigInt(this.players.length) * this.entryUnits; }
  get acceptingOrders() { return this.status === "live" && this.k >= 0 && this.k < this.endK; }

  private emit(e: EngineEvent) {
    const line = JSON.stringify(e);
    this.lines.push(line);
    if (e.type === "tick") this.lastTick = e;
    else if (e.type === "leaderboard") this.lastBoard = e;
    else if (e.type === "lobby") this.lastLobby = e;
    else if (e.type === "final") this.finalEvent = e;
    else if (e.type === "settled") this.settledEvent = e;
    for (const s of this.sinks) s(e, line);
  }

  emitLobby() {
    this.emit({
      type: "lobby", lobbyId: this.id, preset: this.preset.name, status: this.status,
      players: this.players.map((p) => ({ player: p.player, callsign: p.callsign, bot: p.bot })),
      startsAt: this.startsAt, endTime: this.endTime, potUnits: this.potUnits.toString(),
    });
  }

  join(player: string, callsign: string, bot: boolean): OrderResult {
    player = player.toLowerCase();
    if (this.status !== "open" && this.status !== "countdown") return { ok: false, error: `lobby is ${this.status}` };
    if (!ADDR.test(player)) return { ok: false, error: "player must be an address" };
    if (this.players.some((p) => p.player === player)) return { ok: false, error: "already joined" };
    if (this.players.length >= this.maxPlayers) return { ok: false, error: "lobby is full" };
    const cs = String(callsign ?? "").trim().slice(0, 24);
    if (!cs) return { ok: false, error: "callsign required" };
    this.players.push({
      player, callsign: cs, bot, joinIndex: this.players.length, cash: toCents(START_BALANCE), positions: new Map(),
      alive: true, elimOrder: 0, elimEquity: 0n, elimReason: null, lastNonce: -1n,
    });
    this.emitLobby();
    return { ok: true };
  }

  countdown(startsAt: number) {
    if (this.status !== "open") throw new Error(`cannot count down from ${this.status}`);
    this.startsAt = startsAt;
    this.status = "countdown";
    this.emitLobby();
  }

  start() {
    if (this.status !== "countdown") throw new Error(`cannot start from ${this.status}`);
    if (this.players.length < 4) throw new Error("needs 4+ players");
    this.status = "live";
    this.emitLobby();
  }

  /** Open or countdown; also live, for a match whose on-chain start never landed (entries are refunded). */
  cancel() {
    if (this.status !== "open" && this.status !== "countdown" && this.status !== "live") throw new Error(`cannot cancel from ${this.status}`);
    this.status = "cancelled";
    this.emitLobby();
  }

  find(player: string) { return this.players.find((p) => p.player === player.toLowerCase()); }

  finalist(p: PlayerState): Finalist {
    const positions: Position[] = [];
    for (const m of MARKETS) {
      const x = p.positions.get(m);
      if (x) positions.push({ market: m, side: x.side, notional: fromCents(x.notional), entry: fromCents(x.entry) });
    }
    return { player: p.player, cash: fromCents(p.cash), positions };
  }

  equity(p: PlayerState, marks = this.marks): bigint {
    if (!p.alive) return p.elimEquity;
    if (!marks) return p.cash;
    return equityCents(this.finalist(p), marks);
  }

  marginInUse(p: PlayerState): bigint {
    let s = 0n;
    for (const x of p.positions.values()) s += x.margin;
    return s;
  }

  private pnl(market: Market, x: Pos, marks: Prices): bigint {
    // Profit or loss of one position, via the shared scorer.
    const pos: Position = { market, side: x.side, notional: fromCents(x.notional), entry: fromCents(x.entry) };
    return equityCents({ player: "", cash: "0.00", positions: [pos] }, marks);
  }

  /** Alive players by equity (ties: earlier joiner first), then the eliminated, latest elimination first. */
  ranking(): { p: PlayerState; equity: bigint }[] {
    const rows = this.players.map((p) => ({ p, equity: this.equity(p) }));
    return rows.sort((a, b) => {
      if (a.p.alive !== b.p.alive) return a.p.alive ? -1 : 1;
      if (!a.p.alive && a.p.elimOrder !== b.p.elimOrder) return b.p.elimOrder - a.p.elimOrder;
      if (a.equity !== b.equity) return a.equity > b.equity ? -1 : 1;
      return a.p.joinIndex - b.p.joinIndex;
    });
  }

  private zoneAt(k: number): bigint {
    const cps = this.preset.checkpoints.map((s) => s * TICKS_PER_SEC);
    let k0 = 0, z0 = ZONE_START_CENTS;
    for (let i = 0; i < cps.length; i++) {
      const z1 = this.preset.zoneCents[i];
      if (k <= cps[i]) return z0 + ((z1 - z0) * BigInt(k - k0)) / BigInt(cps[i] - k0);
      k0 = cps[i]; z0 = z1;
    }
    return z0;
  }

  private nextCheckpoint(t: number) {
    const i = this.preset.checkpoints.findIndex((c) => t <= c);
    return i < 0 ? null : { index: i + 1, at: this.preset.checkpoints[i] };
  }

  private cutEquity(): string | null {
    if (this.nextCheckpoint(this.lastT) === null) return null;
    const alive = this.players.filter((p) => p.alive);
    if (alive.length === 0) return null;
    const out = new Set(cut(alive.map((p) => ({ player: p.player, equityCents: this.equity(p), joinIndex: p.joinIndex })), this.zone).map((e) => e.player));
    const kept = alive.filter((p) => !out.has(p.player)).map((p) => this.equity(p));
    if (kept.length === 0) return null;
    return fromCents(kept.reduce((m, e) => (e < m ? e : m)));
  }

  private eliminate(list: { p: PlayerState; reason: "cut" | "zone" | "liquidated" }[]) {
    const ranks = new Map(this.ranking().map((r, i) => [r.p.player, i + 1]));
    this.elimCounter++;
    const out = list.map(({ p, reason }) => {
      p.elimEquity = this.equity(p);
      return { player: p.player, callsign: p.callsign, reason, rank: ranks.get(p.player)! };
    });
    for (const { p, reason } of list) { p.alive = false; p.elimOrder = this.elimCounter; p.elimReason = reason; }
    return out;
  }

  /** Process tick k with these marks. */
  step(k: number, marks: Prices) {
    if (this.status !== "live") return;
    if (k !== this.k + 1) throw new Error(`tick ${k} out of order after ${this.k}`);
    this.k = k;
    const t = k / TICKS_PER_SEC;
    this.lastT = t;
    this.marks = marks;
    this.zone = this.zoneAt(k);

    // Liquidation
    const liq: PlayerState[] = [];
    for (const p of this.players) {
      if (!p.alive || equityCents(this.finalist(p), marks) > 0n) continue;
      for (const m of MARKETS) {
        const x = p.positions.get(m);
        if (!x) continue;
        p.cash += this.pnl(m, x, marks);
        p.positions.delete(m);
        this.emit({ type: "fill", t, player: p.player, market: m, side: x.side, margin: fromCents(x.margin), leverage: x.leverage, price: marks[m], kind: "liquidation" });
      }
      liq.push(p);
    }
    if (liq.length) {
      this.emit({ type: "eliminated", t, checkpoint: null, players: this.eliminate(liq.map((p) => ({ p, reason: "liquidated" as const }))) });
    }

    this.emit({ type: "tick", t, marks, zone: fromCents(this.zone), nextCheckpoint: this.nextCheckpoint(t) });
    const warnIdx = this.preset.checkpoints.findIndex((c) => c - 10 === t);
    if (warnIdx >= 0) this.emit({ type: "warning", checkpoint: warnIdx + 1, secondsLeft: 10 });
    this.emitBoard(t);

    const cpIdx = this.preset.checkpoints.indexOf(t);
    if (cpIdx >= 0) {
      const alive = this.players.filter((p) => p.alive);
      const res = cut(alive.map((p) => ({ player: p.player, equityCents: this.equity(p), joinIndex: p.joinIndex })), this.preset.zoneCents[cpIdx]);
      if (res.length) {
        const byId = new Map(alive.map((p) => [p.player, p]));
        this.emit({ type: "eliminated", t, checkpoint: cpIdx + 1, players: this.eliminate(res.map((r) => ({ p: byId.get(r.player)!, reason: r.reason }))) });
      }
    }

    if (k === this.endK) {
      this.status = "settling";
      this.emitLobby();
    }
  }

  private emitBoard(t: number) {
    const rows = this.ranking().map((r, i) => ({
      player: r.p.player, callsign: r.p.callsign, bot: r.p.bot, equity: fromCents(r.equity), rank: i + 1, alive: r.p.alive,
    }));
    this.emit({ type: "leaderboard", t, rows, cutEquity: this.cutEquity() });
  }

  /** Apply an order at the given marks. t is the fill time in match seconds. */
  order(player: string, order: Order, marks: Prices, t: number): OrderResult {
    if (!this.acceptingOrders) return { ok: false, error: "not accepting orders" };
    const p = this.find(player);
    if (!p) return { ok: false, error: "unknown player" };
    if (!p.alive) return { ok: false, error: "eliminated" };
    if (!order || !MARKETS.includes(order.market)) return { ok: false, error: "bad market" };
    const m = order.market;
    t = Math.max(t, this.lastT);
    if (order.action === "open") {
      if (p.positions.has(m)) return { ok: false, error: "position already open in this market" };
      if (order.side !== 1 && order.side !== -1) return { ok: false, error: "side must be 1 or -1" };
      if (!Number.isInteger(order.leverage) || order.leverage < 1 || order.leverage > 100) return { ok: false, error: "leverage must be an integer 1 to 100" };
      if (typeof order.margin !== "string" || !MONEY_IN.test(order.margin)) return { ok: false, error: "margin must be a decimal string" };
      const margin = toCents(order.margin);
      if (margin <= 0n) return { ok: false, error: "margin must be positive" };
      if (margin > equityCents(this.finalist(p), marks) - this.marginInUse(p)) return { ok: false, error: "insufficient free margin" };
      const entry = toCents(marks[m]);
      p.positions.set(m, { side: order.side, notional: margin * BigInt(order.leverage), entry, margin, leverage: order.leverage });
      this.emit({ type: "fill", t, player: p.player, market: m, side: order.side, margin: fromCents(margin), leverage: order.leverage, price: marks[m], kind: "open" });
      return { ok: true };
    }
    if (order.action === "close") {
      const x = p.positions.get(m);
      if (!x) return { ok: false, error: "no position in this market" };
      p.cash += this.pnl(m, x, marks);
      p.positions.delete(m);
      this.emit({ type: "fill", t, player: p.player, market: m, side: x.side, margin: fromCents(x.margin), leverage: x.leverage, price: marks[m], kind: "close" });
      return { ok: true };
    }
    return { ok: false, error: "action must be open or close" };
  }

  logHash(): `0x${string}` {
    return keccak256(toBytes(this.lines.map((l) => l + "\n").join("")));
  }

  /**
   * Freeze the final book at the end tick. It holds positions, not marks, so it does not wait for the
   * settlement candle. `stored` restores a book persisted before a restart (its bytes win).
   */
  freezeBook(stored?: string): string {
    if (this.status !== "settling") throw new Error("freezeBook needs a settling lobby");
    if (this.bookJson) return this.bookJson;
    if (stored) return (this.bookJson = stored);
    const alive = this.players.filter((p) => p.alive).sort((a, b) => (a.player < b.player ? -1 : a.player > b.player ? 1 : 0));
    const book: FinalBook = {
      lobbyId: this.id, endTime: this.endTime!, startBalance: START_BALANCE,
      finalists: alive.map((p) => this.finalist(p)), logHash: this.logHash(),
    };
    this.bookJson = JSON.stringify(book);
    return this.bookJson;
  }

  /** Emit `final` for the frozen book at the final marks. `potUnits`: the on-chain pot when the chain is on. */
  emitFinal(finalMarks: Prices, potUnits: bigint = this.potUnits): EngineEvent {
    if (!this.bookJson) throw new Error("emitFinal needs a frozen book");
    if (this.finalEvent) return this.finalEvent;
    const book = JSON.parse(this.bookJson) as FinalBook;
    const s = settle(book, finalMarks, potUnits, this.feeBps);
    const pay = new Map(s.winners.map((w, i) => [w, s.amounts[i]]));
    const final: EngineEvent = {
      type: "final", marks: finalMarks, bookHash: keccak256(toBytes(this.bookJson)),
      finalists: book.finalists.map((f) => ({
        player: f.player, callsign: this.find(f.player)?.callsign ?? "",
        equity: fromCents(equityCents(f, finalMarks)), provisionalPayoutUnits: (pay.get(f.player) ?? 0n).toString(),
      })),
      feeUnits: s.feeUnits.toString(),
    };
    this.emit(final);
    return final;
  }

  finalize(finalMarks: Prices): { bookJson: string; final: EngineEvent } {
    const bookJson = this.freezeBook();
    return { bookJson, final: this.emitFinal(finalMarks) };
  }

  markSettled(txHash: string, mode: "deployed" | "simulated", via: SettleVia, winners: string[], amounts: string[]) {
    this.status = "settled";
    this.emit({ type: "settled", txHash, mode, via, winners, amounts });
    this.emitLobby();
  }

  /** Full state for reloads. */
  snapshot() {
    return {
      lobbyId: this.id, preset: this.preset.name, status: this.status, startsAt: this.startsAt, endTime: this.endTime,
      potUnits: this.potUnits.toString(), maxPlayers: this.maxPlayers, t: this.k >= 0 ? this.lastT : null,
      checkpoints: this.preset.checkpoints, zoneLines: this.preset.zoneCents.map(fromCents),
      players: this.players.map((p) => ({
        player: p.player, callsign: p.callsign, bot: p.bot, alive: p.alive, reason: p.elimReason,
        equity: fromCents(this.equity(p)), cash: fromCents(p.cash), freeMargin: fromCents(this.equity(p) - this.marginInUse(p)),
        positions: [...p.positions.entries()].map(([market, x]) => ({
          market, side: x.side, margin: fromCents(x.margin), leverage: x.leverage, notional: fromCents(x.notional), entry: fromCents(x.entry),
        })),
      })),
      tick: this.lastTick, leaderboard: this.lastBoard, final: this.finalEvent, settled: this.settledEvent,
    };
  }
}
