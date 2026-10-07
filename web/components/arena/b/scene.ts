// The royale arena in the island's world: a cross-section of a toon island under the island's sky. Every player is a
// summit whose altitude is their equity, wearing their avatar's head and an island label chip; the zone is the
// island's sea, which climbs the slopes and, at each checkpoint, surges over the lowest summits. Everything is drawn
// in a 1920x1080 design space, every colour from lib/theme.ts.
import type { EliminatedEvent, Market, Side } from "@/lib/events";
import { MARKETS, STAGE, START_BALANCE, isTxHash, num, presetOf, unitsToUsd } from "@/lib/events";
import type { MatchState } from "@/lib/useMatch";
import { hasEnded, provisionalFinal } from "@/lib/provisional";
import type { AvatarCfg } from "@/lib/island/avatar";
import { GAME, ISLAND, MEANING, coral, coralText, ink, ink2, line as hair, mint, muted, paper, seaDeep, seaFoam, seaMid, seaShallow, sun, violet } from "@/lib/theme";
import { Type, clamp, commas, easeIn, easeOut, easeOutBack, hash, lerp, mmss, rgba, rng, shortHash, smooth, spring, stamp } from "./draw";
import { Confetti, H, HUD_Y, LW, PODIUM, Sky, W, axisChip, botTag, botW, box, countChip, head, headSprite, panel, potChip, settlingChip, step, wordmark } from "./toon";

const PEAK_L = 170;
const PEAK_R = 1470;
const PLOT_BOTTOM = 1000;
const LIVE_TOP = 340;
const FINAL_TOP = 730;
const LOBBY_TOP = 600; // the plateau sits low so twenty equal labels can stack above it
const LINGER = 11; // seconds a drowned summit stays on the map
const RX = 1512; // right-edge labels: cut line and flood
const HR = 20; // head radius on a summit
const POLE = 30; // pennant pole above the head
const LABEL_GAP = 2 * HR + POLE + 16; // summit to the bottom of the label chip's tip
const CHIP_H = 78;
const NAME_PX = 20; // names and figures on the summits, readable from five metres at 1920x1080
const EQ_PX = 24;
const SCORE_BAND = 236 + HUD_Y; // labels never climb into the HUD

type Peak = {
  id: string;
  callsign: string;
  bot: boolean;
  join: number;
  x: number;
  vx: number;
  eq: number;
  veq: number;
  target: number;
  grow: number;
  vgrow: number;
  alive: boolean;
  deadT: number | null;
  reason: "cut" | "zone" | "liquidated" | null;
  checkpoint: number | null;
  rank: number;
  deathEq: number;
  pos: Map<Market, Side>;
  lift: number;
  vlift: number;
  xoff: number;
  vxoff: number;
  vis: number; // label opacity: a label with no free spot fades out instead of overlapping
};

type Gust = { id: string; side: Side; born: number };
type Box = { l: number; r: number; t: number; b: number };

export class Scene {
  T = new Type();
  sky = new Sky(11);
  confetti = new Confetti();
  me: { address: string; cfg: AvatarCfg } | null = null;
  peaks = new Map<string, Peak>();
  lo = 9750;
  hi = 10250;
  vlo = 0;
  vhi = 0;
  top = LIVE_TOP;
  vtop = 0;
  first = true;
  real = 0;
  seen = new WeakSet<object>();
  gusts: Gust[] = [];
  amp = 0;
  cutBoxNow: { y: number; t: number; b: number } | null = null;
  drown = 0;
  leader: string | null = null;
  burstFinal = false;
  burstSettled = false;
  /** The lobby the scene holds state for; following to the next lobby starts the scene over (undefined: none yet). */
  lobbyId: number | null | undefined = undefined;

  /** Forget everything that belongs to one lobby, so the next one loads as if the page had just opened on it. */
  private reset() {
    this.peaks.clear();
    this.lo = 9750;
    this.hi = 10250;
    this.vlo = 0;
    this.vhi = 0;
    this.top = LIVE_TOP;
    this.vtop = 0;
    this.first = true;
    this.seen = new WeakSet<object>();
    this.gusts = [];
    this.amp = 0;
    this.cutBoxNow = null;
    this.drown = 0;
    this.leader = null;
    this.burstFinal = false;
    this.burstSettled = false;
    this.confetti = new Confetti();
    this.T.rolls.clear();
  }

  // ---------- coordinates ----------
  Y(v: number) {
    return PLOT_BOTTOM - ((v - this.lo) / (this.hi - this.lo)) * (PLOT_BOTTOM - this.top);
  }

  // ---------- state ----------
  private sync(s: MatchState, now: number, dt: number, reduced: boolean) {
    if (s.lobbyId !== this.lobbyId) {
      if (this.lobbyId !== undefined) this.reset();
      this.lobbyId = s.lobbyId;
    }
    // only this lobby's players have a summit (a peak left from another roster is dropped)
    const ids = new Set(s.players.map((lp) => lp.player));
    for (const id of [...this.peaks.keys()]) if (!ids.has(id)) this.peaks.delete(id);
    const rows = new Map((s.board?.rows ?? []).map((r) => [r.player, r]));
    const deaths = new Map<string, { e: EliminatedEvent; reason: Peak["reason"]; rank: number }>();
    for (const e of s.eliminations) for (const p of e.players) deaths.set(p.player, { e, reason: p.reason, rank: p.rank });

    s.players.forEach((lp, i) => {
      let p = this.peaks.get(lp.player);
      const row = rows.get(lp.player);
      const target = row ? num(row.equity) : START_BALANCE;
      if (!p) {
        p = {
          id: lp.player,
          callsign: lp.callsign,
          bot: lp.bot,
          join: i,
          x: 0,
          vx: 0,
          eq: this.first ? target : this.lo,
          veq: 0,
          target,
          grow: this.first ? 1 : 0,
          vgrow: 0,
          alive: true,
          deadT: null,
          reason: null,
          checkpoint: null,
          rank: row?.rank ?? i + 1,
          deathEq: target,
          pos: new Map(),
          lift: 0,
          vlift: 0,
          xoff: 0,
          vxoff: 0,
          vis: 1,
        };
        this.peaks.set(lp.player, p);
      }
      p.join = i;
      const d = deaths.get(lp.player);
      if (d && p.deadT === null) {
        p.deadT = d.e.t;
        p.reason = d.reason;
        p.checkpoint = d.e.checkpoint;
        p.rank = d.rank;
        // a liquidated summit falls from where it stood; loaded straight into the moment, from the waterline
        p.deathEq = d.reason === "liquidated" ? (this.first ? this.floodBase(s, now) : Math.max(p.eq, this.lo)) : target;
      }
      // the board is the truth for who is standing (a missed elimination event must not leave a ghost summit)
      p.alive = !d && (row ? row.alive : true);
      if (row && p.alive) p.rank = row.rank;
      p.target = target;
    });
    // the leader wears the crown
    const top = s.board?.rows.find((r) => r.rank === 1 && r.alive);
    this.leader = top ? top.player : null;

    // fills: positions per market and a puff of wind off the summit
    for (const f of s.fills) {
      if (this.seen.has(f)) continue;
      this.seen.add(f);
      const p = this.peaks.get(f.player);
      if (!p) continue;
      if (f.kind === "open") p.pos.set(f.market, f.side);
      else p.pos.delete(f.market);
      if (!this.first && f.kind === "open" && !reduced) this.gusts.push({ id: f.player, side: f.side, born: this.real });
    }
    if (this.gusts.length > 120) this.gusts.splice(0, this.gusts.length - 120);

    // layout: join order, eliminated summits linger through their sequence
    const shown = this.layout(now);
    const n = shown.length;
    shown.forEach((p, i) => {
      const tx = n === 1 ? (PEAK_L + PEAK_R) / 2 : PEAK_L + ((PEAK_R - PEAK_L) * (i + 0.5)) / n;
      const tEq = p.alive ? p.target : p.reason === "liquidated" ? 0 : p.deathEq;
      if (this.first || p.x === 0) {
        p.x = tx;
        if (this.first) p.eq = tEq;
      }
      if (reduced) {
        p.x = tx;
        p.eq = lerp(p.eq, tEq, 1 - Math.exp(-dt * 14));
        p.grow = 1;
      } else {
        [p.x, p.vx] = spring(p.x, p.vx, tx, 6, 0.78, dt);
        [p.eq, p.veq] = spring(p.eq, p.veq, tEq, 7.5, p.reason === "liquidated" ? 0.45 : 0.72, dt);
        [p.grow, p.vgrow] = spring(p.grow, p.vgrow, 1, 9, 0.45, dt);
      }
      if (Math.abs(p.eq - tEq) < 0.004 && Math.abs(p.veq) < 0.05) {
        p.eq = tEq;
        p.veq = 0;
      }
    });

    // vertical scale
    const base = this.floodBase(s, now);
    const vals: number[] = [base];
    for (const p of shown) {
      if (p.alive) vals.push(p.target);
      else if (p.reason !== "liquidated" && p.deadT !== null && now - p.deadT < 3.6) vals.push(p.deathEq);
    }
    if (s.board && s.board.cutEquity !== null && s.status === "live") vals.push(num(s.board.cutEquity));
    const lo = Math.min(...vals);
    let hi = Math.max(...vals, base + 40);
    const span = Math.max(hi - lo, 180);
    hi = Math.max(hi, lo + span);
    const tlo = lo - span * 0.2;
    const thi = hi + span * 0.1;
    const ttop = s.final ? FINAL_TOP : !s.board ? LOBBY_TOP : LIVE_TOP;
    if (this.first || reduced) {
      this.lo = tlo;
      this.hi = thi;
      this.top = ttop;
    } else {
      [this.lo, this.vlo] = spring(this.lo, this.vlo, tlo, 3.2, 1, dt);
      [this.hi, this.vhi] = spring(this.hi, this.vhi, thi, 3.2, 1, dt);
      [this.top, this.vtop] = spring(this.top, this.vtop, ttop, 3, 1, dt);
    }
  }

  private layout(now: number) {
    return [...this.peaks.values()]
      .filter((p) => p.alive || (p.deadT !== null && now - p.deadT < LINGER && now >= p.deadT))
      .sort((a, b) => a.join - b.join);
  }

  private floodBase(s: MatchState, now: number) {
    const t = s.tick;
    if (!t) return num(STAGE.zoneStart);
    const z = num(t.zone);
    const p = s.prevTick;
    if (!p || t.t <= p.t || s.status !== "live") return z;
    const slope = (z - num(p.zone)) / (t.t - p.t);
    if (slope <= 0) return z;
    return z + slope * clamp(now - t.t, 0, 0.3);
  }

  /** Surge envelope for a checkpoint, a pure function of seconds since the cut. */
  private surge(dt: number, reduced: boolean) {
    if (dt < 0.2 || dt > 4.4) return 0;
    const u = dt - 0.2;
    const rise = reduced ? smooth(u / 0.8) : 1 - Math.exp(-u * 6) * Math.cos(u * 8);
    return rise * (1 - smooth((dt - 2.6) / 1.8));
  }

  /** Displayed altitude of a summit, including the collapse after elimination. */
  private alt(p: Peak, now: number) {
    if (p.alive || p.deadT === null) return p.eq;
    if (p.reason === "liquidated") return Math.max(p.eq, this.drown);
    const dt = now - p.deadT;
    return lerp(p.deathEq, Math.min(p.deathEq, this.drown), easeIn((dt - 0.5) / 2.4));
  }

  private sprite(id: string, r = HR) {
    const own = this.me && this.me.address === id.toLowerCase() ? this.me.cfg : null;
    return headSprite(id.toLowerCase(), this.leader === id, r, own);
  }

  // ---------- frame ----------
  dtNow = 0;
  reducedNow = false;
  /** Provisional result between the end time and `final` (the closing candle), cached per leaderboard. */
  private early: { board: MatchState["board"]; fin: MatchState["final"] } | null = null;
  private earlyNow = false;
  frame(ctx: CanvasRenderingContext2D, s0: MatchState, now: number, dt: number, reduced: boolean) {
    // At the end time the arena shows the result at once, ranked from the latest leaderboard and priced at live
    // marks with the shared settle(); `final` replaces it when the closing candle is in.
    let s = s0;
    this.earlyNow = false;
    if (hasEnded(s0, now)) {
      if (!this.early || this.early.board !== s0.board) this.early = { board: s0.board, fin: provisionalFinal(s0) };
      if (this.early.fin) {
        s = { ...s0, final: this.early.fin, finalT: Math.min(now, s0.duration) };
        this.earlyNow = true;
      }
    } else this.early = null;
    this.real += dt;
    this.dtNow = dt;
    this.reducedNow = reduced;
    this.sync(s, now, dt, reduced);
    this.drown = this.floodBase(s, now) - (this.hi - this.lo) * 0.09;
    const shown = this.layout(now);
    const cpEvents = s.eliminations.filter((e) => e.checkpoint !== null && now - e.t >= 0 && now - e.t < 6.5);
    const liqEvents = s.eliminations.filter((e) => e.checkpoint === null && now - e.t >= 0 && now - e.t < 4);

    // sea level, with surge
    const base = this.floodBase(s, now);
    let flood = base;
    for (const e of cpEvents) {
      const victims = e.players.map((v) => this.peaks.get(v.player)).filter((p): p is Peak => !!p);
      if (!victims.length) continue;
      const crest = Math.max(...victims.map((v) => v.deathEq)) + (this.hi - this.lo) * 0.035;
      flood = Math.max(flood, lerp(base, Math.max(base, crest), this.surge(now - e.t, reduced)));
    }

    // final and settled carry no t: time them from when they arrived (match clock, so frozen mock shots stay fixed).
    const finalDt = s.final ? now - (s.finalT ?? now) : -1;
    const settledDt = s.settled ? now - (s.settledT ?? now) : -1;
    const warn = this.warnLevel(s, now);

    this.sky.draw(ctx, this.real, reduced);
    const step0 = niceStep((this.hi - this.lo) / 16);
    this.drawGrid(ctx, step0, false);
    this.drawTerrain(ctx, shown, now, flood);
    this.drawShards(ctx, cpEvents, liqEvents, now, flood, reduced);
    this.drawSea(ctx, flood, base, s, now, warn, reduced, cpEvents.length > 0 && flood > base + 1, cpEvents, shown);
    // confetti flies over land and sea but under every head, chip and the podium, so no payout is ever covered
    this.confetti.draw(ctx, reduced ? 0 : dt);
    this.drawGrid(ctx, step0, true); // the axis reads over land and sea alike
    this.drawCutLine(ctx, s);
    this.drawPeaks(ctx, s, shown, now, flood);
    this.drawGusts(ctx, reduced);
    this.drawFlashes(ctx, cpEvents, liqEvents, now, reduced);

    // HUD, set a little below the top edge so the sky reads above it
    ctx.save();
    ctx.translate(0, HUD_Y);
    this.drawTitle(ctx, s, reduced);
    this.drawMarks(ctx, s, reduced);
    this.drawCenter(ctx, s, now, reduced, cpEvents);
    ctx.restore();
    if (s.final) this.drawFinal(ctx, s, now, finalDt, settledDt, reduced);
    // confetti: a pop on each checkpoint's survivors' side, the final, then a gentle rain once settled
    if (!reduced) {
      if (s.final && !this.burstFinal && finalDt >= 0.5 && finalDt < 6) {
        this.burstFinal = true;
        this.confetti.burst(960, 470, 140, 1.1);
        this.confetti.burst(700, 560, 60, 0.8);
        this.confetti.burst(1220, 560, 60, 0.8);
      }
      if (s.settled && !this.burstSettled && settledDt >= 0 && settledDt < 6) {
        this.burstSettled = true;
        this.confetti.rain(90);
      }
    }
    if (!s.final) this.burstFinal = false;
    if (!s.settled) this.burstSettled = false;
    this.first = false;
  }

  private warnLevel(s: MatchState, now: number) {
    if (!s.warning || !s.tick?.nextCheckpoint) return 0;
    const left = s.tick.nextCheckpoint.at - now;
    return clamp(1 - left / 10);
  }

  // ---------- map ----------
  private drawGrid(ctx: CanvasRenderingContext2D, step: number, labels: boolean) {
    const T = this.T;
    const from = Math.ceil(this.lo / step) * step;
    if (labels) {
      // each value on its own paper chip (legible over sky, land and sea); the start chip first, then every other
      // value that keeps a clear gap from the chips already placed
      const taken: { top: number; bottom: number }[] = [];
      const sy = this.Y(START_BALANCE);
      if (sy >= this.top - 60 && sy <= H) taken.push(axisChip(ctx, T, 102, sy, commas(START_BALANCE.toFixed(0)), true, "start"));
      for (let v = from; v <= this.hi; v += step) {
        if (Math.abs(v - START_BALANCE) < 1e-6) continue;
        const y = this.Y(v);
        if (y < this.top - 60 || y > H - 16) continue;
        if (taken.some((b) => y + 17 > b.top - 4 && y - 15 < b.bottom + 4)) continue;
        taken.push(axisChip(ctx, T, 102, y, commas(v.toFixed(0))));
      }
      return;
    }
    ctx.save();
    ctx.setLineDash([3, 9]);
    for (let v = from; v <= this.hi; v += step) {
      const y = this.Y(v);
      if (y < this.top - 60) continue;
      const isStart = Math.abs(v - START_BALANCE) < 1e-6;
      ctx.strokeStyle = rgba(ink, isStart ? 0.4 : 0.14);
      ctx.lineWidth = isStart ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(110, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private terrainPath(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) {
    ctx.beginPath();
    ctx.moveTo(-40, H + 40);
    if (!pts.length) {
      const y = this.Y(START_BALANCE);
      ctx.lineTo(-40, y);
      ctx.lineTo(W + 40, y);
    } else {
      const f = pts[0];
      ctx.lineTo(-40, Math.min(H + 40, f.y + 260));
      ctx.bezierCurveTo(40, f.y + 200, f.x - 70, f.y + 40, f.x, f.y);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const dx = b.x - a.x;
        const depth = clamp(dx * 0.5, 34, 150);
        const vy = Math.max(a.y, b.y) + depth;
        const mid = (a.x + b.x) / 2;
        ctx.bezierCurveTo(a.x + dx * 0.16, a.y + depth * 0.3, mid - dx * 0.2, vy, mid, vy);
        ctx.bezierCurveTo(mid + dx * 0.2, vy, b.x - dx * 0.16, b.y + depth * 0.3, b.x, b.y);
      }
      const l = pts[pts.length - 1];
      ctx.bezierCurveTo(l.x + 90, l.y + 50, W - 200, l.y + 230, W + 40, Math.min(H + 40, l.y + 320));
    }
    ctx.lineTo(W + 40, H + 40);
    ctx.closePath();
  }

  /** Toon land: flat bands of the island's meadow, grass and sand (the beach follows the sea), one ink outline. */
  private drawTerrain(ctx: CanvasRenderingContext2D, shown: Peak[], now: number, flood: number) {
    const pts = shown.map((p) => ({ x: p.x, y: this.Y(this.alt(p, now)) + (1 - p.grow) * 120 }));
    const sea = this.Y(flood);
    ctx.save();
    this.terrainPath(ctx, pts);
    ctx.clip();
    ctx.fillStyle = ISLAND.grass;
    ctx.fillRect(0, 0, W, H);
    // high ground: the island's lighter meadow
    const meadow = this.top + (PLOT_BOTTOM - this.top) * 0.28;
    ctx.fillStyle = ISLAND.meadow;
    ctx.fillRect(0, 0, W, Math.max(0, meadow));
    ctx.strokeStyle = rgba(ink, 0.18);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, meadow);
    ctx.lineTo(W, meadow);
    ctx.stroke();
    // the beach: a band of sand above the waterline
    const beach = sea - 30;
    ctx.fillStyle = ISLAND.sand;
    ctx.fillRect(0, beach, W, H - beach);
    ctx.beginPath();
    ctx.moveTo(0, beach);
    ctx.lineTo(W, beach);
    ctx.stroke();
    ctx.restore();
    // the island's ink outline
    this.terrainPath(ctx, pts);
    ctx.lineJoin = "round";
    ctx.strokeStyle = ink;
    ctx.lineWidth = LW;
    ctx.stroke();
  }

  /** The heaviest mark on the map: the line you are cut below at the next checkpoint. */
  private drawCutLine(ctx: CanvasRenderingContext2D, s: MatchState) {
    const b = this.cutBox(s);
    if (!b) return;
    const T = this.T;
    const y = b.y;
    ctx.save();
    ctx.setLineDash([24, 12]);
    ctx.lineCap = "butt";
    ctx.lineWidth = 10;
    ctx.strokeStyle = ink;
    ctx.beginPath();
    ctx.moveTo(110, y);
    ctx.lineTo(RX - 14, y);
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = coral;
    ctx.stroke();
    ctx.restore();
    // the value chip: danger is coral, ink on coral
    const vf = T.font("x", 800, 34);
    const label = T.font("d", 700, 18);
    const vw = T.widthOf(ctx, vf, commas(box2(b.line)));
    const w = Math.max(vw, T.w(ctx, label, "Cut line")) + 36;
    box(ctx, RX, y - 46, w, 92, { fill: coral, r: 18, shadow: 4 });
    T.text(ctx, "Cut line", RX + 18, y - 16, label, ink);
    T.odo(ctx, b.line, RX + 18, y + 28, vf, 34, ink, "left");
  }

  /** Where the water will stand at the next checkpoint: the lobby preset's zone line for it. A relative zone follows
   *  the field, so there is no line to project: the checkpoint enforces the zone as it stands, the live `tick.zone`. */
  private zoneAtCheckpoint(s: MatchState): number | null {
    const nc = s.tick?.nextCheckpoint;
    if (s.status !== "live" || !nc) return null;
    if (s.zoneMode === "relative") return num(s.tick!.zone);
    const l = presetOf(s.preset).zoneLines[nc.index - 1];
    return l ? num(l) : null;
  }

  /**
   * The line you are cut below at the next checkpoint: the higher of the rank cut and the
   * sea's level at the checkpoint, never so high that fewer than three would survive.
   */
  private deathLine(s: MatchState): number | null {
    if (!s.board || s.status !== "live" || !s.tick?.nextCheckpoint) return null;
    if (s.board.cutEquity === null) return null;
    let l = num(s.board.cutEquity);
    const z = this.zoneAtCheckpoint(s);
    if (z !== null) l = Math.max(l, z);
    const alive = s.board.rows.filter((r) => r.alive).map((r) => num(r.equity)).sort((a, b) => b - a);
    const keep = Math.min(3, alive.length);
    if (keep > 0 && alive.filter((e) => e >= l).length < keep) l = Math.min(l, alive[keep - 1]);
    return l;
  }

  private cutBox(s: MatchState) {
    const l = this.deathLine(s);
    if (l === null) return null;
    const y = this.Y(l);
    return { y, line: l, t: y - 52, b: y + 52 };
  }

  /** The island's sea: seaMid to seaDeep going down, a seaShallow band and a seaFoam line where it meets the land. */
  private drawSea(
    ctx: CanvasRenderingContext2D,
    level: number,
    base: number,
    s: MatchState,
    now: number,
    warn: number,
    reduced: boolean,
    surging: boolean,
    cps: EliminatedEvent[],
    shown: Peak[],
  ) {
    const T = this.T;
    const y0 = this.Y(level);
    const amp = reduced ? 0 : 3 + warn * 3 + (surging ? 7 : 0);
    this.amp = amp;
    const t = this.real;
    const surf = (x: number) => y0 + Math.sin(x * 0.011 + t * 0.9) * amp + Math.sin(x * 0.031 - t * 1.4) * amp * 0.45;
    const surface = (dy: number) => {
      for (let x = 0; x <= W; x += 12) (x === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, x, surf(x) + dy);
    };
    ctx.save();
    ctx.beginPath();
    surface(0);
    ctx.lineTo(W, H + 10);
    ctx.lineTo(0, H + 10);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, y0 + 20, 0, Math.max(y0 + 21, H));
    g.addColorStop(0, seaMid);
    g.addColorStop(1, seaDeep);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();
    // shallows: the light band just under the surface
    ctx.beginPath();
    surface(0);
    for (let x = W; x >= 0; x -= 12) ctx.lineTo(x, surf(x) + 22 + Math.sin(x * 0.02 + t * 0.6) * 3);
    ctx.closePath();
    ctx.fillStyle = seaShallow;
    ctx.fill();
    // drowned land shows faintly through the water
    const pts = shown.map((p) => ({ x: p.x, y: this.Y(this.alt(p, now)) + (1 - p.grow) * 120 }));
    this.terrainPath(ctx, pts);
    ctx.strokeStyle = rgba(seaShallow, 0.45);
    ctx.lineWidth = 2;
    ctx.stroke();
    // big figures set in the water: the warning countdown, then the result
    const nc = s.tick?.nextCheckpoint;
    const cp = cps[cps.length - 1];
    const deep = (text: string, a: number) => {
      if (a <= 0.01) return;
      ctx.globalAlpha = a;
      T.text(ctx, text, 960, H - 40, T.font("x", 800, 250), rgba(seaDeep, 0.8), "center");
      ctx.globalAlpha = 1;
    };
    if (cp) {
      const d = now - cp.t;
      deep(`${cp.players.length} drowned`, clamp((d - 0.3) / 0.4) * clamp((6 - d) / 0.8));
    } else if (s.warning && nc && s.status === "live") {
      deep(String(Math.max(0, Math.ceil(nc.at - now - 1e-6))), 1);
    }
    ctx.restore();

    // foam where the sea meets the land
    ctx.beginPath();
    surface(0);
    ctx.strokeStyle = seaFoam;
    ctx.lineWidth = surging ? 8 : 5;
    ctx.lineJoin = "round";
    ctx.stroke();
    if (!reduced) {
      // foam flecks riding the swell, more on a surge
      ctx.fillStyle = seaFoam;
      const every = surging ? 11 : 37;
      for (let x = 6; x < W; x += every) {
        const j = (hash("f" + x) % 100) / 100;
        const r = 1.5 + j * (surging ? 3 : 2);
        ctx.beginPath();
        ctx.arc(x + Math.sin(t * 2 + j * 9) * 4, surf(x) + 7 + j * 12, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // where the water will stand at the next checkpoint
    let note = "";
    const at = this.zoneAtCheckpoint(s);
    if (nc && at !== null && s.zoneMode === "relative") {
      note = `follows the field, cuts at checkpoint ${nc.index}`;
    } else if (nc && at !== null) {
      note = `rises to ${commas(Math.round(at).toFixed(0))} by checkpoint ${nc.index}`;
      const hy = this.Y(at);
      ctx.save();
      ctx.setLineDash([6, 8]);
      ctx.strokeStyle = rgba(seaDeep, 0.5 + warn * 0.5);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(110, hy);
      ctx.lineTo(PEAK_R + 20, hy);
      ctx.stroke();
      ctx.restore();
    } else if (s.status === "live" || s.status === "settling" || s.status === "settled" || s.final) note = "holding, checkpoints are over";
    else note = "rises once the match starts";

    // one chip for the sea, at the right edge, kept clear of the cut-line chip
    let ly = y0 + 22;
    const cb = this.cutBox(s);
    if (cb && ly < cb.b + 8 && ly + 76 > cb.t) ly = cb.b + 16;
    ly = Math.min(ly, H - 92);
    const head = surging ? "Surge" : "Flood";
    const hf = T.font("d", 700, 18);
    const vf = T.font("x", 800, 24);
    const nf = T.font("c", 600, 18);
    const val = commas(box2(surging ? level : base));
    const w = Math.max(T.w(ctx, hf, head + " ") + T.widthOf(ctx, vf, val), T.w(ctx, nf, note)) + 32;
    box(ctx, RX, ly, Math.min(w, W - RX - 16), 72, { r: 18, shadow: 4 });
    T.text(ctx, head, RX + 16, ly + 30, hf, seaDeep);
    T.odo(ctx, surging ? level : base, RX + 16 + T.w(ctx, hf, head + " "), ly + 31, vf, 24, seaDeep, "left");
    T.text(ctx, note, RX + 16, ly + 56, nf, ink2);
  }

  private drawPeaks(ctx: CanvasRenderingContext2D, s: MatchState, shown: Peak[], now: number, flood: number) {
    const l = this.deathLine(s);
    const podium = new Set(s.final ? rankedFinal(s).slice(0, 3).map((f) => f.player) : []);
    const finalIds = new Set(s.final?.finalists.map((f) => f.player) ?? []);
    const surfY = this.Y(flood);
    const obstacles: Box[] = s.final ? [podiumBox()] : [];
    const lifts = this.placeLabels(ctx, s, shown, now, surfY - this.amp * 1.5 - 8, podium, obstacles);
    const drowned = this.placeDrowned(ctx, shown, now, surfY);
    this.cutBoxNow = this.cutBox(s);
    const labels: (() => void)[] = [];
    for (const p of shown) {
      const y = this.Y(this.alt(p, now)) + (1 - p.grow) * 120;
      if (!p.alive) {
        this.drawDrowned(ctx, p, y, now, drowned.get(p.id) ?? NaN);
        continue;
      }
      if (podium.has(p.id)) {
        // the podium holds this player: the summit keeps a sun flag with their place
        this.placeFlag(ctx, p.x, y, rankedFinal(s).findIndex((f) => f.player === p.id) + 1);
        continue;
      }
      const lobby = !s.board;
      const atRisk = l !== null && p.target < l;
      ctx.save();
      ctx.globalAlpha = clamp(p.grow * 1.4);
      const g = Math.max(0.01, p.grow);
      const hy = y - HR * g;
      // wind pennants on a pole behind the head: mint flies right for long, violet flies left for short
      let longs = 0;
      let shorts = 0;
      for (const side of p.pos.values()) side === 1 ? longs++ : shorts++;
      if (longs || shorts) {
        const top = y - 2 * HR - POLE;
        ctx.strokeStyle = ink;
        ctx.lineWidth = LW;
        ctx.beginPath();
        ctx.moveTo(p.x, hy);
        ctx.lineTo(p.x, top);
        ctx.stroke();
        const flap = this.reducedNow ? 0 : Math.sin(this.real * 5 + p.x * 0.05) * 3;
        const pennant = (dir: number, c: string, dy: number) => {
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.moveTo(p.x, top + dy);
          ctx.quadraticCurveTo(p.x + dir * 14, top + dy + 4 + flap, p.x + dir * 30, top + dy + 9 + flap * 0.5);
          ctx.lineTo(p.x, top + dy + 18);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = ink;
          ctx.lineWidth = 2;
          ctx.stroke();
        };
        if (longs) pennant(1, MEANING.long.fill, 0);
        if (shorts) pennant(-1, MEANING.short.fill, longs ? 4 : 0);
      }
      if (atRisk) {
        // at risk: a coral ring that breathes around the head
        const pulse = this.reducedNow ? 0.6 : 0.5 + 0.5 * Math.sin(this.real * 6);
        ctx.beginPath();
        ctx.arc(p.x, hy, HR + 8 + pulse * 4, 0, Math.PI * 2);
        ctx.strokeStyle = ink;
        ctx.lineWidth = 8;
        ctx.stroke();
        ctx.strokeStyle = coral;
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      head(ctx, this.sprite(p.id, HR), p.x, hy, HR * g);
      ctx.restore();
      // label, drawn after every head
      const spot = lifts.get(p.id);
      const shownLabel = spot !== null;
      const [target, tx] = spot ?? [p.lift, p.xoff];
      p.vis = this.first || this.reducedNow ? (shownLabel ? 1 : 0) : clamp(p.vis + (shownLabel ? 1 : -1) * this.dtNow * 6);
      if (this.first || this.reducedNow || (shownLabel && p.vis < 0.2)) {
        p.lift = target;
        p.xoff = tx;
      } else {
        [p.lift, p.vlift] = spring(p.lift, p.vlift, target, 10, 0.85, this.dtNow);
        [p.xoff, p.vxoff] = spring(p.xoff, p.vxoff, tx, 10, 0.85, this.dtNow);
      }
      const tipY = y - LABEL_GAP - p.lift;
      const lx = p.x + p.xoff;
      const fin = s.final && finalIds.has(p.id) ? s.final.finalists.find((f) => f.player === p.id) : undefined;
      if (p.vis <= 0.01) continue;
      labels.push(() => {
        ctx.save();
        ctx.globalAlpha = clamp(p.grow * 1.4) * p.vis;
        if (p.lift > 4 || Math.abs(p.xoff) > 4) {
          ctx.strokeStyle = rgba(ink, 0.55);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(p.x, y - 2 * HR - 4);
          ctx.lineTo(lx, tipY);
          ctx.stroke();
        }
        this.chip(ctx, p, lx, tipY, lobby ? null : p.eq, fin ? this.payoutOf(s, p.id) : null, payNote(s));
        ctx.restore();
      });
    }
    for (const f of labels) f();
  }

  /** The island label chip: name and bot tag, equity as a sun (profit) or coral (loss) pill, its tip at (x, tipY).
   *  A finalist's chip adds the payout and its status (provisional, paid, or offline). */
  private chip(ctx: CanvasRenderingContext2D, p: Peak, x: number, tipY: number, eq: number | null, payout: string | null, note = "") {
    const T = this.T;
    const { w, h } = this.chipSize(ctx, p, payout);
    const top = tipY - 10 - 4 - h;
    const l = x - w / 2;
    box(ctx, l, top, w, h, { r: 20, shadow: 4, pointer: true, fill: paper });
    const nf = T.font("d", 700, NAME_PX);
    const nw = T.w(ctx, nf, p.callsign);
    const bw = p.bot ? botW(ctx, this.T) + 6 : 0;
    const nx = x - (nw + bw) / 2;
    T.text(ctx, p.callsign, nx, top + 30, nf, ink);
    if (p.bot) botTag(ctx, this.T, nx + nw + 6, top + 11);
    const v = eq ?? START_BALANCE;
    const ef = T.font("x", 700, EQ_PX);
    const ew = T.widthOf(ctx, ef, commas(box2(v)));
    const pw = ew + 18;
    let py = top + 40;
    const fill = eq === null ? hair : v >= START_BALANCE ? MEANING.profit.fill : MEANING.loss.fill;
    box(ctx, x - pw / 2, py, pw, 30, { fill, r: 15, shadow: 0, line: LW });
    T.odo(ctx, v, x, py + 23, ef, EQ_PX, ink, "center");
    if (payout) {
      py += 36;
      T.text(ctx, money(payout), x, py + 26, T.font("x", 800, 28), ink, "center");
      T.text(ctx, note, x, py + 48, T.font("c", 600, 17), ink2, "center");
    }
  }

  private chipSize(ctx: CanvasRenderingContext2D, p: Peak, payout: string | null) {
    const T = this.T;
    const nw = T.w(ctx, T.font("d", 700, NAME_PX), p.callsign) + (p.bot ? botW(ctx, this.T) + 6 : 0);
    const ew = T.widthOf(ctx, T.font("x", 700, EQ_PX), "10,000.00") + 18;
    const aw = payout ? Math.max(T.widthOf(ctx, T.font("x", 800, 28), money(payout)), T.w(ctx, T.font("c", 600, 17), "offline, nothing paid")) : 0;
    return { w: Math.max(nw, ew, aw) + 26, h: CHIP_H + (payout ? 58 : 0) };
  }

  /** A sun flag on an empty summit, numbered with the podium place its player took. */
  private placeFlag(ctx: CanvasRenderingContext2D, x: number, y: number, place: number) {
    const T = this.T;
    const top = y - 64;
    ctx.strokeStyle = ink;
    ctx.lineWidth = LW;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, top);
    ctx.stroke();
    const wave = this.reducedNow ? 0 : Math.sin(this.real * 4 + x) * 3;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.quadraticCurveTo(x + 22, top + 4 + wave, x + 44, top + 13);
    ctx.lineTo(x, top + 30);
    ctx.closePath();
    ctx.fillStyle = sun;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.stroke();
    T.text(ctx, String(place), x + 15, top + 21, T.font("x", 800, 16), ink, "center");
  }

  /** A drowned summit: its head sinks into the sea and its name chip, in loss coral, fades over ten seconds. */
  private drawDrowned(ctx: CanvasRenderingContext2D, p: Peak, y: number, now: number, labelY: number) {
    const T = this.T;
    const ddt = now - (p.deadT as number);
    ctx.save();
    if (ddt < 0.35 && p.reason !== "liquidated") {
      // the instant of the cut: a coral flash around the head before it goes under
      ctx.globalAlpha = 1 - ddt / 0.35;
      ctx.beginPath();
      ctx.arc(p.x, y - HR, HR + 14, 0, Math.PI * 2);
      ctx.fillStyle = coral;
      ctx.fill();
    }
    if (p.reason === "liquidated" && ddt < 3.4) {
      // the callout, in the sky where the summit stood
      ctx.globalAlpha = clamp(1 - (ddt - 2.6) / 0.8) * clamp(ddt / 0.15);
      const cb = this.cutBoxNow;
      const cy = Math.min(this.Y(p.deathEq), cb ? cb.t : H) - 50;
      const nf = T.font("d", 800, 24);
      const lf = T.font("d", 700, 18);
      const w = Math.max(T.w(ctx, nf, p.callsign), T.w(ctx, lf, "liquidated") + 24) + 32;
      box(ctx, p.x - w / 2, cy - 64, w, 84, { r: 20, shadow: 4, fill: paper });
      T.text(ctx, p.callsign, p.x, cy - 32, nf, ink, "center");
      const lw2 = T.w(ctx, lf, "liquidated") + 24;
      box(ctx, p.x - lw2 / 2, cy - 22, lw2, 30, { fill: coral, r: 15, shadow: 0, line: 2 });
      T.text(ctx, "liquidated", p.x, cy - 1, lf, ink, "center");
    }
    const a = clamp((ddt - 0.6) / 0.5) * clamp(1 - (ddt - 1.1) / (LINGER - 1.6));
    if (a > 0.01) {
      ctx.globalAlpha = a * 0.75;
      head(ctx, this.sprite(p.id, HR), p.x, y - HR, HR);
      ctx.globalAlpha = a;
      if (Number.isNaN(labelY)) {
        ctx.restore();
        return;
      }
      if (labelY > y + 6) {
        ctx.strokeStyle = rgba(seaFoam, 0.6);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x, y + 2);
        ctx.lineTo(p.x, labelY - 22);
        ctx.stroke();
      }
      const nf = T.font("d", 700, 19);
      const w = this.tagWidth(ctx, p) + 24;
      box(ctx, p.x - w / 2, labelY - 26, w, 36, { r: 18, shadow: 3, fill: paper, line: LW });
      const nw = T.w(ctx, nf, p.callsign);
      const bw = p.bot ? botW(ctx, this.T) + 6 : 0;
      const nx = p.x - (nw + bw) / 2;
      T.text(ctx, p.callsign, nx, labelY - 1, nf, coralText);
      if (p.bot) botTag(ctx, this.T, nx + nw + 6, labelY - 19);
    }
    ctx.restore();
  }

  private tagWidth(ctx: CanvasRenderingContext2D, p: Peak) {
    const T = this.T;
    return T.w(ctx, T.font("d", 700, 19), p.callsign) + (p.bot ? botW(ctx, this.T) + 6 : 0);
  }

  /** Living labels: kept above the wave crest, the highest summits keep their spot, lower ones climb clear. */
  private placeLabels(
    ctx: CanvasRenderingContext2D,
    s: MatchState,
    shown: Peak[],
    now: number,
    crest: number,
    skip: Set<string>,
    obstacles: Box[],
  ) {
    const out = new Map<string, [number, number] | null>();
    const boxes: Box[] = [...obstacles];
    const cb = this.cutBox(s);
    if (cb) {
      boxes.push({ l: RX - 10, r: W, t: cb.t, b: cb.b + 8 });
      boxes.push({ l: 0, r: W, t: cb.y - 8, b: cb.y + 8 });
    }
    const finalIds = new Set(s.final?.finalists.map((f) => f.player) ?? []);
    // who gets a label first: you, the leader, the summits at risk (closest to the line first), then by height
    const l = this.deathLine(s);
    const mine = (p: Peak) => !!this.me && this.me.address === p.id.toLowerCase();
    const prio = (p: Peak) => (mine(p) ? 0 : p.id === this.leader ? 1 : l !== null && p.target < l ? 2 : 3);
    const order = shown.filter((p) => p.alive && !skip.has(p.id)).sort((a, b) => prio(a) - prio(b) || b.eq - a.eq);
    // every head and pennant is an obstacle too, so a label never covers someone's face
    for (const p of shown) {
      if (!p.alive || skip.has(p.id)) continue;
      const y = this.Y(this.alt(p, now)) + (1 - p.grow) * 120;
      boxes.push({ l: p.x - HR - 8, r: p.x + HR + 8, t: y - 2 * HR - POLE - 6, b: y });
    }
    const hits = (l: number, r: number, t: number, b: number) => boxes.find((o) => o.l < r && o.r > l && o.t < b && o.b > t);
    for (const p of order) {
      const y = this.Y(this.alt(p, now)) + (1 - p.grow) * 120;
      const { w: cw, h: ch } = this.chipSize(ctx, p, finalIds.has(p.id) ? "00.00" : null);
      const w = cw + 6;
      const h = ch + 18;
      const bottom = y - LABEL_GAP + 4;
      // climb straight up; if the climb runs into the HUD, try a step to either side; no room at all hides the label
      let best: { b: number; dx: number } | null = null;
      for (const dx of [0, w * 0.6, -w * 0.6, w * 1.1, -w * 1.1]) {
        const x = p.x + dx;
        if (x - w / 2 < 116 || x + w / 2 > W - 16) continue;
        let b = Math.min(bottom, crest);
        for (let k = 0; k < 16; k++) {
          const hit = hits(x - w / 2, x + w / 2, b - h, b);
          if (!hit) break;
          b = hit.t - 4;
        }
        const band = bandFor(x - w / 2, x + w / 2, !!s.final) + h;
        if (b >= band) {
          best = { b, dx };
          break;
        }
      }
      if (!best) {
        out.set(p.id, null);
        continue;
      }
      out.set(p.id, [Math.max(0, bottom - best.b), best.dx]);
      boxes.push({ l: p.x + best.dx - w / 2, r: p.x + best.dx + w / 2, t: best.b - h, b: best.b });
    }
    return out;
  }

  /** Drowned labels sit in the water and push down past each other. Returns each name's baseline. */
  private placeDrowned(ctx: CanvasRenderingContext2D, shown: Peak[], now: number, surfY: number) {
    const out = new Map<string, number>();
    const boxes: Box[] = [];
    const dead = shown.filter((p) => !p.alive).sort((a, b) => a.join - b.join);
    for (const p of dead) {
      const y = this.Y(this.alt(p, now));
      const w = this.tagWidth(ctx, p) + 30;
      const h = 38;
      const first = surfY + 30;
      const rows = Math.max(1, Math.floor((H - 4 - first) / (h + 4)));
      const k0 = clamp(Math.floor((y + 8 - first) / (h + 4)), 0, rows - 1);
      const free = (k: number) => {
        const tt = first + k * (h + 4);
        return !boxes.some((o) => o.l < p.x + w / 2 && o.r > p.x - w / 2 && o.t < tt + h && o.b > tt);
      };
      let k = -1;
      for (let j = k0; j < rows && k < 0; j++) if (free(j)) k = j;
      for (let j = k0 - 1; j >= 0 && k < 0; j--) if (free(j)) k = j;
      if (k < 0) continue; // no room this frame; the head still shows
      const t = first + k * (h + 4);
      boxes.push({ l: p.x - w / 2, r: p.x + w / 2, t, b: t + h });
      out.set(p.id, t + 26);
    }
    return out;
  }

  private drawGusts(ctx: CanvasRenderingContext2D, reduced: boolean) {
    if (reduced) return;
    this.gusts = this.gusts.filter((g) => this.real - g.born < 1.3);
    for (const g of this.gusts) {
      const p = this.peaks.get(g.id);
      if (!p || !p.alive) continue;
      const age = (this.real - g.born) / 1.3;
      const y = this.Y(p.eq) - HR - g.side * easeOut(age) * 70;
      ctx.strokeStyle = rgba(g.side === 1 ? mint : violet, 1 - age);
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let k = -1; k <= 1; k++) {
        const x = p.x + k * 10 + Math.sin(age * 6 + k) * 4;
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + g.side * 14);
      }
      ctx.stroke();
    }
  }

  /** Toon shards popping off a cut summit, falling into the sea with a splash. */
  private drawShards(
    ctx: CanvasRenderingContext2D,
    cps: EliminatedEvent[],
    liqs: EliminatedEvent[],
    now: number,
    flood: number,
    reduced: boolean,
  ) {
    if (reduced) return;
    const wy = this.Y(flood);
    for (const e of [...cps, ...liqs]) {
      const dt = now - e.t - (e.checkpoint === null ? 0.12 : 0.35);
      if (dt < 0 || dt > 3.5) continue;
      for (const v of e.players) {
        const p = this.peaks.get(v.player);
        if (!p) continue;
        const r = rng(hash(v.player) ^ Math.round(e.t * 1000));
        const x0 = p.x;
        const y0 = this.Y(p.deathEq) - HR;
        const col = p.deathEq >= START_BALANCE ? sun : coral;
        for (let k = 0; k < 16; k++) {
          const vx = (r() - 0.5) * 240;
          const vy = -(140 + r() * 300);
          const spin = (r() - 0.5) * 14;
          const sz = 6 + r() * 8;
          const x = x0 + vx * dt;
          let y = y0 + vy * dt + 0.5 * 780 * dt * dt;
          let a = 1;
          if (y > wy) {
            const depth = y - wy;
            y = wy + depth * 0.35;
            a = clamp(1 - depth / 200);
          }
          if (a <= 0) continue;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(spin * dt + k);
          ctx.globalAlpha = a;
          ctx.beginPath();
          ctx.moveTo(0, -sz);
          ctx.lineTo(sz * 0.8, sz * 0.6);
          ctx.lineTo(-sz * 0.6, sz * 0.4);
          ctx.closePath();
          ctx.fillStyle = col;
          ctx.fill();
          ctx.strokeStyle = ink;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
        }
        // splash rings where the summit meets the water
        const sdt = dt - 0.4;
        if (sdt > 0 && sdt < 2.4) {
          for (let k = 0; k < 3; k++) {
            const q = sdt - k * 0.25;
            if (q <= 0) continue;
            ctx.strokeStyle = rgba(seaFoam, clamp(1 - q / 2) * 0.9);
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.ellipse(x0, wy, 10 + q * 60, 3 + q * 9, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    }
  }

  /** A checkpoint or a liquidation lands as one bright beat: a quick paper flash over the scene. */
  private drawFlashes(ctx: CanvasRenderingContext2D, cps: EliminatedEvent[], liqs: EliminatedEvent[], now: number, reduced: boolean) {
    for (const e of [...cps, ...liqs]) {
      const dt = now - e.t;
      const big = e.checkpoint !== null;
      const a = reduced ? 0.15 * clamp(1 - dt / 0.6) : (big ? 0.5 : 0.25) * Math.exp(-dt * 5);
      if (a > 0.005) {
        ctx.fillStyle = rgba(paper, a);
        ctx.fillRect(0, 0, W, H);
      }
    }
  }

  // ---------- HUD ----------
  private drawTitle(ctx: CanvasRenderingContext2D, s: MatchState, reduced: boolean) {
    const T = this.T;
    wordmark(ctx, T, `Lobby ${s.lobbyId}`, GAME.royale);
    const x = potChip(ctx, T, "$" + commas(unitsToUsd(s.potUnits)), this.real, reduced);
    const alive = s.board ? s.board.rows.filter((r) => r.alive).length : s.players.length;
    const total = s.players.length;
    const word = s.board ? `standing of ${total}` : total === 1 ? "player in" : "players in";
    countChip(ctx, T, x + 12, "alive", String(alive), word, this.real, reduced);
  }

  private drawMarks(ctx: CanvasRenderingContext2D, s: MatchState, reduced: boolean) {
    const T = this.T;
    const marks = s.final?.marks ?? s.tick?.marks;
    const prev = s.prevTick?.marks;
    const R0 = 1888;
    const w = 300;
    MARKETS.forEach((m, i) => {
      const y = 24 + i * 62;
      box(ctx, R0 - w, y, w, 50, { r: 25, shadow: 4, fill: paper });
      T.text(ctx, m, R0 - w + 18, y + 33, T.font("d", 700, 18), ink);
      if (!marks) {
        T.text(ctx, "waiting", R0 - 22, y + 32, T.font("c", 600, 20), muted, "right");
        return;
      }
      const v = commas(marks[m]);
      const d = prev && !s.final ? num(marks[m]) - num(prev[m]) : 0;
      // marks update at 4 Hz: a short roll, so the cents settle between updates
      T.roll(ctx, "m" + m, v, R0 - 44, y + 34, T.font("x", 700, 26), 26, ink, "right", this.real, reduced, d < 0 ? -1 : 1, 0.12);
      // the tick arrow
      const ax = R0 - 26;
      const ay = y + 25;
      ctx.fillStyle = d === 0 ? hair : ink;
      ctx.beginPath();
      if (d >= 0) {
        ctx.moveTo(ax, ay - 8);
        ctx.lineTo(ax + 7, ay + 4);
        ctx.lineTo(ax - 7, ay + 4);
      } else {
        ctx.moveTo(ax, ay + 8);
        ctx.lineTo(ax + 7, ay - 4);
        ctx.lineTo(ax - 7, ay - 4);
      }
      ctx.closePath();
      ctx.fill();
    });
  }

  private drawCenter(ctx: CanvasRenderingContext2D, s: MatchState, now: number, reduced: boolean, cps: EliminatedEvent[]) {
    const T = this.T;
    const cx = 960;
    if (s.final) return;
    const cp = cps[cps.length - 1];
    const cpDt = cp ? now - cp.t : 99;
    const bannerA = cp ? clamp(cpDt / 0.25) * clamp((5.5 - cpDt) / 0.6) : 0;
    const normalA = 1 - bannerA;

    if (bannerA > 0 && cp) {
      ctx.save();
      ctx.globalAlpha = bannerA;
      const sc = reduced ? 1 : 1 + 0.18 * Math.exp(-cpDt * 5);
      ctx.translate(cx, 110);
      ctx.scale(sc, sc);
      ctx.translate(-cx, -110);
      const alive = s.board ? s.board.rows.filter((r) => r.alive).length : 0;
      const n = cp.players.length;
      const sub = `${n} ${n === 1 ? "summit" : "summits"} went under. ${alive} still standing.`;
      const w = Math.max(T.w(ctx, T.font("c", 600, 26), sub), T.w(ctx, T.font("d", 800, 60), `Checkpoint ${cp.checkpoint}`)) + 80;
      panel(ctx, T, cx, w, 196, "The sea surged", GAME.royale);
      T.text(ctx, `Checkpoint ${cp.checkpoint}`, cx, 140, T.font("d", 800, 60), ink, "center");
      T.text(ctx, sub, cx, 186, T.font("c", 600, 26), ink2, "center");
      ctx.restore();
    }
    if (normalA <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = normalA;
    const big = T.font("x", 800, 96);
    if (!s.status || s.status === "open" || s.status === "countdown") {
      if (s.status === "countdown") {
        panel(ctx, T, cx, 420, 196, "Starting in", GAME.royale);
        T.roll(ctx, "start", String(Math.max(0, Math.ceil(-now - 1e-6))), cx, 160, big, 96, ink, "center", this.real, reduced);
        T.text(ctx, "Every summit starts at 10,000.", cx, 196, T.font("c", 500, 20), ink2, "center");
      } else {
        panel(ctx, T, cx, 560, 196, "Waiting for players", GAME.royale);
        const w = T.roll(ctx, "joined", String(s.players.length), cx - 40, 152, big, 96, ink, "center", this.real, reduced);
        T.text(ctx, "joined", cx - 40 + w / 2 + 14, 150, T.font("d", 700, 26), ink2, "left");
        T.text(ctx, "Every summit starts at 10,000. Survive the flood.", cx, 194, T.font("c", 500, 20), ink2, "center");
      }
    } else {
      const nc = s.tick?.nextCheckpoint;
      const end = s.duration - now;
      if (nc) {
        const left = nc.at - now;
        const warn = !!s.warning;
        panel(ctx, T, cx, 420, 200, `Checkpoint ${nc.index} in`, warn ? coral : GAME.royale);
        const beat = warn && !reduced ? 1 + 0.08 * Math.exp(-((Math.ceil(left) - left) % 1) * 7) : 1;
        ctx.save();
        ctx.translate(cx, 156);
        ctx.scale(beat, beat);
        T.roll(ctx, "cp", mmss(left), 0, 0, big, 96, warn ? coralText : ink, "center", this.real, reduced);
        ctx.restore();
      } else {
        panel(ctx, T, cx, 420, 200, "Final in", GAME.royale);
        T.roll(ctx, "cp", mmss(end), cx, 156, big, 96, ink, "center", this.real, reduced);
      }
      const l = this.deathLine(s);
      if (nc && s.warning && s.board && l !== null) {
        const n = s.board.rows.filter((r) => r.alive && num(r.equity) < l).length;
        T.text(ctx, `${n} below the line`, cx, 196, T.font("d", 700, 22), coralText, "center");
      } else if (nc) {
        T.text(ctx, `Match ends in ${mmss(end)}`, cx, 196, T.font("c", 600, 20), ink2, "center");
      }
    }
    ctx.restore();
  }

  // ---------- final ----------
  private payoutOf(s: MatchState, id: string) {
    if (this.earlyNow) return CALC;
    const fin = s.final!;
    const settled = s.settled;
    if (settled) {
      const i = settled.winners.findIndex((w) => w.toLowerCase() === id.toLowerCase());
      return commas(unitsToUsd(i >= 0 ? settled.amounts[i] : "0"));
    }
    return commas(unitsToUsd(fin.finalists.find((x) => x.player === id)?.provisionalPayoutUnits ?? "0"));
  }

  private drawFinal(ctx: CanvasRenderingContext2D, s: MatchState, now: number, finalDt: number, settledDt: number, reduced: boolean) {
    const T = this.T;
    const fin = s.final!;
    const settled = s.settled;
    const ranked = rankedFinal(s);
    const units = (id: string) => {
      if (settled) {
        const i = settled.winners.findIndex((w) => w.toLowerCase() === id.toLowerCase());
        return i >= 0 ? settled.amounts[i] : "0";
      }
      return fin.finalists.find((x) => x.player === id)?.provisionalPayoutUnits ?? "0";
    };
    const maxU = Math.max(1, ...ranked.map((f) => Number(units(f.player))));
    // the stream leaves from just under the pot chip, so it never crosses the HUD chips
    const potX = 130;
    const potY = 166 + HUD_Y;
    const places = podiumPlaces(ranked.length);

    // the pot streams to the finalists
    if (!reduced && finalDt > 0.8 && finalDt < 5.6) {
      // about four seconds of coins, then it stops
      const fade = clamp((finalDt - 0.8) / 0.8) * clamp((5.6 - finalDt) / 0.8);
      ranked.forEach((f, fi) => {
        const p = this.peaks.get(f.player);
        if (!p) return;
        const place = places[fi];
        const tx = place ? place.x : p.x;
        const ty = place ? place.top - 40 : this.Y(p.eq) - HR;
        const cxp = (potX + tx) / 2;
        const cyp = Math.min(potY, ty) - 60;
        const k = 6 + Math.round(24 * (Number(units(f.player)) / maxU));
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.5;
        for (let i = 0; i < k; i++) {
          const u = (i / k + this.real * 0.32 + fi * 0.13) % 1;
          const x = (1 - u) * (1 - u) * potX + 2 * (1 - u) * u * cxp + u * u * tx;
          const y = (1 - u) * (1 - u) * potY + 2 * (1 - u) * u * cyp + u * u * ty;
          ctx.globalAlpha = fade * Math.sin(u * Math.PI);
          ctx.fillStyle = sun;
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      });
    }

    // the island's podium: gold in the middle, silver left, bronze right
    ranked.slice(0, 3).forEach((f, i) => {
      const pl = places[i];
      if (!pl) return;
      const reveal = reduced ? clamp((finalDt - i * 0.15) / 0.4) : easeOutBack((finalDt - 0.3 - (2 - i) * 0.18) / 0.6);
      const rise = clamp(reveal);
      step(ctx, pl.x - pl.w / 2, pl.base - pl.h, pl.w, pl.h, pl.fill, rise);
      if (rise <= 0.02) return;
      ctx.save();
      ctx.globalAlpha = clamp(reveal * 2);
      const top = pl.base - pl.h * rise;
      // place number on the step face
      T.text(ctx, String(i + 1), pl.x, top + Math.min(pl.h * rise - 8, 46), T.font("d", 800, 34), ink, "center");
      // the head, bobbing in a little dance on the top step
      const bob = reduced ? 0 : Math.abs(Math.sin(this.real * 3.2 + i)) * (i === 0 ? 8 : 5);
      const r = i === 0 ? 42 : 36;
      const hy = top - r - 4 - bob;
      head(ctx, this.sprite(f.player, r), pl.x, hy, r);
      // name, equity and payout in a chip above the head
      const nf = T.font("d", 800, i === 0 ? 24 : 20);
      const ef = T.font("x", 700, 20);
      const af = T.font("x", 800, i === 0 ? 34 : 28);
      const p = this.peaks.get(f.player);
      const amt = this.earlyNow ? CALC : "$" + commas(unitsToUsd(units(f.player)));
      const eqv = p ? p.eq : num(f.equity);
      const bot = p?.bot ?? false;
      const bw = bot ? botW(ctx, this.T) + 6 : 0;
      const nameW = T.w(ctx, nf, f.callsign) + bw;
      const w = Math.max(nameW, T.widthOf(ctx, ef, commas(box2(eqv))) + 16, T.widthOf(ctx, af, amt) + 20) + 28;
      const h = i === 0 ? 150 : 138;
      const ct = hy - r * 2.05 - 12 - h;
      box(ctx, pl.x - w / 2, ct, w, h, { r: 20, shadow: 4, pointer: true, fill: paper });
      const nx = pl.x - nameW / 2;
      T.text(ctx, f.callsign, nx, ct + 30, nf, ink);
      if (bot) botTag(ctx, this.T, nx + nameW - bw + 6, ct + 14);
      const ew = T.widthOf(ctx, ef, commas(box2(eqv))) + 16;
      box(ctx, pl.x - ew / 2, ct + 40, ew, 24, { fill: eqv >= START_BALANCE ? MEANING.profit.fill : MEANING.loss.fill, r: 12, shadow: 0, line: 2 });
      T.odo(ctx, eqv, pl.x, ct + 59, ef, 20, ink, "center");
      const aw = T.widthOf(ctx, af, amt) + 20;
      const ay = ct + 72;
      box(ctx, pl.x - aw / 2, ay, aw, i === 0 ? 46 : 40, { fill: sun, r: 16, shadow: 0, line: 2 });
      T.roll(ctx, "pay" + f.player, amt, pl.x, ay + (i === 0 ? 35 : 30), af, i === 0 ? 34 : 28, ink, "center", this.real, reduced);
      T.text(ctx, payNote(s), pl.x, ct + h - 10, T.font("c", 600, 16), ink2, "center");
      ctx.restore();
    });

    // headline panel
    const w0 = ranked[0];
    const hA = reduced ? clamp(finalDt / 0.5) : easeOut(finalDt / 0.8);
    ctx.save();
    ctx.globalAlpha = hA;
    const total = ranked.reduce((a, f) => a + BigInt(units(f.player)), 0n);
    const title = `${w0.callsign} holds the high ground`;
    // Count only finalists with a non-zero payout: the split is pro rata to profit, so finalists at or under the
    // start balance are paid nothing.
    const paid = ranked.filter((f) => BigInt(units(f.player)) > 0n).length;
    const who = paid === ranked.length ? `${paid} ${paid === 1 ? "finalist" : "finalists"}` : `${paid} of ${ranked.length} finalists`;
    const usd = `$${commas(unitsToUsd(total.toString()))}`;
    const sub =
      settled && !isTxHash(settled.txHash)
        ? `${who} ${paid === 1 ? "takes" : "split"} ${usd}. Settled offline (no chain), nothing paid.`
        : settled
          ? `${who} ${paid === 1 ? "was" : "were"} paid ${usd} from the pot.`
          : this.earlyNow
            ? `${ranked.length} ${ranked.length === 1 ? "finalist" : "finalists"} at live prices. Payouts are calculated from the closing price.`
            : `${who} ${paid === 1 ? "takes" : "split"} ${usd}. Payouts are provisional until settlement.`;
    ctx.translate(0, HUD_Y);
    const tf = T.font("d", 800, 44);
    const sf = T.font("c", 600, 24);
    const w = Math.min(1180, Math.max(T.w(ctx, tf, title), T.w(ctx, sf, sub)) + 80);
    panel(ctx, T, 960, w, 196, "Final", GAME.royale);
    T.text(ctx, title, 960, 116, tf, ink, "center");
    T.text(ctx, sub, 960, 156, sf, ink2, "center");
    T.text(ctx, this.earlyNow ? "Final book after the closing candle" : `Book ${shortHash(fin.bookHash)}`, 960, 190, T.font("x", 600, 18), muted, "center");
    ctx.restore();

    // between final and settled: the report is on its way; it cross-fades out as the seal lands in its place
    const pend = !settled ? 1 : settledDt >= 0 ? 1 - settledDt / (reduced ? 0.4 : 0.25) : 1;
    if (!s.cancelled)
      settlingChip(
        ctx,
        T,
        1888,
        366,
        finalDt,
        this.real,
        reduced,
        pend * hA,
        this.earlyNow ? "Payouts are calculated once it lands" : "Payouts are provisional until it lands",
        this.earlyNow ? "Waiting for the closing price" : "Chainlink CRE is running the settlement",
        this.earlyNow ? "Last one-minute Coinbase candle" : "Report to Base Sepolia",
      );
    if (settled && settledDt >= 0) stamp(ctx, T, settled.txHash, settled.mode, settledDt, reduced, 1700, 420);
  }
}

/** How high a label may climb at this x: below the centre panel in the middle, below the corner chips elsewhere. */
function bandFor(l: number, r: number, final: boolean) {
  if (r > 650 && l < 1270) return SCORE_BAND;
  if (final && r > 1500) return 580; // the settlement seal
  if (l < 480) return 168 + HUD_Y;
  if (r > 1570) return 214 + HUD_Y;
  return 150 + HUD_Y;
}

/** The status under a payout: provisional until settled, then paid, or the offline wording for a no-chain settlement. */
function payNote(s: MatchState) {
  if (!s.settled) return "provisional";
  return isTxHash(s.settled.txHash) ? "paid" : "offline, nothing paid";
}

/** Finalists by equity, highest first (the podium order). */
function rankedFinal(s: MatchState) {
  return [...(s.final?.finalists ?? [])].sort((a, b) => num(b.equity) - num(a.equity));
}

const POD_BASE = 655;
const POD_W = 170;
function podiumPlaces(n: number) {
  const out: { x: number; w: number; h: number; base: number; fill: string; top: number }[] = [];
  const spec: [number, number, string][] = [
    [960, 100, PODIUM.gold],
    [960 - POD_W - 6, 72, PODIUM.silver],
    [960 + POD_W + 6, 50, PODIUM.bronze],
  ];
  for (let i = 0; i < Math.min(3, n); i++) out.push({ x: spec[i][0], w: POD_W, h: spec[i][1], base: POD_BASE, fill: spec[i][2], top: POD_BASE - spec[i][1] });
  return out;
}
function podiumBox(): Box {
  return { l: 960 - POD_W * 1.5 - 20, r: 960 + POD_W * 1.5 + 20, t: 220, b: POD_BASE + 10 };
}

/** A value as the 2-decimal string the odometer will draw (for measuring). */
function box2(v: number) {
  return Math.max(0, v).toFixed(2);
}

function niceStep(raw: number) {
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
  for (const s of steps) if (s >= raw) return s;
  return 10000;
}

/** Before the closing price, payouts read "Calculating…": live-price amounts can differ a lot from the final ones. */
const CALC = "Calculating…";
function money(payout: string) {
  return payout === CALC ? CALC : "$" + payout;
}
