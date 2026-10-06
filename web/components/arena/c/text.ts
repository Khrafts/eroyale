// Canvas type setting with tabular figures: every digit gets the same advance, so numbers
// that roll never shimmy. Canvas has no font-feature-settings, so we place glyphs ourselves.

export type Align = "left" | "center" | "right";
export type TextOpt = {
  size: number;
  weight?: number;
  color: string;
  align?: Align;
  halo?: string | false;
  haloW?: number;
  alpha?: number;
  tab?: boolean;
};

const DIGITS = "0123456789";

export class Typesetter {
  family = "serif";
  private cache = new Map<string, number>();

  setFamily(f: string) {
    this.family = f;
    this.cache.clear();
  }

  reset() {
    this.cache.clear();
  }

  font(size: number, weight = 600) {
    return `${weight} ${size}px ${this.family}`;
  }

  private cw(ctx: CanvasRenderingContext2D, font: string, ch: string): number {
    const k = font + "|" + ch;
    let w = this.cache.get(k);
    if (w === undefined) {
      ctx.font = font;
      if (ch === "#digit") {
        w = 0;
        for (const d of DIGITS) w = Math.max(w, ctx.measureText(d).width);
      } else w = ctx.measureText(ch).width;
      this.cache.set(k, w);
    }
    return w;
  }

  width(ctx: CanvasRenderingContext2D, s: string, size: number, weight = 600, tab = true): number {
    const font = this.font(size, weight);
    if (!tab) {
      ctx.font = font;
      return ctx.measureText(s).width;
    }
    const dw = this.cw(ctx, font, "#digit");
    let w = 0;
    for (const ch of s) w += DIGITS.includes(ch) ? dw : this.cw(ctx, font, ch);
    return w;
  }

  draw(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, o: TextOpt): number {
    const font = this.font(o.size, o.weight ?? 600);
    const tab = o.tab ?? /\d/.test(s);
    const align = o.align ?? "left";
    ctx.globalAlpha = o.alpha ?? 1;
    ctx.font = font;
    ctx.textBaseline = "alphabetic";
    const haloW = o.haloW ?? Math.max(3, o.size * 0.2);
    if (!tab) {
      ctx.textAlign = align;
      if (o.halo) {
        ctx.lineJoin = "round";
        ctx.lineWidth = haloW;
        ctx.strokeStyle = o.halo;
        ctx.strokeText(s, x, y);
      }
      ctx.fillStyle = o.color;
      ctx.fillText(s, x, y);
      ctx.globalAlpha = 1;
      return ctx.measureText(s).width;
    }
    const dw = this.cw(ctx, font, "#digit");
    const chars = [...s];
    const ws = chars.map((ch) => (DIGITS.includes(ch) ? dw : this.cw(ctx, font, ch)));
    const total = ws.reduce((a, b) => a + b, 0);
    let x0 = align === "left" ? x : align === "right" ? x - total : x - total / 2;
    ctx.font = font;
    ctx.textAlign = "left";
    const pass = (stroke: boolean) => {
      let cx = x0;
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const gw = DIGITS.includes(ch) ? this.cw(ctx, font, ch) : ws[i];
        const px = cx + (ws[i] - gw) / 2;
        if (stroke) ctx.strokeText(ch, px, y);
        else ctx.fillText(ch, px, y);
        cx += ws[i];
      }
    };
    if (o.halo) {
      ctx.lineJoin = "round";
      ctx.lineWidth = haloW;
      ctx.strokeStyle = o.halo;
      pass(true);
    }
    ctx.fillStyle = o.color;
    pass(false);
    ctx.globalAlpha = 1;
    x0 += 0;
    return total;
  }
}

const NF = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Rolling display value. */
export const money = (n: number) => NF.format(n);

/** Exact 2-decimal wire string with thousands separators, no float round trip. */
export function moneyStr(s: string): string {
  const neg = s.startsWith("-");
  const [w, d = "00"] = (neg ? s.slice(1) : s).split(".");
  const ww = w.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + ww + "." + d.padEnd(2, "0").slice(0, 2);
}

export function clockStr(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
