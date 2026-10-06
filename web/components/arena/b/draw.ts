// Palette, maths and the two number renderers (odometer for spring values, roller for strings).
// Digits are laid out in fixed-width cells, which gives tabular figures on a canvas.
import { isTxHash } from "@/lib/events";

export const C = {
  sky: "#172930",
  skyClear: "#1E3640",
  ink: "#D9C9A0",
  chalk: "#F1ECDD",
  flood: "#2E5BFF",
  floodHi: "#A3BBFF",
  floodDeep: "#0F2470",
  profit: "#FFD23F",
  loss: "#FF4F6A",
  long: "#57E0B0",
  short: "#D88BFF",
};

export const RAMP = ["#1D322C", "#2A4337", "#3D5440", "#5B6344", "#837449", "#A88E5C", "#C7AE7C"];

export const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t), 3);
export const easeIn = (t: number) => Math.pow(clamp(t), 3);
export const smooth = (t: number) => {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
};
export const easeOutBack = (t: number) => {
  const x = clamp(t) - 1;
  return 1 + 2.4 * x * x * x + 1.4 * x * x;
};

export function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgba = (h: string, a: number) => {
  const [r, g, b] = hexToRgb(h);
  return `rgba(${r},${g},${b},${a})`;
};
export function ramp(t: number): string {
  const x = clamp(t) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(RAMP[i]);
  const b = hexToRgb(RAMP[i + 1]);
  return `rgb(${Math.round(lerp(a[0], b[0], f))},${Math.round(lerp(a[1], b[1], f))},${Math.round(lerp(a[2], b[2], f))})`;
}

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Damped spring step, sub-stepped so a long frame cannot explode it. */
export function spring(x: number, v: number, target: number, omega: number, zeta: number, dt: number): [number, number] {
  const n = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const a = omega * omega * (target - x) - 2 * zeta * omega * v;
    v += a * h;
    x += v * h;
  }
  return [x, v];
}

export const commas = (s: string) => {
  const [i, d] = s.split(".");
  const neg = i.startsWith("-");
  const body = (neg ? i.slice(1) : i).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + body + (d !== undefined ? "." + d : "");
};
export const mmss = (sec: number) => {
  const s = Math.max(0, Math.ceil(sec - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
export const shortHash = (h: string) => (h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);

type Align = "left" | "center" | "right";

/** Text measurement with a cache that the scene clears once web fonts finish loading. */
export class Type {
  cache = new Map<string, number>();
  constructor(public cond: string, public xc: string) {}
  font(face: "c" | "x", weight: number, size: number) {
    return `${weight} ${size}px ${face === "c" ? this.cond : this.xc}`;
  }
  w(ctx: CanvasRenderingContext2D, font: string, s: string) {
    const k = font + "|" + s;
    let v = this.cache.get(k);
    if (v === undefined) {
      ctx.font = font;
      v = ctx.measureText(s).width;
      this.cache.set(k, v);
    }
    return v;
  }
  digitW(ctx: CanvasRenderingContext2D, font: string) {
    let m = 0;
    for (let d = 0; d < 10; d++) m = Math.max(m, this.w(ctx, font, String(d)));
    return m;
  }
  cellW(ctx: CanvasRenderingContext2D, font: string, ch: string) {
    return ch >= "0" && ch <= "9" ? this.digitW(ctx, font) : this.w(ctx, font, ch);
  }
  widthOf(ctx: CanvasRenderingContext2D, font: string, s: string) {
    let w = 0;
    for (const ch of s) w += this.cellW(ctx, font, ch);
    return w;
  }
  /** Plain text with an optional cartographic halo. */
  text(
    ctx: CanvasRenderingContext2D,
    s: string,
    x: number,
    y: number,
    font: string,
    color: string,
    align: Align = "left",
    halo?: string,
  ) {
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    if (halo) {
      ctx.lineJoin = "round";
      ctx.strokeStyle = halo;
      ctx.lineWidth = 5;
      ctx.strokeText(s, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }

  /** Odometer: the lowest digit turns continuously, higher digits turn as it carries. */
  odo(
    ctx: CanvasRenderingContext2D,
    value: number,
    x: number,
    y: number,
    font: string,
    size: number,
    color: string,
    align: Align,
    prefix = "",
    halo?: string,
  ) {
    const v = Math.max(0, value);
    const cents = Math.round(v * 100 * 1e4) / 1e4;
    const whole = Math.floor(cents);
    const frac = cents - whole;
    const s = prefix + commas((whole / 100).toFixed(2));
    const total = this.widthOf(ctx, font, s);
    let cx = align === "left" ? x : align === "right" ? x - total : x - total / 2;
    // place value of each digit, counted from the cents digit
    const digitsOnly = s.replace(/[^0-9]/g, "");
    let place = digitsOnly.length - 1;
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (const ch of s) {
      const cw = this.cellW(ctx, font, ch);
      if (ch >= "0" && ch <= "9") {
        const d = Number(ch);
        let f = 0;
        if (place === 0) f = frac;
        else {
          const p = Math.pow(10, place);
          const below = (whole % p) + frac;
          f = below > p - 1 ? below - (p - 1) : 0;
        }
        // detent: digits hold, then flip over the last quarter of each step, like a counter wheel
        f = clamp((f - 0.72) / 0.28);
        if (f < 0.002) this.cell(ctx, ch, cx + cw / 2, y, color, halo);
        else {
          const h = size * 1.0;
          ctx.save();
          ctx.beginPath();
          ctx.rect(cx - 3, y - size * 0.82, cw + 6, size * 0.92);
          ctx.clip();
          this.cell(ctx, ch, cx + cw / 2, y - f * h, color, halo);
          this.cell(ctx, String((d + 1) % 10), cx + cw / 2, y + (1 - f) * h, color, halo);
          ctx.restore();
        }
        place--;
      } else this.cell(ctx, ch, cx + cw / 2, y, color, halo);
      cx += cw;
    }
    return total;
  }

  private cell(ctx: CanvasRenderingContext2D, ch: string, x: number, y: number, color: string, halo?: string) {
    if (halo) {
      ctx.lineJoin = "round";
      ctx.strokeStyle = halo;
      ctx.lineWidth = 5;
      ctx.strokeText(ch, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(ch, x, y);
  }

  rolls = new Map<string, { cur: string; prev: string; at: number }>();
  /** Roller for strings that change in steps (timers, prices, counts): changed digits roll in. */
  roll(
    ctx: CanvasRenderingContext2D,
    key: string,
    s: string,
    x: number,
    y: number,
    font: string,
    size: number,
    color: string,
    align: Align,
    now: number,
    reduced: boolean,
    dir = 1,
  ) {
    let st = this.rolls.get(key);
    if (!st) {
      st = { cur: s, prev: s, at: -1e9 };
      this.rolls.set(key, st);
    } else if (st.cur !== s) {
      st.prev = st.cur;
      st.cur = s;
      st.at = now;
    }
    const p = clamp((now - st.at) / 0.32);
    const e = easeOut(p);
    const total = this.widthOf(ctx, font, s);
    let cx = align === "left" ? x : align === "right" ? x - total : x - total / 2;
    const prev = st.prev.length === s.length ? st.prev : "";
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    let i = 0;
    for (const ch of s) {
      const cw = this.cellW(ctx, font, ch);
      const old = prev[i];
      if (p >= 1 || !old || old === ch) this.cell(ctx, ch, cx + cw / 2, y, color);
      else {
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx - 3, y - size * 0.8, cw + 6, size * 1.0);
        ctx.clip();
        if (reduced) {
          const a0 = ctx.globalAlpha;
          ctx.globalAlpha = a0 * (1 - e);
          this.cell(ctx, old, cx + cw / 2, y, color);
          ctx.globalAlpha = a0 * e;
          this.cell(ctx, ch, cx + cw / 2, y, color);
        } else {
          this.cell(ctx, old, cx + cw / 2, y - dir * e * size, color);
          this.cell(ctx, ch, cx + cw / 2, y + dir * (1 - e) * size, color);
        }
        ctx.restore();
      }
      cx += cw;
      i++;
    }
    return total;
  }
}

/** The "Verified by Chainlink" stamp: a brass survey benchmark disc that lands on `settled`. */
export function stamp(ctx: CanvasRenderingContext2D, T: Type, tx: string, mode: string, dt: number, reduced: boolean, x: number, y: number) {
  const k = reduced ? 1 : clamp(dt / 0.22);
  const sc = reduced ? 1 : lerp(1.9, 1, easeIn(k));
  const a = reduced ? clamp(dt / 0.4) : clamp(k * 1.5);
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
  const onchain = isTxHash(tx);
  const ring = onchain ? "Verified by Chainlink" : "Offline run · no chain";
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
  T.text(ctx, onchain ? shortHash(tx) : "offline", 0, 52, T.font("x", 600, 24), C.ink, "center");
  T.text(ctx, onchain ? (mode === "simulated" ? "simulated report" : "onchain report") : "no chain", 0, 96, T.font("c", 700, 22), rgba(C.ink, 0.85), "center");
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
