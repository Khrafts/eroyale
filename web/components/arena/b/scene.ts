// The storm: a survey cross-section of a mountain range. Every player is a summit whose
// altitude is their equity; the zone is a flood that climbs the contours and, at each
// checkpoint, surges over the lowest peaks. Everything is drawn in a 1920x1080 design space.
import type { EliminatedEvent, Market, Side } from "@/lib/events";
import { MARKETS, STAGE, START_BALANCE, num, unitsToUsd } from "@/lib/events";
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
} from "./draw";

const W = 1920;
const H = 1080;
const PEAK_L = 170;
const PEAK_R = 1470;
const PLOT_BOTTOM = 1000;
const LIVE_TOP = 330;
const FINAL_TOP = 470;
const LINGER = 3.6; // seconds an eliminated summit stays on the map
const GX = 132; // flood gauge text, clear of the altitude scale

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
type FeedRow = { key: string; callsign: string; text: string; reason: string; appear: number; y: number; vy: number };

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
  feed = new Map<string, FeedRow>();

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
      else if (p.reason !== "liquidated") vals.push(p.deathEq);
    }
    if (s.board && s.status === "live") vals.push(num(s.board.cutEquity));
    let lo = Math.min(...vals);
    let hi = Math.max(...vals, base + 40);
    const span = Math.max(hi - lo, 180);
    hi = Math.max(hi, lo + span);
    const tlo = lo - span * 0.2;
    const thi = hi + span * 0.1;
    const ttop = s.final ? FINAL_TOP : LIVE_TOP;
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
    if (p.alive || p.deadT === null || p.reason === "liquidated") return p.eq;
    const dt = now - p.deadT;
    return lerp(p.deathEq, this.lo - (this.hi - this.lo) * 0.12, easeIn((dt - 0.5) / 2.4));
  }

  // ---------- frame ----------
  dtNow = 0;
  reducedNow = false;
  frame(ctx: CanvasRenderingContext2D, s: MatchState, now: number, dt: number, reduced: boolean) {
    this.real += dt;
    this.dtNow = dt;
    this.reducedNow = reduced;
    this.sync(s, now, dt, reduced);
    const shown = this.layout(now);
    const cpEvents = s.eliminations.filter((e) => e.checkpoint !== null && now - e.t >= 0 && now - e.t < 6);
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

    const finalDt = s.final ? now - STAGE.duration : -1;
    const settledDt = s.settled ? now - (STAGE.duration + 8) : -1;
    const warn = this.warnLevel(s, now);

    // sky
    const clear = s.final ? smooth(finalDt / 3) : 0;
    ctx.fillStyle = clear > 0 ? mix(C.sky, C.skyClear, clear) : C.sky;
    ctx.fillRect(0, 0, W, H);
    if (warn > 0 && !reduced) {
      ctx.fillStyle = rgba("#050d1a", 0.35 * warn);
      ctx.fillRect(0, 0, W, H);
    }

    const step = niceStep((this.hi - this.lo) / 16);
    this.drawSkyGrid(ctx, step, false);
    this.drawTerrain(ctx, shown, now, step);
    this.drawSkyGrid(ctx, step, true);
    this.drawShards(ctx, cpEvents, liqEvents, now, flood, reduced);
    this.drawFlood(ctx, flood, base, s, now, warn, reduced, cpEvents.length > 0 && flood > base + 1);
    this.drawCutLine(ctx, s);
    this.drawPeaks(ctx, s, shown, now, flood);
    this.drawGusts(ctx, reduced);
    if (!reduced) this.drawRain(ctx, s, dt, warn, finalDt);
    this.drawStrikes(ctx, cpEvents, liqEvents, now, flood, reduced);

    // HUD
    this.drawTitle(ctx, s, now, reduced);
    this.drawMarks(ctx, s, now, reduced);
    this.drawCenter(ctx, s, now, reduced, cpEvents, finalDt);
    this.drawFeed(ctx, s, now, dt, reduced, finalDt);
    this.drawLegend(ctx, step, s);
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
        T.text(ctx, commas(v.toFixed(0)), 96, y + 6, T.font("x", 600, 19), rgba(C.ink, isStart ? 0.95 : 0.6), "right", C.sky);
        if (isStart) T.text(ctx, "start", 96, y + 25, T.font("c", 500, 15), rgba(C.ink, 0.7), "right", C.sky);
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

  private drawCutLine(ctx: CanvasRenderingContext2D, s: MatchState) {
    if (!s.board || s.status !== "live") return;
    const y = this.Y(num(s.board.cutEquity));
    const T = this.T;
    ctx.save();
    ctx.setLineDash([12, 9]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = rgba(C.chalk, 0.9);
    ctx.beginPath();
    ctx.moveTo(110, y);
    ctx.lineTo(PEAK_R + 40, y);
    ctx.stroke();
    ctx.restore();
    const lx = PEAK_R + 50;
    T.text(ctx, "Cut line", lx, y - 4, T.font("c", 700, 19), C.chalk, "left", C.sky);
    T.odo(ctx, num(s.board.cutEquity), lx, y + 20, T.font("x", 600, 21), 21, C.chalk, "left", "", C.sky);
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
  ) {
    const T = this.T;
    const y0 = this.Y(level);
    const amp = reduced ? 0 : 3 + warn * 6 + (surging ? 7 : 0);
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

    // gauge text on the water, at the left
    const ly = H - 52;
    T.text(ctx, surging ? "Storm surge" : "Flood", GX, ly, T.font("c", 700, 22), C.floodHi);
    T.odo(ctx, surging ? level : base, GX + T.w(ctx, T.font("c", 700, 22), surging ? "Storm surge " : "Flood "), ly, T.font("x", 700, 24), 24, C.floodHi, "left");
    const nc = s.tick?.nextCheckpoint;
    const p = s.prevTick;
    let note = "";
    if (s.status === "live" && nc && s.tick && p && s.tick.t > p.t) {
      const slope = (num(s.tick.zone) - num(p.zone)) / (s.tick.t - p.t);
      const at = num(s.tick.zone) + slope * (nc.at - s.tick.t);
      note = `Rises to ${commas(Math.round(at).toFixed(0))} at checkpoint ${nc.index}. Summits under the water are cut.`;
      const hy = this.Y(at);
      ctx.save();
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = rgba(C.floodHi, 0.35 + warn * 0.5);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(110, hy);
      ctx.lineTo(PEAK_R + 40, hy);
      ctx.stroke();
      ctx.restore();
    } else if (s.status === "live" || s.final) note = "Holding. Checkpoints are over.";
    else if (!s.final) note = "The flood rises during the match. Summits under it at a checkpoint are cut.";
    if (note) T.text(ctx, note, GX, ly + 26, T.font("c", 500, 17), rgba(C.floodHi, 0.85));
  }

  private drawPeaks(ctx: CanvasRenderingContext2D, s: MatchState, shown: Peak[], now: number, flood: number) {
    const T = this.T;
    const lifts = this.placeLabels(ctx, s, shown, now);
    const live = s.status === "live";
    const cut = s.board ? num(s.board.cutEquity) : 0;
    const finalIds = new Set(s.final?.finalists.map((f) => f.player) ?? []);
    shown.forEach((p, i) => {
      if (s.final && finalIds.has(p.id)) return; // drawn by the podium
      const y = this.Y(this.alt(p, now)) + (1 - p.grow) * 120;
      const dead = !p.alive && p.deadT !== null;
      const ddt = dead ? now - (p.deadT as number) : 0;
      const shattered = dead && ddt > 0.35 && p.reason !== "liquidated";
      const labelA = dead ? clamp(1 - (ddt - 0.25) / 0.75) : clamp(p.grow * 1.4);
      const lobby = !s.board;
      const up = p.eq >= START_BALANCE;
      const col = lobby ? C.chalk : up ? C.profit : C.loss;
      const inCut = live && p.alive && p.target < cut;
      const under = p.alive && p.eq < flood;

      ctx.save();
      ctx.globalAlpha = labelA;
      // marker: a survey summit triangle
      if (!shattered) {
        const flash = dead && ddt < 0.35 ? 1 - ddt / 0.35 : 0;
        const g = Math.max(0.01, p.grow);
        ctx.beginPath();
        ctx.moveTo(p.x, y - 20 * g);
        ctx.lineTo(p.x + 11 * g, y);
        ctx.lineTo(p.x - 11 * g, y);
        ctx.closePath();
        ctx.fillStyle = flash > 0 ? mix(col, "#ffffff", flash) : col;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = C.sky;
        ctx.stroke();
      }
      if (inCut || under) {
        const pulse = 0.5 + 0.5 * Math.sin(this.real * 6);
        ctx.beginPath();
        ctx.arc(p.x, y - 8, 22 + pulse * 4, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(C.loss, 0.6 + pulse * 0.4);
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      // open positions as wind barbs beside the marker
      let bx = p.x + 18;
      for (const m of MARKETS) {
        const side = p.pos.get(m);
        if (!side || dead) continue;
        const c2 = side === 1 ? C.long : C.short;
        ctx.fillStyle = c2;
        ctx.beginPath();
        const cy = y - 9;
        if (side === 1) {
          ctx.moveTo(bx, cy - 7);
          ctx.lineTo(bx + 5, cy);
          ctx.lineTo(bx - 5, cy);
        } else {
          ctx.moveTo(bx, cy + 7);
          ctx.lineTo(bx + 5, cy);
          ctx.lineTo(bx - 5, cy);
        }
        ctx.closePath();
        ctx.fill();
        T.text(ctx, m[0], bx, y + 14, T.font("c", 700, 12), c2, "center", C.sky);
        bx += 13;
      }
      // label
      const target = lifts.get(p.id) ?? 0;
      if (this.first || this.reducedNow) p.lift = target;
      else [p.lift, p.vlift] = spring(p.lift, p.vlift, target, 10, 0.85, this.dtNow);
      const raise = p.lift;
      const ly = y - 30 - raise;
      if (raise > 4) {
        ctx.strokeStyle = rgba(C.ink, 0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x, y - 22);
        ctx.lineTo(p.x, ly + 4);
        ctx.stroke();
      }
      const sink = dead ? easeIn((ddt - 0.4) / 2) * 40 : 0;
      T.odo(ctx, dead ? p.deathEq : p.eq, p.x, ly + sink, T.font("x", 600, 22), 22, dead ? C.loss : col, "center", "", C.sky);
      const nameF = T.font("c", 800, 22);
      const botF = T.font("c", 600, 13);
      const nw = T.w(ctx, nameF, p.callsign);
      const bw = p.bot ? T.w(ctx, botF, "BOT") + 6 : 0;
      const nx = p.x - (nw + bw) / 2;
      T.text(ctx, p.callsign, nx, ly - 24 + sink, nameF, inCut || dead ? C.loss : C.chalk, "left", C.sky);
      if (dead && p.reason === "liquidated") {
        // the strike callout stays readable for the whole sequence
        ctx.globalAlpha = clamp(1 - (ddt - 2.6) / 0.8) * clamp(ddt / 0.15);
        const cy = this.Y(p.deathEq) - 44;
        T.text(ctx, p.callsign, p.x, cy - 30, T.font("c", 800, 30), C.loss, "center", C.sky);
        T.text(ctx, "liquidated", p.x, cy, T.font("c", 700, 22), C.chalk, "center", C.sky);
        ctx.globalAlpha = labelA;
      }
      if (p.bot) T.text(ctx, "BOT", nx + nw + 6, ly - 24 + sink, botF, rgba(C.chalk, 0.6), "left", C.sky);
      ctx.restore();
    });
  }

  /** Greedy label placement: highest summits keep their spot, lower labels climb clear of them. */
  private placeLabels(ctx: CanvasRenderingContext2D, s: MatchState, shown: Peak[], now: number) {
    const T = this.T;
    const out = new Map<string, number>();
    const cut = s.board ? num(s.board.cutEquity) : 0;
    const boxes: { l: number; r: number; t: number; b: number }[] = [];
    const order = shown.filter((p) => p.alive).sort((a, b) => b.eq - a.eq);
    for (const p of order) {
      const y = this.Y(this.alt(p, now));
      const w = Math.max(T.w(ctx, T.font("c", 800, 22), p.callsign) + (p.bot ? 34 : 0), 80) + 16;
      const h = 52;
      const bottom = y - 22;
      let box = { l: p.x - w / 2, r: p.x + w / 2, t: bottom - h, b: bottom };
      for (let k = 0; k < 12; k++) {
        const hit = boxes.find((o) => o.l < box.r && o.r > box.l && o.t < box.b && o.b > box.t);
        if (!hit) break;
        const nb = hit.t - 4;
        box = { ...box, t: nb - h, b: nb };
      }
      // never climb into the scoreboard band
      out.set(p.id, Math.min(bottom - box.b, Math.max(0, bottom - 250)));
      boxes.push(box);
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
    T.text(ctx, word, 40 + fw + 8, 195, T.font("c", 500, 21), rgba(C.chalk, 0.7));
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
      T.text(ctx, `The flood took ${n} ${n === 1 ? "summit" : "summits"}. ${alive} still standing.`, cx, 172, T.font("c", 600, 30), C.chalk, "center");
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
        T.text(ctx, "Every summit starts at 10,000. Survive the flood.", cx, 200, T.font("c", 500, 21), rgba(C.chalk, 0.6), "center");
      }
    } else {
      const nc = s.tick?.nextCheckpoint;
      const end = STAGE.duration - now;
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
      if (nc) {
        const msg = `Match ends in ${mmss(end)}`;
        T.text(ctx, msg, cx, 206, T.font("c", 500, 21), rgba(C.chalk, 0.6), "center");
      }
    }
    ctx.restore();
  }

  private drawFeed(ctx: CanvasRenderingContext2D, s: MatchState, now: number, dt: number, reduced: boolean, finalDt: number) {
    const T = this.T;
    const rows: FeedRow[] = [];
    for (const e of s.eliminations) {
      e.players.forEach((v, i) => {
        const key = `${e.t}|${v.player}`;
        let r = this.feed.get(key);
        if (!r) {
          const text =
            v.reason === "liquidated"
              ? `Liquidated at ${mmss(e.t)}`
              : v.reason === "zone"
                ? `Under the flood at checkpoint ${e.checkpoint}`
                : `Cut at checkpoint ${e.checkpoint}, rank ${v.rank}`;
          r = { key, callsign: v.callsign, text, reason: v.reason, appear: e.t + 0.3 + i * 0.12, y: -1, vy: 0 };
          this.feed.set(key, r);
        }
        if (now >= r.appear) rows.push(r);
      });
    }
    if (!rows.length) return;
    rows.sort((a, b) => b.appear - a.appear);
    const A = s.final ? 1 - smooth(finalDt / 1.2) : 1;
    if (A <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = A;
    const x0 = 1600;
    T.text(ctx, "Eliminated", x0, 262, T.font("c", 700, 22), rgba(C.chalk, 0.7));
    const MAX = 9;
    const room = rows.length > MAX ? MAX - 1 : MAX;
    rows.forEach((r, i) => {
      const ty = 304 + i * 54;
      if (r.y < 0 || this.first || reduced) r.y = ty;
      else [r.y, r.vy] = spring(r.y, r.vy, ty, 9, 0.8, dt);
      if (i >= room) return;
      const age = now - r.appear;
      const k = reduced ? clamp(age / 0.3) : easeOutBack(age / 0.45);
      ctx.save();
      ctx.globalAlpha = A * clamp(age / 0.2);
      if (!reduced) ctx.translate((1 - k) * 80, 0);
      ctx.fillStyle = r.reason === "liquidated" ? C.loss : C.flood;
      ctx.fillRect(x0, r.y - 22, 5, 44);
      T.text(ctx, r.callsign, x0 + 16, r.y - 2, T.font("c", 800, 24), C.chalk);
      T.text(ctx, r.text, x0 + 16, r.y + 20, T.font("c", 500, 17), rgba(C.chalk, 0.65));
      ctx.restore();
    });
    if (rows.length > MAX) T.text(ctx, `and ${rows.length - room} more`, x0 + 16, 304 + room * 54 - 14, T.font("c", 600, 18), rgba(C.chalk, 0.65));
    ctx.restore();
  }

  private drawLegend(ctx: CanvasRenderingContext2D, step: number, s: MatchState) {
    const T = this.T;
    const x = 1600;
    const y = 852;
    const w = 280;
    const h = 196;
    ctx.fillStyle = rgba(C.sky, 0.92);
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = rgba(C.ink, 0.6);
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.strokeRect(x + 4.5, y + 4.5, w - 9, h - 9);
    const F = T.font("c", 500, 18);
    const tri = (cx: number, cy: number, c: string) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 9);
      ctx.lineTo(cx + 7, cy + 4);
      ctx.lineTo(cx - 7, cy + 4);
      ctx.closePath();
      ctx.fill();
    };
    let ly = y + 34;
    tri(x + 26, ly - 6, C.profit);
    T.text(ctx, "Summit in profit", x + 44, ly, F, C.chalk);
    ly += 28;
    tri(x + 26, ly - 6, C.loss);
    T.text(ctx, "Summit in loss", x + 44, ly, F, C.chalk);
    ly += 28;
    tri(x + 26, ly - 6, C.long);
    T.text(ctx, "Long", x + 44, ly, F, C.chalk);
    ctx.fillStyle = C.short;
    ctx.beginPath();
    ctx.moveTo(x + 136, ly);
    ctx.lineTo(x + 143, ly - 13);
    ctx.lineTo(x + 129, ly - 13);
    ctx.closePath();
    ctx.fill();
    T.text(ctx, "Short", x + 154, ly, F, C.chalk);
    ly += 28;
    ctx.fillStyle = C.flood;
    ctx.fillRect(x + 18, ly - 13, 18, 12);
    T.text(ctx, "Flood, cut at checkpoints", x + 44, ly, F, C.chalk);
    ly += 28;
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = C.chalk;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 16, ly - 6);
    ctx.lineTo(x + 38, ly - 6);
    ctx.stroke();
    ctx.restore();
    T.text(ctx, "Cut line, ringed summits under it", x + 44, ly, F, C.chalk);
    ly += 28;
    T.text(ctx, `Altitude is equity. Contours every $${step}.`, x + 18, ly, T.font("c", 500, 16), rgba(C.ink, 0.85));
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
      if (rank === 0) {
        // survey flag on the winning summit
        const fy = y - 26 - 70 * clamp(reveal);
        ctx.strokeStyle = C.chalk;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(p.x, y - 24);
        ctx.lineTo(p.x, fy);
        ctx.stroke();
        const wave = reduced ? 0 : Math.sin(this.real * 4) * 4;
        ctx.fillStyle = C.profit;
        ctx.beginPath();
        ctx.moveTo(p.x, fy);
        ctx.quadraticCurveTo(p.x + 24, fy + 4 + wave, p.x + 48, fy + 10);
        ctx.lineTo(p.x, fy + 26);
        ctx.closePath();
        ctx.fill();
      }
      const lift = (1 - clamp(reveal)) * 30 + (rank === 0 ? 76 : 0);
      const ly = y - 40 - lift;
      const amt = "$" + commas(unitsToUsd(units(f.player)));
      T.text(ctx, settled ? "paid" : "provisional", p.x, ly, T.font("c", 600, 18), rgba(C.chalk, 0.7), "center", C.sky);
      T.roll(ctx, "pay" + f.player, amt, p.x, ly - 24, T.font("x", 800, 40), 40, C.profit, "center", this.real, reduced);
      T.odo(ctx, p.eq, p.x, ly - 72, T.font("x", 600, 24), 24, col, "center", "", C.sky);
      const nameF = T.font("c", 800, 30);
      const nw = T.w(ctx, nameF, f.callsign);
      const isBot = p.bot;
      const bw = isBot ? T.w(ctx, T.font("c", 600, 15), "BOT") + 6 : 0;
      T.text(ctx, f.callsign, p.x - (nw + bw) / 2, ly - 100, nameF, C.chalk, "left", C.sky);
      if (isBot) T.text(ctx, "BOT", p.x - (nw + bw) / 2 + nw + 6, ly - 100, T.font("c", 600, 15), rgba(C.chalk, 0.6), "left", C.sky);
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
    T.text(ctx, `Book ${shortHash(fin.bookHash)}`, 960, 184, T.font("c", 500, 19), rgba(C.chalk, 0.55), "center");
    ctx.restore();

    if (settled && settledDt >= 0) this.drawStamp(ctx, settled.txHash, settled.mode, settledDt, reduced);
  }

  private drawStamp(ctx: CanvasRenderingContext2D, tx: string, mode: string, dt: number, reduced: boolean) {
    const T = this.T;
    const k = reduced ? 1 : clamp(dt / 0.22);
    const sc = reduced ? 1 : lerp(1.9, 1, easeIn(k));
    const a = reduced ? clamp(dt / 0.4) : clamp(k * 1.5);
    const x = 1720;
    const y = 400;
    const R = 132;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.16);
    ctx.scale(sc, sc);
    ctx.globalAlpha = a;
    // a brass survey benchmark disc
    ctx.fillStyle = rgba("#2A3A3C", 0.95);
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, R - 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, R - 52, 0, Math.PI * 2);
    ctx.stroke();
    // lettering around the rim
    const ring = "Verified by Chainlink";
    ctx.font = T.font("c", 800, 26);
    ctx.fillStyle = C.ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const rr = R - 32;
    const ringF = T.font("c", 800, 26);
    const total = T.w(ctx, ringF, ring) * 1.08;
    let acc = -total / 2;
    ctx.font = ringF;
    for (const ch of ring) {
      const cw = T.w(ctx, ringF, ch) * 1.08;
      const ang = (acc + cw / 2) / rr;
      ctx.save();
      ctx.rotate(ang);
      ctx.fillText(ch, 0, -rr);
      ctx.restore();
      acc += cw;
    }
    // benchmark triangle and tx
    ctx.beginPath();
    ctx.moveTo(0, -38);
    ctx.lineTo(18, -10);
    ctx.lineTo(-18, -10);
    ctx.closePath();
    ctx.fill();
    ctx.textBaseline = "alphabetic";
    T.text(ctx, "Settled", 0, 24, T.font("c", 800, 30), C.ink, "center");
    T.text(ctx, shortHash(tx), 0, 52, T.font("x", 600, 24), C.ink, "center");
    T.text(ctx, mode === "simulated" ? "simulated report" : "onchain report", 0, R - 22, T.font("c", 600, 15), rgba(C.ink, 0.8), "center");
    ctx.restore();
    // ink spread on impact
    if (!reduced && dt > 0.2 && dt < 1) {
      ctx.strokeStyle = rgba(C.ink, (1 - (dt - 0.2) / 0.8) * 0.6);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, R + (dt - 0.2) * 90, 0, Math.PI * 2);
      ctx.stroke();
    }
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
