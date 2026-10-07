// One Stickman Duel (CLAUDE.md "Stickman Duel > Engine"): the state machine around shared/duel.ts. No clock or I/O;
// the server calls advance() at 60 Hz and feeds each side's latest input bits. The bits applied each tick are the book.
import { keccak256, toBytes } from "viem";
import { botInput, encodeInputs, initDuel, stateHash, step, type Bits, type DuelState } from "./duel-rules.ts";
import type { EngineEvent, SettleVia } from "./types.ts";

export type DuelStatus = "matching" | "countdown" | "live" | "settling" | "settled" | "cancelled";
export type DuelPlayer = { player: string; callsign: string; bot: boolean };
export type DuelBook = { mode: "duel"; duelId: number; players: [string, string]; stakeUnits: string; feeBps: number; inputs: [string, string]; ticks: number; logHash: string };

export const DUEL_STAKE_UNITS = 5_000000n;
export const DUEL_FEE_BPS = 500n;
/** A win pays the winner pot - floor(pot * 500 / 10000) (the DuelEscrow rule); the rest goes to the treasury. */
export const winPayout = (pot: bigint) => pot - (pot * DUEL_FEE_BPS) / 10000n;

export class DuelMatch {
  readonly id: number;
  readonly ranked: boolean;
  readonly stakeUnits: bigint;
  readonly players: [DuelPlayer, DuelPlayer];
  /** House bot level per side (null for a human side). */
  readonly botLevel: [1 | 2 | 3 | null, 1 | 2 | 3 | null];
  status: DuelStatus = "matching";
  startsAt: number | null = null; // unix seconds, as royale's lobby.startsAt
  state: DuelState = initDuel();
  readonly applied: [Bits[], Bits[]] = [[], []];
  readonly latest: [Bits, Bits] = [0, 0];
  bookJson: string | null = null;
  cancelReason: string | null = null;
  lastDuel: EngineEvent | null = null;
  lastDstate: EngineEvent | null = null;
  readonly rounds: EngineEvent[] = []; // every dround so far
  finalEvent: EngineEvent | null = null;
  settledEvent: EngineEvent | null = null;
  private readonly lines: string[] = []; // logged events (everything but dstate), for logHash
  private readonly sinks: ((e: EngineEvent, line: string) => void)[] = [];
  private roundsDone = new Set<number>();

  constructor(o: { id: number; ranked: boolean; stakeUnits: bigint; players: [DuelPlayer, DuelPlayer]; botLevel?: [1 | 2 | 3 | null, 1 | 2 | 3 | null] }) {
    this.id = o.id;
    this.ranked = o.ranked;
    this.stakeUnits = o.stakeUnits;
    this.players = o.players;
    this.botLevel = o.botLevel ?? [null, null];
  }

  get potUnits(): bigint { return this.stakeUnits * 2n; }
  get ticks(): number { return this.applied[0].length; }
  onEvent(fn: (e: EngineEvent, line: string) => void) { this.sinks.push(fn); }

  private emit(e: EngineEvent) {
    const line = JSON.stringify(e);
    if (e.type !== "dstate") this.lines.push(line);
    if (e.type === "duel") this.lastDuel = e;
    else if (e.type === "dstate") this.lastDstate = e;
    else if (e.type === "dround") this.rounds.push(e);
    else if (e.type === "dfinal") this.finalEvent = e;
    else if (e.type === "settled") this.settledEvent = e;
    for (const s of this.sinks) s(e, line);
  }

  emitDuel() {
    this.emit({ type: "duel", duelId: this.id, status: this.status, players: this.players, stakeUnits: this.stakeUnits.toString(), startsAt: this.startsAt, ranked: this.ranked });
  }

  countdown(startsAt: number) {
    if (this.status !== "matching") return;
    this.status = "countdown";
    this.startsAt = startsAt;
    this.emitDuel();
  }

  start() {
    if (this.status !== "countdown") return;
    this.status = "live";
    this.emitDuel();
    this.emitDstate();
  }

  setInput(side: 0 | 1, bits: Bits) { this.latest[side] = bits & 63; }

  /** One 60 Hz tick: apply each side's latest bits (a bot side asks botInput), step, emit. True once the match is over. */
  advance(): boolean {
    if (this.status !== "live") return this.state.over;
    const prev = this.state;
    const bits: [Bits, Bits] = [0, 1].map((i) => {
      const lv = this.botLevel[i];
      return (lv ? botInput(prev, i as 0 | 1, lv) : this.latest[i]) & 63;
    }) as [Bits, Bits];
    const next = step(prev, bits[0], bits[1]);
    this.applied[0].push(bits[0]);
    this.applied[1].push(bits[1]);
    this.state = next;
    this.emitHits(prev, next);
    this.emitRound(prev, next);
    if (next.tick % 2 === 0 || next.over) this.emitDstate();
    if (next.over) {
      this.status = "settling";
      this.emitDuel();
    }
    return next.over;
  }

  /** A move connecting (its `hit` flag rising) is a dhit; damage is the defender's hp loss on that tick. */
  private emitHits(prev: DuelState, next: DuelState) {
    if (next.round !== prev.round) return; // the round reset this tick; the KO hit shows in dround's hp
    for (const by of [0, 1] as const) {
      const a0 = prev.f[by], a1 = next.f[by], d0 = prev.f[1 - by], d1 = next.f[1 - by];
      if (a0.hit || !a1.hit) continue;
      const damage = Math.max(0, d0.hp - d1.hp);
      this.emit({
        type: "dhit", duelId: this.id, tick: next.tick, by, move: a1.act, damage, combo: Math.max(a1.combo, d1.combo),
        blocked: d1.act.startsWith("block"),
      });
    }
  }

  /** dround once per round: when a side's round wins go up, or the round number moves on (or the match ends) without that. */
  private emitRound(prev: DuelState, next: DuelState) {
    const r = prev.round;
    if (this.roundsDone.has(r)) return;
    const w0 = next.f[0].rounds - prev.f[0].rounds, w1 = next.f[1].rounds - prev.f[1].rounds;
    const moved = next.round !== prev.round;
    if (!w0 && !w1 && !moved && !next.over) return;
    this.roundsDone.add(r);
    const winner = w0 > 0 ? 0 : w1 > 0 ? 1 : null;
    const hpFrom = moved ? prev : next; // a new round resets hp; report the hp the round ended on
    this.emit({ type: "dround", duelId: this.id, round: r, winner, hp: [Math.max(0, hpFrom.f[0].hp), Math.max(0, hpFrom.f[1].hp)] });
  }

  private emitDstate() {
    const s = this.state;
    this.emit({
      type: "dstate", duelId: this.id, tick: s.tick, round: s.round, roundTick: s.roundTick,
      f: s.f.map((f) => ({ x: f.x, y: f.y, hp: f.hp, facing: f.facing, act: f.act, frame: f.frame, combo: f.combo })),
      rounds: [s.f[0].rounds, s.f[1].rounds],
    });
  }

  logHash(): `0x${string}` { return keccak256(toBytes(this.lines.map((l) => l + "\n").join(""))); }

  /** The book, frozen once at the end of the match. `stored` restores one persisted before a restart. */
  freezeBook(stored?: string): string {
    if (this.bookJson) return this.bookJson;
    if (stored) return (this.bookJson = stored);
    if (this.status !== "settling") throw new Error("freezeBook needs a finished duel");
    const book: DuelBook = {
      mode: "duel", duelId: this.id, players: [this.players[0].player, this.players[1].player], stakeUnits: this.stakeUnits.toString(),
      feeBps: Number(DUEL_FEE_BPS), inputs: [encodeInputs(this.applied[0]), encodeInputs(this.applied[1])], ticks: this.ticks, logHash: this.logHash(),
    };
    this.bookJson = JSON.stringify(book);
    return this.bookJson;
  }

  /** Winner index, from the engine's own state (the book replays to the same). */
  get winnerIndex(): 0 | 1 | null { return this.state.winner; }

  /** dfinal. `potUnits`: the escrow's pot with the chain on. Payout: the win amount, a draw's stake back, 0 for a free fight. */
  emitFinal(potUnits: bigint = this.potUnits): EngineEvent {
    if (!this.bookJson) throw new Error("emitFinal needs a frozen book");
    if (this.finalEvent) return this.finalEvent;
    const w = this.winnerIndex;
    const payout = !this.ranked ? 0n : w === null ? potUnits / 2n : winPayout(potUnits);
    const e: EngineEvent = {
      type: "dfinal", duelId: this.id, winner: w === null ? null : this.players[w].player, winnerSide: w,
      bookHash: keccak256(toBytes(this.bookJson)), rounds: [this.state.f[0].rounds, this.state.f[1].rounds],
      payoutUnits: payout.toString(), ticks: this.ticks, replayHash: stateHash(this.state), ranked: this.ranked,
    };
    this.emit(e);
    return e;
  }

  /** `winners`/`amounts` as paid; a draw lists nobody (the stakes are refunds, not winnings) and carries `refunds`. */
  markSettled(txHash: string, mode: "deployed" | "simulated", via: SettleVia, winners: string[], amounts: string[], extra: Record<string, unknown> = {}) {
    if (this.status === "settled") return;
    this.status = "settled";
    this.emit({ type: "settled", duelId: this.id, txHash, mode, via, winners, amounts, ...extra });
    this.emitDuel();
  }

  cancel(reason: string) {
    if (this.status === "settled" || this.status === "cancelled") return;
    this.status = "cancelled";
    this.cancelReason = reason;
    this.emit({ type: "cancelled", duelId: this.id, reason });
    this.emitDuel();
  }

  catchUp(): EngineEvent[] {
    return [this.lastDuel, ...this.rounds, this.lastDstate, this.finalEvent, this.settledEvent].filter((e): e is EngineEvent => e !== null);
  }

  summary() {
    const s = this.state;
    return {
      duelId: this.id, status: this.status, ranked: this.ranked, stakeUnits: this.stakeUnits.toString(), players: this.players,
      round: s.round, hp: [s.f[0].hp, s.f[1].hp], rounds: [s.f[0].rounds, s.f[1].rounds], startsAt: this.startsAt,
    };
  }

  snapshot() {
    return {
      ...this.summary(), tick: this.state.tick, roundTick: this.state.roundTick, cancelReason: this.cancelReason,
      dstate: this.lastDstate, drounds: this.rounds, dfinal: this.finalEvent, settled: this.settledEvent,
    };
  }
}
