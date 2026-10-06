// Drawing helpers for the pit: palette, tabular numbers, chips, slag.

export const C = {
  steel: "#2C3843", // pit walls and floor, blued cast iron
  steelLit: "#46576A", // rails, chip faces
  steelDeep: "#1C252D", // chip sides, shadows
  chalk: "#EDE8DA", // all text and marks, chalk on iron
  slag: "#FF6A1A", // the zone, and only the zone
  slagHot: "#FFA040",
  slagDeep: "#8A2308",
  crust: "#3B1C12",
  profit: "#47D6A0", // patina
  loss: "#E25CC4", // bruise
  long: "#6E8BFF", // cobalt
  short: "#D8C35A", // brass
} as const;

export const W = 1920;
export const H = 1080;

export function hash(s: string, k = 0): number {
  let h = 2166136261 ^ k;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const ease = (u: number) => 1 - Math.pow(1 - clamp(u, 0, 1), 3);

/** 10212.5 -> "10,212.50" */
export function money(v: number, dp = 2): string {
  const neg = v < 0;
  const s = Math.abs(v).toFixed(dp);
  const [i, f] = s.split(".");
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + g + (f ? "." + f : "");
}

/** "10212.50" -> "10,212.50" without going through a float. */
export function moneyStr(s: string): string {
  const neg = s.startsWith("-");
  const [i, f] = s.replace("-", "").split(".");
  return (neg ? "-" : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f !== undefined ? "." + f : "");
}

export function clockStr(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

let FAMILY = "serif";
export function setFamily(f: string) {
  FAMILY = f;
}
export function font(ctx: CanvasRenderingContext2D, size: number, weight = 700) {
  ctx.font = `${weight} ${size}px ${FAMILY}`;
}

const advCache = new Map<string, number>();
/** Text with every digit on the same advance, so rolling numbers never shimmy. */
export function tab(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, align: "left" | "right" | "center" = "left") {
  let adv = advCache.get(ctx.font);
  if (adv === undefined) {
    adv = ctx.measureText("0").width;
    advCache.set(ctx.font, adv);
  }
  const ws: number[] = [];
  let total = 0;
  for (const ch of s) {
    const w = ch >= "0" && ch <= "9" ? adv : ctx.measureText(ch).width;
    ws.push(w);
    total += w;
  }
  let cx = align === "left" ? x : align === "right" ? x - total : x - total / 2;
  const prev = ctx.textAlign;
  ctx.textAlign = "left";
  let i = 0;
  for (const ch of s) {
    const w = ws[i++];
    if (ch >= "0" && ch <= "9") ctx.fillText(ch, cx + (w - ctx.measureText(ch).width) / 2, y);
    else ctx.fillText(ch, cx, y);
    cx += w;
  }
  ctx.textAlign = prev;
  return total;
}

export type Wedges = Partial<Record<"BTC" | "ETH" | "SOL", 1 | -1>>;

/** A weighted chip seen slightly from above: iron body, coloured rim, notches, initials, position wedges. */
export function chip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  tilt: number,
  rim: string,
  initials: string,
  wedges: Wedges,
  opts: { alpha?: number; hot?: number; white?: number } = {},
) {
  const th = r * 0.32;
  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.translate(x, y);
  ctx.rotate(tilt);
  // shadow on the floor
  ctx.fillStyle = "rgba(10,14,18,0.45)";
  ctx.beginPath();
  ctx.ellipse(r * 0.15, th + r * 0.55, r * 1.05, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  // body side
  ctx.fillStyle = C.steelDeep;
  ctx.beginPath();
  ctx.ellipse(0, th, r, r * 0.86, 0, 0, Math.PI);
  ctx.lineTo(-r, 0);
  ctx.ellipse(0, 0, r, r * 0.86, 0, Math.PI, 0, true);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = rim;
  ctx.globalAlpha *= 0.55;
  ctx.fillRect(-r, 0, 2 * r, th * 0.5);
  ctx.globalAlpha = opts.alpha ?? 1;
  // face
  ctx.beginPath();
  ctx.ellipse(0, 0, r, r * 0.86, 0, 0, Math.PI * 2);
  ctx.fillStyle = rim;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.74, r * 0.64, 0, 0, Math.PI * 2);
  ctx.fillStyle = C.steelLit;
  ctx.fill();
  ctx.strokeStyle = "rgba(237,232,218,0.25)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.62, r * 0.53, 0, 0, Math.PI * 2);
  ctx.stroke();
  // edge notches, chalk
  ctx.fillStyle = C.chalk;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    ctx.save();
    ctx.translate(Math.cos(a) * r * 0.87, Math.sin(a) * r * 0.75);
    ctx.rotate(a);
    ctx.fillRect(-r * 0.09, -r * 0.05, r * 0.18, r * 0.1);
    ctx.restore();
  }
  // position wedges: BTC left, ETH top, SOL right
  const slots: ["BTC" | "ETH" | "SOL", number][] = [["BTC", -Math.PI * 0.78], ["ETH", -Math.PI / 2], ["SOL", -Math.PI * 0.22]];
  for (const [m, a] of slots) {
    const side = wedges[m];
    if (!side) continue;
    ctx.fillStyle = side === 1 ? C.long : C.short;
    ctx.strokeStyle = C.steelDeep;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.02, r * 0.88, 0, a - 0.3, a + 0.3);
    ctx.ellipse(0, 0, r * 0.72, r * 0.62, 0, a + 0.3, a - 0.3, true);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // initials
  font(ctx, Math.round(r * 0.62), 800);
  ctx.fillStyle = C.chalk;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials, 0, r * 0.04);
  if (opts.white) {
    ctx.globalAlpha = clamp(opts.white, 0, 1) * (opts.alpha ?? 1);
    ctx.fillStyle = "#FFF6E8";
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.02, r * 0.88, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function initials(callsign: string): string {
  const c = callsign.replace(/[^A-Za-z0-9]/g, "");
  return (c[0] ?? "?").toUpperCase() + (c[1] ?? "").toLowerCase();
}

/** Slag surface height at x, relative to the base level. */
export function slagWave(x: number, t: number, calm: boolean): number {
  if (calm) return Math.sin(x * 0.01) * 2;
  return Math.sin(x * 0.011 + t * 0.6) * 5 + Math.sin(x * 0.029 - t * 1.1) * 2.6 + Math.sin(x * 0.067 + t * 2.1) * 1.1;
}

/** The rising floor of molten slag. `heat` 0..1 brightens it before a cut. */
export function slag(ctx: CanvasRenderingContext2D, y0: number, t: number, heat: number, calm: boolean, x0 = 0, x1 = W) {
  if (y0 >= H + 20) return;
  // heat haze above the surface
  const haze = ctx.createLinearGradient(0, y0 - 140 - heat * 80, 0, y0);
  haze.addColorStop(0, "rgba(255,106,26,0)");
  haze.addColorStop(1, `rgba(255,106,26,${0.16 + heat * 0.22})`);
  ctx.fillStyle = haze;
  ctx.fillRect(x0, y0 - 220, x1 - x0, 220);

  ctx.beginPath();
  ctx.moveTo(x0, H);
  for (let x = x0; x <= x1 + 16; x += 16) ctx.lineTo(x, y0 + slagWave(x, t, calm));
  ctx.lineTo(x1, H);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, y0, 0, Math.max(y0 + 260, H));
  g.addColorStop(0, heat > 0.5 ? C.slagHot : C.slag);
  g.addColorStop(0.18, C.slag);
  g.addColorStop(1, C.slagDeep);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();

  // cooling crust plates riding the surface, cracks glowing between them
  for (let i = 0; i < 26; i++) {
    const sp = 6 + hash("crust", i) * 14;
    const span = x1 - x0 + 300;
    const cx = x0 - 150 + ((hash("cx", i) * span + (calm ? 0 : t * sp * (i % 2 ? 1 : -1))) % span + span) % span;
    const depth = 14 + hash("cd", i) * Math.max(10, H - y0 - 40);
    const cy = y0 + Math.min(depth, H - y0 + 30);
    const w = 40 + hash("cw", i) * 90;
    const h = 8 + hash("ch", i) * 14;
    const a = 0.85 - Math.min(0.6, (cy - y0) / 600);
    ctx.fillStyle = `rgba(59,28,18,${a})`;
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, cy + slagWave(cx, t, calm));
    ctx.lineTo(cx - w * 0.2, cy - h * 0.5 + slagWave(cx, t, calm));
    ctx.lineTo(cx + w * 0.35, cy - h * 0.3 + slagWave(cx, t, calm));
    ctx.lineTo(cx + w / 2, cy + h * 0.4 + slagWave(cx, t, calm));
    ctx.lineTo(cx, cy + h * 0.7 + slagWave(cx, t, calm));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // bright meniscus
  ctx.strokeStyle = C.slagHot;
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let x = x0; x <= x1 + 16; x += 16) {
    const y = y0 + slagWave(x, t, calm);
    if (x === x0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // bubbles
  if (!calm) {
    for (let i = 0; i < 14; i++) {
      const period = 1.6 + hash("bp", i) * 2.4;
      const ph = ((t + hash("bo", i) * period) % period) / period;
      const bx = x0 + hash("bx", i + Math.floor((t + hash("bo", i) * period) / period) * 31) * (x1 - x0);
      const by = y0 + slagWave(bx, t, false);
      const rr = (3 + hash("br", i) * 7) * Math.sin(ph * Math.PI) * (1 + heat);
      ctx.strokeStyle = `rgba(255,190,110,${0.7 * (1 - ph)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by - rr * 0.4, rr, Math.PI, 0);
      ctx.stroke();
    }
  }
}
