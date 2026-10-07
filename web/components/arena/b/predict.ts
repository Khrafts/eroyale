// Prediction rounds in the island's world: one price over time under the island's sky. The live price is an ink line
// walking toward the resolve post; every call is a line across the chart ending in its player's head chip. After the
// lock the sea closes in from above and below, leaving one sun band: the prices the current winners span. At the
// resolve the settlement price lands, the sea slams shut on the winners' band, their payouts roll in and confetti
// flies. Same kit, type and motion as the royale arena; the sea tokens are only the zone (outside the band).
import { isTxHash, num, unitsToUsd } from "@/lib/events";
import { GAMES } from "@/lib/island/places";
import type { MatchState } from "@/lib/useMatch";
import type { AvatarCfg } from "@/lib/island/avatar";
import { GAME, MEANING, ink, ink2, muted, paper, seaDeep, seaFoam, seaMid, seaShallow, sun } from "@/lib/theme";
import { Type, clamp, commas, easeOut, easeOutBack, hash, lerp, mmss, rgba, shortHash, spring, stamp } from "./draw";
import { Confetti, H, HUD_Y, LW, Sky, W, axisChip, botTag, botW, box, countChip, head, headSprite, panel, potChip, settlingChip, wordmark } from "./toon";

const PREDICT = GAMES.find((g) => g.id === "predict")!; // "Price Prediction", "PP", as on the island
const PL = 150; // plot left
const PR = 1440; // the resolve post
const PT = 320; // plot top
const PB = 990; // plot bottom
const LX = 1500; // label column
const RX = 1888; // right edge of the label column
const ROW = 38; // rows and type sized for five metres at 1920x1080
const HR = 14; // head radius in a label chip

type Line = {
  id: string;
  callsign: string;
  bot: boolean;
  price: number;
  priceStr: string;
  join: number;
  ly: number;
  vly: number;
};

export class PredictScene {
  T = new Type();
  sky = new Sky(23, 2, [600, 900]);
  confetti = new Confetti();
  me: { address: string; cfg: AvatarCfg } | null = null;
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
  lobbyId: number | null = null;
  burst = false;
  burstSettled = false;

  Y(v: number) {
    return PB - ((v - this.lo) / (this.hi - this.lo)) * (PB - PT);
  }

  private sprite(id: string, r: number, crown = false) {
    const own = this.me && this.me.address === id.toLowerCase() ? this.me.cfg : null;
    return headSprite(id.toLowerCase(), crown, r, own);
  }

  private reset() {
    this.lines.clear();
    this.lineKey = "";
    this.first = true;
    this.fronts = false;
    this.burst = false;
    this.burstSettled = false;
    this.T.rolls.clear();
  }

  frame(ctx: CanvasRenderingContext2D, s: MatchState, now: number, dt: number, reduced: boolean) {
    this.real += dt;
    if (s.lobbyId !== this.lobbyId) {
      this.lobbyId = s.lobbyId;
      this.reset();
    }
    const T = this.T;
    this.sky.draw(ctx, this.real, reduced, LX - 30); // no cloud behind the label column
    const round = s.round;
    if (!round) {
      wordmark(ctx, T, "", GAME.predict, PREDICT.name, PREDICT.short);
      if (!s.error) {
        const msg = "Waiting for the next prediction round";
        const f = T.font("d", 700, 36);
        const w = T.w(ctx, f, msg) + 80;
        box(ctx, 960 - w / 2, 500, w, 84, { r: 24, shadow: 6, fill: paper });
        T.text(ctx, msg, 960, 555, f, ink, "center");
      }
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
    const headP = priceAt(s.path, headU);

    // ---------- lines (revealed at the lock) ----------
    const leaders = new Map<string, number>();
    if (fin) for (const w of fin.winners) leaders.set(w.player, w.rank);
    else for (const l of s.ptick?.leaders ?? []) leaders.set(l.player, l.rank);
    const key = s.locked ? s.locked.predictions.map((p) => p.player + p.price).join() : "";
    if (key !== this.lineKey) {
      this.lineKey = key;
      this.lines.clear();
      (s.locked?.predictions ?? []).forEach((p, i) => {
        const j = s.players.findIndex((x) => x.player === p.player);
        this.lines.set(p.player, { id: p.player, callsign: p.callsign, bot: p.bot, price: num(p.price), priceStr: p.price, join: j >= 0 ? j : i, ly: 0, vly: 0 });
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
    if (!vals.length) vals = [headP ?? 100];
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

    // ---------- the sea fronts: the band between them is the winners' span ----------
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
        // the sea rolls in from the chart edges at the lock (or sits in place on a reload)
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
    // the chart itself is clipped below the HUD, so a zoom never draws over the headline
    ctx.save();
    ctx.beginPath();
    ctx.rect(PL, PT - 40, PR - PL + 14, PB - PT + 40); // the plot box: trace, calls and sea never leave it
    ctx.clip();
    this.drawSealed(ctx, lockX);
    const surge = fin && !reduced ? Math.exp(-Math.max(0, fDt - 0.25) * 1.6) : 0;
    if (this.fronts) this.drawSea(ctx, lockX, reduced, surge, fDt);
    this.drawLines(ctx, lockX, leaders, s, now, reduced, fDt);
    this.drawTrace(ctx, s, X, u0, headU, headP);
    if (fin && sp !== null) this.drawSettlement(ctx, sp, fDt, reduced);
    this.drawHead(ctx, X(headU), headP, !!fin, reduced);
    ctx.restore();
    this.drawPosts(ctx, lockX, now, endT, locked, !!fin);
    this.drawLabels(ctx, s, leaders, dt, reduced, fDt);
    if (fin) this.drawFlash(ctx, fDt, reduced);

    // HUD, set a little below the top edge so the sky reads above it
    ctx.save();
    ctx.translate(0, HUD_Y);
    this.drawTitle(ctx, s, reduced);
    this.drawMarket(ctx, s, headP, reduced, fDt, settledDt);
    this.drawCenter(ctx, s, now, reduced, fDt);
    if (s.settled && settledDt >= 0) {
      ctx.save();
      ctx.translate(1752, 150);
      ctx.scale(0.72, 0.72);
      stamp(ctx, T, s.settled.txHash, s.settled.mode, settledDt, reduced, 0, 0);
      ctx.restore();
    }
    ctx.restore();
    // confetti on the reveal, a gentle rain once settled
    if (!reduced) {
      if (fin && sp !== null && !this.burst && fDt >= 0.3 && fDt < 6) {
        this.burst = true;
        // from the settlement mark on the post, up and over the chart, clear of the payout chips
        this.confetti.burst(PR, this.Y(sp), 120, 0.7, -Math.PI * 0.72);
        this.confetti.burst(960, Math.min(PB, this.Y(sp)), 80, 0.8);
      }
      if (s.settled && !this.burstSettled && settledDt >= 0 && settledDt < 6) {
        this.burstSettled = true;
        this.confetti.rain(80);
      }
    }
    this.confetti.draw(ctx, reduced ? 0 : dt);
    this.first = false;
  }

  // ---------- chart ----------
  private drawGrid(ctx: CanvasRenderingContext2D, step: number) {
    const T = this.T;
    const from = Math.ceil(this.lo / step) * step;
    const dec = step < 1 ? 2 : 0;
    ctx.save();
    ctx.setLineDash([3, 9]);
    ctx.strokeStyle = rgba(ink, 0.16);
    ctx.lineWidth = 1.5;
    for (let v = from; v <= this.hi; v += step) {
      const y = this.Y(v);
      if (y < PT - 40 || y > H - 10) continue;
      ctx.beginPath();
      ctx.moveTo(PL - 20, y);
      ctx.lineTo(PR, y);
      ctx.stroke();
    }
    ctx.restore();
    // each price on its own paper chip, the island's chip style, so it reads from across the room
    for (let v = from; v <= this.hi; v += step) {
      const y = this.Y(v);
      if (y < PT - 40 || y > H - 10) continue;
      axisChip(ctx, T, PL - 24, y, commas(v.toFixed(dec)));
    }
  }

  /** The stretch before the lock: calls were sealed, so it sits under a paper veil. */
  private drawSealed(ctx: CanvasRenderingContext2D, lockX: number) {
    const T = this.T;
    ctx.fillStyle = rgba(paper, 0.32);
    ctx.fillRect(PL, PT - 40, Math.max(0, lockX - PL), PB - PT + 40);
    if (lockX - PL > 180) T.text(ctx, "sealed calls", (PL + lockX) / 2, PB - 16, T.font("c", 600, 20), ink2, "center");
  }

  private drawPosts(ctx: CanvasRenderingContext2D, lockX: number, now: number, endT: number, locked: boolean, final: boolean) {
    const T = this.T;
    // lock post: dashed ink
    ctx.save();
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = rgba(ink, 0.7);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(lockX, PT - 30);
    ctx.lineTo(lockX, PB);
    ctx.stroke();
    ctx.restore();
    const tag = (x: number, text: string, fill: string) => {
      const f = T.font("d", 700, 15);
      const w = T.w(ctx, f, text) + 26;
      box(ctx, x - w / 2, PT - 62, w, 32, { r: 16, shadow: 3, fill, line: LW });
      T.text(ctx, text, x, PT - 40, f, ink, "center");
    };
    tag(lockX, locked ? "Locked" : "Lock", paper);
    // resolve post: an ink pole striped like a survey staff
    ctx.fillStyle = ink;
    ctx.fillRect(PR - 5, PT - 30, 10, PB - PT + 30);
    ctx.fillStyle = paper;
    for (let y = PT - 24; y < PB - 6; y += 36) ctx.fillRect(PR - 2, y, 4, 16);
    tag(PR, final ? "Resolved" : now < endT ? "Resolve" : "Resolving", final ? sun : paper);
  }

  private drawLines(ctx: CanvasRenderingContext2D, lockX: number, leaders: Map<string, number>, s: MatchState, now: number, reduced: boolean, fDt: number) {
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
      ctx.beginPath();
      ctx.moveTo(PR - (PR - lockX) * g, y);
      ctx.lineTo(PR, y);
      if (lead) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.strokeStyle = sun;
        ctx.lineWidth = 3;
        ctx.stroke();
      } else {
        ctx.setLineDash([7, 7]);
        ctx.strokeStyle = rgba(ink, 0.55);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** The live price: an ink line over a paper underlay, so it reads over sky, sun and sea alike. */
  private drawTrace(ctx: CanvasRenderingContext2D, s: MatchState, X: (u: number) => number, u0: number, headU: number, p: number | null) {
    const pts = s.path;
    if (!pts.length || p === null) return;
    const stride = Math.max(1, Math.ceil(pts.length / 1600));
    ctx.save();
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < pts.length; i += stride) {
      const q = pts[i];
      if (q.u < u0) continue;
      if (q.u > headU) break;
      const x = X(q.u);
      const y = this.Y(q.p);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.lineTo(X(headU), this.Y(p));
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = rgba(paper, 0.9);
    ctx.lineWidth = 9;
    ctx.stroke();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();
  }

  /** Outside the band is the island's sea: from above and from below, with shallows and a foam line at each edge;
   *  between the edges, the band is sun. */
  private drawSea(ctx: CanvasRenderingContext2D, lockX: number, reduced: boolean, surge: number, fDt: number) {
    const t = this.real;
    const amp = reduced ? 0 : 3 + surge * 9;
    const yTop = this.Y(this.fTop) - 16;
    const yBot = this.Y(this.fBot) + 16;
    const x0 = lockX;
    const x1 = PR;
    const wave = (x: number, y0: number, ph: number) => y0 + Math.sin(x * 0.011 + t * 0.9 + ph) * amp + Math.sin(x * 0.031 - t * 1.4 + ph) * amp * 0.45;
    const ceil = PT - 30;
    const top = Math.max(ceil, Math.min(yTop, H));
    const bot = Math.min(H + 20, Math.max(yBot, ceil));
    // the band: sun, laid on paper so the sky does not muddy it
    ctx.fillStyle = paper;
    ctx.fillRect(x0, top, x1 - x0, Math.max(0, bot - top));
    ctx.fillStyle = rgba(sun, 0.8);
    ctx.fillRect(x0, top, x1 - x0, Math.max(0, bot - top));
    const edge = (y0: number, ph: number, dir: 1 | -1) => {
      // the water body, from the edge away from the band
      const far = dir === 1 ? H + 10 : ceil;
      ctx.save();
      ctx.beginPath();
      for (let x = x0; x <= x1; x += 12) (x === x0 ? ctx.moveTo : ctx.lineTo).call(ctx, x, wave(x, y0, ph));
      ctx.lineTo(x1, wave(x1, y0, ph));
      ctx.lineTo(x1, far);
      ctx.lineTo(x0, far);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, y0 + dir * 18, 0, far);
      g.addColorStop(0, seaMid);
      g.addColorStop(1, seaDeep);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.clip();
      // shallows along the edge
      ctx.beginPath();
      for (let x = x0; x <= x1; x += 12) (x === x0 ? ctx.moveTo : ctx.lineTo).call(ctx, x, wave(x, y0, ph));
      for (let x = x1; x >= x0; x -= 12) ctx.lineTo(x, wave(x, y0, ph) + dir * (20 + Math.sin(x * 0.02 + t * 0.6) * 3));
      ctx.closePath();
      ctx.fillStyle = seaShallow;
      ctx.fill();
      ctx.restore();
      // foam
      ctx.beginPath();
      for (let x = x0; x <= x1; x += 12) (x === x0 ? ctx.moveTo : ctx.lineTo).call(ctx, x, wave(x, y0, ph));
      ctx.strokeStyle = seaFoam;
      ctx.lineWidth = surge > 0.05 ? 7 : 5;
      ctx.lineJoin = "round";
      ctx.stroke();
      if (!reduced) {
        ctx.fillStyle = seaFoam;
        const every = surge > 0.05 && fDt > 0.2 ? 11 : 37;
        for (let x = x0 + 6; x < x1; x += every) {
          const j = (hash("f" + x) % 100) / 100;
          ctx.beginPath();
          ctx.arc(x + Math.sin(t * 2 + j * 9) * 3, wave(x, y0, ph) + dir * (7 + j * 10), 1.5 + j * 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    if (top > ceil) edge(top, 1.7, -1);
    edge(bot, 0, 1);
  }

  private drawHead(ctx: CanvasRenderingContext2D, x: number, p: number | null, final: boolean, reduced: boolean) {
    if (p === null) return;
    const y = this.Y(p);
    const pulse = reduced || final ? 0 : (this.real * 1.2) % 1;
    if (pulse > 0) {
      ctx.strokeStyle = rgba(ink, 0.6 * (1 - pulse));
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 9 + pulse * 26, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = paper;
    ctx.strokeStyle = ink;
    ctx.lineWidth = LW;
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private drawSettlement(ctx: CanvasRenderingContext2D, sp: number, fDt: number, reduced: boolean) {
    const y = this.Y(sp);
    const g = reduced ? clamp(fDt / 0.4) : easeOut((fDt - 0.25) / 0.7);
    if (g <= 0) return;
    ctx.save();
    ctx.globalAlpha = reduced ? g : 1;
    ctx.beginPath();
    ctx.moveTo(PR, y);
    ctx.lineTo(PR - (PR - PL) * (reduced ? 1 : g), y);
    ctx.strokeStyle = paper;
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.strokeStyle = ink;
    ctx.lineWidth = LW;
    ctx.stroke();
    // a marker on the post
    ctx.beginPath();
    ctx.moveTo(PR, y - 4);
    ctx.lineTo(PR + 22, y - 28);
    ctx.lineTo(PR - 22, y - 28);
    ctx.closePath();
    ctx.fillStyle = sun;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = LW;
    ctx.stroke();
    ctx.restore();
  }

  /** The resolve lands as one bright beat. */
  private drawFlash(ctx: CanvasRenderingContext2D, fDt: number, reduced: boolean) {
    const a = reduced ? 0.15 * clamp(1 - fDt / 0.6) : 0.5 * Math.exp(-fDt * 5);
    if (a > 0.005) {
      ctx.fillStyle = rgba(paper, a);
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ---------- the label column ----------
  /** A head chip: the player's head, name and bot tag; returns the width used by the name part. */
  private headChip(ctx: CanvasRenderingContext2D, id: string, name: string, bot: boolean, x: number, y: number, w: number, h: number, fill: string, big: boolean, limit = x + w) {
    const T = this.T;
    box(ctx, x, y, w, h, { r: h / 2, shadow: 3, fill, line: LW });
    const r = big ? 17 : HR;
    head(ctx, this.sprite(id, r), x + 4 + r + 2, y + h / 2, r);
    const nf = T.font("d", 700, big ? 20 : 17);
    const nx = x + 4 + 2 * r + 12;
    T.text(ctx, name, nx, y + h / 2 + (big ? 7 : 6), nf, ink);
    let used = nx - x + T.w(ctx, nf, name);
    // the bot tag goes where it fits before `limit` (a payout pill on the right)
    if (bot && x + used + 6 + botW(ctx, T) <= limit) {
      botTag(ctx, T, x + used + 6, y + h / 2 - 11);
      used += botW(ctx, T) + 6;
    }
    return used;
  }

  private drawLabels(ctx: CanvasRenderingContext2D, s: MatchState, leaders: Map<string, number>, dt: number, reduced: boolean, fDt: number) {
    const T = this.T;
    if (!s.locked) {
      // sealed: who is in, how many have called, no prices
      const n = s.players.length;
      box(ctx, LX, PT - 62, RX - LX, 98, { r: 24, shadow: 4, fill: paper });
      T.text(ctx, "Sealed calls", LX + 20, PT - 30, T.font("d", 700, 17), ink);
      const w = T.roll(ctx, "sealed", String(s.predictedCount), LX + 20, PT + 20, T.font("x", 800, 44), 44, ink, "left", this.real, reduced);
      T.text(ctx, `of ${n} ${n === 1 ? "player" : "players"}`, LX + 20 + w + 12, PT + 16, T.font("c", 600, 22), ink2);
      const top = PT + 62;
      const per = Math.max(2, Math.floor((PB - top) / ROW));
      const cols = n > per ? 2 : 1;
      const cw = cols === 2 ? (RX - LX - 8) / 2 : RX - LX;
      s.players.forEach((p, i) => {
        const c = Math.floor(i / per);
        if (c >= cols) return;
        const x = LX + c * (cw + 8);
        const y = top + (i % per) * ROW;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x - 2, y - 4, cw + 4, ROW + 4);
        ctx.clip();
        this.headChip(ctx, p.player, p.callsign, p.bot, x, y, cw, ROW - 4, paper, false);
        ctx.restore();
      });
      if (n > per * cols) T.text(ctx, `and ${n - per * cols} more`, LX, top + per * ROW + 20, T.font("c", 600, 20), ink);
      if (n < 4) {
        const msg = `${4 - n} more to play`;
        const f = T.font("d", 700, 18);
        const mw = T.w(ctx, f, msg) + 30;
        box(ctx, LX, PB - 20, mw, 36, { r: 18, shadow: 3, fill: GAME.predict });
        T.text(ctx, msg, LX + 15, PB + 4, f, ink);
      }
      return;
    }

    const fin = s.pfinal;
    const paid = new Map<string, string>();
    if (s.settled) s.settled.winners.forEach((w, i) => paid.set(w, s.settled!.amounts[i]));
    const rows = [...this.lines.values()].sort((a, b) => b.price - a.price || a.join - b.join);
    const gap = fin ? 58 : ROW;
    const h = fin ? 50 : ROW - 4;
    const visible = rows.filter((l) => !fin || leaders.has(l.id) || clamp((fDt - 0.4) / 1.2) < 1);
    // spread labels around their line, keeping order and a minimum gap
    const want = visible.map((l) => this.Y(l.price) - h / 2);
    const ys: number[] = [];
    want.forEach((y, i) => ys.push(i === 0 ? Math.max(y, PT - 20) : Math.max(y, ys[i - 1] + gap)));
    const over = ys.length ? ys[ys.length - 1] + h - (H - 12) : 0;
    if (over > 0) for (let i = ys.length - 1; i >= 0; i--) ys[i] = Math.min(ys[i] - over, i < ys.length - 1 ? ys[i + 1] - gap : Infinity);
    const minY = fin ? 240 : PT - 22; // below the "Closest k win" caption
    if (ys.length && ys[0] < minY) {
      const d = minY - ys[0];
      for (let i = 0; i < ys.length; i++) ys[i] = i === 0 ? minY : Math.max(ys[i], ys[i - 1] + gap, ys[i] + d * (1 - i / ys.length));
    }
    visible.forEach((l, i) => {
      if (this.first || reduced || l.ly === 0) l.ly = ys[i];
      else [l.ly, l.vly] = spring(l.ly, l.vly, ys[i], 9, 0.85, dt);
      const lead = leaders.get(l.id);
      const lineY = this.Y(l.price);
      const gone = fin && lead === undefined ? clamp((fDt - 0.4) / 1.2) : 0;
      const sinkY = reduced ? 0 : gone * 40;
      const y = l.ly + sinkY;
      ctx.save();
      ctx.globalAlpha = 1 - gone;
      // elbow from the resolve post to the chip
      ctx.strokeStyle = lead !== undefined ? ink : rgba(ink, 0.4);
      ctx.lineWidth = lead !== undefined ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(PR + 6, lineY);
      ctx.lineTo(LX - 30, lineY);
      ctx.lineTo(LX - 8, y + h / 2);
      ctx.stroke();
      // rank badge for the current winners
      let x = LX;
      if (lead !== undefined) {
        const rf = T.font("x", 800, fin ? 24 : 19);
        const d = h;
        box(ctx, LX - 4, y, d, d, { r: d / 2, shadow: 3, fill: sun, line: LW });
        T.roll(ctx, "rk" + l.id, String(lead), LX - 4 + d / 2, y + d / 2 + (fin ? 8 : 7), rf, fin ? 24 : 19, ink, "center", this.real, reduced);
        x = LX + d + 2;
      }
      const w = RX - x;
      const fill = lead !== undefined ? MEANING.profit.fill : paper;
      const payW = fin && lead !== undefined ? T.widthOf(ctx, T.font("x", 800, 26), "$" + commas(unitsToUsd(fin.winners.find((q) => q.player === l.id)?.provisionalPayoutUnits ?? "0"))) + 20 : 0;
      const used = this.headChip(ctx, l.id, l.callsign, l.bot, x, y, w, h, fill, !!fin, payW ? RX - payW - 12 : RX - 124);
      if (fin && lead !== undefined) {
        const win = fin.winners.find((q) => q.player === l.id)!;
        const units = s.settled ? (paid.get(l.id) ?? win.provisionalPayoutUnits) : win.provisionalPayoutUnits;
        const reveal = reduced ? clamp((fDt - 0.6) / 0.4) : clamp((fDt - 1.1 - (fin.winners.length - win.rank) * 0.12) / 0.3);
        if (reveal > 0) {
          ctx.globalAlpha = reveal;
          const amt = "$" + commas(unitsToUsd(units));
          const af = T.font("x", 800, 26);
          const aw = T.widthOf(ctx, af, amt) + 20;
          box(ctx, RX - aw - 6, y + 6, aw, h - 12, { r: (h - 12) / 2, shadow: 0, fill: paper, line: 2 });
          T.roll(ctx, "pay" + l.id, amt, RX - 16, y + h / 2 + 9, af, 26, ink, "right", this.real, reduced);
          const off = `off ${commas(win.distance)}`;
          const of = T.font("x", 600, 17);
          const ox = RX - aw - 14;
          if (ox - T.widthOf(ctx, of, off) > x + used + 8) T.text(ctx, off, ox, y + h / 2 + 6, of, ink2, "right");
          ctx.globalAlpha = 1 - gone;
        }
      } else {
        const pf = T.font("x", lead !== undefined ? 800 : 600, 19);
        T.text(ctx, commas(l.priceStr), RX - 14, y + h / 2 + 7, pf, ink, "right");
      }
      ctx.restore();
    });
    const offline = !!s.settled && !isTxHash(s.settled.txHash);
    const caption = fin ? (s.settled ? (offline ? "Settled offline, nothing paid" : "Paid") : "Provisional payouts") : `Closest ${s.ptick?.leaders.length ?? 0} win`;
    const cf = T.font("d", 700, 17);
    const cy = fin ? Math.max(196, Math.min(PT - 64, (ys[0] ?? PT) - 52)) : PT - 62;
    const cw = T.w(ctx, cf, caption) + 28;
    box(ctx, LX, cy, cw, 36, { r: 18, shadow: 3, fill: fin ? paper : sun, line: LW });
    T.text(ctx, caption, LX + 14, cy + 24, cf, ink);
  }

  // ---------- HUD ----------
  private drawTitle(ctx: CanvasRenderingContext2D, s: MatchState, reduced: boolean) {
    const T = this.T;
    const r = s.round!;
    const creator = r.params.creator ? s.players.find((p) => p.player === r.params.creator)?.callsign : null;
    const who = r.protocol ? "protocol round" : creator ? `${creator}'s round` : "player round";
    wordmark(ctx, T, "", GAME.predict, PREDICT.name, PREDICT.short);
    // the round's name on its own chip, so the centre panel keeps its width
    const cap = `Predict ${r.params.market}, ${who} ${r.lobbyId}`;
    const cf = T.font("d", 700, 18);
    box(ctx, 32, 98, T.w(ctx, cf, cap) + 36, 50, { r: 25, shadow: 4, fill: GAME.predict });
    T.text(ctx, cap, 50, 130, cf, ink);
    ctx.save();
    ctx.translate(0, 74);
    const x = potChip(ctx, T, "$" + commas(unitsToUsd(s.potUnits)), this.real, reduced);
    const n = s.players.length;
    const k = Math.max(1, Math.floor((n * r.params.winnerBps) / 10000));
    const fee = r.params.creator && r.params.creatorFeeBps ? `, ${r.params.creatorFeeBps / 100}% to the creator` : "";
    countChip(ctx, T, x + 12, "n", String(n), `in, closest ${k} split the pot ${r.params.split === "equal" ? "evenly" : r.params.split === "steep" ? "steeply" : "by rank"}${fee}`, this.real, reduced);
    ctx.restore();
  }

  private drawMarket(ctx: CanvasRenderingContext2D, s: MatchState, p: number | null, reduced: boolean, fDt: number, settledDt: number) {
    const T = this.T;
    const m = s.round!.params.market;
    const fin = s.pfinal;
    const R0 = 1888;
    if (fin) {
      // between final and settled: the report is on its way; it cross-fades out as the seal lands in its place
      const pend = !s.settled ? 1 : settledDt >= 0 ? 1 - settledDt / (reduced ? 0.4 : 0.25) : 1;
      const a = reduced ? clamp(fDt / 0.5) : clamp(fDt / 0.6);
      if (!s.cancelled) settlingChip(ctx, T, R0, 24, fDt, this.real, reduced, pend * a, `Book ${shortHash(fin.bookHash)}, payouts provisional`);
      return;
    }
    const w = 330;
    box(ctx, R0 - w, 24, w, 124, { r: 24, shadow: 4, fill: paper });
    T.text(ctx, `${m} live`, R0 - 22, 58, T.font("d", 700, 18), ink, "right");
    const str = s.ptick?.mark ?? (p !== null ? p.toFixed(2) : null);
    if (str === null) {
      T.text(ctx, "waiting for a price", R0 - 22, 116, T.font("c", 600, 24), muted, "right");
      return;
    }
    const prev = s.prevPtick ? num(s.prevPtick.mark) : null;
    const d = prev !== null ? num(str) - prev : 0;
    T.roll(ctx, "mark", commas(str), R0 - 22, 126, T.font("x", 800, 50), 50, ink, "right", this.real, reduced, d < 0 ? -1 : 1, 0.12);
  }

  private drawCenter(ctx: CanvasRenderingContext2D, s: MatchState, now: number, reduced: boolean, fDt: number) {
    const T = this.T;
    const r = s.round!;
    const cx = 960;
    const fin = s.pfinal;
    const big = T.font("x", 800, 96);
    if (fin) {
      const a = reduced ? clamp(fDt / 0.5) : clamp((fDt - 0.3) / 0.3);
      const sc = reduced ? 1 : lerp(0.6, 1, easeOutBack((fDt - 0.3) / 0.7));
      const w = [...fin.winners].sort((x, y) => x.rank - y.rank)[0];
      const total = fin.winners.reduce((acc, x) => acc + BigInt(x.provisionalPayoutUnits), 0n);
      const creatorU = BigInt(fin.creatorFeeUnits);
      const treasuryU = BigInt(s.potUnits) - total - creatorU;
      const fees = `. $${commas(unitsToUsd((treasuryU < 0n ? 0n : treasuryU).toString()))} to the treasury` + (creatorU > 0n ? `, $${commas(unitsToUsd(creatorU.toString()))} to the creator.` : ".");
      const n = fin.winners.length;
      const sub = w
        ? (s.settled && !isTxHash(s.settled.txHash)
            ? `${n} ${n === 1 ? "winner splits" : "winners split"} $${commas(unitsToUsd(total.toString()))}. Settled offline (no chain), nothing paid`
            : s.settled
            ? `${n} ${n === 1 ? "winner was" : "winners were"} paid $${commas(unitsToUsd(total.toString()))} on chain`
            : `${n} ${n === 1 ? "winner splits" : "winners split"} $${commas(unitsToUsd(total.toString()))}, provisional until settlement`) + fees
        : "";
      const sf = T.font("c", 600, 18);
      const hf = T.font("d", 800, 22);
      const head = w ? `${w.callsign} called it within $${commas(w.distance)}.` : "Nobody made a call. Every entry goes back.";
      // the sentence breaks before its fees so the panel stays clear of the corner chips
      const cut = sub.indexOf(". $");
      const sub1 = cut >= 0 ? sub.slice(0, cut + 1) : sub;
      const sub2 = cut >= 0 ? sub.slice(cut + 2) : "";
      const pw = Math.min(620, Math.max(520, T.w(ctx, sf, sub1) + 50, T.w(ctx, sf, sub2) + 50, T.w(ctx, hf, head) + 50));
      ctx.save();
      ctx.globalAlpha = a;
      panel(ctx, T, cx, pw, 242, `${r.params.market} settled at`, GAME.predict);
      ctx.save();
      ctx.translate(cx, 140);
      ctx.scale(sc, sc);
      T.text(ctx, commas(fin.settlementPrice), 0, 0, T.font("x", 800, 84), ink, "center");
      ctx.restore();
      const sa = reduced ? clamp((fDt - 0.5) / 0.5) : clamp((fDt - 1.2) / 0.5);
      ctx.globalAlpha = a * sa;
      T.text(ctx, head, cx, 184, hf, ink, "center");
      if (sub1) T.text(ctx, sub1, cx, 212, sf, ink2, "center");
      if (sub2) T.text(ctx, sub2, cx, 236, sf, ink2, "center");
      ctx.restore();
      return;
    }
    if (!s.locked) {
      panel(ctx, T, cx, 620, 200, "Calls lock in", GAME.predict);
      T.roll(ctx, "cd", mmss(r.lockTime - now), cx, 154, big, 96, ink, "center", this.real, reduced);
      T.text(ctx, "Call where the price will be at the resolve. Closest calls win.", cx, 196, T.font("c", 600, 19), ink2, "center");
      return;
    }
    if (now < r.endTime) {
      const band = s.ptick?.band;
      const bandText = band ? `Winning now: calls from ${commas(band.low)} to ${commas(band.high)}` : "";
      const bf = T.font("x", 700, 18);
      panel(ctx, T, cx, Math.min(620, Math.max(460, T.w(ctx, bf, bandText) + 60)), 206, "Resolves in", GAME.predict);
      const left = r.endTime - now;
      const close = left <= 10 && !reduced;
      const beat = close ? 1 + 0.08 * Math.exp(-((Math.ceil(left) - left) % 1) * 7) : 1;
      ctx.save();
      ctx.translate(cx, 154);
      ctx.scale(beat, beat);
      T.roll(ctx, "cd", mmss(left), 0, 0, big, 96, ink, "center", this.real, reduced);
      ctx.restore();
      if (band) {
        const bw = T.w(ctx, bf, bandText) + 24;
        box(ctx, cx - bw / 2, 170, bw, 32, { r: 16, shadow: 0, fill: sun, line: 2 });
        T.text(ctx, bandText, cx, 192, bf, ink, "center");
      }
      return;
    }
    const sub = `The close of the last one-minute candle before ${clockOf(r.endTime)} UTC, from Coinbase`;
    const sf = T.font("c", 600, 22);
    panel(ctx, T, cx, T.w(ctx, sf, sub) + 80, 170, "Resolving", GAME.predict);
    T.text(ctx, "Reading the settlement price", cx, 118, T.font("d", 800, 34), ink, "center");
    T.text(ctx, sub, cx, 160, sf, ink2, "center");
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
