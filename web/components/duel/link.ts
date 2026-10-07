"use client";
// One live duel over WS /ws?duel=:id. The engine is authoritative; the phone sends its input bits whenever they change.
// Your own fighter is predicted locally (the rules stepped from the last `dstate` with your recent inputs), the
// opponent is interpolated between `dstate` frames about 70 ms behind. The big screen uses the same link with no side.
import { step, initDuel, type DuelState, type Fighter } from "./sim";
import type { DuelEvent, DuelPlayer, DuelStatus, WireFighter } from "./types";
import type { RFighter } from "./render";
import { duelWsUrl, getDuel } from "./net";

type Frame = { tick: number; round: number; roundTick: number; f: [WireFighter, WireFighter]; rounds: [number, number]; at: number };
export type LinkInfo = {
  status: DuelStatus | null;
  players: DuelPlayer[];
  stakeUnits: string | null;
  startsAt: number | null;
  final: Extract<DuelEvent, { type: "dfinal" }> | null;
  settled: Extract<DuelEvent, { type: "settled" }> | null;
  cancelled: string | null;
  connected: boolean;
  /** GET /duels/:id said 404: there is no such duel. */
  missing: boolean;
  ranked: boolean | null;
  lastRound: Extract<DuelEvent, { type: "dround" }> | null;
};

const LEAD = 3; // ticks your fighter runs ahead of the last server frame
const BEHIND = 4; // ticks the opponent is drawn behind the newest frame
const MS_PER_TICK = 1000 / 60;

export class DuelLink {
  info: LinkInfo = { status: null, players: [], stakeUnits: null, startsAt: null, final: null, settled: null, cancelled: null, connected: false, missing: false, ranked: null, lastRound: null };
  private frames: Frame[] = [];
  private ws: WebSocket | null = null;
  private subs = new Set<() => void>();
  private seq = 0;
  private sent = -1;
  private history = new Map<number, number>();
  private dead = false;
  private retry = 500;
  private pauseFrom: { round: number; tick: number } | null = null;
  private shownMe: { x: number; y: number } | null = null;

  constructor(
    readonly duelId: number,
    readonly side: 0 | 1 | null,
    private readonly token: string | null,
  ) {
    this.connect();
    void getDuel(duelId)
      .then(({ status, body }) => {
        if (status === 404) {
          // no such duel: stop following it
          this.info.missing = true;
          this.close();
          return this.emit();
        }
        if (body) this.snapshot(body);
      })
      .catch(() => {});
  }

  subscribe(f: () => void) {
    this.subs.add(f);
    return () => void this.subs.delete(f);
  }
  private emit() {
    this.info = { ...this.info };
    this.subs.forEach((f) => f());
  }

  private snapshot(d: Record<string, unknown>) {
    if (Array.isArray(d.players) && !this.info.players.length) this.info.players = d.players as DuelPlayer[];
    if (typeof d.status === "string" && !this.info.status) this.info.status = d.status as DuelStatus;
    if (typeof d.stakeUnits === "string") this.info.stakeUnits = d.stakeUnits;
    if (typeof d.ranked === "boolean") this.info.ranked = d.ranked;
    if (d.dfinal && typeof d.dfinal === "object" && !this.info.final) this.info.final = d.dfinal as LinkInfo["final"];
    if (d.settled && typeof d.settled === "object" && !this.info.settled) this.info.settled = d.settled as LinkInfo["settled"];
    if (d.status === "cancelled" && !this.info.cancelled) this.info.cancelled = typeof d.cancelReason === "string" ? d.cancelReason : "cancelled";
    // an archived duel (finished before this engine started) has no live socket to follow
    if (d.archived === true || this.info.settled || this.info.cancelled) {
      if (d.archived === true || d.status === "settled" || d.status === "cancelled") this.close();
    }
    this.emit();
  }

  private connect() {
    const url = duelWsUrl(this.duelId);
    if (!url || this.dead) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      this.info.connected = true;
      this.sent = -1; // resend the current bits
      this.emit();
    };
    ws.onmessage = (m) => {
      let e: DuelEvent;
      try {
        e = JSON.parse(String(m.data)) as DuelEvent;
      } catch {
        return;
      }
      this.on(e);
    };
    ws.onclose = () => {
      this.info.connected = false;
      this.emit();
      if (this.dead || this.info.settled || this.info.cancelled) return;
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(5000, this.retry * 2);
    };
  }

  private on(e: DuelEvent) {
    switch (e.type) {
      case "duel":
        Object.assign(this.info, { status: e.status, players: e.players ?? this.info.players, stakeUnits: e.stakeUnits ?? this.info.stakeUnits, startsAt: e.startsAt ?? null, ranked: typeof e.ranked === "boolean" ? e.ranked : this.info.ranked });
        return this.emit();
      case "dstate": {
        const fr: Frame = { tick: e.tick, round: e.round, roundTick: e.roundTick, f: e.f, rounds: e.rounds, at: performance.now() };
        const last = this.frames[this.frames.length - 1];
        if (last && fr.tick <= last.tick) return;
        this.frames.push(fr);
        if (this.frames.length > 40) this.frames.shift();
        if (this.info.status !== "live" && !this.info.final) {
          this.info.status = "live";
          this.emit();
        }
        return;
      }
      case "dround":
        this.info.lastRound = e;
        return this.emit();
      case "dfinal":
        this.info.final = e;
        if (this.info.status === "live") this.info.status = "settling";
        return this.emit();
      case "settled":
        this.info.settled = e;
        this.info.status = "settled";
        return this.emit();
      case "cancelled":
        this.info.cancelled = e.reason ?? "cancelled";
        this.info.status = "cancelled";
        return this.emit();
    }
  }

  /** Send your bits when they change (called every frame by the fight screen). */
  input(bits: number) {
    if (this.side === null || !this.token) return;
    const latest = this.frames[this.frames.length - 1];
    if (latest) this.history.set(this.targetTick(latest, performance.now()), bits);
    if (bits === this.sent || this.ws?.readyState !== WebSocket.OPEN) return;
    this.sent = bits;
    this.ws.send(JSON.stringify({ type: "input", sessionToken: this.token, seq: ++this.seq, bits }));
  }

  private targetTick(latest: Frame, now: number) {
    return latest.tick + Math.min(30, Math.floor((now - latest.at) / MS_PER_TICK)) + LEAD;
  }

  private fighterOf(w: WireFighter, rounds: number, prev?: WireFighter, dt = 1): Fighter {
    return {
      x: w.x,
      y: w.y,
      vx: prev && w.y > 0 ? Math.round((w.x - prev.x) / dt) : 0,
      vy: prev && w.y > 0 ? Math.round((w.y - prev.y) / dt) : 0,
      hp: w.hp,
      facing: w.facing,
      act: w.act,
      frame: w.frame,
      combo: w.combo,
      hit: false,
      airUsed: w.act.includes("air"),
      rounds,
    };
  }

  /** Your fighter, stepped from the newest frame up to the present with your recorded inputs. */
  private predict(latest: Frame, prev: Frame | undefined, now: number): Fighter | null {
    if (this.side === null) return null;
    const me = this.side;
    const dt = prev ? Math.max(1, latest.tick - prev.tick) : 1;
    let s: DuelState = {
      ...initDuel(),
      tick: latest.tick,
      round: latest.round,
      roundTick: latest.roundTick,
      pause: 0,
      f: [this.fighterOf(latest.f[0], latest.rounds[0], prev?.f[0], dt), this.fighterOf(latest.f[1], latest.rounds[1], prev?.f[1], dt)],
    };
    if (this.pauseLeft(latest) > 0) return s.f[me];
    const target = this.targetTick(latest, now);
    for (let t = latest.tick + 1; t <= target; t++) {
      const b = this.history.get(t) ?? this.sent;
      s = me === 0 ? step(s, Math.max(0, b), 0) : step(s, 0, Math.max(0, b));
      if (s.round !== latest.round || s.over) break;
    }
    for (const k of this.history.keys()) if (k < latest.tick - 60) this.history.delete(k);
    return s.f[me];
  }

  private pauseLeft(latest: Frame) {
    // dstate carries no pause: count 90 ticks from the first frame of a round at roundTick 0
    if (latest.roundTick > 0) {
      this.pauseFrom = null;
      return 0;
    }
    if (!this.pauseFrom || this.pauseFrom.round !== latest.round) this.pauseFrom = { round: latest.round, tick: latest.tick };
    return Math.max(1, 90 - (latest.tick - this.pauseFrom.tick));
  }

  /** The frame to draw now, or null before the first `dstate`. */
  frame(now: number): { f: [RFighter, RFighter]; round: number; roundTick: number; pause: number; over: boolean; winner: 0 | 1 | null } | null {
    const n = this.frames.length;
    if (!n) return null;
    const latest = this.frames[n - 1];
    const rt = latest.tick + (now - latest.at) / MS_PER_TICK - BEHIND;
    let a = this.frames[0],
      b = latest;
    for (let i = n - 1; i > 0; i--) {
      if (this.frames[i - 1].tick <= rt) {
        a = this.frames[i - 1];
        b = this.frames[i];
        break;
      }
    }
    const t = b.tick === a.tick ? 1 : Math.max(0, Math.min(1, (rt - a.tick) / (b.tick - a.tick)));
    const lerpF = (i: 0 | 1): RFighter => {
      const fa = a.f[i],
        fb = b.f[i];
      const src = t < 0.5 ? fa : fb;
      // a reset between rounds (hp back to full, starting marks) must not slide across the stage
      const jump = Math.abs(fb.x - fa.x) > 1500;
      return { x: jump ? fb.x : fa.x + (fb.x - fa.x) * t, y: jump ? fb.y : fa.y + (fb.y - fa.y) * t, hp: src.hp, facing: src.facing, act: src.act, frame: src.frame, combo: src.combo, rounds: (t < 0.5 ? a : b).rounds[i] };
    };
    const f: [RFighter, RFighter] = [lerpF(0), lerpF(1)];
    const me = this.side;
    if (me !== null && !this.info.final) {
      const p = this.predict(latest, n > 1 ? this.frames[n - 2] : undefined, now);
      if (p) {
        // ease small corrections, snap big ones (a new round)
        const sh = this.shownMe;
        const near = sh && Math.abs(sh.x - p.x) < 1500;
        const x = near ? sh!.x + (p.x - sh!.x) * 0.5 : p.x;
        const y = near ? sh!.y + (p.y - sh!.y) * 0.6 : p.y;
        this.shownMe = { x, y };
        f[me] = { x, y, hp: latest.f[me].hp, facing: p.facing, act: p.act, frame: p.frame, combo: latest.f[me].combo, rounds: latest.rounds[me] };
      }
    }
    const fin = this.info.final;
    const winner = fin ? winnerSideOf(fin, this.info.players) : null;
    if (fin) {
      f[0].rounds = fin.rounds[0];
      f[1].rounds = fin.rounds[1];
    }
    // a final whose winner cannot be placed yet (players unknown) is not shown as a draw: hold the banner
    return { f, round: latest.round, roundTick: latest.roundTick, pause: this.pauseLeft(latest), over: !!fin && winner !== undefined, winner: winner ?? null };
  }

  close() {
    this.dead = true;
    this.ws?.close();
  }
}

/** The winning side of a `dfinal`: its winnerSide, else the winner's place among the players; null a draw;
 *  undefined when the winner is an address not (yet) among the known players. */
export function winnerSideOf(fin: { winner: string | null; winnerSide?: 0 | 1 | null }, players: DuelPlayer[]): 0 | 1 | null | undefined {
  if (fin.winnerSide === 0 || fin.winnerSide === 1) return fin.winnerSide;
  if (fin.winner === null) return fin.winnerSide === null || fin.winnerSide === undefined ? null : undefined;
  const i = players.findIndex((p) => p.player.toLowerCase() === fin.winner!.toLowerCase());
  return i === 0 || i === 1 ? i : undefined;
}
