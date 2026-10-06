// The storm: a survey cross-section of a mountain range. Every player is a summit whose
// altitude is their equity; the zone is a flood that climbs the contours and, at each
// checkpoint, surges over the lowest peaks. Everything is drawn in a 1920x1080 design space.
import type { EliminatedEvent, Market, Side } from "@/lib/events";
import { MARKETS, STAGE, START_BALANCE, num, presetOf, unitsToUsd } from "@/lib/events";
import type { MatchState } from "@/lib/useMatch";
import {
  C,
  Type,
  clamp,
  commas,
  easeIn,
  easeOut,
  easeOutBack,
  hash,
  lerp,
  mmss,
  ramp,
  rgba,
  rng,
  shortHash,
  smooth,
  spring,
  stamp,
} from "./draw";

const W = 1920;
const H = 1080;
const PEAK_L = 170;
const PEAK_R = 1470;
const PLOT_BOTTOM = 1000;
const LIVE_TOP = 330;
const FINAL_TOP = 560;
const LOBBY_TOP = 600; // the plateau sits low so twenty equal labels can stack above it
const LINGER = 11; // seconds a drowned summit stays on the map
const RX = 1512; // right-edge labels: cut line and flood
const POLE = 34; // pennant pole above the summit triangle
const LABEL_GAP = 26 + POLE + 12; // summit to equity baseline

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
};

type Gust = { id: string; side: Side; born: number };
type Drop = { x: number; y: number; len: number; sp: number };
type Box = { l: number; r: number; t: number; b: number };

export class Scene {
  T: Type;
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
  drops: Drop[] = [];
  amp = 0;
  cutBoxNow: { y: number; t: number; b: number } | null = null;
  drown = 0;

  constructor(cond: string, xc: string) {
    this.T = new Type(cond, xc);
    const r = rng(11);
    for (let i = 0; i < 280; i++) this.drops.push({ x: r() * (W + 300), y: r() * H, len: 14 + r() * 26, sp: 900 + r() * 700 });
  }

  // ---------- coordinates ----------
  Y(v: number) {
    return PLOT_BOTTOM - ((v - this.lo) / (this.hi - this.lo)) * (PLOT_BOTTOM - this.top);
  }

  // ---------- state ----------
  private sync(s: MatchState, now: number, dt: number, reduced: boolean) {
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
      p.alive = !d;
      if (row && p.alive) p.rank = row.rank;
      p.target = target;
    });

    // fills: positions per market and a gust of wind off the summit
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
      let tEq = p.alive ? p.target : p.reason === "liquidated" ? 0 : p.deathEq;
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
    let lo = Math.min(...vals);
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

  /** Storm surge envelope for a checkpoint, a pure function of seconds since the cut. */
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

  // ---------- frame ----------
  dtNow = 0;
  reducedNow = false;
  frame(ctx: CanvasRenderingContext2D, s: MatchState, now: number, dt: number, reduced: boolean) {
    this.real += dt;
    this.dtNow = dt;
    this.reducedNow = reduced;
    this.sync(s, now, dt, reduced);
    this.drown = this.floodBase(s, now) - (this.hi - this.lo) * 0.09;
    const shown = this.layout(now);
    const cpEvents = s.eliminations.filter((e) => e.checkpoint !== null && now - e.t >= 0 && now - e.t < 6.5);
    const liqEvents = s.eliminations.filter((e) => e.checkpoint === null && now - e.t >= 0 && now - e.t < 4);

    // flood level, with surge
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

    // sky
    const clear = s.final ? smooth(finalDt / 3) : 0;
    ctx.fillStyle = clear > 0 ? mix(C.sky, C.skyClear, clear) : C.sky;
    ctx.fillRect(0, 0, W, H);
    if (warn > 0 && !reduced) {
      ctx.fillStyle = rgba("#050d1a", 0.2 * warn);
      ctx.fillRect(0, 0, W, H);
    }

    const step = niceStep((this.hi - this.lo) / 16);
    this.drawSkyGrid(ctx, step, false);
    this.drawTerrain(ctx, shown, now, step);
    this.drawSkyGrid(ctx, step, true);
    this.drawShards(ctx, cpEvents, liqEvents, now, flood, reduced);
    this.drawFlood(ctx, flood, base, s, now, warn, reduced, cpEvents.length > 0 && flood > base + 1, cpEvents);
    this.drawVignette(ctx, warn, !!s.warning && s.status === "live" && !!s.tick?.nextCheckpoint);
    this.drawCutLine(ctx, s);
    this.drawPeaks(ctx, s, shown, now, flood);
    this.drawGusts(ctx, reduced);
    if (!reduced) this.drawRain(ctx, s, dt, warn, finalDt);
    this.drawStrikes(ctx, cpEvents, liqEvents, now, flood, reduced);

    // HUD
    this.drawTitle(ctx, s, now, reduced);
    this.drawMarks(ctx, s, now, reduced);
    this.drawCenter(ctx, s, now, reduced, cpEvents, finalDt);
    if (s.final) this.drawFinal(ctx, s, shown, now, finalDt, settledDt, reduced);
    this.first = false;
  }

  private warnLevel(s: MatchState, now: number) {
    if (!s.warning || !s.tick?.nextCheckpoint) return 0;
    const left = s.tick.nextCheckpoint.at - now;
    return clamp(1 - left / 10);
  }

  // ---------- map ----------
  private drawSkyGrid(ctx: CanvasRenderingContext2D, step: number, labels: boolean) {
    const T = this.T;
    const from = Math.ceil(this.lo / step) * step;
    ctx.save();
    ctx.setLineDash([2, 7]);
    for (let v = from; v <= this.hi; v += step) {
      const y = this.Y(v);
      if (y < this.top - 60) continue;
      const isStart = Math.abs(v - START_BALANCE) < 1e-6;
      if (labels) {
        const nearStart = !isStart && v < START_BALANCE && this.Y(START_BALANCE) + 36 > y - 10 && this.Y(START_BALANCE) < y;
        if (nearStart) continue;
        T.text(ctx, commas(v.toFixed(0)), 100, y + 8, T.font("x", 600, 23), rgba(C.ink, isStart ? 1 : 0.72), "right", C.sky);
        if (isStart) T.text(ctx, "start", 100, y + 32, T.font("c", 600, 22), rgba(C.ink, 0.8), "right", C.sky);
        continue;
      }
      ctx.strokeStyle = rgba(C.ink, isStart ? 0.32 : 0.1);
      ctx.lineWidth = 1;
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

  private drawTerrain(ctx: CanvasRenderingContext2D, shown: Peak[], now: number, step: number) {
    const pts = shown.map((p) => ({ x: p.x, y: this.Y(this.alt(p, now)) + (1 - p.grow) * 120 }));
    ctx.save();
    this.terrainPath(ctx, pts);
    ctx.clip();
    // hypsometric tint: one band per contour interval, cool below the start balance, warm above
    const from = Math.floor(this.lo / step) * step - step * 4;
    ctx.fillStyle = ramp(0);
    ctx.fillRect(0, 0, W, H);
    for (let v = from; v < this.hi + step; v += step) {
      const y0 = this.Y(v);
      const y1 = this.Y(v + step);
      const mid = v + step / 2;
      const t =
        mid < START_BALANCE
          ? 0.42 * clamp((mid - this.lo) / Math.max(1, START_BALANCE - this.lo))
          : 0.42 + 0.58 * clamp((mid - START_BALANCE) / Math.max(1, this.hi - START_BALANCE));
      ctx.fillStyle = ramp(t);
      ctx.fillRect(0, Math.min(y1, H), W, Math.max(0, Math.min(y0, H + 40) - y1));
    }
    // contour lines, every fifth one an index contour
    for (let v = from; v < this.hi + step; v += step) {
      const y = this.Y(v);
      if (y > H || y < 0) continue;
      const index = Math.round(v / step) % 5 === 0;
      ctx.strokeStyle = rgba("#10201b", index ? 0.55 : 0.32);
      ctx.lineWidth = index ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    // hachures: short strokes down the slopes give the relief its grain
    ctx.strokeStyle = rgba("#0d1a16", 0.22);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 6; x < W; x += 9) {
      const r = ((hash(String(x)) % 1000) / 1000) * 30;
      for (let y = 0; y < H; y += 48) {
        ctx.moveTo(x, y + r);
        ctx.lineTo(x - 3, y + r + 9);
      }
    }
    ctx.stroke();
    ctx.restore();
    // ridge line
    this.terrainPath(ctx, pts);
    ctx.strokeStyle = rgba(C.ink, 0.85);
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /** The heaviest mark on the map: the line you are cut below at the next checkpoint. */
  private drawCutLine(ctx: CanvasRenderingContext2D, s: MatchState) {
    const box = this.cutBox(s);
    if (!box) return;
    const T = this.T;
    const y = box.y;
    ctx.save();
    ctx.setLineDash([22, 12]);
    ctx.lineCap = "butt";
    ctx.lineWidth = 9;
    ctx.strokeStyle = rgba(C.sky, 0.7);
    ctx.beginPath();
    ctx.moveTo(110, y);
    ctx.lineTo(W - 24, y);
    ctx.stroke();
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = C.chalk;
    ctx.stroke();
    ctx.restore();
    T.text(ctx, "Cut line", RX, y - 58, T.font("c", 800, 26), C.chalk, "left", C.sky);
    T.odo(ctx, box.line, RX, y - 14, T.font("x", 800, 44), 44, C.chalk, "left", "", C.sky);
  }

  /** Where the water will stand at the next checkpoint: the lobby preset's zone line for it. */
  private zoneAtCheckpoint(s: MatchState): number | null {
    const nc = s.tick?.nextCheckpoint;
    if (s.status !== "live" || !nc) return null;
    const line = presetOf(s.preset).zoneLines[nc.index - 1];
    return line ? num(line) : null;
  }

  /**
   * The line you are cut below at the next checkpoint: the higher of the rank cut and the
   * flood's level at the checkpoint, never so high that fewer than three would survive.
   */
  private deathLine(s: MatchState): number | null {
    if (!s.board || s.status !== "live" || !s.tick?.nextCheckpoint) return null;
    if (s.board.cutEquity === null) return null;
    let line = num(s.board.cutEquity);
    const z = this.zoneAtCheckpoint(s);
    if (z !== null) line = Math.max(line, z);
    const alive = s.board.rows.filter((r) => r.alive).map((r) => num(r.equity)).sort((a, b) => b - a);
    const keep = Math.min(3, alive.length);
    if (keep > 0 && alive.filter((e) => e >= line).length < keep) line = Math.min(line, alive[keep - 1]);
    return line;
  }

  private cutBox(s: MatchState) {
    const line = this.deathLine(s);
    if (line === null) return null;
    const y = this.Y(line);
    return { y, line, t: y - 84, b: y + 4 };
  }

  private drawFlood(
    ctx: CanvasRenderingContext2D,
    level: number,
    base: number,
    s: MatchState,
    now: number,
    warn: number,
    reduced: boolean,
    surging: boolean,
    cps: EliminatedEvent[],
  ) {
    const T = this.T;
    const y0 = this.Y(level);
    const amp = reduced ? 0 : 3 + warn * 6 + (surging ? 7 : 0);
    this.amp = amp;
    const t = this.real;
    const surf = (x: number) => y0 + Math.sin(x * 0.017 + t * 1.3) * amp + Math.sin(x * 0.043 - t * 2.2) * amp * 0.45;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, H + 10);
    for (let x = 0; x <= W; x += 12) ctx.lineTo(x, surf(x));
    ctx.lineTo(W, H + 10);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, y0, 0, Math.max(y0 + 1, H));
    g.addColorStop(0, rgba(C.flood, 0.8));
    g.addColorStop(1, rgba(C.floodDeep, 0.95));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();
    // radar sweep bands drifting through the water
    ctx.strokeStyle = rgba(C.floodHi, 0.09);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const off = (t * 14) % 16;
    for (let y = y0 + off; y < H; y += 16) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
    // type set dark inside the water: the warning countdown, then the result
    const nc = s.tick?.nextCheckpoint;
    const cp = cps[cps.length - 1];
    const deep = (text: string, a: number) => {
      if (a <= 0.01) return;
      ctx.globalAlpha = a;
      T.text(ctx, text, 960, H - 34, T.font("x", 800, 330), rgba(C.floodDeep, 0.85), "center");
      ctx.globalAlpha = 1;
    };
    if (cp) {
      const d = now - cp.t;
      deep(`${cp.players.length} drowned`, clamp((d - 0.3) / 0.4) * clamp((6 - d) / 0.8));
    } else if (s.warning && nc && s.status === "live") {
      deep(String(Math.max(0, Math.ceil(nc.at - now - 1e-6))), 1);
    }
    ctx.restore();

    ctx.beginPath();
    for (let x = 0; x <= W; x += 12) (x === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, x, surf(x));
    ctx.strokeStyle = C.floodHi;
    ctx.lineWidth = surging ? 5 : 2.5;
    ctx.stroke();
    if (surging && !reduced) {
      // foam riding the surge crest
      ctx.fillStyle = rgba("#E8EEFF", 0.75);
      for (let x = 6; x < W; x += 11) {
        const j = (hash("f" + x) % 100) / 100;
        const r = 1.2 + j * 2.4;
        ctx.beginPath();
        ctx.arc(x + Math.sin(t * 3 + j * 9) * 3, surf(x) - 2 + j * 7, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // where the water will stand at the next checkpoint
    let note = "";
    const at = this.zoneAtCheckpoint(s);
    if (nc && at !== null) {
      note = `rises to ${commas(Math.round(at).toFixed(0))} by checkpoint ${nc.index}`;
      const hy = this.Y(at);
      ctx.save();
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = rgba(C.floodHi, 0.35 + warn * 0.5);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(110, hy);
      ctx.lineTo(PEAK_R + 20, hy);
      ctx.stroke();
      ctx.restore();
    } else if (s.status === "live" || s.final) note = "holding, checkpoints are over";
    else note = "rises once the match starts";

    // one label for the flood, at the right edge, kept clear of the cut-line label
    let ly = y0 + 40;
    const cb = this.cutBox(s);
    if (cb && ly - 28 < cb.b && ly + 34 > cb.t) ly = cb.b + 32;
    ly = Math.min(ly, H - 44);
    const head = surging ? "Storm surge" : "Flood";
    T.text(ctx, head, RX, ly, T.font("c", 800, 26), C.floodHi);
    T.odo(ctx, surging ? level : base, RX + T.w(ctx, T.font("c", 800, 26), head + " "), ly, T.font("x", 800, 28), 28, C.floodHi, "left");
    T.text(ctx, note, RX, ly + 30, T.font("c", 600, 22), rgba(C.floodHi, 0.9));
  }

  private drawPeaks(ctx: CanvasRenderingContext2D, s: MatchState, shown: Peak[], now: number, flood: number) {
    const T = this.T;
    const line = this.deathLine(s);
    const finalIds = new Set(s.final?.finalists.map((f) => f.player) ?? []);
    const surfY = this.Y(flood);
    const lifts = this.placeLabels(ctx, s, shown, now, surfY - this.amp * 1.5 - 8, finalIds);
    const drowned = this.placeDrowned(ctx, shown, now, surfY);
    this.cutBoxNow = this.cutBox(s);
    for (const p of shown) {
      if (s.final && finalIds.has(p.id)) continue; // drawn by the podium
      const y = this.Y(this.alt(p, now)) + (1 - p.grow) * 120;
      if (!p.alive) {
        this.drawDrowned(ctx, p, y, now, drowned.get(p.id) ?? NaN);
        continue;
      }
      const lobby = !s.board;
      const col = lobby ? C.chalk : p.eq >= START_BALANCE ? C.profit : C.loss;
      const atRisk = line !== null && p.target < line;
      ctx.save();
      ctx.globalAlpha = clamp(p.grow * 1.4);
      const g = Math.max(0.01, p.grow);
      // marker: a survey summit triangle
      ctx.beginPath();
      ctx.moveTo(p.x, y - 26 * g);
      ctx.lineTo(p.x + 15 * g, y);
      ctx.lineTo(p.x - 15 * g, y);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = C.sky;
      ctx.stroke();
      if (atRisk) {
        // at risk: a white ring that breathes, separate from the loss colour
        const pulse = this.reducedNow ? 0.6 : 0.5 + 0.5 * Math.sin(this.real * 6);
        ctx.beginPath();
        ctx.arc(p.x, y - 10, 27 + pulse * 5, 0, Math.PI * 2);
        ctx.strokeStyle = rgba("#FFFFFF", 0.55 + pulse * 0.45);
        ctx.lineWidth = 3.5;
        ctx.stroke();
      }
      // wind pennant: teal flies right for long, violet flies left for short
      let longs = 0;
      let shorts = 0;
      for (const side of p.pos.values()) side === 1 ? longs++ : shorts++;
      if (longs || shorts) {
        const top = y - 26 - POLE;
        ctx.strokeStyle = C.chalk;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(p.x, y - 24);
        ctx.lineTo(p.x, top);
        ctx.stroke();
        const flap = this.reducedNow ? 0 : Math.sin(this.real * 5 + p.x * 0.05) * 3;
        const pennant = (dir: number, c: string, dy: number) => {
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.moveTo(p.x, top + dy);
          ctx.quadraticCurveTo(p.x + dir * 16, top + dy + 5 + flap, p.x + dir * 34, top + dy + 11 + flap * 0.5);
          ctx.lineTo(p.x, top + dy + 22);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = C.sky;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        };
        if (longs) pennant(1, C.long, 0);
        if (shorts) pennant(-1, C.short, longs ? 4 : 0);
      }
      // label
      const target = lifts.get(p.id) ?? 0;
      if (this.first || this.reducedNow) p.lift = target;
      else [p.lift, p.vlift] = spring(p.lift, p.vlift, target, 10, 0.85, this.dtNow);
      const ly = y - LABEL_GAP - p.lift;
      if (p.lift > 4) {
        ctx.strokeStyle = rgba(C.chalk, 0.55);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.x, y - 26 - POLE);
        ctx.lineTo(p.x, ly + 6);
        ctx.stroke();
      }
      T.odo(ctx, p.eq, p.x, ly, T.font("x", 700, 26), 26, col, "center", "", C.sky);
      this.nameTag(ctx, p, p.x, ly - 28, C.chalk, C.sky);
      ctx.restore();
    }
  }

  private nameTag(ctx: CanvasRenderingContext2D, p: Peak, x: number, y: number, color: string, halo: string) {
    const T = this.T;
    const nameF = T.font("c", 800, 26);
    const botF = T.font("c", 600, 22);
    const nw = T.w(ctx, nameF, p.callsign);
    const bw = p.bot ? T.w(ctx, botF, "BOT") + 7 : 0;
    const nx = x - (nw + bw) / 2;
    T.text(ctx, p.callsign, nx, y, nameF, color, "left", halo);
    if (p.bot) T.text(ctx, "BOT", nx + nw + 7, y, botF, rgba(C.chalk, 0.62), "left", halo);
  }

  private tagWidth(ctx: CanvasRenderingContext2D, p: Peak) {
    const T = this.T;
    return T.w(ctx, T.font("c", 800, 26), p.callsign) + (p.bot ? T.w(ctx, T.font("c", 600, 22), "BOT") + 7 : 0);
  }

  /** A drowned summit: a dim shape under the water with its name in loss red, fading over ten seconds. */
  private drawDrowned(ctx: CanvasRenderingContext2D, p: Peak, y: number, now: number, labelY: number) {
    const T = this.T;
    const ddt = now - (p.deadT as number);
    ctx.save();
    if (ddt < 0.35 && p.reason !== "liquidated") {
      // the instant of the cut: the marker flashes before it shatters
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, y - 26);
      ctx.lineTo(p.x + 15, y);
      ctx.lineTo(p.x - 15, y);
      ctx.closePath();
      ctx.fillStyle = mix(C.loss, "#ffffff", 1 - ddt / 0.35);
      ctx.fill();
    }
    if (p.reason === "liquidated" && ddt < 3.4) {
      // the strike callout, in the sky where the summit stood
      ctx.globalAlpha = clamp(1 - (ddt - 2.6) / 0.8) * clamp(ddt / 0.15);
      const cb = this.cutBoxNow;
      const cy = Math.min(this.Y(p.deathEq), cb ? cb.t : H) - 50;
      T.text(ctx, p.callsign, p.x, cy - 32, T.font("c", 800, 34), C.loss, "center", C.sky);
      T.text(ctx, "liquidated", p.x, cy, T.font("c", 700, 26), C.chalk, "center", C.sky);
    }
    const a = clamp((ddt - 0.6) / 0.5) * clamp(1 - (ddt - 1.1) / (LINGER - 1.6));
    if (a > 0.01) {
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(p.x, y - 26);
      ctx.lineTo(p.x + 15, y);
      ctx.lineTo(p.x - 15, y);
      ctx.closePath();
      ctx.strokeStyle = rgba(C.loss, 0.7);
      ctx.lineWidth = 2;
      ctx.stroke();
      if (Number.isNaN(labelY)) {
        ctx.restore();
        return;
      }
      if (labelY > y + 6) {
        ctx.strokeStyle = rgba(C.loss, 0.45);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.x, y + 2);
        ctx.lineTo(p.x, labelY - 22);
        ctx.stroke();
      }
      this.nameTag(ctx, p, p.x, labelY, C.loss, C.floodDeep);
    }
    ctx.restore();
  }

  /** Living labels: kept above the wave crest, the highest summits keep their spot, lower ones climb clear. */
  private placeLabels(
    ctx: CanvasRenderingContext2D,
    s: MatchState,
    shown: Peak[],
    now: number,
    crest: number,
    skip: Set<string>,
  ) {
    const out = new Map<string, number>();
    const boxes: Box[] = [];
    const cb = this.cutBox(s);
    if (cb) {
      boxes.push({ l: RX - 10, r: W, t: cb.t, b: cb.b });
      boxes.push({ l: 0, r: W, t: cb.y - 8, b: cb.y + 8 });
    }
    const order = shown.filter((p) => p.alive && !skip.has(p.id)).sort((a, b) => b.eq - a.eq);
    for (const p of order) {
      const y = this.Y(this.alt(p, now)) + (1 - p.grow) * 120;
      const w = Math.max(this.tagWidth(ctx, p), 96) + 14;
      const h = 58;
      const bottom = y - LABEL_GAP + 8;
      let b = Math.min(bottom, crest);
      for (let k = 0; k < 16; k++) {
        const hit = boxes.find((o) => o.l < p.x + w / 2 && o.r > p.x - w / 2 && o.t < b && o.b > b - h);
        if (!hit) break;
        b = hit.t - 4;
      }
      b = Math.max(b, 236 + h); // never climb into the scoreboard band
      out.set(p.id, Math.max(0, bottom - b));
      boxes.push({ l: p.x - w / 2, r: p.x + w / 2, t: b - h, b });
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
      const w = this.tagWidth(ctx, p) + 14;
      const h = 32;
      // fixed rows under the surface, so names never overlap: start at the summit's own row,
      // search down, then up
      const first = surfY + 26;
      const rows = Math.max(1, Math.floor((H - 4 - first) / (h + 4)));
      const k0 = clamp(Math.floor((y + 8 - first) / (h + 4)), 0, rows - 1);
      const free = (k: number) => {
        const tt = first + k * (h + 4);
        return !boxes.some((o) => o.l < p.x + w / 2 && o.r > p.x - w / 2 && o.t < tt + h && o.b > tt);
      };
      let k = -1;
      for (let j = k0; j < rows && k < 0; j++) if (free(j)) k = j;
      for (let j = k0 - 1; j >= 0 && k < 0; j--) if (free(j)) k = j;
      if (k < 0) continue; // no room this frame; the silhouette still shows
      const t = first + k * (h + 4);
      boxes.push({ l: p.x - w / 2, r: p.x + w / 2, t, b: t + h });
      out.set(p.id, t + 25);
    }
    return out;
  }

  private drawVignette(ctx: CanvasRenderingContext2D, warnRaw: number, warning: boolean) {
    if (!warning) return;
    const warn = 0.35 + 0.65 * warnRaw;
    // the lens closes in through the ten-second warning; the strike releases it
    const inner = lerp(1000, 240, smooth(warn));
    const g = ctx.createRadialGradient(960, 600, inner, 960, 600, inner + 700);
    g.addColorStop(0, "rgba(4,10,18,0)");
    g.addColorStop(1, `rgba(4,10,18,${0.92 * smooth(warn)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  private drawGusts(ctx: CanvasRenderingContext2D, reduced: boolean) {
    if (reduced) return;
    this.gusts = this.gusts.filter((g) => this.real - g.born < 1.3);
    for (const g of this.gusts) {
      const p = this.peaks.get(g.id);
      if (!p || !p.alive) continue;
      const age = (this.real - g.born) / 1.3;
      const y = this.Y(p.eq) - 10 - g.side * easeOut(age) * 70;
      ctx.strokeStyle = rgba(g.side === 1 ? C.long : C.short, (1 - age) * 0.9);
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = -1; k <= 1; k++) {
        const x = p.x + k * 9 + Math.sin(age * 6 + k) * 4;
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + g.side * 14);
      }
      ctx.stroke();
    }
  }

  private drawRain(ctx: CanvasRenderingContext2D, s: MatchState, dt: number, warn: number, finalDt: number) {
    let I = s.status === "live" ? 0.45 + warn * 0.55 : s.board ? 0.3 : 0.18;
    if (s.final) I *= 1 - smooth(finalDt / 2.5);
    if (I <= 0.01) return;
    const count = Math.floor(this.drops.length * I);
    ctx.strokeStyle = rgba(C.floodHi, 0.16 + 0.14 * warn);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      d.y += d.sp * dt;
      d.x -= d.sp * 0.22 * dt;
      if (d.y > H) {
        d.y -= H + 40;
        d.x = (d.x + 300 + W * 0.37) % (W + 300);
      }
      if (i >= count) continue;
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + d.len * 0.22, d.y - d.len);
    }
    ctx.stroke();
  }

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
        const y0 = this.Y(e.checkpoint === null ? p.deathEq : p.deathEq) - 10;
        const col = p.deathEq >= START_BALANCE ? C.profit : C.loss;
        for (let k = 0; k < 22; k++) {
          const vx = (r() - 0.5) * 240;
          const vy = -(140 + r() * 300);
          const spin = (r() - 0.5) * 14;
          const sz = 5 + r() * 8;
          const x = x0 + vx * dt;
          let y = y0 + vy * dt + 0.5 * 780 * dt * dt;
          let a = 1;
          if (y > wy) {
            const depth = y - wy;
            y = wy + depth * 0.35;
            a = clamp(1 - depth / 260);
          }
          if (a <= 0) continue;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(spin * dt + k);
          ctx.globalAlpha = a;
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.moveTo(0, -sz);
          ctx.lineTo(sz * 0.8, sz * 0.6);
          ctx.lineTo(-sz * 0.6, sz * 0.4);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        // splash rings where the summit meets the water
        const sdt = dt - 0.4;
        if (sdt > 0 && sdt < 2.4) {
          for (let k = 0; k < 3; k++) {
            const q = sdt - k * 0.25;
            if (q <= 0) continue;
            ctx.strokeStyle = rgba(C.floodHi, clamp(1 - q / 2) * 0.8);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(x0, wy, 10 + q * 60, 3 + q * 9, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    }
  }

  private drawStrikes(
    ctx: CanvasRenderingContext2D,
    cps: EliminatedEvent[],
    liqs: EliminatedEvent[],
    now: number,
    flood: number,
    reduced: boolean,
  ) {
    for (const e of [...cps, ...liqs]) {
      const dt = now - e.t;
      const big = e.checkpoint !== null;
      const flashA = reduced ? 0.18 * clamp(1 - dt / 0.6) : (big ? 0.6 : 0.3) * Math.exp(-dt * 5);
      if (flashA > 0.005) {
        ctx.fillStyle = rgba("#DCE6FF", flashA);
        ctx.fillRect(0, 0, W, H);
      }
      if (reduced) continue;
      const vis = dt < 0.18 || (dt > 0.26 && dt < 0.42) || (big ? dt > 0.8 && dt < 1.1 : dt > 0.5 && dt < 0.62);
      if (!vis) continue;
      const targets = big
        ? e.players.slice(0, 4).map((v) => this.peaks.get(v.player)).filter((p): p is Peak => !!p)
        : e.players.map((v) => this.peaks.get(v.player)).filter((p): p is Peak => !!p);
      targets.forEach((p, k) => {
        const r = rng(hash(p.id) + k + Math.round(e.t));
        const ty = this.Y(big ? Math.min(p.deathEq, flood) : p.deathEq) - 18;
        let x = p.x + (r() - 0.5) * 300;
        let y = 0;
        const segs = 14;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let i = 1; i <= segs; i++) {
          const f = i / segs;
          x = lerp(x, p.x, f * 0.6) + (i === segs ? 0 : (r() - 0.5) * 70);
          y = ty * f;
          if (i === segs) x = p.x;
          ctx.lineTo(x, y);
        }
        ctx.strokeStyle = rgba("#C9D7FF", 0.35);
        ctx.lineWidth = 9;
        ctx.stroke();
        ctx.strokeStyle = "#F4F7FF";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      });
    }
  }

  // ---------- HUD ----------
  private drawTitle(ctx: CanvasRenderingContext2D, s: MatchState, now: number, reduced: boolean) {
    const T = this.T;
    T.text(ctx, "Trading Royale", 40, 70, T.font("c", 800, 44), C.chalk);
    T.text(ctx, `Lobby ${s.lobbyId}`, 40, 104, T.font("c", 500, 22), rgba(C.chalk, 0.7));
    T.text(ctx, "Pot", 40, 154, T.font("c", 600, 22), rgba(C.chalk, 0.7));
    T.roll(ctx, "pot", "$" + commas(unitsToUsd(s.potUnits)), 84, 156, T.font("x", 700, 38), 38, C.profit, "left", this.real, reduced);
    const alive = s.board ? s.board.rows.filter((r) => r.alive).length : s.players.length;
    const total = s.players.length;
    const word = s.board ? `standing of ${total}` : total === 1 ? "player in" : "players in";
    const fw = T.roll(ctx, "alive", String(alive), 40, 196, T.font("x", 700, 30), 30, C.chalk, "left", this.real, reduced);
    T.text(ctx, word, 40 + fw + 8, 195, T.font("c", 500, 22), rgba(C.chalk, 0.7));
  }

  private drawMarks(ctx: CanvasRenderingContext2D, s: MatchState, now: number, reduced: boolean) {
    const T = this.T;
    const marks = s.final?.marks ?? s.tick?.marks;
    const prev = s.prevTick?.marks;
    MARKETS.forEach((m, i) => {
      const y = 64 + i * 46;
      T.text(ctx, m, 1660, y, T.font("c", 700, 22), rgba(C.chalk, 0.7), "right");
      if (!marks) {
        T.text(ctx, "waiting", 1880, y, T.font("c", 500, 22), rgba(C.chalk, 0.5), "right");
        return;
      }
      const v = commas(marks[m]);
      const d = prev && !s.final ? num(marks[m]) - num(prev[m]) : 0;
      T.roll(ctx, "m" + m, v, 1858, y + 2, T.font("x", 600, 36), 36, C.chalk, "right", this.real, reduced, d < 0 ? -1 : 1);
      ctx.fillStyle = rgba(C.chalk, d === 0 ? 0.25 : 0.8);
      ctx.beginPath();
      if (d >= 0) {
        ctx.moveTo(1874, y - 18);
        ctx.lineTo(1881, y - 8);
        ctx.lineTo(1867, y - 8);
      } else {
        ctx.moveTo(1874, y - 2);
        ctx.lineTo(1881, y - 12);
        ctx.lineTo(1867, y - 12);
      }
      ctx.closePath();
      ctx.fill();
    });
  }

  private drawCenter(
    ctx: CanvasRenderingContext2D,
    s: MatchState,
    now: number,
    reduced: boolean,
    cps: EliminatedEvent[],
    finalDt: number,
  ) {
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
      const sc = reduced ? 1 : 1 + 0.25 * Math.exp(-cpDt * 5);
      ctx.translate(cx, 120);
      ctx.scale(sc, sc);
      T.text(ctx, `Checkpoint ${cp.checkpoint}`, 0, 0, T.font("x", 800, 104), C.floodHi, "center");
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = bannerA;
      const alive = s.board ? s.board.rows.filter((r) => r.alive).length : 0;
      const n = cp.players.length;
      T.text(ctx, `${n} ${n === 1 ? "summit" : "summits"} went under. ${alive} still standing.`, cx, 172, T.font("c", 600, 30), C.chalk, "center");
      ctx.restore();
    }
    if (normalA <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = normalA;
    if (!s.status || s.status === "open" || s.status === "countdown") {
      if (s.status === "countdown") {
        T.text(ctx, "Starting in", cx, 58, T.font("c", 600, 26), rgba(C.chalk, 0.75), "center");
        T.roll(ctx, "start", String(Math.max(0, Math.ceil(-now - 1e-6))), cx, 172, T.font("x", 800, 130), 130, C.chalk, "center", this.real, reduced);
      } else {
        T.text(ctx, "Waiting for players", cx, 58, T.font("c", 600, 26), rgba(C.chalk, 0.75), "center");
        const w = T.roll(ctx, "joined", String(s.players.length), cx, 162, T.font("x", 800, 110), 110, C.chalk, "center", this.real, reduced);
        T.text(ctx, "joined", cx + w / 2 + 12, 160, T.font("c", 600, 28), rgba(C.chalk, 0.75), "left");
        T.text(ctx, "Every summit starts at 10,000. Survive the flood.", cx, 204, T.font("c", 500, 22), rgba(C.chalk, 0.7), "center");
      }
    } else {
      const nc = s.tick?.nextCheckpoint;
      const end = s.duration - now;
      if (nc) {
        const left = nc.at - now;
        const warn = !!s.warning;
        T.text(ctx, `Checkpoint ${nc.index} in`, cx, 58, T.font("c", 600, 26), warn ? C.floodHi : rgba(C.chalk, 0.75), "center");
        const beat = warn && !reduced ? 1 + 0.1 * Math.exp(-((Math.ceil(left) - left) % 1) * 7) : 1;
        ctx.save();
        ctx.translate(cx, 168);
        ctx.scale(beat, beat);
        T.roll(ctx, "cp", mmss(left), 0, 0, T.font("x", 800, warn ? 128 : 112), warn ? 128 : 112, warn ? C.floodHi : C.chalk, "center", this.real, reduced);
        ctx.restore();
      } else {
        T.text(ctx, "Final in", cx, 58, T.font("c", 600, 26), rgba(C.chalk, 0.75), "center");
        T.roll(ctx, "cp", mmss(end), cx, 168, T.font("x", 800, 112), 112, C.chalk, "center", this.real, reduced);
      }
      const line = this.deathLine(s);
      if (nc && s.warning && s.board && line !== null) {
        const n = s.board.rows.filter((r) => r.alive && num(r.equity) < line).length;
        T.text(ctx, `${n} below the line`, cx, 210, T.font("c", 800, 30), C.chalk, "center");
      } else if (nc) {
        T.text(ctx, `Match ends in ${mmss(end)}`, cx, 208, T.font("c", 500, 22), rgba(C.chalk, 0.7), "center");
      }
    }
    ctx.restore();
  }

  // ---------- final ----------
  private drawFinal(
    ctx: CanvasRenderingContext2D,
    s: MatchState,
    shown: Peak[],
    now: number,
    finalDt: number,
    settledDt: number,
    reduced: boolean,
  ) {
    const T = this.T;
    const fin = s.final!;
    const settled = s.settled;
    const paid = new Map<string, string>();
    if (settled) settled.winners.forEach((w, i) => paid.set(w.toLowerCase(), settled.amounts[i]));
    const units = (id: string) => {
      const f = fin.finalists.find((x) => x.player === id)!;
      return settled ? (paid.get(id.toLowerCase()) ?? "0") : f.provisionalPayoutUnits;
    };
    const maxU = Math.max(1, ...fin.finalists.map((f) => Number(units(f.player))));
    const potX = 206;
    const potY = 140;

    // pot streams to the finalists
    if (!reduced && finalDt > 0.8) {
      const ramp = clamp((finalDt - 0.8) / 0.8) * (settled ? 1 - 0.6 * smooth(settledDt / 4) : 1);
      fin.finalists.forEach((f, fi) => {
        const p = this.peaks.get(f.player);
        if (!p) return;
        const tx = p.x;
        const ty = this.Y(p.eq) - 14;
        const cxp = (potX + tx) / 2;
        const cyp = Math.min(potY, ty) - 60;
        const k = 6 + Math.round(30 * (Number(units(f.player)) / maxU));
        for (let i = 0; i < k; i++) {
          const u = (i / k + this.real * 0.32 + fi * 0.13) % 1;
          const x = (1 - u) * (1 - u) * potX + 2 * (1 - u) * u * cxp + u * u * tx;
          const y = (1 - u) * (1 - u) * potY + 2 * (1 - u) * u * cyp + u * u * ty;
          ctx.fillStyle = rgba(C.profit, ramp * Math.sin(u * Math.PI) * 0.9);
          ctx.beginPath();
          ctx.arc(x, y, 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }

    // podium plates on each finalist summit
    const byEq = [...fin.finalists];
    byEq.forEach((f, rank) => {
      const p = this.peaks.get(f.player);
      if (!p) return;
      const y = this.Y(p.eq);
      const reveal = reduced ? clamp((finalDt - rank * 0.15) / 0.4) : easeOutBack((finalDt - 0.4 - (byEq.length - 1 - rank) * 0.18) / 0.6);
      ctx.save();
      ctx.globalAlpha = clamp(reveal * 2);
      // marker
      const col = num(f.equity) >= START_BALANCE ? C.profit : C.loss;
      ctx.beginPath();
      ctx.moveTo(p.x, y - 26);
      ctx.lineTo(p.x + 15, y);
      ctx.lineTo(p.x - 15, y);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = C.sky;
      ctx.lineWidth = 2;
      ctx.stroke();
      // a survey flag on every finalist, sized by its share of the pot
      const share = Number(units(f.player)) / maxU;
      const fs = 0.55 + 0.9 * share;
      const rise = clamp(reveal);
      const poleH = (40 + 70 * fs) * rise;
      const fy = y - 24 - poleH;
      ctx.strokeStyle = C.chalk;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x, y - 24);
      ctx.lineTo(p.x, fy);
      ctx.stroke();
      const wave = reduced ? 0 : Math.sin(this.real * 4 + rank) * 4 * fs;
      ctx.fillStyle = C.profit;
      ctx.beginPath();
      ctx.moveTo(p.x, fy);
      ctx.quadraticCurveTo(p.x + 26 * fs, fy + 4 + wave, p.x + 54 * fs, fy + 12 * fs);
      ctx.lineTo(p.x, fy + 30 * fs);
      ctx.closePath();
      ctx.fill();
      const ly = fy - 14 - (1 - rise) * 30;
      const amt = "$" + commas(unitsToUsd(units(f.player)));
      const payF = Math.round(34 + 22 * share);
      T.text(ctx, settled ? "paid" : "provisional", p.x, ly, T.font("c", 600, 22), rgba(C.chalk, 0.75), "center", C.sky);
      T.roll(ctx, "pay" + f.player, amt, p.x, ly - 26, T.font("x", 800, payF), payF, C.profit, "center", this.real, reduced);
      T.odo(ctx, p.eq, p.x, ly - 32 - payF, T.font("x", 600, 26), 26, col, "center", "", C.sky);
      this.nameTag(ctx, p, p.x, ly - 62 - payF, C.chalk, C.sky);
      ctx.restore();
    });

    // headline
    const w = fin.finalists[0];
    const hA = reduced ? clamp(finalDt / 0.5) : easeOut(finalDt / 0.8);
    ctx.save();
    ctx.globalAlpha = hA;
    const total = fin.finalists.reduce((a, f) => a + BigInt(units(f.player)), 0n);
    T.text(ctx, `${w.callsign} holds the high ground`, 960, 104, T.font("x", 800, 92), C.chalk, "center");
    const sub = settled
      ? `${fin.finalists.length} finalists were paid $${commas(unitsToUsd(total.toString()))} from the pot.`
      : `${fin.finalists.length} finalists split $${commas(unitsToUsd(total.toString()))}. Payouts are provisional until settlement.`;
    T.text(ctx, sub, 960, 150, T.font("c", 600, 27), rgba(C.chalk, 0.8), "center");
    T.text(ctx, `Book ${shortHash(fin.bookHash)}`, 960, 188, T.font("c", 500, 22), rgba(C.chalk, 0.6), "center");
    ctx.restore();

    if (settled && settledDt >= 0) this.drawStamp(ctx, settled.txHash, settled.mode, settledDt, reduced);
  }

  private drawStamp(ctx: CanvasRenderingContext2D, tx: string, mode: string, dt: number, reduced: boolean) {
    stamp(ctx, this.T, tx, mode, dt, reduced, 1720, 400);
  }
}

function mix(a: string, b: string, t: number) {
  const n = (h: string) => parseInt(h.slice(1), 16);
  const A = n(a);
  const B = n(b);
  const c = (sh: number) => Math.round(lerp((A >> sh) & 255, (B >> sh) & 255, clamp(t)));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}

function niceStep(raw: number) {
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
  for (const s of steps) if (s >= raw) return s;
  return 10000;
}
