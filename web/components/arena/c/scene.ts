// The specimen: the lobby as a stained culture on a slide. Cells drift on an equity axis,
// pulse with profit, split off buds when they bank a trade, and lyse in the picric reagent.
import type { MatchState } from "@/lib/useMatch";
import type { Market } from "@/lib/events";
import { num, unitsToUsd, START_BALANCE } from "@/lib/events";
import { Typesetter, money, moneyStr, clockStr } from "./text";

export const W = 1920;
export const H = 1080;

export const PAL = {
  eosin: "#EBC6D2", // the field
  ink: "#2A1858", // hematoxylin: text, nuclei, reticle
  profit: "#0E7A57", // methyl green
  loss: "#B4123A", // carmine
  long: "#1D5BD6", // methylene blue
  short: "#8A4A14", // Bismarck brown
  zone: "#F2C40C", // picric acid, owned by the zone
  zoneDeep: "#8F6A00",
  halo: "#F3D9E2",
};

const F = { l: 330, r: 1500, t: 250, b: 985 };
const MID_X = (F.l + F.r) / 2;
const SED_Y = 1034;
const RIGHT_L = 1560;
const RIGHT_R = 1872;
const POT_PT = { x: 1700, y: 300 };
const MARKETS: Market[] = ["BTC", "ETH", "SOL"];

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOut = (v: number) => 1 - Math.pow(1 - clamp01(v), 3);
const easeIO = (v: number) => {
  v = clamp01(v);
  return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
};
const smooth = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

type Pos = { side: 1 | -1; lev: number };
type Fx = { kind: "cilia" | "bud"; side: 1 | -1; t0: number; ang: number; good: boolean };
type Cell = {
  id: string;
  callsign: string;
  bot: boolean;
  join: number;
  seed: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  grow: number;
  eqT: number;
  eqStr: string;
  disp: number;
  rate: number;
  pos: Map<Market, Pos>;
  fx: Fx[];
  ghost: { x: number; y: number; a: number } | null;
  tx: number;
  ty: number;
  tr: number;
  danger: boolean;
  homeX: number;
  placed: boolean;
};
type Death = {
  id: string;
  t: number;
  checkpoint: 1 | 2 | 3 | null;
  reason: "cut" | "zone" | "liquidated";
  rank: number;
  x: number;
  y: number;
  r: number;
  callsign: string;
  bot: boolean;
  homeX: number;
  seed: number;
  join: number;
};

export class Scene {
  type = new Typesetter();
  private cells = new Map<string, Cell>();
  private deaths = new Map<string, Death>();
  private seenFills = new WeakSet<object>();
  private elimSeen = 0;
  private first = true;
  private now = 0;
  private wt = 0;
  private hi = 10400;
  private zoneD = 9800;
  private cutD = 0;
  private marks: Record<Market, number> = { BTC: 0, ETH: 0, SOL: 0 };
  private bg: HTMLCanvasElement | null = null;
  private stamp: { hash: string; c: HTMLCanvasElement } | null = null;
  private settledAt: number | null = null;
  private payD = new Map<string, number>();
  private n = 4;
  private freeze = 0;

  reset() {
    this.cells.clear();
    this.deaths.clear();
    this.seenFills = new WeakSet();
    this.elimSeen = 0;
    this.first = true;
    this.settledAt = null;
    this.payD.clear();
  }

  // ---------- geometry ----------
  private lo() {
    const z = this.zoneD;
    const f = 0.1 + 0.27 * clamp01((z - 9800) / 500);
    return z - ((this.hi - z) * f) / (1 - f);
  }
  private yOf(e: number) {
    const lo = this.lo();
    if (e < lo) return F.b + 30 * (1 - Math.exp(-(lo - e) / 500));
    return F.b - ((e - lo) / (this.hi - lo)) * (F.b - F.t);
  }
  private base() {
    return clamp(((F.r - F.l) / this.n) * 0.46, 13, 40);
  }

  // ---------- update ----------
  update(dt: number, s: MatchState, clock: number, reduced: boolean) {
    if (s.eliminations.length < this.elimSeen || s.players.length < this.cells.size) this.reset();
    this.now += dt;
    const first = this.first;
    this.n = Math.max(4, s.players.length);
    const n = this.n;

    // Cells for every lobby player, placed in join order across the dish.
    s.players.forEach((p, i) => {
      let c = this.cells.get(p.player);
      if (!c) {
        const seed = hash(p.player);
        c = {
          id: p.player,
          callsign: p.callsign,
          bot: p.bot,
          join: i,
          seed,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          r: this.base(),
          grow: first ? 1 : 0,
          eqT: START_BALANCE,
          eqStr: "10000.00",
          disp: START_BALANCE,
          rate: 0,
          pos: new Map(),
          fx: [],
          ghost: null,
          tx: 0,
          ty: 0,
          tr: 0,
          danger: false,
          homeX: 0,
          placed: false,
        };
        this.cells.set(p.player, c);
      }
      c.join = i;
      c.homeX = F.l + ((i + 0.5) * (F.r - F.l)) / n;
    });

    // Equity per player.
    const rows = new Map<string, { eq: number; str: string; alive: boolean }>();
    for (const r of s.board?.rows ?? []) rows.set(r.player, { eq: num(r.equity), str: r.equity, alive: r.alive });
    for (const c of this.cells.values()) {
      const r = rows.get(c.id);
      const eq = r ? r.eq : START_BALANCE;
      if (eq !== c.eqT) c.rate = lerp(c.rate, Math.abs(eq - c.eqT) * 4, 0.35);
      c.eqT = eq;
      c.eqStr = r ? r.str : "10000.00";
    }
    if (s.final) for (const f of s.final.finalists) {
      const c = this.cells.get(f.player);
      if (c) {
        c.eqT = num(f.equity);
        c.eqStr = f.equity;
      }
    }

    // Fills: positions (organelles) and small reactions.
    for (const f of s.fills) {
      if (this.seenFills.has(f)) continue;
      this.seenFills.add(f);
      const c = this.cells.get(f.player);
      if (!c) continue;
      if (f.kind === "open") c.pos.set(f.market, { side: f.side, lev: f.leverage });
      else c.pos.delete(f.market);
      if (!first && !reduced && clock - f.t < 1.2 && f.kind !== "liquidation") {
        const R = rng(c.seed + Math.floor(f.t * 100));
        c.fx.push({
          kind: f.kind === "open" ? "cilia" : "bud",
          side: f.side,
          t0: this.now,
          ang: R() * Math.PI * 2,
          good: c.eqT >= START_BALANCE,
        });
      }
    }

    // Scale.
    const tick = s.tick;
    const zoneT = tick ? num(tick.zone) : 9800;
    this.zoneD = first ? zoneT : lerp(this.zoneD, zoneT, smooth(dt, 6));
    const alive = [...this.cells.values()].filter((c) => !this.deaths.has(c.id) && (rows.get(c.id)?.alive ?? true));
    const finalists = s.final ? new Set(s.final.finalists.map((f) => f.player)) : null;
    const pool = finalists ? alive.filter((c) => finalists.has(c.id)) : alive;
    let maxE = START_BALANCE;
    for (const c of pool) maxE = Math.max(maxE, c.eqT);
    const cutT = s.board ? num(s.board.cutEquity) : 0;
    let hiT = Math.max(maxE, cutT, zoneT + 400);
    hiT += (hiT - zoneT) * 0.14;
    this.hi = first ? hiT : lerp(this.hi, hiT, smooth(dt, 1.6));
    this.cutD = first || this.cutD === 0 ? cutT : lerp(this.cutD, cutT, smooth(dt, 5));
    if (tick) for (const m of MARKETS) {
      const v = num(tick.marks[m]);
      this.marks[m] = first || this.marks[m] === 0 ? v : Math.abs(v - this.marks[m]) < 0.005 ? v : lerp(this.marks[m], v, smooth(dt, 7));
    }

    // Freeze: checkpoint and final hold their breath.
    const cp = this.cpSeq(s, clock);
    let fz = 0;
    if (cp) fz = cp.s < 1.4 ? 1 : 1 - clamp01((cp.s - 1.4) / 0.8);
    if (s.final) fz = 1;
    this.freeze = fz;
    if (!reduced) this.wt += dt * (1 - fz * 0.9);

    // Targets.
    const base = this.base();
    const fl = s.final?.finalists ?? [];
    const spacing = Math.min(250, (F.r - F.l) / Math.max(1, fl.length));
    for (const c of this.cells.values()) {
      const sp = Math.tanh((c.eqT - START_BALANCE) / 2500);
      c.tr = base * Math.max(0.6, 1 + 0.6 * sp);
      const drift = reduced ? 0 : 1 - fz;
      c.tx = c.homeX + Math.sin(this.now * 0.21 + c.seed) * base * 0.5 * drift;
      c.ty = clamp(this.yOf(c.eqT), F.t - 30, 1015) + Math.sin(this.now * 0.17 + c.seed * 3) * 3 * drift;
      // Before the first leaderboard everyone holds the same balance: let the colony cluster loosely.
      if (!s.board) c.ty += (((c.join * 7) % 3) - 1) * base * 2.6;
      const fi = fl.findIndex((f) => f.player === c.id);
      if (fi >= 0) {
        const off = fi === 0 ? 0 : fi % 2 === 1 ? -Math.ceil(fi / 2) : Math.ceil(fi / 2);
        c.tx = MID_X + off * spacing;
        c.tr = Math.min(64, base * 1.5 * (1 + 0.35 * sp));
        c.ty = clamp(this.yOf(c.eqT), F.t + 40, 900);
      }
      c.danger = !s.final && !!s.board && s.status === "live" && (c.eqT < cutT || c.eqT < zoneT);
      c.disp = first ? c.eqT : Math.abs(c.disp - c.eqT) < 0.01 ? c.eqT : lerp(c.disp, c.eqT, smooth(dt, 6));
    }

    // Motion.
    const list = alive;
    if (first) for (const c of this.cells.values()) this.place(c);
    for (const c of list) {
      if (!c.placed) this.place(c);
      c.grow = Math.min(1, c.grow + dt * 1.6);
      c.r = lerp(c.r, c.tr, smooth(dt, 4));
      if (reduced) {
        if (Math.abs(c.tx - c.x) + Math.abs(c.ty - c.y) > 30) {
          c.ghost = { x: c.x, y: c.y, a: 1 };
          c.x = c.tx;
          c.y = c.ty;
        } else {
          c.x = lerp(c.x, c.tx, smooth(dt, 8));
          c.y = lerp(c.y, c.ty, smooth(dt, 8));
        }
        if (c.ghost) {
          c.ghost.a -= dt / 0.45;
          if (c.ghost.a <= 0) c.ghost = null;
        }
        continue;
      }
      const k = 22;
      const damp = 2 * Math.sqrt(k) * 0.6;
      let ax = k * (c.tx - c.x) - damp * c.vx;
      let ay = k * (c.ty - c.y) - damp * c.vy;
      for (const o of list) {
        if (o === c) continue;
        const dx = c.x - o.x;
        const dy = c.y - o.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const min = c.r + o.r + 6;
        if (d < min) {
          const push = (min - d) * 60;
          ax += (dx / d) * push;
          ay += (dy / d) * push * 0.3;
        }
      }
      c.vx += ax * dt;
      c.vy += ay * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.fx = c.fx.filter((f) => this.now - f.t0 < (f.kind === "cilia" ? 0.9 : 1.6));
    }

    // Eliminations become deaths, frozen where the cell last stood.
    for (; this.elimSeen < s.eliminations.length; this.elimSeen++) {
      const ev = s.eliminations[this.elimSeen];
      for (const p of ev.players) {
        const c = this.cells.get(p.player);
        if (!c) continue;
        if (!c.placed) this.place(c);
        c.pos.clear();
        this.deaths.set(p.player, {
          id: p.player,
          t: ev.t,
          checkpoint: ev.checkpoint,
          reason: p.reason,
          rank: p.rank,
          x: c.x,
          y: c.y,
          r: c.r,
          callsign: c.callsign,
          bot: c.bot,
          homeX: c.homeX,
          seed: c.seed,
          join: c.join,
        });
      }
    }

    // Payouts roll up as the pot streams in.
    if (s.settled && this.settledAt === null) this.settledAt = first ? clock - 2 : clock;
    if (s.final) {
      const finalT = s.tick?.t ?? clock;
      const sF = clock - finalT;
      const paid = new Map<string, number>();
      if (s.settled) s.settled.winners.forEach((w, i) => paid.set(w, Number(s.settled!.amounts[i])));
      for (const f of s.final.finalists) {
        const target = s.settled ? paid.get(f.player) ?? 0 : Number(f.provisionalPayoutUnits);
        const roll = reduced ? 1 : easeIO((sF - 0.4) / 2.4);
        this.payD.set(f.player, target * roll);
      }
    }

    this.first = false;
  }

  private place(c: Cell) {
    c.x = c.tx;
    c.y = c.ty;
    c.r = c.tr;
    c.vx = 0;
    c.vy = 0;
    c.placed = true;
  }

  private cpSeq(s: MatchState, clock: number) {
    for (let i = s.eliminations.length - 1; i >= 0; i--) {
      const e = s.eliminations[i];
      if (e.checkpoint === null) continue;
      const t = clock - e.t;
      if (t >= -0.01 && t < 4.6) return { s: Math.max(0, t), ev: e };
      break;
    }
    return null;
  }

  // ---------- draw ----------
  draw(ctx: CanvasRenderingContext2D, s: MatchState, clock: number, reduced: boolean) {
    ctx.drawImage(this.background(), 0, 0);
    const live = s.status === "live" || s.status === "settling" || s.status === "settled";
    const cp = this.cpSeq(s, clock);
    const warnLeft =
      s.warning && s.tick?.nextCheckpoint && s.status === "live" ? s.tick.nextCheckpoint.at - clock : null;
    const warn = warnLeft !== null && warnLeft > 0 && warnLeft <= 10.05 ? warnLeft : null;

    this.drawReticle(ctx, s);
    if (warn !== null) this.drawGhostNumeral(ctx, String(Math.ceil(warn)), 0.13 + 0.05 * (1 - (warn % 1)));
    if ((s.status === "countdown" || s.status === "open") && clock < 0 && s.status === "countdown")
      this.drawGhostNumeral(ctx, String(Math.ceil(-clock)), 0.15);

    const alive = [...this.cells.values()].filter((c) => !this.deaths.has(c.id) && c.placed);
    for (const c of alive) this.drawCell(ctx, c, warn, reduced);

    this.drawReagent(ctx, s, cp, reduced);
    this.drawSediment(ctx, clock, reduced);
    if (live && s.board && !s.final) this.drawCutLine(ctx, warn);
    for (const c of alive) if (c.danger) this.drawDanger(ctx, c, warn);

    // Deaths in progress, dissolving through the reagent.
    for (const d of this.deaths.values()) this.drawLysis(ctx, d, clock - d.t, reduced);

    // Nutrient stream from the pot to the finalists.
    if (s.final) this.drawStream(ctx, s, clock, reduced);

    if (!s.final) this.drawLabels(ctx, alive, s);

    // Iris diaphragm closes over the ten-second warning, snaps open at the checkpoint.
    let iris = 0;
    if (warn !== null) iris = easeIO(1 - warn / 10);
    if (cp) iris = 1 - easeOut(cp.s / 0.7);
    if (iris > 0.001) this.drawIris(ctx, iris, reduced);
    this.drawHud(ctx, s, clock, warn);
    this.drawFeed(ctx, s, clock, reduced);
    if (warn !== null) this.drawWarnText(ctx, s, warn);

    if (cp) this.drawCheckpointCaption(ctx, cp.ev.checkpoint ?? 0, cp.ev.players.length, alive.length, cp.s);
    this.drawLiquidationCaptions(ctx, clock);
    if (s.final) this.drawFinal(ctx, s, clock, reduced);

    // Shutter flash.
    if (cp && cp.s < 0.35 && !reduced) {
      ctx.fillStyle = `rgba(255,252,240,${0.8 * (1 - cp.s / 0.35)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  private background(): HTMLCanvasElement {
    if (this.bg) return this.bg;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    g.fillStyle = PAL.eosin;
    g.fillRect(0, 0, W, H);
    const R = rng(4049);
    // Stained fibres.
    for (let i = 0; i < 220; i++) {
      const x = R() * W;
      const y = R() * H;
      const a = R() * Math.PI;
      const L = 80 + R() * 380;
      g.strokeStyle = `rgba(176,70,120,${0.035 + R() * 0.05})`;
      g.lineWidth = 0.8 + R() * 2.4;
      g.beginPath();
      g.moveTo(x, y);
      g.bezierCurveTo(
        x + Math.cos(a) * L * 0.3 + (R() - 0.5) * 60,
        y + Math.sin(a) * L * 0.3 + (R() - 0.5) * 60,
        x + Math.cos(a) * L * 0.7 + (R() - 0.5) * 60,
        y + Math.sin(a) * L * 0.7 + (R() - 0.5) * 60,
        x + Math.cos(a) * L,
        y + Math.sin(a) * L,
      );
      g.stroke();
    }
    // Ghost erythrocytes, the residue of earlier cultures.
    for (let i = 0; i < 70; i++) {
      const x = R() * W;
      const y = R() * H;
      const r = 6 + R() * 12;
      g.strokeStyle = `rgba(190,80,125,${0.06 + R() * 0.06})`;
      g.lineWidth = 2 + R() * 2;
      g.beginPath();
      g.ellipse(x, y, r, r * (0.8 + R() * 0.2), R() * 3, 0, Math.PI * 2);
      g.stroke();
    }
    // Lens falloff at the very edge of the field.
    const v = g.createRadialGradient(W / 2, H / 2, H * 0.55, W / 2, H / 2, H * 1.05);
    v.addColorStop(0, "rgba(120,40,90,0)");
    v.addColorStop(1, "rgba(120,40,90,0.16)");
    g.fillStyle = v;
    g.fillRect(0, 0, W, H);
    this.bg = c;
    return c;
  }

  private drawReticle(ctx: CanvasRenderingContext2D, s: MatchState) {
    const lo = this.lo();
    const hi = this.hi;
    const span = hi - lo;
    const raw = span / 7;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= raw) ?? raw;
    const x = 150;
    ctx.strokeStyle = rgba(PAL.ink, 0.55);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, F.t - 30);
    ctx.lineTo(x, H);
    ctx.stroke();
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const y = this.yOf(v);
      if (y < F.t - 30 || y > H - 10) continue;
      const major = Math.abs(v - START_BALANCE) < 0.5;
      ctx.strokeStyle = rgba(PAL.ink, major ? 0.8 : 0.5);
      ctx.lineWidth = major ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(x - (major ? 22 : 14), y);
      ctx.lineTo(x, y);
      ctx.stroke();
      // graticule
      ctx.strokeStyle = rgba(PAL.ink, major ? 0.16 : 0.07);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(F.r + 40, y);
      ctx.stroke();
      if (!s.board) continue;
      const label = v >= 10000 ? `${Math.round(v / 100) / 10}k` : `${Math.round(v / 10) / 100}k`;
      this.type.draw(ctx, label.replace(/\.0k$/, "k"), x - 26, y + 6, {
        size: 18,
        weight: major ? 800 : 600,
        color: PAL.ink,
        align: "right",
        alpha: major ? 0.9 : 0.6,
      });
    }
    // Minor ticks.
    for (let v = Math.ceil(lo / (step / 5)) * (step / 5); v <= hi; v += step / 5) {
      const y = this.yOf(v);
      if (y < F.t - 30 || y > H) continue;
      ctx.strokeStyle = rgba(PAL.ink, 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 6, y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    if (s.board && !s.final) {
      const y = this.yOf(START_BALANCE);
      if (y > F.t && y < H - 20)
        this.type.draw(ctx, "start", x + 10, y - 8, { size: 16, weight: 600, color: PAL.ink, alpha: 0.55, tab: false });
    }
  }

  private drawGhostNumeral(ctx: CanvasRenderingContext2D, txt: string, alpha: number) {
    this.type.draw(ctx, txt, MID_X, 760, { size: 520, weight: 800, color: PAL.ink, align: "center", alpha });
  }

  private drawCutLine(ctx: CanvasRenderingContext2D, warn: number | null) {
    const y = this.yOf(this.cutD);
    if (y < F.t - 40 || y > H) return;
    const pulse = warn !== null ? 0.5 + 0.5 * Math.sin(this.now * 7) : 0;
    ctx.save();
    ctx.setLineDash([16, 10]);
    ctx.lineDashOffset = -this.now * 14;
    ctx.strokeStyle = rgba(PAL.ink, 0.8 + 0.2 * pulse);
    ctx.lineWidth = warn !== null ? 3.5 + pulse * 1.5 : 2.5;
    ctx.beginPath();
    ctx.moveTo(150, y);
    ctx.lineTo(F.r + 50, y);
    ctx.stroke();
    ctx.restore();
    this.type.draw(ctx, "cut line", 164, y - 36, {
      size: 19,
      weight: 700,
      color: PAL.ink,
      halo: PAL.halo,
      tab: false,
    });
    this.type.draw(ctx, moneyStr(this.cutD.toFixed(2)), 164, y - 11, {
      size: 26,
      weight: 800,
      color: PAL.ink,
      halo: PAL.halo,
    });
  }

  private membrane(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, seed: number, jit: number) {
    const N = 44;
    const t = this.wt;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const rr =
        r *
        (1 +
          0.04 * Math.sin(3 * a + t * 0.8 + seed) +
          0.025 * Math.sin(5 * a - t * 1.3 + seed * 2) +
          jit * Math.sin(11 * a + t * 9 + seed));
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  private drawCell(ctx: CanvasRenderingContext2D, c: Cell, warn: number | null, reduced: boolean) {
    if (c.ghost && reduced) {
      ctx.globalAlpha = c.ghost.a;
      this.cellBody(ctx, c, c.ghost.x, c.ghost.y, c.r * c.grow, 0, 1);
      ctx.globalAlpha = 1;
    }
    const a = c.ghost && reduced ? 1 - c.ghost.a : 1;
    const sp = Math.tanh((c.eqT - START_BALANCE) / 2500);
    // Pulse: profit throbs, fast movers beat faster.
    const freq = 0.6 + Math.min(2.2, c.rate / 300);
    const amp = reduced ? 0 : 0.02 + Math.max(0, sp) * 0.07 + Math.min(0.03, c.rate / 6000);
    const pulse = 1 + amp * Math.sin(this.wt * freq * Math.PI * 2 + c.seed) * (1 - this.freeze * 0.8);
    const jit = c.danger && !reduced ? (warn !== null ? 0.03 + 0.03 * (1 - warn / 10) : 0.015) : 0;
    ctx.globalAlpha = a;
    this.cellBody(ctx, c, c.x, c.y, c.r * c.grow * pulse, jit, a);
    ctx.globalAlpha = 1;
    if (!reduced) this.drawFx(ctx, c);
  }

  private cellBody(ctx: CanvasRenderingContext2D, c: Cell, x: number, y: number, r: number, jit: number, alpha: number) {
    if (r < 1) return;
    const pnl = c.eqT - START_BALANCE;
    const sp = Math.tanh(pnl / 2500);
    const col = Math.abs(pnl) < 0.5 ? PAL.ink : pnl > 0 ? PAL.profit : PAL.loss;
    // Phase halo.
    this.membrane(ctx, x, y, r + 3, c.seed, jit);
    ctx.lineWidth = 8;
    ctx.strokeStyle = `rgba(255,247,251,${0.55 * alpha})`;
    ctx.stroke();
    // Cytoplasm.
    this.membrane(ctx, x, y, r, c.seed, jit);
    ctx.fillStyle = `rgba(252,236,243,${0.7 * alpha})`;
    ctx.fill();
    ctx.fillStyle = rgba(col, (0.12 + 0.22 * Math.abs(sp)) * alpha);
    ctx.fill();
    ctx.lineWidth = Math.max(2.5, r * 0.11);
    ctx.strokeStyle = rgba(col, 0.92 * alpha);
    ctx.stroke();
    // Organelles: one rod per open position. Long rods ride the upper half, short rods the lower.
    let i = 0;
    for (const m of MARKETS) {
      const p = c.pos.get(m);
      i++;
      if (!p) continue;
      const k = i - 2;
      const ang = p.side === 1 ? -Math.PI / 2 + k * 0.85 : Math.PI / 2 - k * 0.85;
      const cx = x + Math.cos(ang) * r * 0.6;
      const cy = y + Math.sin(ang) * r * 0.6;
      const L = r * (0.22 + 0.14 * Math.log10(Math.max(1, p.lev)));
      ctx.strokeStyle = rgba(p.side === 1 ? PAL.long : PAL.short, alpha);
      ctx.lineWidth = Math.max(3.5, r * 0.17);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(ang) * L * 0.5, cy - Math.sin(ang) * L * 0.5);
      ctx.lineTo(cx + Math.cos(ang) * L * 0.5, cy + Math.sin(ang) * L * 0.5);
      ctx.stroke();
      ctx.lineCap = "butt";
    }
    // Nucleus.
    const nx = x + Math.cos(c.seed) * r * 0.08;
    const ny = y + Math.sin(c.seed) * r * 0.08;
    const nr = r * 0.34;
    ctx.fillStyle = rgba(PAL.ink, 0.88 * alpha);
    ctx.beginPath();
    ctx.ellipse(nx, ny, nr, nr * 0.86, c.seed, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(190,160,230,${0.6 * alpha})`;
    ctx.beginPath();
    ctx.arc(nx + nr * 0.3, ny - nr * 0.25, Math.max(1.5, nr * 0.24), 0, Math.PI * 2);
    ctx.fill();
  }

  private drawFx(ctx: CanvasRenderingContext2D, c: Cell) {
    for (const f of c.fx) {
      const a = this.now - f.t0;
      if (f.kind === "cilia") {
        const k = a / 0.9;
        const col = f.side === 1 ? PAL.long : PAL.short;
        const baseA = f.side === 1 ? -Math.PI / 2 : Math.PI / 2;
        ctx.strokeStyle = rgba(col, 1 - k);
        ctx.lineWidth = 3;
        for (const o of [-0.55, 0, 0.55]) {
          const ang = baseA + o;
          const sx = c.x + Math.cos(ang) * c.r;
          const sy = c.y + Math.sin(ang) * c.r;
          const L = c.r * 1.1 * Math.sin(Math.PI * k);
          const ex = sx + Math.cos(ang) * L;
          const ey = sy + Math.sin(ang) * L;
          const w = Math.sin(a * 24 + o * 3) * 8;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.quadraticCurveTo((sx + ex) / 2 - Math.sin(ang) * w, (sy + ey) / 2 + Math.cos(ang) * w, ex, ey);
          ctx.stroke();
        }
      } else {
        const k = a / 1.6;
        const d = c.r + 6 + 60 * easeOut(k);
        const bx = c.x + Math.cos(f.ang) * d;
        const by = c.y + Math.sin(f.ang) * d;
        const br = c.r * 0.34 * (1 - 0.5 * k);
        const col = f.good ? PAL.profit : PAL.loss;
        ctx.fillStyle = rgba(col, 0.3 * (1 - k));
        ctx.strokeStyle = rgba(col, 0.9 * (1 - k));
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Cleavage bridge while the bud is still pinching off.
        if (k < 0.35) {
          ctx.beginPath();
          ctx.moveTo(c.x + Math.cos(f.ang) * c.r, c.y + Math.sin(f.ang) * c.r);
          ctx.lineTo(bx, by);
          ctx.lineWidth = br * (1 - k / 0.35);
          ctx.strokeStyle = rgba(col, 0.35);
          ctx.stroke();
        }
      }
    }
  }

  private drawDanger(ctx: CanvasRenderingContext2D, c: Cell, warn: number | null) {
    const r = c.r * c.grow + 10;
    ctx.save();
    ctx.setLineDash([7, 6]);
    ctx.lineDashOffset = this.now * 20;
    ctx.lineWidth = warn !== null ? 3.5 : 2.5;
    ctx.strokeStyle = rgba(PAL.loss, 0.9);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Labels are placed greedily so they never pile up: cells at risk first, then by equity.
  private drawLabels(ctx: CanvasRenderingContext2D, cells: Cell[], s: MatchState) {
    const lobby = !s.board;
    const fs = this.n <= 30 ? 20 : 15;
    const placed: { l: number; r: number; t: number; b: number }[] = [];
    const hit = (b: { l: number; r: number; t: number; b: number }) =>
      placed.some((p) => b.l < p.r && b.r > p.l && b.t < p.b && b.b > p.t) || b.t < F.t - 40;
    const order = [...cells].sort((a, b) => Number(b.danger) - Number(a.danger) || b.eqT - a.eqT);
    for (const c of order) {
      const pnl = c.eqT - START_BALANCE;
      const eq = Math.abs(c.disp - c.eqT) < 0.01 ? moneyStr(c.eqStr) : money(c.disp);
      const line2 = lobby ? (c.bot ? "BOT" : "") : c.bot ? `BOT  ${eq}` : eq;
      const w1 = this.type.width(ctx, c.callsign, fs, 800, false);
      const w2 = line2 ? this.type.width(ctx, line2, fs * 0.8, 700) : 0;
      const r = c.r * c.grow + 6;
      const pref = c.join % 2 === 0;
      let done = false;
      for (const two of line2 ? [true, false] : [false]) {
        const h = two ? fs * 2.05 : fs * 1.15;
        const w = Math.max(w1, two ? w2 : 0) + 8;
        for (const above of [pref, !pref]) {
          const top = above ? c.y - r - h : c.y + r;
          const box = { l: c.x - w / 2, r: c.x + w / 2, t: top, b: top + h };
          if (hit(box)) continue;
          placed.push(box);
          const y1 = top + fs * 0.95;
          this.type.draw(ctx, c.callsign, c.x, y1, {
            size: fs,
            weight: 800,
            color: PAL.ink,
            align: "center",
            halo: PAL.halo,
            tab: false,
            alpha: c.grow,
          });
          if (two)
            this.type.draw(ctx, line2, c.x, y1 + fs * 0.95, {
              size: fs * 0.8,
              weight: 700,
              color: lobby || Math.abs(pnl) < 0.5 ? PAL.ink : pnl > 0 ? PAL.profit : PAL.loss,
              align: "center",
              halo: PAL.halo,
              alpha: c.grow,
            });
          done = true;
          break;
        }
        if (done) break;
      }
    }
  }

  private drawLysis(ctx: CanvasRenderingContext2D, d: Death, s: number, reduced: boolean) {
    if (s < 0) return;
    const violent = d.checkpoint === null;
    const a = s * (violent ? 1.5 : 1);
    if (a >= 2.75) return;
    if (reduced) {
      const k = clamp01(a / 1.2);
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = PAL.loss;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = PAL.ink;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r * 0.34, 0, Math.PI * 2);
      ctx.fill();
      this.type.draw(ctx, d.callsign, d.x, d.y - d.r - 12, { size: 20, weight: 800, color: PAL.loss, align: "center", halo: PAL.halo, tab: false, alpha: 1 - k });
      ctx.globalAlpha = 1;
      return;
    }
    const R = rng(d.seed);
    // Swell and crack.
    if (a < 0.28) {
      const k = a / 0.28;
      this.membrane(ctx, d.x, d.y, d.r * (1 + (violent ? 0.4 : 0.18) * k), d.seed, 0.06 * k);
      ctx.fillStyle = rgba(PAL.loss, 0.25);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = PAL.loss;
      ctx.stroke();
    }
    const u = a - 0.22;
    if (u > 0) {
      // Carmine bleeding into the reagent: the dye cloud of a lysed cell.
      const bk = clamp01(u / 1.4);
      const br = d.r * (1.2 + 3.2 * easeOut(bk)) * (violent ? 1.5 : 1);
      const ba = 0.55 * (1 - clamp01((u - 1.0) / 1.5));
      if (ba > 0) {
        const g = ctx.createRadialGradient(d.x, d.y + 10 * u, 0, d.x, d.y + 10 * u, br);
        g.addColorStop(0, rgba(PAL.loss, ba));
        g.addColorStop(0.6, rgba(PAL.loss, ba * 0.45));
        g.addColorStop(1, rgba(PAL.loss, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(d.x, d.y + 10 * u, br, 0, Math.PI * 2);
        ctx.fill();
      }
      // Membrane fragments.
      const N = 16;
      for (let i = 0; i < N; i++) {
        const ang = (i / N) * Math.PI * 2 + R() * 0.3;
        const v = (70 + R() * 110) * (violent ? 2.4 : 1.3);
        const dist = d.r + v * (1 - Math.exp(-2.6 * u));
        const fx = d.x + Math.cos(ang) * dist;
        const fy = d.y + Math.sin(ang) * dist + 34 * u * u;
        const rot = ang + u * (R() - 0.5) * 5;
        const al = clamp01(1 - u / 2.2);
        if (al <= 0) continue;
        ctx.save();
        ctx.translate(fx, fy);
        ctx.rotate(rot);
        ctx.strokeStyle = rgba(PAL.loss, al);
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.arc(-d.r, 0, d.r, -0.2, 0.2);
        ctx.stroke();
        ctx.restore();
      }
      // Cytoplasm spilling and sinking.
      for (let i = 0; i < 26; i++) {
        const ang = R() * Math.PI * 2;
        const v = (20 + R() * 70) * (violent ? 2 : 1);
        const px = d.x + Math.cos(ang) * v * (1 - Math.exp(-2 * u));
        const py = d.y + Math.sin(ang) * v * (1 - Math.exp(-2 * u)) + 50 * Math.pow(u, 1.4);
        const al = clamp01(0.7 * (1 - u / 2.5));
        ctx.fillStyle = rgba(i % 3 === 0 ? PAL.ink : PAL.loss, al);
        ctx.beginPath();
        ctx.arc(px, py, 1.5 + R() * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      if (violent && u < 0.7) {
        ctx.strokeStyle = rgba(PAL.loss, 1 - u / 0.7);
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r + 420 * easeOut(u / 0.7), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // Nucleus sinks to the sediment.
    const p = easeIO((a - 0.3) / 2.45);
    const nx = lerp(d.x, d.homeX, p);
    const ny = lerp(d.y, SED_Y, p);
    const nr = lerp(d.r * 0.36, 7, p);
    ctx.fillStyle = rgba(PAL.ink, 0.9);
    ctx.beginPath();
    ctx.ellipse(nx, ny, nr, nr * 0.85, d.seed, 0, Math.PI * 2);
    ctx.fill();
    const la = clamp01(1 - (a - 1.3) / 0.9);
    if (la > 0)
      this.type.draw(ctx, d.callsign, d.x, d.y - d.r - 16 - a * 6, {
        size: 22,
        weight: 800,
        color: PAL.loss,
        align: "center",
        halo: PAL.halo,
        tab: false,
        alpha: la,
      });
  }

  private drawSediment(ctx: CanvasRenderingContext2D, clock: number, reduced: boolean) {
    for (const d of this.deaths.values()) {
      const a = (clock - d.t) * (d.checkpoint === null ? 1.5 : 1);
      const k = reduced ? clamp01((a - 0.6) / 0.8) : a >= 2.75 ? 1 : 0;
      if (k <= 0) continue;
      ctx.globalAlpha = k;
      ctx.fillStyle = rgba(PAL.ink, 0.85);
      ctx.beginPath();
      ctx.ellipse(d.homeX, SED_Y, 7, 6, d.seed, 0, Math.PI * 2);
      ctx.fill();
      this.type.draw(ctx, d.callsign, d.homeX, d.join % 2 === 0 ? SED_Y + 26 : SED_Y + 42, {
        size: 14,
        weight: 700,
        color: PAL.zoneDeep,
        align: "center",
        tab: false,
        alpha: 0.85 * k,
      });
      ctx.globalAlpha = 1;
    }
  }

  private drawReagent(ctx: CanvasRenderingContext2D, s: MatchState, cp: { s: number; ev: { players: { player: string }[] } } | null, reduced: boolean) {
    const yz = this.yOf(this.zoneD);
    let surface = yz;
    let turb = 1;
    if (cp && !reduced) {
      let top = yz;
      for (const p of cp.ev.players) {
        const d = this.deaths.get(p.player);
        if (d) top = Math.min(top, d.y - d.r - 30);
      }
      const t = cp.s;
      const h = t < 0.55 ? easeOut(t / 0.55) * 1.06 : t < 1.6 ? 1 : 1 - easeIO((t - 1.6) / 1.6);
      surface = lerp(yz, Math.min(yz - 110, top), clamp01(h));
      turb = 1 + 3 * clamp01(1 - Math.abs(t - 0.5) / 1.4);
    }
    const t = this.wt;
    const wave = (x: number) =>
      surface + turb * (4 * Math.sin(x * 0.011 + t * 1.2) + 2.5 * Math.sin(x * 0.029 - t * 1.9));
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, wave(x));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = rgba(PAL.zone, 0.72);
    ctx.fill();
    // Deeper layer.
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, Math.max(wave(x) + 26, surface + 26 + 3 * Math.sin(x * 0.017 + t)));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = rgba(PAL.zone, 0.35);
    ctx.fill();
    // Meniscus.
    ctx.beginPath();
    for (let x = 0; x <= W; x += 16) (x === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, x, wave(x));
    ctx.strokeStyle = PAL.zoneDeep;
    ctx.lineWidth = 3;
    ctx.stroke();
    // Bubbles rising through the reagent.
    const R = rng(77);
    for (let i = 0; i < 40; i++) {
      const bx = R() * W;
      const sp = 18 + R() * 30;
      const ph = R();
      const depth = H - surface;
      if (depth < 20) break;
      const prog = reduced ? ph : (ph + (t * sp) / depth) % 1;
      const by = H - prog * depth;
      ctx.strokeStyle = rgba(PAL.zoneDeep, 0.35 * (1 - prog));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(bx + Math.sin(prog * 9 + i) * 5, by, 2 + R() * 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (s.tick || s.board) {
      const ly = Math.min(yz + 34, H - 40);
      this.type.draw(ctx, "zone", 164, ly, { size: 19, weight: 700, color: "#5C4300", tab: false });
      this.type.draw(ctx, moneyStr(this.zoneD.toFixed(2)), 164, ly + 28, {
        size: 26,
        weight: 800,
        color: "#5C4300",
      });
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D, s: MatchState, clock: number, warn: number | null) {
    const T = this.type;
    const x = 60;
    let big = "";
    let l2 = "";
    let l3 = "";
    if (s.final) {
      big = "Final";
      l2 = `${s.final.finalists.length} survivors split the pot`;
      l3 = s.settled ? "Paid out on chain" : "Payouts are provisional until settlement";
    } else if (s.status === "open" || s.status === null) {
      big = String(s.players.length);
      l2 = s.players.length === 1 ? "player in the dish" : "players in the dish";
      l3 = "Waiting for players";
    } else if (s.status === "countdown") {
      big = clockStr(-clock);
      l2 = "until the match starts";
      l3 = `${s.players.length} players`;
    } else if (s.status === "live" || s.status === "settling") {
      const nc = s.tick?.nextCheckpoint;
      const end = 120;
      if (nc) {
        big = clockStr(nc.at - clock);
        l2 = `until checkpoint ${nc.index}`;
      } else {
        big = clockStr(end - clock);
        l2 = "until the final";
      }
      l3 = `${clockStr(end - clock)} left in the match`;
    } else if (s.status === "cancelled") {
      big = "Cancelled";
      l2 = "Every entry is refunded";
    }
    const urgent = warn !== null;
    T.draw(ctx, big, x, 126, { size: 108, weight: 800, color: urgent ? PAL.loss : PAL.ink, halo: PAL.halo, haloW: 10 });
    T.draw(ctx, l2, x + 4, 166, { size: 28, weight: 700, color: PAL.ink, halo: PAL.halo, tab: false });
    if (l3) T.draw(ctx, l3, x + 4, 200, { size: 21, weight: 600, color: PAL.ink, alpha: 0.7, halo: PAL.halo });

    // Marks.
    if (s.tick) {
      MARKETS.forEach((m, i) => {
        const y = 64 + i * 42;
        T.draw(ctx, m, RIGHT_L, y, { size: 24, weight: 700, color: PAL.ink, alpha: 0.75, halo: PAL.halo, tab: false });
        const exact = s.tick!.marks[m];
        const str = Math.abs(this.marks[m] - num(exact)) < 0.005 ? moneyStr(exact) : money(this.marks[m]);
        T.draw(ctx, str, RIGHT_R, y, { size: 32, weight: 800, color: PAL.ink, align: "right", halo: PAL.halo });
      });
    }
    // Pot.
    const potY = s.tick ? 222 : 86;
    T.draw(ctx, "Pot", RIGHT_L, potY, { size: 24, weight: 700, color: PAL.ink, alpha: 0.75, halo: PAL.halo, tab: false });
    T.draw(ctx, `$${moneyStr(unitsToUsd(s.potUnits))}`, RIGHT_R, potY + 6, {
      size: 50,
      weight: 800,
      color: PAL.ink,
      align: "right",
      halo: PAL.halo,
    });
    const alive = s.board ? s.board.rows.filter((r) => r.alive).length : s.players.length;
    if (s.board)
      T.draw(ctx, `${alive} of ${s.players.length} alive`, RIGHT_R, potY + 42, {
        size: 22,
        weight: 600,
        color: PAL.ink,
        align: "right",
        alpha: 0.75,
        halo: PAL.halo,
      });
    if (s.status === "open" || s.status === "countdown")
      T.draw(ctx, "$5.00 to enter, 4 to 50 players", RIGHT_R, potY + 42, {
        size: 22,
        weight: 600,
        color: PAL.ink,
        align: "right",
        alpha: 0.75,
        halo: PAL.halo,
      });
  }

  private drawFeed(ctx: CanvasRenderingContext2D, s: MatchState, clock: number, reduced: boolean) {
    if (!s.eliminations.length) return;
    const T = this.type;
    let y = 352;
    T.draw(ctx, "Eliminated", RIGHT_L, y, { size: 26, weight: 800, color: PAL.ink, halo: PAL.halo, tab: false });
    y += 40;
    const lines: { t: number; k: number; callsign: string; why: string; col: string }[] = [];
    for (let i = s.eliminations.length - 1; i >= 0; i--) {
      const e = s.eliminations[i];
      e.players.forEach((p, k) => {
        const why = p.reason === "liquidated" ? "liquidated" : p.reason === "zone" ? "in the zone" : `cut, rank ${p.rank}`;
        lines.push({
          t: e.t,
          k,
          callsign: p.callsign,
          why,
          col: p.reason === "zone" ? PAL.zoneDeep : PAL.loss,
        });
      });
    }
    const max = 15;
    for (const [i, l] of lines.entries()) {
      if (i >= max) {
        T.draw(ctx, `and ${lines.length - max} more`, RIGHT_L, y + 4, { size: 18, weight: 600, color: PAL.ink, alpha: 0.6, halo: PAL.halo, tab: false });
        break;
      }
      const appear = l.t + 0.15 + l.k * 0.09;
      const a = reduced ? clamp01((clock - appear) / 0.5) : clamp01((clock - appear) / 0.25);
      if (a <= 0) continue;
      T.draw(ctx, clockStr(l.t), RIGHT_L, y, { size: 19, weight: 700, color: PAL.ink, alpha: 0.6 * a, halo: PAL.halo });
      const w = T.draw(ctx, l.callsign, RIGHT_L + 52, y, { size: 21, weight: 800, color: PAL.ink, alpha: a, halo: PAL.halo, tab: false });
      T.draw(ctx, l.why, RIGHT_R, y, { size: 17, weight: 700, color: l.col, align: "right", alpha: a, halo: PAL.halo });
      // Struck through like a crossed-out sample.
      const sk = reduced ? a : easeOut((clock - appear - 0.2) / 0.35);
      if (sk > 0) {
        ctx.strokeStyle = rgba(PAL.loss, 0.85);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(RIGHT_L + 50, y - 7);
        ctx.lineTo(RIGHT_L + 50 + (w + 6) * sk, y - 7);
        ctx.stroke();
      }
      y += 31;
    }
  }

  private drawIris(ctx: CanvasRenderingContext2D, k: number, reduced: boolean) {
    const cx = W / 2;
    const cy = H / 2;
    if (reduced) {
      ctx.fillStyle = rgba(PAL.ink, 0.25 * k);
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const R = lerp(1200, 860, k);
    const blades = 9;
    const rot = k * 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    for (let i = 0; i <= blades; i++) {
      const a = rot + (i / blades) * Math.PI * 2;
      const px = cx + Math.cos(a) * R;
      const py = cy + Math.sin(a) * R * 0.92;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = rgba(PAL.ink, 0.86);
    ctx.fill("evenodd");
    // Blade seams.
    ctx.strokeStyle = "rgba(235,198,210,0.18)";
    ctx.lineWidth = 2;
    for (let i = 0; i < blades; i++) {
      const a = rot + (i / blades) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R * 0.92);
      ctx.lineTo(cx + Math.cos(a + 0.5) * (R + 700), cy + Math.sin(a + 0.5) * (R + 700));
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawWarnText(ctx: CanvasRenderingContext2D, s: MatchState, warn: number) {
    const nc = s.tick?.nextCheckpoint;
    if (!nc) return;
    const below = [...this.cells.values()].filter((c) => !this.deaths.has(c.id) && c.danger).length;
    this.type.draw(ctx, `Checkpoint ${nc.index} in ${Math.ceil(warn)}`, MID_X, 118, {
      size: 64,
      weight: 800,
      color: PAL.loss,
      align: "center",
      halo: PAL.halo,
      haloW: 10,
    });
    this.type.draw(ctx, `${below} below the line`, MID_X, 162, {
      size: 28,
      weight: 700,
      color: PAL.ink,
      align: "center",
      halo: PAL.halo,
    });
  }

  private drawCheckpointCaption(ctx: CanvasRenderingContext2D, index: number, cutN: number, left: number, t: number) {
    const a = clamp01(t / 0.2) * (1 - clamp01((t - 3.8) / 0.8));
    if (a <= 0) return;
    const sc = 1 + 0.08 * (1 - easeOut(t / 0.5));
    ctx.save();
    ctx.translate(MID_X, 120);
    ctx.scale(sc, sc);
    this.type.draw(ctx, `Checkpoint ${index}`, 0, 0, { size: 88, weight: 900, color: PAL.ink, align: "center", halo: PAL.halo, haloW: 12, alpha: a });
    ctx.restore();
    this.type.draw(ctx, `${cutN} cut, ${left} survive`, MID_X, 170, {
      size: 34,
      weight: 800,
      color: PAL.loss,
      align: "center",
      halo: PAL.halo,
      alpha: a,
    });
  }

  private drawLiquidationCaptions(ctx: CanvasRenderingContext2D, clock: number) {
    for (const d of this.deaths.values()) {
      if (d.checkpoint !== null) continue;
      const t = clock - d.t;
      if (t < 0 || t > 3) continue;
      const a = clamp01(t / 0.15) * (1 - clamp01((t - 2.4) / 0.6));
      const y = clamp(d.y - d.r - 60, F.t, 920);
      this.type.draw(ctx, "Liquidated", d.x, y, { size: 44, weight: 900, color: PAL.loss, align: "center", halo: PAL.halo, haloW: 9, alpha: a, tab: false });
    }
  }

  private drawStream(ctx: CanvasRenderingContext2D, s: MatchState, clock: number, reduced: boolean) {
    if (reduced || !s.final) return;
    const finalT = s.tick?.t ?? clock;
    const sF = clock - finalT;
    const end = this.settledAt !== null ? clock - this.settledAt : -1;
    const fade = end < 0 ? 1 : 1 - clamp01((end - 0.5) / 2.5);
    const start = clamp01((sF - 0.6) / 0.6);
    const a = start * fade;
    if (a <= 0) return;
    const total = s.final.finalists.reduce((acc, f) => acc + Number(f.provisionalPayoutUnits), 0) || 1;
    for (const f of s.final.finalists) {
      const c = this.cells.get(f.player);
      if (!c) continue;
      const share = Number(f.provisionalPayoutUnits) / total;
      const count = 8 + Math.round(share * 50);
      const cx = (POT_PT.x + c.x) / 2;
      const cy = Math.min(POT_PT.y, c.y) - 140;
      const R = rng(c.seed);
      for (let i = 0; i < count; i++) {
        const ph = i / count + R() * 0.02;
        const q = (sF * 0.32 + ph) % 1;
        const jx = (R() - 0.5) * 26;
        const jy = (R() - 0.5) * 26;
        const ix = (1 - q) * (1 - q) * POT_PT.x + 2 * (1 - q) * q * (cx + jx) + q * q * c.x;
        const iy = (1 - q) * (1 - q) * POT_PT.y + 2 * (1 - q) * q * (cy + jy) + q * q * c.y;
        ctx.fillStyle = rgba(PAL.profit, a * (0.35 + 0.55 * Math.sin(Math.PI * q)));
        ctx.beginPath();
        ctx.arc(ix, iy, 2.5 + 2.5 * Math.sin(Math.PI * q), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawFinal(ctx: CanvasRenderingContext2D, s: MatchState, clock: number, reduced: boolean) {
    const fin = s.final!;
    const T = this.type;
    fin.finalists.forEach((f, i) => {
      const c = this.cells.get(f.player);
      if (!c) return;
      const y0 = c.y + c.r + 40;
      if (c.bot)
        T.draw(ctx, "BOT", c.x, c.y - c.r - (i === 0 ? 64 : 56), {
          size: 18,
          weight: 800,
          color: PAL.ink,
          align: "center",
          halo: PAL.halo,
          alpha: 0.75,
          tab: false,
        });
      T.draw(ctx, f.callsign, c.x, c.y - c.r - 22, {
        size: i === 0 ? 38 : 30,
        weight: 900,
        color: PAL.ink,
        align: "center",
        halo: PAL.halo,
        haloW: 8,
        tab: false,
      });
      T.draw(ctx, moneyStr(f.equity), c.x, y0, { size: 24, weight: 700, color: PAL.profit, align: "center", halo: PAL.halo });
      const units = this.payD.get(f.player) ?? 0;
      const usd = units / 1e6;
      T.draw(ctx, `$${money(Math.floor(usd * 100) / 100)}`, c.x, y0 + 44, {
        size: 40,
        weight: 900,
        color: PAL.ink,
        align: "center",
        halo: PAL.halo,
        haloW: 8,
      });
      T.draw(ctx, s.settled ? "paid" : "provisional", c.x, y0 + 72, {
        size: 19,
        weight: 700,
        color: s.settled ? PAL.profit : PAL.ink,
        alpha: s.settled ? 1 : 0.7,
        align: "center",
        halo: PAL.halo,
        tab: false,
      });
    });
    if (s.settled && this.settledAt !== null) this.drawStamp(ctx, s.settled.txHash, clock - this.settledAt, reduced);
  }

  private stampCanvas(hash: string): HTMLCanvasElement {
    if (this.stamp && this.stamp.hash === hash) return this.stamp.c;
    const w = 600;
    const h = 190;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    g.strokeStyle = PAL.ink;
    g.lineWidth = 6;
    g.strokeRect(6, 6, w - 12, h - 12);
    g.lineWidth = 2;
    g.strokeRect(18, 18, w - 36, h - 36);
    this.type.draw(g, "Verified by Chainlink", w / 2, 92, { size: 50, weight: 900, color: PAL.ink, align: "center", tab: false });
    const short = `${hash.slice(0, 6)}…${hash.slice(-4)}`;
    this.type.draw(g, `tx ${short}`, w / 2, 144, { size: 32, weight: 700, color: PAL.ink, align: "center" });
    // Ink grain.
    const R = rng(hash.length * 31 + 7);
    g.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(0,0,0,${0.4 + R() * 0.6})`;
      g.beginPath();
      g.arc(R() * w, R() * h, 0.6 + R() * 2.2, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = "source-over";
    this.stamp = { hash, c };
    return c;
  }

  private drawStamp(ctx: CanvasRenderingContext2D, hash: string, t: number, reduced: boolean) {
    const c = this.stampCanvas(hash);
    const k = reduced ? clamp01(t / 0.5) : clamp01(t / 0.22);
    const sc = (reduced ? 1 : lerp(1.7, 1, easeOut(k))) * 0.82;
    ctx.save();
    ctx.translate(MID_X, 912);
    ctx.rotate(-0.09);
    ctx.scale(sc, sc);
    ctx.globalAlpha = k * 0.92;
    ctx.drawImage(c, -c.width / 2, -c.height / 2);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
