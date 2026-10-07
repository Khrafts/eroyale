// The island's world on a 2D canvas: sky and clouds, island chips, avatar heads, the podium and confetti.
// Every colour comes from lib/theme.ts; avatar colours come from the player's config (lib/island/avatar.ts).
import { ISLAND, RADIUS, STROKE, coral, ink, ink2, mint, muted, paper, skyBottom, skyTop, sun, violet } from "@/lib/theme";
import { cfgFor, type AvatarCfg } from "@/lib/island/avatar";
import { Type, clamp, rgba, rng } from "./draw";

export const W = 1920;
export const H = 1080;
export const LW = STROKE.arena; // every outline on the arena canvas
export const HUD_Y = 16; // the HUD sits this far below the top edge, so a band of sky shows above it

// ---------- shapes ----------
export function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/** An island chip or panel: fill, ink outline, hard ink shadow straight down. `pointer` adds the tag's downward tip. */
export function box(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  o: { fill?: string; r?: number; shadow?: number; pointer?: boolean; line?: number } = {},
) {
  const r = o.r ?? RADIUS.round;
  const sh = o.shadow ?? 4;
  const lw = o.line ?? LW;
  if (sh > 0) {
    ctx.fillStyle = ink;
    rr(ctx, x, y + sh, w, h, r);
    ctx.fill();
  }
  if (o.pointer) {
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.moveTo(x + w / 2 - 8, y + h + sh - 1);
    ctx.lineTo(x + w / 2 + 8, y + h + sh - 1);
    ctx.lineTo(x + w / 2, y + h + sh + 10);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = o.fill ?? paper;
  rr(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = ink;
  ctx.stroke();
}

// ---------- sky ----------
type Cloud = { img: HTMLCanvasElement; x: number; y: number; w: number; h: number; sp: number };
let skyGrad: { ctx: CanvasRenderingContext2D; g: CanvasGradient } | null = null;

/** The island's sky gradient (skyTop overhead to skyBottom at the horizon) with slow toon clouds. */
export class Sky {
  clouds: Cloud[] = [];
  constructor(seed: number, n = 6, band: [number, number] = [170, 330]) {
    const r = rng(seed);
    for (let i = 0; i < n; i++) {
      const s = 0.55 + r() * 0.45;
      const img = cloudSprite(r, s);
      this.clouds.push({ img, x: r() * (W + 400) - 200, y: band[0] + r() * (band[1] - band[0]), w: img.width / 2, h: img.height / 2, sp: 6 + r() * 8 });
    }
  }
  draw(ctx: CanvasRenderingContext2D, real: number, reduced: boolean) {
    if (!skyGrad || skyGrad.ctx !== ctx) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, skyTop);
      g.addColorStop(0.72, skyBottom);
      g.addColorStop(1, skyBottom);
      skyGrad = { ctx, g };
    }
    ctx.fillStyle = skyGrad.g;
    ctx.fillRect(0, 0, W, H);
    for (const c of this.clouds) {
      const x = reduced ? c.x : ((c.x + real * c.sp + 200) % (W + 400)) - 200;
      ctx.drawImage(c.img, x - c.w / 2, c.y - c.h / 2, c.w, c.h);
    }
  }
}

/** A cloud: a row of white puffs with one ink outline around the union (outline every puff, then fill every puff). */
function cloudSprite(r: () => number, s: number): HTMLCanvasElement {
  const n = 3 + Math.floor(r() * 3);
  const puffs: [number, number, number][] = [];
  for (let k = 0; k < n; k++) puffs.push([k * 46 * s, -r() * 18 * s, (30 + r() * 22) * s * (k === 0 || k === n - 1 ? 0.8 : 1)]);
  const minX = Math.min(...puffs.map((p) => p[0] - p[2])) - 6;
  const maxX = Math.max(...puffs.map((p) => p[0] + p[2])) + 6;
  const minY = Math.min(...puffs.map((p) => p[1] - p[2])) - 6;
  const maxY = 30 * s + 8;
  const cv = document.createElement("canvas");
  cv.width = Math.ceil((maxX - minX) * 2);
  cv.height = Math.ceil((maxY - minY) * 2);
  const c = cv.getContext("2d")!;
  c.scale(2, 2);
  c.translate(-minX, -minY);
  const shape = () => {
    c.beginPath();
    for (const [x, y, rad] of puffs) {
      c.moveTo(x + rad, y);
      c.arc(x, y, rad, 0, Math.PI * 2);
    }
    c.rect(puffs[0][0], 0, puffs[n - 1][0] - puffs[0][0], 30 * s);
  };
  // flat underside like the island's clouds
  c.save();
  c.beginPath();
  c.rect(minX, minY, maxX - minX, 30 * s - minY);
  c.clip();
  shape();
  c.lineWidth = LW * 2;
  c.strokeStyle = rgba(ink, 0.9);
  c.stroke();
  c.fillStyle = ISLAND.white;
  shape();
  c.fill();
  c.restore();
  c.strokeStyle = rgba(ink, 0.9);
  c.lineWidth = LW;
  c.beginPath();
  c.moveTo(puffs[0][0] - puffs[0][2] * 0.6, 30 * s);
  c.lineTo(puffs[n - 1][0] + puffs[n - 1][2] * 0.6, 30 * s);
  c.stroke();
  return cv;
}

// ---------- avatar heads ----------
const heads = new Map<string, HTMLCanvasElement>();
const HEAD_RES = 2.5; // sprite pixels per design pixel (covers dpr 2 at the 1920 design size)

/** A player's head as the island draws it, cached once per look and size. `own` overrides the address-derived look. */
export function headSprite(address: string, crown: boolean, radius: number, own?: AvatarCfg | null): HTMLCanvasElement {
  const key = `${address}|${crown ? 1 : 0}|${radius}|${own ? JSON.stringify(own) : ""}`;
  let cv = heads.get(key);
  if (cv) return cv;
  const cfg: AvatarCfg = own ? { ...own, hat: crown ? "crown" : own.hat } : cfgFor(address, "", crown ? 0 : -1);
  cv = document.createElement("canvas");
  const box = radius * 3.2; // room for hats above
  cv.width = Math.ceil(box * HEAD_RES);
  cv.height = Math.ceil(box * HEAD_RES);
  const c = cv.getContext("2d")!;
  c.scale(HEAD_RES, HEAD_RES);
  c.translate(box / 2, box * 0.62);
  drawHead(c, cfg, radius);
  heads.set(key, cv);
  return cv;
}

/** Draw a cached head centred on (x, y), the head circle's centre. */
export function head(ctx: CanvasRenderingContext2D, sprite: HTMLCanvasElement, x: number, y: number, radius: number) {
  const box = radius * 3.2;
  ctx.drawImage(sprite, x - box / 2, y - box * 0.62, box, box);
}

function drawHead(c: CanvasRenderingContext2D, cfg: AvatarCfg, R: number) {
  const lw = Math.max(2, R * 0.12);
  c.lineJoin = "round";
  c.lineCap = "round";
  const outline = (fill: string) => {
    c.fillStyle = fill;
    c.fill();
    c.lineWidth = lw;
    c.strokeStyle = ink;
    c.stroke();
  };
  const hc = cfg.hatColor;
  // behind the head
  if (cfg.hat === "halo") {
    c.beginPath();
    c.ellipse(0, -R * 1.45, R * 0.7, R * 0.2, 0, 0, Math.PI * 2);
    c.lineWidth = R * 0.16;
    c.strokeStyle = ink;
    c.stroke();
    c.lineWidth = R * 0.09;
    c.strokeStyle = sun;
    c.stroke();
  }
  // the head
  c.beginPath();
  c.arc(0, 0, R, 0, Math.PI * 2);
  outline(cfg.skin);
  // cheeks
  c.fillStyle = rgba(coral, 0.45);
  for (const sd of [-1, 1]) {
    c.beginPath();
    c.ellipse(sd * R * 0.58, R * 0.28, R * 0.17, R * 0.1, 0, 0, Math.PI * 2);
    c.fill();
  }
  // eyes
  const eye = (x: number, arc: boolean) => {
    c.beginPath();
    if (arc) {
      c.arc(x, -R * 0.02, R * 0.14, Math.PI * 1.1, Math.PI * 1.9);
      c.lineWidth = R * 0.08;
      c.strokeStyle = ink;
      c.stroke();
    } else {
      c.arc(x, -R * 0.08, R * 0.12, 0, Math.PI * 2);
      c.fillStyle = ink;
      c.fill();
    }
  };
  if (cfg.face === "shades") {
    rr(c, -R * 0.72, -R * 0.26, R * 1.44, R * 0.32, R * 0.1);
    c.fillStyle = ink;
    c.fill();
    c.fillStyle = ISLAND.wave;
    rr(c, -R * 0.5, -R * 0.2, R * 0.38, R * 0.08, R * 0.04);
    c.fill();
  } else {
    eye(-R * 0.36, cfg.face === "happy");
    eye(R * 0.36, cfg.face === "happy" || cfg.face === "wink");
  }
  // mouth
  c.beginPath();
  c.arc(0, R * 0.26, R * 0.16, Math.PI * 0.15, Math.PI * 0.85);
  c.lineWidth = R * 0.07;
  c.strokeStyle = ink;
  c.stroke();
  // headwear
  if (cfg.hat === "crown") {
    const y0 = -R * 0.72;
    c.beginPath();
    c.moveTo(-R * 0.62, y0 + R * 0.12);
    c.lineTo(-R * 0.62, y0 - R * 0.42);
    c.lineTo(-R * 0.31, y0 - R * 0.16);
    c.lineTo(0, y0 - R * 0.58);
    c.lineTo(R * 0.31, y0 - R * 0.16);
    c.lineTo(R * 0.62, y0 - R * 0.42);
    c.lineTo(R * 0.62, y0 + R * 0.12);
    c.closePath();
    outline(sun);
    [-0.34, 0, 0.34].forEach((dx, i) => {
      c.beginPath();
      c.arc(dx * R, y0 - R * 0.02, R * 0.07, 0, Math.PI * 2);
      c.fillStyle = i % 2 ? coral : ISLAND.sky;
      c.fill();
    });
  } else if (cfg.hat === "cap") {
    c.beginPath();
    c.arc(0, -R * 0.1, R * 1.02, Math.PI * 1.04, Math.PI * 1.96);
    c.closePath();
    outline(hc);
    rr(c, R * 0.1, -R * 0.32, R * 1.05, R * 0.24, R * 0.12);
    outline(hc);
    c.beginPath();
    c.arc(0, -R * 1.1, R * 0.1, 0, Math.PI * 2);
    c.fillStyle = ink;
    c.fill();
  } else if (cfg.hat === "tophat") {
    rr(c, -R * 0.95, -R * 0.98, R * 1.9, R * 0.2, R * 0.08);
    outline(ink);
    rr(c, -R * 0.6, -R * 2.0, R * 1.2, R * 1.1, R * 0.08);
    outline(ink);
    c.fillStyle = hc;
    c.fillRect(-R * 0.6 + lw / 2, -R * 1.18, R * 1.2 - lw, R * 0.22);
  } else if (cfg.hat === "beanie") {
    c.beginPath();
    c.ellipse(0, -R * 0.28, R * 1.0, R * 1.06, 0, Math.PI, Math.PI * 2);
    c.closePath();
    outline(hc);
    rr(c, -R * 1.04, -R * 0.42, R * 2.08, R * 0.3, R * 0.15);
    outline(hc);
    c.beginPath();
    c.arc(0, -R * 1.42, R * 0.24, 0, Math.PI * 2);
    outline(paper);
  } else if (cfg.hat === "party") {
    c.save();
    c.translate(R * 0.15, -R * 0.78);
    c.rotate(0.22);
    c.beginPath();
    c.moveTo(-R * 0.48, 0);
    c.lineTo(R * 0.48, 0);
    c.lineTo(0, -R * 1.3);
    c.closePath();
    outline(hc);
    c.beginPath();
    c.arc(0, -R * 1.34, R * 0.18, 0, Math.PI * 2);
    outline(sun);
    c.restore();
  }
}

// ---------- confetti ----------
const CONFETTI = [sun, coral, violet, mint, ISLAND.sky];
type Bit = { x: number; y: number; vx: number; vy: number; a: number; va: number; w: number; h: number; c: string; life: number };

export class Confetti {
  bits: Bit[] = [];
  r = rng(5);
  /** A pop of confetti from (x, y), aimed at `dir` (radians, default straight up). */
  burst(x: number, y: number, n: number, spread = 1, dir = -Math.PI / 2) {
    const r = this.r;
    for (let i = 0; i < n && this.bits.length < 600; i++) {
      const ang = dir + (r() - 0.5) * 2.2 * spread;
      const sp = 380 + r() * 620;
      this.bits.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, a: r() * 6, va: (r() - 0.5) * 14, w: 9 + r() * 8, h: 5 + r() * 5, c: CONFETTI[i % CONFETTI.length], life: 0 });
    }
  }
  /** Gentle fall from the top edge (the settled celebration). */
  rain(n: number) {
    const r = this.r;
    for (let i = 0; i < n && this.bits.length < 600; i++) {
      this.bits.push({ x: r() * W, y: -20 - r() * 60, vx: (r() - 0.5) * 80, vy: 80 + r() * 120, a: r() * 6, va: (r() - 0.5) * 10, w: 9 + r() * 8, h: 5 + r() * 5, c: CONFETTI[i % CONFETTI.length], life: 0 });
    }
  }
  draw(ctx: CanvasRenderingContext2D, dt: number) {
    if (!this.bits.length) return;
    const keep: Bit[] = [];
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ink;
    for (const b of this.bits) {
      b.life += dt;
      b.vy += 900 * dt;
      b.vx *= Math.exp(-dt * 1.6);
      b.vy = Math.min(b.vy, 260);
      b.x += b.vx * dt + Math.sin(b.life * 5 + b.a) * 40 * dt;
      b.y += b.vy * dt;
      b.a += b.va * dt;
      if (b.y > H + 30 || b.life > 9) continue;
      keep.push(b);
      const ca = Math.cos(b.a);
      const sa = Math.sin(b.a);
      const sx = Math.cos(b.life * 7 + b.a);
      // the corners of the spinning, flipping piece
      const hw = (b.w / 2) * sx;
      const hh = b.h / 2;
      ctx.beginPath();
      ctx.moveTo(b.x - hw * ca + hh * sa, b.y - hw * sa - hh * ca);
      ctx.lineTo(b.x + hw * ca + hh * sa, b.y + hw * sa - hh * ca);
      ctx.lineTo(b.x + hw * ca - hh * sa, b.y + hw * sa + hh * ca);
      ctx.lineTo(b.x - hw * ca - hh * sa, b.y - hw * sa + hh * ca);
      ctx.closePath();
      ctx.fillStyle = b.c;
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    this.bits = keep;
  }
}

// ---------- podium ----------
export const PODIUM = { silver: ISLAND.silver, bronze: ISLAND.bronze, gold: sun };

/** One podium step: a flat block with an ink outline and a hard shadow, the place number on its face. */
export function step(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, rise: number) {
  const hh = h * clamp(rise);
  if (hh < 1) return;
  box(ctx, x, y + h - hh, w, hh, { fill, r: 14, shadow: 6 });
}

// ---------- HUD pieces shared by both scenes ----------
/** The island's panel with the game's colour on its head and the head's two soft white circles. */
export function panel(ctx: CanvasRenderingContext2D, T: Type, cx: number, w: number, h: number, title: string, headFill: string) {
  const x = cx - w / 2;
  const y = 18;
  box(ctx, x, y, w, h, { r: RADIUS.panel, shadow: 6, fill: paper });
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, 46);
  ctx.clip();
  ctx.fillStyle = headFill;
  rr(ctx, x, y, w, h, RADIUS.panel);
  ctx.fill();
  ctx.fillStyle = rgba(paper, 0.22);
  ctx.beginPath();
  ctx.arc(x + w - 40, y - 4, 34, 0, Math.PI * 2);
  ctx.moveTo(x + w - 74, y + 40);
  ctx.arc(x + w - 92, y + 40, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = ink;
  ctx.lineWidth = LW;
  ctx.beginPath();
  ctx.moveTo(x, y + 46);
  ctx.lineTo(x + w, y + 46);
  ctx.stroke();
  rr(ctx, x, y, w, h, RADIUS.panel);
  ctx.stroke();
  T.text(ctx, title, cx, y + 31, T.font("d", 700, 19), ink, "center");
}

export function botW(ctx: CanvasRenderingContext2D, T: Type) {
  return T.w(ctx, T.font("x", 600, 12), "bot") + 10;
}
/** The island's bot tag: a small outlined mono pill, its top left at (x, y). */
export function botTag(ctx: CanvasRenderingContext2D, T: Type, x: number, y: number) {
  box(ctx, x, y, botW(ctx, T), 18, { fill: paper, r: 6, shadow: 0, line: 1.5 });
  T.text(ctx, "bot", x + 5, y + 13.5, T.font("x", 600, 12), muted);
}

/** The wordmark chip at the top left: the game's badge, "Trading Royale" and a caption. Returns its right edge. */
export function wordmark(ctx: CanvasRenderingContext2D, T: Type, caption: string, game: string) {
  const wf = T.font("d", 800, 28);
  const lf = T.font("c", 600, 20);
  const ww = T.w(ctx, wf, "Trading Royale");
  const w = 22 + 34 + 12 + ww + (caption ? 14 + T.w(ctx, lf, caption) : 0) + 22;
  box(ctx, 32, 24, w, 60, { r: 30, shadow: 4, fill: paper });
  ctx.fillStyle = game;
  ctx.beginPath();
  ctx.arc(71, 54, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  T.text(ctx, "TR", 71, 60, T.font("d", 800, 14), paper, "center");
  T.text(ctx, "Trading Royale", 100, 65, wf, ink);
  if (caption) T.text(ctx, caption, 100 + ww + 14, 63, lf, ink2);
  return 32 + w;
}

/** The pot chip under the wordmark (the amount on a sun pill). Returns its right edge. */
export function potChip(ctx: CanvasRenderingContext2D, T: Type, pot: string, real: number, reduced: boolean) {
  const lf = T.font("c", 600, 20);
  const pf = T.font("x", 800, 26);
  const potW = T.widthOf(ctx, pf, pot) + 22;
  const w = 18 + T.w(ctx, lf, "Pot") + 10 + potW + 10;
  box(ctx, 32, 98, w, 50, { r: 25, shadow: 4, fill: paper });
  T.text(ctx, "Pot", 50, 130, lf, ink2);
  const px = 50 + T.w(ctx, lf, "Pot") + 10;
  box(ctx, px, 106, potW, 34, { fill: sun, r: 17, shadow: 0, line: 2 });
  T.roll(ctx, "pot", pot, px + 11, 132, pf, 26, ink, "left", real, reduced);
  return 32 + w;
}

/** A count chip: a big mono figure and a caption. */
export function countChip(ctx: CanvasRenderingContext2D, T: Type, x: number, key: string, n: string, caption: string, real: number, reduced: boolean) {
  const lf = T.font("c", 600, 20);
  const af = T.font("x", 800, 26);
  const aw = T.widthOf(ctx, af, n);
  const w = 18 + aw + 10 + T.w(ctx, lf, caption) + 18;
  box(ctx, x, 98, w, 50, { r: 25, shadow: 4, fill: paper });
  T.roll(ctx, key, n, x + 18, 132, af, 26, ink, "left", real, reduced);
  T.text(ctx, caption, x + 18 + aw + 10, 130, lf, ink2);
}
