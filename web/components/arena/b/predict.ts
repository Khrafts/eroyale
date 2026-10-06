// The storm, prediction rounds: a survey of one price over time. Every prediction is a contour line across the
// map; the live price is the survey trace walking toward the resolve post. After the lock the storm closes in from
// above and below, leaving one dry corridor: the prices the current winners span. At the resolve a strike lands
// on the settlement price, the storm slams shut on the winners' corridor and their payouts roll in.
// Same palette, type and motion as the royale storm; flood blue is still only the storm.
import { num, unitsToUsd } from "@/lib/events";
import type { MatchState } from "@/lib/useMatch";
import { C, Type, clamp, commas, easeOut, easeOutBack, hash, lerp, mmss, rgba, rng, shortHash, smooth, spring, stamp } from "./draw";

const W = 1920;
const H = 1080;
const PL = 150; // plot left
const PR = 1470; // the resolve post
const PT = 290; // plot top
const PB = 985; // plot bottom
const LX = 1528; // label column
const RX = 1888; // right edge of the label column
const ROW = 30;

type Line = {
  id: string;
  callsign: string;
  bot: boolean;
  price: number;
  priceStr: string;
  join: number;
  ly: number;
  vly: number;
  sink: number;
};

type Drop = { x: number; y: number; len: number; sp: number };

export class PredictScene {
  T: Type;
  lo = 0;
  hi = 1;
  vlo = 0;
  vhi = 0;
  first = true;
  real = 0;
  lines = new Map<string, Line>();
  lineKey = "";
  fTop = 0;
  vTop = 0;
  fBot = 0;
  vBot = 0;
  fronts = false;
  drops: Drop[] = [];
  lobbyId: number | null = null;

  constructor(cond: string, xc: string) {
    this.T = new Type(cond, xc);
    const r = rng(23);
    for (let i = 0; i < 220; i++) this.drops.push({ x: r() * (W + 300), y: r() * H, len: 14 + r() * 26, sp: 900 + r() * 700 });
  }

  Y(v: number) {
    return PB - ((v - this.lo) / (this.hi - this.lo)) * (PB - PT);
  }

  private reset() {
    this.lines.clear();
    this.lineKey = "";
    this.first = true;
    this.fronts = false;
    this.T.rolls.clear();
  }

  frame(ctx: CanvasRenderingContext2D, s: MatchState, now: number, dt: number, reduced: boolean) {
    this.real += dt;
    if (s.lobbyId !== this.lobbyId) {
      this.lobbyId = s.lobbyId;
      this.reset();
    }
    const T = this.T;
    ctx.fillStyle = C.sky;
    ctx.fillRect(0, 0, W, H);
    const round = s.round;
    if (!round) {
      T.text(ctx, "Trading Royale", 40, 70, T.font("c", 800, 44), C.chalk);
      T.text(ctx, s.error ? "" : "Waiting for the next prediction round", 960, 540, T.font("c", 700, 44), rgba(C.chalk, 0.8), "center");
      if (!reduced) this.drawRain(ctx, dt, 0.2);
      return;
    }
    const fin = s.pfinal;
    const fDt = fin ? now - (s.pfinalT ?? now) : -1;
    const settledDt = s.settled ? now - (s.settledT ?? now) : -1;
    const lockT = round.lockTime;
    const endT = round.endTime;
    const u0 = s.tOrigin ?? s.path[0]?.u ?? lockT - 60;
    const span = Math.max(1, endT - u0);
    const X = (u: number) => PL + ((u - u0) / span) * (PR - PL);
    const locked = !!s.locked;
    // The trace runs one tick behind the clock and interpolates, so the head glides between 4 Hz updates.
    const lastU = s.path.length ? s.path[s.path.length - 1].u : u0;
    const headU = Math.max(u0, Math.min(now - 0.25, lastU));
    const head = priceAt(s.path, headU);

    // ---------- lines (revealed at the lock) ----------
    const leaders = new Map<string, number>();
    if (fin) for (const w of fin.winners) leaders.set(w.player, w.rank);
    else for (const l of s.ptick?.leaders ?? []) leaders.set(l.player, l.rank);
    const key = s.locked ? s.locked.predictions.map((p) => p.player + p.price).join() : "";
    if (key !== this.lineKey) {
      this.lineKey = key;
      this.lines.clear();
      (s.locked?.predictions ?? []).forEach((p, i) => {
        this.lines.set(p.player, {
          id: p.player,
          callsign: p.callsign,
          bot: p.bot,
          price: num(p.price),
          priceStr: p.price,
          join: s.players.findIndex((x) => x.player === p.player) ?? i,
          ly: 0,
          vly: 0,
          sink: 0,
        });
      });
    }

    // ---------- vertical scale ----------
    const sp = fin ? num(fin.settlementPrice) : null;
    let vals: number[];
    if (fin && sp !== null) {
      vals = [sp, ...fin.winners.map((w) => num(w.price))];
    } else {
      vals = s.path.filter((p) => p.u >= u0).map((p) => p.p);
      for (const l of this.lines.values()) vals.push(l.price);
    }
    if (!vals.length) vals = [head ?? 100];
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const mid = (lo + hi) / 2;
    const minSpan = mid * (fin ? 0.0006 : 0.0016);
    if (hi - lo < minSpan) {
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    const pad = (hi - lo) * (fin ? 0.32 : 0.12);
    const tlo = lo - pad;
    const thi = hi + pad;
    if (this.first || reduced) {
      this.lo = tlo;
      this.hi = thi;
    } else {
      [this.lo, this.vlo] = spring(this.lo, this.vlo, tlo, fin ? 2.6 : 3.2, 1, dt);
      [this.hi, this.vhi] = spring(this.hi, this.vhi, thi, fin ? 2.6 : 3.2, 1, dt);
    }

    // ---------- the storm fronts: the dry corridor is the winners' span ----------
    let cTop: number | null = null;
    let cBot: number | null = null;
    if (fin && fin.winners.length) {
      const ps = fin.winners.map((w) => num(w.price));
      cTop = Math.max(...ps, sp!);
      cBot = Math.min(...ps, sp!);
    } else if (s.ptick) {
      cTop = num(s.ptick.band.high);
      cBot = num(s.ptick.band.low);
    }
    if (cTop !== null && cBot !== null) {
      if (!this.fronts) {
        // the storm rolls in from the map edges at the lock (or sits in place on a reload)
        this.fTop = this.first || reduced ? cTop : this.hi;
        this.fBot = this.first || reduced ? cBot : this.lo;
        this.fronts = true;
      }
      if (reduced) {
        this.fTop = cTop;
        this.fBot = cBot;
      } else {
        const om = fin ? 5.5 : 2.4;
        [this.fTop, this.vTop] = spring(this.fTop, this.vTop, cTop, om, fin ? 0.55 : 0.9, dt);
        [this.fBot, this.vBot] = spring(this.fBot, this.vBot, cBot, om, fin ? 0.55 : 0.9, dt);
      }
    }

    // ---------- draw ----------
    const step = niceStep((this.hi - this.lo) / 9);
    this.drawGrid(ctx, step);
    const lockX = X(lockT);
    this.drawPosts(ctx, lockX, now, lockT, endT, locked, !!fin);
    // the map itself is clipped below the HUD, so a zoom never draws over the headline
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, PT - 60, W, H - PT + 60);
    ctx.clip();
    this.drawLines(ctx, lockX, leaders, s, now, reduced, fDt);
    this.drawTrace(ctx, s, X, u0, headU, head);
    const surge = fin && !reduced ? Math.exp(-Math.max(0, fDt - 0.25) * 1.6) : 0;
    if (this.fronts) this.drawFronts(ctx, lockX, reduced, surge, fDt);
    if (fin && sp !== null) this.drawSettlement(ctx, sp, fDt, reduced);
    this.drawHead(ctx, X(headU), head, !!fin, reduced);
    ctx.restore();
    if (!reduced) this.drawRain(ctx, dt, fin ? 0.3 * (1 - smooth(fDt / 2.5)) : locked ? 0.45 : 0.25);
    this.drawLabels(ctx, s, leaders, now, dt, reduced, fDt);
    if (fin) this.drawStrike(ctx, sp!, fDt, reduced);

    // HUD
    this.drawTitle(ctx, s, reduced);
    this.drawMarket(ctx, s, head, reduced);
    this.drawCenter(ctx, s, now, reduced, fDt);
    if (s.settled && settledDt >= 0) {
      ctx.save();
      ctx.translate(1752, 138);
      ctx.scale(0.78, 0.78);
      stamp(ctx, T, s.settled.txHash, s.settled.mode, settledDt, reduced, 0, 0);
      ctx.restore();
    }
    this.first = false;
  }

  // ---------- map ----------
  private drawGrid(ctx: CanvasRenderingContext2D, step: number) {
    const T = this.T;
    const from = Math.ceil(this.lo / step) * step;
    const dec = step < 1 ? 2 : 0;
    ctx.save();
    ctx.setLineDash([2, 7]);
    ctx.strokeStyle = rgba(C.ink, 0.1);
    ctx.lineWidth = 1;
    for (let v = from; v <= this.hi; v += step) {
      const y = this.Y(v);
      if (y < PT - 40 || y > H - 10) continue;
      ctx.beginPath();
      ctx.moveTo(PL - 20, y);
      ctx.lineTo(PR, y);
      ctx.stroke();
      T.text(ctx, commas(v.toFixed(dec)), PL - 28, y + 8, T.font("x", 600, 23), rgba(C.ink, 0.72), "right", C.sky);
    }
    ctx.restore();
  }

  private drawPosts(ctx: CanvasRenderingContext2D, lockX: number, now: number, lockT: number, endT: number, locked: boolean, final: boolean) {
    const T = this.T;
    // lock post: dashed, the sealed stretch before it is shaded
    ctx.fillStyle = rgba("#0B1A20", 0.35);
    ctx.fillRect(PL, PT - 40, lockX - PL, PB - PT + 40);
    ctx.save();
    ctx.setLineDash([6, 8]);
    ctx.strokeStyle = rgba(C.chalk, 0.45);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lockX, PT - 40);
    ctx.lineTo(lockX, PB);
    ctx.stroke();
    ctx.restore();
    T.text(ctx, locked ? "Locked" : "Lock", lockX - 12, PT - 14, T.font("c", 700, 22), rgba(C.chalk, 0.75), "right", C.sky);
    T.text(ctx, "sealed calls", (PL + lockX) / 2, PB - 16, T.font("c", 600, 22), rgba(C.ink, 0.6), "center");
    // resolve post: a survey pole
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(PR, PT - 40);
    ctx.lineTo(PR, PB);
    ctx.stroke();
    for (let y = PT - 40; y < PB; y += 36) {
      ctx.fillStyle = rgba(C.ink, 0.9);
      ctx.fillRect(PR - 3, y, 6, 18);
    }
    T.text(ctx, final ? "Resolved" : now < endT ? "Resolve" : "Resolving", PR - 12, PT - 14, T.font("c", 700, 22), C.ink, "right", C.sky);
  }

  private drawLines(
    ctx: CanvasRenderingContext2D,
    lockX: number,
    leaders: Map<string, number>,
    s: MatchState,
    now: number,
    reduced: boolean,
    fDt: number,
  ) {
    const lockAge = s.locked && s.round ? now - s.round.lockTime : 0;
    let i = 0;
    for (const l of this.lines.values()) {
      const y = this.Y(l.price);
      const g = reduced ? 1 : easeOut((lockAge - i * 0.04) / 0.9);
      i++;
      if (g <= 0) continue;
      const lead = leaders.has(l.id);
      const gone = s.pfinal && !lead ? clamp((fDt - 0.4) / 1.2) : 0;
      ctx.save();
      ctx.globalAlpha = (reduced ? g : 1) * (1 - gone * 0.85);
      ctx.strokeStyle = lead ? C.profit : rgba(C.ink, 0.6);
      ctx.lineWidth = lead ? 2.5 : 1.5;
      if (!lead) ctx.setLineDash([7, 7]);
      ctx.beginPath();
      ctx.moveTo(PR - (PR - lockX) * g, y);
      ctx.lineTo(PR, y);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawTrace(ctx: CanvasRenderingContext2D, s: MatchState, X: (u: number) => number, u0: number, headU: number, head: number | null) {
    const pts = s.path;
    if (!pts.length || head === null) return;
    const stride = Math.max(1, Math.ceil(pts.length / 1600));
    ctx.save();
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < pts.length; i += stride) {
      const p = pts[i];
      if (p.u < u0) continue;
      if (p.u > headU) break;
      const x = X(p.u);
      const y = this.Y(p.p);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.lineTo(X(headU), this.Y(head));
    ctx.lineJoin = "round";
    ctx.strokeStyle = rgba(C.sky, 0.9);
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.strokeStyle = C.chalk;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  private drawFronts(ctx: CanvasRenderingContext2D, lockX: number, reduced: boolean, surge: number, fDt: number) {
    const t = this.real;
    const amp = reduced ? 0 : 3 + surge * 9;
    const yTop = this.Y(this.fTop) - 16;
    const yBot = this.Y(this.fBot) + 16;
    const x0 = lockX;
    const x1 = PR + 10;
    const wave = (x: number, y0: number, ph: number) => y0 + Math.sin(x * 0.017 + t * 1.3 + ph) * amp + Math.sin(x * 0.043 - t * 2.2 + ph) * amp * 0.45;
    // the storm from above: a cloud bank whose underside is the front
    const top = Math.max(PT - 60, Math.min(yTop, H));
    if (top > PT - 60) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x0, PT - 60);
      ctx.lineTo(x1, PT - 60);
      for (let x = x1; x >= x0; x -= 12) ctx.lineTo(x, Math.max(PT - 60, wave(x, top, 1.7)));
      ctx.closePath();
      const g = ctx.createLinearGradient(0, PT - 60, 0, top);
      g.addColorStop(0, rgba(C.floodDeep, 0));
      g.addColorStop(Math.min(0.5, 60 / Math.max(61, top - PT + 60)), rgba(C.floodDeep, 0.9));
      g.addColorStop(1, rgba(C.flood, 0.78));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.clip();
      this.sweep(ctx, PT - 60, top, t);
      ctx.restore();
      ctx.beginPath();
      for (let x = x0; x <= x1; x += 12) (x === x0 ? ctx.moveTo : ctx.lineTo).call(ctx, x, Math.max(PT - 60, wave(x, top, 1.7)));
      ctx.strokeStyle = C.floodHi;
      ctx.lineWidth = surge > 0.05 ? 4 : 2.5;
      ctx.stroke();
    }
    // the flood from below
    const bot = Math.min(H + 20, Math.max(yBot, PT - 60));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, H + 10);
    for (let x = x0; x <= x1; x += 12) ctx.lineTo(x, wave(x, bot, 0));
    ctx.lineTo(x1, H + 10);
    ctx.closePath();
    const g2 = ctx.createLinearGradient(0, bot, 0, H);
    g2.addColorStop(0, rgba(C.flood, 0.8));
    g2.addColorStop(1, rgba(C.floodDeep, 0.95));
    ctx.fillStyle = g2;
    ctx.fill();
    ctx.clip();
    this.sweep(ctx, bot, H, t);
    ctx.restore();
    ctx.beginPath();
    for (let x = x0; x <= x1; x += 12) (x === x0 ? ctx.moveTo : ctx.lineTo).call(ctx, x, wave(x, bot, 0));
    ctx.strokeStyle = C.floodHi;
    ctx.lineWidth = surge > 0.05 ? 4 : 2.5;
    ctx.stroke();
    if (surge > 0.05 && fDt > 0.2) {
      ctx.fillStyle = rgba("#E8EEFF", 0.75 * surge);
      for (let x = x0 + 6; x < x1; x += 11) {
        const j = (hash("f" + x) % 100) / 100;
        const r = 1.2 + j * 2.4;
        ctx.beginPath();
        ctx.arc(x, wave(x, bot, 0) - 2 + j * 7, r, 0, Math.PI * 2);
        ctx.arc(x, wave(x, top, 1.7) + 2 - j * 7, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private sweep(ctx: CanvasRenderingContext2D, y0: number, y1: number, t: number) {
    ctx.strokeStyle = rgba(C.floodHi, 0.09);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const off = (t * 14) % 16;
    for (let y = y0 + off; y < y1; y += 16) {
      ctx.moveTo(PL, y);
      ctx.lineTo(PR + 10, y);
    }
    ctx.stroke();
  }

  private drawHead(ctx: CanvasRenderingContext2D, x: number, p: number | null, final: boolean, reduced: boolean) {
    if (p === null) return;
    const y = this.Y(p);
    const pulse = reduced || final ? 0 : (this.real * 1.2) % 1;
    if (pulse > 0) {
      ctx.strokeStyle = rgba(C.chalk, 0.6 * (1 - pulse));
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 8 + pulse * 26, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = C.chalk;
    ctx.strokeStyle = C.sky;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private drawSettlement(ctx: CanvasRenderingContext2D, sp: number, fDt: number, reduced: boolean) {
    const y = this.Y(sp);
    const g = reduced ? clamp(fDt / 0.4) : easeOut((fDt - 0.25) / 0.7);
    if (g <= 0) return;
    ctx.save();
    ctx.globalAlpha = reduced ? g : 1;
    ctx.strokeStyle = C.chalk;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(PR, y);
    ctx.lineTo(PR - (PR - PL) * (reduced ? 1 : g), y);
    ctx.stroke();
    // a benchmark triangle on the post
    ctx.fillStyle = C.chalk;
    ctx.beginPath();
    ctx.moveTo(PR, y - 4);
    ctx.lineTo(PR + 22, y - 26);
    ctx.lineTo(PR - 22, y - 26);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawStrike(ctx: CanvasRenderingContext2D, sp: number, fDt: number, reduced: boolean) {
    const flashA = reduced ? 0.18 * clamp(1 - fDt / 0.6) : 0.6 * Math.exp(-fDt * 5);
    if (flashA > 0.005) {
      ctx.fillStyle = rgba("#DCE6FF", flashA);
      ctx.fillRect(0, 0, W, H);
    }
    if (reduced) return;
    const vis = fDt < 0.18 || (fDt > 0.26 && fDt < 0.42) || (fDt > 0.8 && fDt < 1.05);
    if (!vis) return;
    const r = rng(hash("strike") + Math.round(sp * 100));
    const ty = this.Y(sp) - 26;
    let x = PR + (r() - 0.5) * 360;
    let y = 0;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 16;
    for (let i = 1; i <= segs; i++) {
      const f = i / segs;
      x = i === segs ? PR : lerp(x, PR, f * 0.6) + (r() - 0.5) * 80;
      y = ty * f;
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rgba("#C9D7FF", 0.35);
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.strokeStyle = "#F4F7FF";
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  private drawRain(ctx: CanvasRenderingContext2D, dt: number, I: number) {
    if (I <= 0.01) return;
    const count = Math.floor(this.drops.length * I);
    ctx.strokeStyle = rgba(C.floodHi, 0.18);
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

  // ---------- the label column ----------
  private drawLabels(
    ctx: CanvasRenderingContext2D,
    s: MatchState,
    leaders: Map<string, number>,
    now: number,
    dt: number,
    reduced: boolean,
    fDt: number,
  ) {
    const T = this.T;
    const round = s.round!;
    if (!s.locked) {
      // sealed: who is in, how many have called, no prices
      const n = s.players.length;
      T.text(ctx, "Sealed calls", LX, PT - 14, T.font("c", 700, 22), rgba(C.chalk, 0.75));
      const w = T.roll(ctx, "sealed", String(s.predictedCount), LX, PT + 62, T.font("x", 800, 84), 84, C.chalk, "left", this.real, reduced);
      T.text(ctx, `of ${n} ${n === 1 ? "player" : "players"}`, LX + w + 12, PT + 60, T.font("c", 600, 28), rgba(C.chalk, 0.75));
      const top = PT + 112;
      const per = Math.max(2, Math.floor((PB - top) / ROW));
      const cols = n > per ? 2 : 1;
      s.players.forEach((p, i) => {
        const c = Math.floor(i / per);
        if (c >= cols) return;
        const x = LX + c * 186;
        const y = top + (i % per) * ROW;
        this.nameTag(ctx, p.callsign, p.bot, x, y, rgba(C.chalk, 0.85), 22);
      });
      if (n > per * cols) T.text(ctx, `and ${n - per * cols} more`, LX, top + per * ROW, T.font("c", 600, 22), rgba(C.ink, 0.8));
      if (n < 4) T.text(ctx, `${4 - n} more to play`, LX, PB, T.font("c", 700, 24), C.floodHi);
      return;
    }

    const fin = s.pfinal;
    const paid = new Map<string, string>();
    if (s.settled) s.settled.winners.forEach((w, i) => paid.set(w, s.settled!.amounts[i]));
    const rows = [...this.lines.values()].sort((a, b) => b.price - a.price || a.join - b.join);
    // spread labels around their line, keeping order and a minimum gap
    const gap = fin ? 38 : ROW;
    const visible = rows.filter((l) => !fin || leaders.has(l.id) || clamp((fDt - 0.4) / 1.2) < 1);
    const want = visible.map((l) => this.Y(l.price) + 8);
    const ys: number[] = [];
    want.forEach((y, i) => ys.push(i === 0 ? Math.max(y, PT - 8) : Math.max(y, ys[i - 1] + gap)));
    const over = ys.length ? ys[ys.length - 1] - (H - 24) : 0;
    if (over > 0) for (let i = ys.length - 1; i >= 0; i--) ys[i] = Math.min(ys[i] - over, i < ys.length - 1 ? ys[i + 1] - gap : Infinity);
    const minY = 34;
    if (ys.length && ys[0] < minY) {
      const d = minY - ys[0];
      for (let i = 0; i < ys.length; i++) ys[i] = i === 0 ? minY : Math.max(ys[i] + 0, ys[i - 1] + gap, ys[i] + d * (1 - i / ys.length));
    }
    const yTop = this.Y(this.fTop) - 16;
    const yBot = this.Y(this.fBot) + 16;
    visible.forEach((l, i) => {
      if (this.first || reduced || l.ly === 0) l.ly = ys[i];
      else [l.ly, l.vly] = spring(l.ly, l.vly, ys[i], 9, 0.85, dt);
      const lead = leaders.get(l.id);
      const lineY = this.Y(l.price);
      const wet = this.fronts && (lineY < yTop || lineY > yBot);
      const gone = fin && lead === undefined ? clamp((fDt - 0.4) / 1.2) : 0;
      const sinkY = reduced ? 0 : gone * 40;
      ctx.save();
      ctx.globalAlpha = 1 - gone;
      const col = lead !== undefined ? C.profit : wet ? rgba(C.floodHi, 0.85) : rgba(C.chalk, 0.85);
      // elbow from the resolve post to the label
      ctx.strokeStyle = lead !== undefined ? rgba(C.profit, 0.8) : rgba(C.ink, 0.35);
      ctx.lineWidth = lead !== undefined ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(PR + 4, lineY);
      ctx.lineTo(LX - 22, lineY);
      ctx.lineTo(LX - 6, l.ly - 8 + sinkY);
      ctx.stroke();
      const y = l.ly + sinkY;
      const halo = wet ? undefined : C.sky;
      if (lead !== undefined) T.roll(ctx, "rk" + l.id, String(lead), LX + 22, y, T.font("x", 800, 26), 26, C.profit, "right", this.real, reduced);
      const nameW = this.nameTag(ctx, l.callsign, l.bot, LX + 32, y, col, lead !== undefined ? 24 : 22, lead !== undefined ? 800 : 600, halo);
      if (fin && lead !== undefined) {
        const w = fin.winners.find((x) => x.player === l.id)!;
        const units = s.settled ? (paid.get(l.id) ?? w.provisionalPayoutUnits) : w.provisionalPayoutUnits;
        const reveal = reduced ? clamp((fDt - 0.6) / 0.4) : clamp((fDt - 1.1 - (fin.winners.length - w.rank) * 0.12) / 0.3);
        if (reveal > 0) {
          ctx.globalAlpha = reveal;
          const amt = "$" + commas(unitsToUsd(units));
          T.roll(ctx, "pay" + l.id, amt, RX, y + 2, T.font("x", 800, 32), 32, C.profit, "right", this.real, reduced);
          const aw = T.widthOf(ctx, T.font("x", 800, 32), amt);
          const dx = Math.max(LX + 40 + nameW, RX - aw - 14);
          T.text(ctx, `off ${commas(w.distance)}`, dx, y, T.font("c", 600, 20), rgba(C.chalk, 0.7), "right");
          ctx.globalAlpha = 1 - gone;
        }
      } else {
        T.text(ctx, commas(l.priceStr), RX, y, T.font("x", lead !== undefined ? 800 : 600, lead !== undefined ? 27 : 24), col, "right", halo);
      }
      ctx.restore();
    });
    if (fin) {
      const total = fin.winners.reduce((a, w) => a + BigInt(w.provisionalPayoutUnits), 0n);
      T.text(ctx, s.settled ? "Paid" : "Provisional payouts", LX, 46 + Math.max(0, Math.min(PT - 80, (ys[0] ?? PT) - 80)), T.font("c", 700, 22), rgba(C.chalk, 0.75));
      void total;
    } else {
      const k = s.ptick?.leaders.length ?? 0;
      T.text(ctx, `Closest ${k} win`, LX, PT - 14, T.font("c", 700, 22), C.profit, "left", C.sky);
    }
    void round;
  }

  private nameTag(
    ctx: CanvasRenderingContext2D,
    name: string,
    bot: boolean,
    x: number,
    y: number,
    color: string,
    size: number,
    weight = 700,
    halo?: string,
  ) {
    const T = this.T;
    const f = T.font("c", weight, size);
    T.text(ctx, name, x, y, f, color, "left", halo);
    let w = T.w(ctx, f, name);
    if (bot) {
      const bf = T.font("c", 700, 14);
      const bw = T.w(ctx, bf, "BOT") + 8;
      ctx.strokeStyle = rgba(C.ink, 0.8);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + w + 7, y - 15, bw, 17);
      T.text(ctx, "BOT", x + w + 11, y - 1, bf, rgba(C.ink, 0.9));
      w += bw + 7;
    }
    return w;
  }

  // ---------- HUD ----------
  private drawTitle(ctx: CanvasRenderingContext2D, s: MatchState, reduced: boolean) {
    const T = this.T;
    const r = s.round!;
    T.text(ctx, "Trading Royale", 40, 70, T.font("c", 800, 44), C.chalk);
    const creator = r.params.creator ? s.players.find((p) => p.player === r.params.creator)?.callsign : null;
    const who = r.protocol ? "protocol round" : creator ? `${creator}'s round` : "player round";
    T.text(ctx, `Predict ${r.params.market}, ${who} ${r.lobbyId}`, 40, 104, T.font("c", 500, 22), rgba(C.chalk, 0.7));
    T.text(ctx, "Pot", 40, 154, T.font("c", 600, 22), rgba(C.chalk, 0.7));
    T.roll(ctx, "pot", "$" + commas(unitsToUsd(s.potUnits)), 84, 156, T.font("x", 700, 38), 38, C.profit, "left", this.real, reduced);
    const n = s.players.length;
    const k = Math.max(1, Math.floor((n * r.params.winnerBps) / 10000));
    const fw = T.roll(ctx, "n", String(n), 40, 196, T.font("x", 700, 30), 30, C.chalk, "left", this.real, reduced);
    const fee = r.params.creator && r.params.creatorFeeBps ? `, ${r.params.creatorFeeBps / 100}% to the creator` : "";
    T.text(ctx, `in, closest ${k} split the pot ${r.params.split === "equal" ? "evenly" : r.params.split === "steep" ? "steeply" : "by rank"}${fee}`, 40 + fw + 8, 195, T.font("c", 500, 22), rgba(C.chalk, 0.7));
  }

  private drawMarket(ctx: CanvasRenderingContext2D, s: MatchState, head: number | null, reduced: boolean) {
    const T = this.T;
    const m = s.round!.params.market;
    const fin = s.pfinal;
    if (fin) {
      if (!s.settled) {
        T.text(ctx, "Settlement report", 1880, 58, T.font("c", 700, 24), rgba(C.chalk, 0.7), "right");
        T.text(ctx, "on its way to the chain", 1880, 92, T.font("c", 600, 24), rgba(C.chalk, 0.7), "right");
        T.text(ctx, `Book ${shortHash(fin.bookHash)}`, 1880, 126, T.font("x", 600, 24), rgba(C.chalk, 0.6), "right");
      }
      return;
    }
    T.text(ctx, `${m} live`, 1880, 58, T.font("c", 700, 24), rgba(C.chalk, 0.7), "right");
    const str = s.ptick?.mark ?? (head !== null ? head.toFixed(2) : null);
    if (str === null) {
      T.text(ctx, "waiting for a price", 1880, 120, T.font("c", 600, 30), rgba(C.chalk, 0.5), "right");
      return;
    }
    const prev = s.prevPtick ? num(s.prevPtick.mark) : null;
    const d = prev !== null && !fin ? num(str) - prev : 0;
    T.roll(ctx, "mark", commas(str), 1880, 126, T.font("x", 700, 66), 66, C.chalk, "right", this.real, reduced, d < 0 ? -1 : 1);
  }

  private drawCenter(ctx: CanvasRenderingContext2D, s: MatchState, now: number, reduced: boolean, fDt: number) {
    const T = this.T;
    const r = s.round!;
    const cx = 960;
    const fin = s.pfinal;
    if (fin) {
      const a = reduced ? clamp(fDt / 0.5) : clamp((fDt - 0.3) / 0.3);
      const sc = reduced ? 1 : lerp(0.6, 1, easeOutBack((fDt - 0.3) / 0.7));
      ctx.save();
      ctx.globalAlpha = a;
      T.text(ctx, `${r.params.market} settled at`, cx, 54, T.font("c", 700, 28), rgba(C.chalk, 0.8), "center");
      ctx.translate(cx, 166);
      ctx.scale(sc, sc);
      T.text(ctx, commas(fin.settlementPrice), 0, 0, T.font("x", 800, 128), C.chalk, "center");
      ctx.restore();
      const w = [...fin.winners].sort((x, y) => x.rank - y.rank)[0];
      const total = fin.winners.reduce((acc, x) => acc + BigInt(x.provisionalPayoutUnits), 0n);
      const sa = reduced ? clamp((fDt - 0.5) / 0.5) : clamp((fDt - 1.2) / 0.5);
      const creatorU = BigInt(fin.creatorFeeUnits);
      const treasuryU = BigInt(s.potUnits) - total - creatorU;
      const fees =
        `. $${commas(unitsToUsd((treasuryU < 0n ? 0n : treasuryU).toString()))} to the treasury` +
        (creatorU > 0n ? `, $${commas(unitsToUsd(creatorU.toString()))} to the creator.` : ".");
      ctx.save();
      ctx.globalAlpha = sa;
      if (w) {
        const n = fin.winners.length;
        T.text(ctx, `${w.callsign} called it within $${commas(w.distance)}.`, cx, 218, T.font("c", 800, 32), C.profit, "center");
        T.text(
          ctx,
          (s.settled
            ? `${n} ${n === 1 ? "winner was" : "winners were"} paid $${commas(unitsToUsd(total.toString()))} on chain`
            : `${n} ${n === 1 ? "winner splits" : "winners split"} $${commas(unitsToUsd(total.toString()))}, provisional until settlement`) + fees,
          cx,
          254,
          T.font("c", 600, 24),
          rgba(C.chalk, 0.8),
          "center",
        );
      } else T.text(ctx, "Nobody made a call. Every entry goes back.", cx, 218, T.font("c", 700, 30), C.chalk, "center");
      ctx.restore();
      return;
    }
    if (!s.locked) {
      T.text(ctx, "Calls lock in", cx, 58, T.font("c", 600, 26), rgba(C.chalk, 0.75), "center");
      T.roll(ctx, "cd", mmss(r.lockTime - now), cx, 172, T.font("x", 800, 112), 112, C.chalk, "center", this.real, reduced);
      T.text(ctx, "Call where the price will be at the resolve. Closest calls win.", cx, 214, T.font("c", 500, 24), rgba(C.chalk, 0.75), "center");
      return;
    }
    if (now < r.endTime) {
      T.text(ctx, "Resolves in", cx, 58, T.font("c", 600, 26), rgba(C.chalk, 0.75), "center");
      const left = r.endTime - now;
      const close = left <= 10 && !reduced;
      const beat = close ? 1 + 0.08 * Math.exp(-((Math.ceil(left) - left) % 1) * 7) : 1;
      ctx.save();
      ctx.translate(cx, 172);
      ctx.scale(beat, beat);
      T.roll(ctx, "cd", mmss(left), 0, 0, T.font("x", 800, 112), 112, close ? C.floodHi : C.chalk, "center", this.real, reduced);
      ctx.restore();
      const band = s.ptick?.band;
      if (band)
        T.text(ctx, `Winning now: calls from ${commas(band.low)} to ${commas(band.high)}`, cx, 214, T.font("c", 600, 24), C.profit, "center");
      return;
    }
    T.text(ctx, "Reading the settlement price", cx, 120, T.font("c", 800, 48), C.chalk, "center");
    T.text(ctx, `The close of the last one-minute candle before ${clockOf(r.endTime)} UTC, from Coinbase`, cx, 166, T.font("c", 500, 24), rgba(C.chalk, 0.75), "center");
  }
}

function clockOf(u: number) {
  const d = new Date(u * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Linear interpolation along the price path at unix time u. */
function priceAt(path: { u: number; p: number }[], u: number): number | null {
  if (!path.length) return null;
  if (u <= path[0].u) return path[0].p;
  const last = path[path.length - 1];
  if (u >= last.u) return last.p;
  let lo = 0;
  let hi = path.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (path[m].u <= u) lo = m;
    else hi = m;
  }
  const a = path[lo];
  const b = path[hi];
  return a.p + ((b.p - a.p) * (u - a.u)) / Math.max(1e-9, b.u - a.u);
}

function niceStep(raw: number) {
  const e = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * e >= raw) return m * e;
  return 10 * e;
}
