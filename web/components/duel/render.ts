// The duel on a 2D canvas, shared by the phone (/duel) and the big screen (/arena?duel=). The island's world in 2D:
// its sky gradient with slow clouds, a toon meadow and a wooden dojo deck with a 3 px ink outline, and two stickmen
// in ink lines wearing their avatar's colours. Everything is read from a plain view each frame; the renderer keeps
// only presentation state (camera, smoothed joints, sparks, the damage trail, banners).
import type { AvatarCfg } from "@/lib/island/avatar";
import { ISLAND, canvasFont, coral, ink, muted, paper, skyBottom, skyTop, sun, tang } from "@/lib/theme";

export type RFighter = { x: number; y: number; hp: number; facing: 1 | -1; act: string; frame: number; combo: number; rounds: number };
export type View = {
  f: [RFighter, RFighter];
  round: number;
  roundTick: number;
  pause: number;
  over: boolean;
  winner: 0 | 1 | null;
  names: [string, string];
  bots: [boolean, boolean];
  avatars: [AvatarCfg, AvatarCfg];
  /** Which side is "you" (labelled), or null for a spectator. */
  me: 0 | 1 | null;
};

const ROUND_TICKS = 1800;
const STAGE_MIN = 500;
const STAGE_MAX = 11500;
type P = [number, number];
type Joints = { hip: P; neck: P; head: P; eF: P; hF: P; eB: P; hB: P; kF: P; fF: P; kB: P; fB: P };
const KEYS = ["hip", "neck", "head", "eF", "hF", "eB", "hB", "kF", "fF", "kB", "fB"] as const;

// ---------- poses, in fighter units facing +x (height about 1750) ----------
const STANCE: Joints = { hip: [0, 900], neck: [70, 1420], head: [100, 1610], eF: [280, 1200], hF: [420, 1390], eB: [140, 1150], hB: [300, 1330], kF: [200, 470], fF: [300, 0], kB: [-110, 460], fB: [-250, 0] };
const CROUCH: Joints = { hip: [0, 520], neck: [130, 1010], head: [170, 1200], eF: [330, 820], hF: [460, 980], eB: [200, 780], hB: [340, 930], kF: [330, 430], fF: [300, 0], kB: [-140, 330], fB: [-260, 0] };
const BLOCK: Joints = { ...STANCE, neck: [40, 1410], head: [50, 1600], eF: [230, 1330], hF: [250, 1590], eB: [170, 1280], hB: [230, 1510], fB: [-300, 0] };
const CBLOCK: Joints = { ...CROUCH, eF: [290, 900], hF: [300, 1160], eB: [230, 860], hB: [270, 1100] };
const JAB: Joints = { ...STANCE, neck: [150, 1410], head: [190, 1595], eF: [500, 1390], hF: [950, 1400], hB: [260, 1380], fF: [380, 0] };
const HEAVY_WIND: Joints = { ...STANCE, neck: [-30, 1420], head: [-30, 1610], eB: [-140, 1200], hB: [-60, 1390], eF: [300, 1250], hF: [430, 1420] };
const HEAVY: Joints = { hip: [130, 870], neck: [320, 1370], head: [380, 1550], eF: [230, 1150], hF: [130, 1300], eB: [700, 1360], hB: [1200, 1360], kF: [420, 470], fF: [560, 0], kB: [-80, 420], fB: [-320, 0] };
const SWEEP: Joints = { hip: [-40, 430], neck: [-280, 820], head: [-380, 990], eF: [-80, 560], hF: [80, 130], eB: [-460, 640], hB: [-560, 260], kF: [620, 150], fF: [1260, 50], kB: [40, 200], fB: [-280, 0] };
const TUCK: Joints = { hip: [0, 900], neck: [40, 1420], head: [60, 1610], eF: [260, 1500], hF: [360, 1720], eB: [-140, 1480], hB: [-200, 1700], kF: [260, 700], fF: [160, 380], kB: [-40, 640], fB: [-210, 400] };
const AIR: Joints = { hip: [0, 900], neck: [-90, 1400], head: [-110, 1585], eF: [140, 1280], hF: [60, 1460], eB: [-300, 1300], hB: [-480, 1420], kF: [420, 720], fF: [880, 540], kB: [-40, 600], fB: [-200, 360] };
const GRAB: Joints = { ...STANCE, neck: [180, 1400], head: [230, 1580], eF: [480, 1300], hF: [780, 1270], eB: [400, 1230], hB: [720, 1190], fF: [420, 0] };
const TOSS: Joints = { ...STANCE, neck: [-60, 1420], head: [-80, 1610], eF: [120, 1600], hF: [-60, 1800], eB: [60, 1560], hB: [-120, 1740], fB: [-320, 0] };
const RECOIL: Joints = { hip: [-50, 890], neck: [-170, 1380], head: [-260, 1540], eF: [-20, 1250], hF: [-120, 1480], eB: [-330, 1220], hB: [-420, 1420], kF: [180, 460], fF: [280, 0], kB: [-160, 450], fB: [-320, 0] };
const LYING: Joints = { hip: [-500, 110], neck: [-1080, 150], head: [-1290, 170], eF: [-800, 90], hF: [-560, 40], eB: [-920, 260], hB: [-700, 330], kF: [-160, 270], fF: [220, 60], kB: [-220, 120], fB: [160, 30] };

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
function mix(a: Joints, b: Joints, t: number): Joints {
  const o = {} as Joints;
  for (const k of KEYS) o[k] = [a[k][0] + (b[k][0] - a[k][0]) * t, a[k][1] + (b[k][1] - a[k][1]) * t];
  return o;
}
function strike(frame: number, s: number, a: number, r: number, from: Joints, to: Joints, wind?: Joints): Joints {
  if (frame < s) return wind && frame < s * 0.6 ? mix(from, wind, ease(frame / (s * 0.6))) : mix(wind ?? from, to, ease(wind ? (frame - s * 0.6) / (s * 0.4) : frame / s));
  if (frame < s + a) return to;
  return mix(to, from, ease((frame - s - a) / r));
}

/** What a fighter is doing, from its act name (tolerant of the rules module's own names). */
export function kindOf(act: string): string {
  const a = act.toLowerCase();
  if (a.includes("jab") || a.includes("light")) return "jab";
  if (a.includes("heavy")) return "heavy";
  if (a.includes("sweep")) return "sweep";
  if (a.includes("throw") || a.includes("grab")) return "throw";
  if (a.includes("air") || a.includes("kick")) return "air";
  if (a.includes("down") || a.includes("knock") || a === "ko") return "down";
  if (a.includes("bstun") || a.includes("blockstun") || (a.includes("block") && a.includes("stun"))) return "bstun";
  if (a.includes("stun") || a.includes("hit")) return "hstun";
  if (a.includes("cblock") || a.includes("crouchblock")) return "cblock";
  if (a.includes("block") || a.includes("guard")) return "block";
  if (a.includes("crouch")) return "crouch";
  if (a.includes("land")) return "land";
  if (a.includes("jump")) return "jump";
  if (a.includes("walk") || a.includes("fwd") || a.includes("forward")) return "walk";
  if (a.includes("back")) return "back";
  return "idle";
}

function poseOf(f: RFighter, t: number): Joints {
  const k = kindOf(f.act);
  const fr = f.frame;
  if (f.hp <= 0) return LYING;
  switch (k) {
    case "walk":
    case "back": {
      // the stride follows the ground covered (the rules keep frame at 0 while walking)
      const ph = f.x / 150 * f.facing;
      const base = k === "back" ? BLOCK : STANCE;
      const o = mix(base, base, 0);
      o.fF = [300 + 170 * Math.sin(ph), Math.max(0, 70 * Math.cos(ph))];
      o.fB = [-250 - 170 * Math.sin(ph), Math.max(0, -70 * Math.cos(ph))];
      o.kF = [200 + 90 * Math.sin(ph), 470];
      o.kB = [-110 - 90 * Math.sin(ph), 460];
      return o;
    }
    case "crouch":
      return CROUCH;
    case "block":
      return BLOCK;
    case "cblock":
      return CBLOCK;
    case "jab":
      return strike(fr, 4, 2, 7, STANCE, JAB);
    case "heavy":
      return strike(fr, 9, 3, 16, STANCE, HEAVY, HEAVY_WIND);
    case "sweep":
      return strike(fr, 8, 3, 18, CROUCH, SWEEP);
    case "throw":
      return fr < 5 ? strike(fr, 3, 2, 22, STANCE, GRAB) : mix(TOSS, STANCE, ease((fr - 5) / 22));
    case "air":
      return mix(TUCK, AIR, ease(fr / 5));
    case "jump":
      return TUCK;
    case "land":
      return mix(STANCE, CROUCH, 0.45);
    case "hstun":
      return mix(STANCE, RECOIL, ease(Math.min(1, fr / 6)));
    case "bstun":
      return mix(BLOCK, { ...BLOCK, hip: [-60, 880], neck: [-30, 1400], head: [-40, 1590] }, 0.8);
    case "down":
      // frame counts down from 40: the last 12 ticks are the get-up
      return fr > 12 ? LYING : mix(CROUCH, LYING, ease(fr / 12));
  }
  // idle: a slow breath
  const b = Math.sin(t * 0.004) * 18;
  const o = mix(STANCE, STANCE, 0);
  for (const key of ["neck", "head", "eF", "hF", "eB", "hB"] as const) o[key] = [o[key][0], o[key][1] + b];
  o.hip = [0, 900 + b * 0.5];
  return o;
}

// ---------- the renderer ----------
type Spark = { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number };
type Burst = { x: number; y: number; life: number; color: string; blocked: boolean };
type FState = { j: Joints | null; trail: number; trailHold: number; lastHp: number; lastKind: string; comboShown: number; comboPop: number; comboFade: number };

export type Renderer = {
  draw: (v: View, now: number) => void;
  resize: () => void;
  /** Tick-exact hit from the engine (`dhit`); the renderer also infers hits from hp drops. */
  hit: (defender: 0 | 1, blocked: boolean) => void;
  /** Visible stage scale for the HUD; `big` is the 1920x1080 arena. */
  big: boolean;
};

export function createRenderer(canvas: HTMLCanvasElement, opts: { big?: boolean; reduceMotion?: boolean; hud?: boolean } = {}): Renderer {
  const ctx = canvas.getContext("2d")!;
  const big = !!opts.big;
  let W = 0,
    H = 0,
    dpr = 1;
  let cam = { x: 6000, w: 6400 };
  let last = 0;
  const fs: [FState, FState] = [0, 1].map(() => ({ j: null, trail: 100, trailHold: 0, lastHp: 100, lastKind: "idle", comboShown: 0, comboPop: 0, comboFade: 0 })) as [FState, FState];
  const sparks: Spark[] = [];
  const bursts: Burst[] = [];
  let shake = 0;
  let lastRound = 0;
  let bannerT = 0;
  let clouds = [0.08, 0.34, 0.61, 0.86].map((x, i) => ({ x, y: 0.12 + (i % 2) * 0.09, s: 0.8 + (i % 3) * 0.25 }));

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, big ? 1.5 : 2);
    W = Math.max(1, r.width);
    H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  };
  resize();

  const u = () => (big ? W / 1920 : Math.min(W / 390, H / 420));
  const groundY = () => H * (big ? 0.8 : 0.82);
  const scale = () => Math.min(W / cam.w, (groundY() - (big ? 0.2 : 0.2) * H) / 1900);
  const sx = (x: number) => (x - cam.x) * scale() + W / 2;
  const sy = (y: number) => groundY() - y * scale();

  function spawnHit(v: View, d: 0 | 1, blocked: boolean) {
    const def = v.f[d];
    const att = v.f[1 - d];
    const kind = kindOf(att.act);
    const hy = kind === "sweep" ? 220 : kind === "air" ? 1250 : kind === "throw" ? 1150 : 1320;
    const x = def.x - def.facing * 120;
    const y = def.y + hy;
    const color = blocked ? paper : sun;
    bursts.push({ x, y, life: 1, color, blocked });
    const n = opts.reduceMotion ? 0 : blocked ? 6 : 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + i * 0.37;
      const sp = 40 + ((i * 53) % 50);
      sparks.push({ x, y, vx: Math.cos(a) * sp + att.facing * 25, vy: Math.sin(a) * sp + 20, life: 1, max: 0.35 + ((i * 7) % 5) * 0.05, color: i % 3 === 0 ? tang : color, size: 70 + ((i * 31) % 50) });
    }
    if (!blocked && !opts.reduceMotion) shake = Math.max(shake, kind === "heavy" || kind === "throw" ? 1 : 0.55);
  }

  // ---------- stage ----------
  function stage(now: number) {
    const gy = groundY();
    const g = ctx.createLinearGradient(0, 0, 0, gy);
    g.addColorStop(0, skyTop);
    g.addColorStop(0.72, skyBottom);
    g.addColorStop(1, ISLAND.horizon);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // clouds drift slowly (the island's), parallax with the camera
    ctx.fillStyle = ISLAND.white;
    for (const c of clouds) {
      const drift = opts.reduceMotion ? 0 : now * 0.000006;
      const cx = (((c.x + drift - cam.x / 60000) % 1.2) + 1.2) % 1.2;
      const x = cx * W * 1.1 - W * 0.05;
      const y = c.y * H;
      const r = 26 * u() * c.s;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.moveTo(x + r * 2.35, y - r * 0.4);
      ctx.arc(x + r * 1.1, y - r * 0.4, r * 1.25, 0, Math.PI * 2);
      ctx.moveTo(x + r * 3.25, y);
      ctx.arc(x + r * 2.3, y, r * 0.95, 0, Math.PI * 2);
      ctx.rect(x, y, r * 2.3, r * 0.95);
      ctx.fill("nonzero");
    }
    const lw = (big ? 3 : 2) * Math.max(1, u() * (big ? 1 : 0.9));
    // far meadow hills (parallax 0.25)
    const par = (k: number, x: number) => (x - cam.x * k) * scale() * 0.7 + W / 2;
    ctx.lineWidth = lw;
    ctx.strokeStyle = ink;
    ctx.fillStyle = ISLAND.meadowDark;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    for (let i = 0; i <= 24; i++) {
      const x = (i / 24) * W;
      const wx = (x - W / 2) / (scale() * 0.7) + cam.x * 0.25;
      ctx.lineTo(x, gy - (110 + 70 * Math.sin(wx / 2600) + 40 * Math.sin(wx / 900 + 1)) * scale() * 0.7);
    }
    ctx.lineTo(W, gy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // toon trees on the meadow
    for (let i = -3; i <= 14; i++) {
      const wx = i * 1500 + 300;
      const x = par(0.25, wx);
      if (x < -80 * u() || x > W + 80 * u()) continue;
      const s = scale() * 0.7;
      const ty = gy - (130 + 70 * Math.sin(wx / 2600) + 40 * Math.sin(wx / 900 + 1)) * s;
      ctx.fillStyle = ISLAND.pathEdge;
      ctx.fillRect(x - 28 * s, ty - 260 * s, 56 * s, 260 * s);
      ctx.strokeRect(x - 28 * s, ty - 260 * s, 56 * s, 260 * s);
      ctx.fillStyle = i % 2 ? ISLAND.grass : ISLAND.meadow;
      ctx.beginPath();
      ctx.arc(x, ty - 420 * s, 230 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // the deck: sand planks from the walls in, ink top edge
    const left = sx(STAGE_MIN - 400),
      right = sx(STAGE_MAX + 400);
    ctx.fillStyle = ISLAND.grass;
    ctx.fillRect(0, gy, W, H - gy);
    ctx.fillStyle = ISLAND.sand;
    ctx.fillRect(left, gy, right - left, H - gy);
    ctx.strokeStyle = ISLAND.pathEdge;
    ctx.lineWidth = lw;
    for (let x = STAGE_MIN - 400; x <= STAGE_MAX + 400; x += 500) {
      const a = sx(x);
      if (a < -10 || a > W + 10) continue;
      ctx.beginPath();
      ctx.moveTo(a, gy);
      ctx.lineTo(a + (a - W / 2) * 0.35, H);
      ctx.stroke();
    }
    ctx.fillStyle = ISLAND.path;
    ctx.fillRect(left, gy, right - left, Math.max(6, 10 * u()));
    ctx.strokeStyle = ink;
    ctx.lineWidth = lw * 1.2;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(W, gy);
    ctx.stroke();
    // the dojo posts at the walls
    for (const wx of [STAGE_MIN - 250, STAGE_MAX + 250]) {
      const x = sx(wx);
      if (x < -200 || x > W + 200) continue;
      const pw = 170 * scale();
      const ph = 2300 * scale();
      ctx.fillStyle = tang;
      ctx.fillRect(x - pw / 2, gy - ph, pw, ph);
      ctx.strokeRect(x - pw / 2, gy - ph, pw, ph);
      ctx.fillStyle = ink;
      ctx.fillRect(x - pw * 0.9, gy - ph - 50 * scale(), pw * 1.8, 90 * scale());
    }
  }

  // ---------- a stickman ----------
  function limb(a: P, b: P, c: P, color: string, ox: number, oy: number, face: number, w: number) {
    const s = scale();
    const pts = [a, b, c].map((p) => [ox + p[0] * face * s, oy - p[1] * s] as P);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.lineTo(pts[2][0], pts[2][1]);
    ctx.strokeStyle = ink;
    ctx.lineWidth = w;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = w * 0.48;
    ctx.stroke();
  }

  function fighter(f: RFighter, j: Joints, av: AvatarCfg, hurt: number) {
    const s = scale();
    const ox = sx(f.x);
    const oy = sy(f.y);
    const face = f.facing;
    const w = Math.max(big ? 9 : 5, 105 * s);
    // floor shadow
    ctx.fillStyle = "rgba(43,29,82,.18)";
    ctx.beginPath();
    ctx.ellipse(ox, groundY(), 380 * s * Math.max(0.4, 1 - f.y / 2400), 60 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    // back limbs first, then torso, then front limbs
    limb(j.hip, j.kB, j.fB, av.pants, ox, oy, face, w);
    limb(j.neck, j.eB, j.hB, av.shirt, ox, oy, face, w);
    limb(j.hip, [(j.hip[0] + j.neck[0]) / 2, (j.hip[1] + j.neck[1]) / 2], j.neck, av.shirt, ox, oy, face, w * 1.35);
    limb(j.hip, j.kF, j.fF, av.pants, ox, oy, face, w);
    if (av.extra === "scarf" || av.extra === "cape") {
      const nx = ox + j.neck[0] * face * s,
        ny = oy - j.neck[1] * s;
      ctx.strokeStyle = ink;
      ctx.lineWidth = w * 0.9;
      ctx.beginPath();
      ctx.moveTo(nx, ny);
      ctx.lineTo(nx - face * (av.extra === "cape" ? 260 : 200) * s, ny + (av.extra === "cape" ? 480 : 120) * s);
      ctx.stroke();
      ctx.strokeStyle = av.hatColor;
      ctx.lineWidth = w * 0.45;
      ctx.stroke();
    }
    limb(j.neck, j.eF, j.hF, av.shirt, ox, oy, face, w);
    // fists
    for (const h of [j.hF, j.hB]) {
      ctx.fillStyle = av.skin;
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(1.5, w * 0.22);
      ctx.beginPath();
      ctx.arc(ox + h[0] * face * s, oy - h[1] * s, w * 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    head(ox + j.head[0] * face * s, oy - j.head[1] * s, 175 * s, av, face, hurt, Math.max(big ? 3 : 2, w * 0.24));
  }

  /** An avatar head: skin, face, hat. Also used for the HUD chips. */
  function head(x: number, y: number, r: number, av: AvatarCfg, face: number, hurt: number, lw: number) {
    ctx.fillStyle = av.skin;
    ctx.strokeStyle = ink;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ink;
    const ex = x + face * r * 0.32;
    if (hurt > 0) {
      // squeezed-shut eyes
      ctx.lineWidth = lw * 0.9;
      for (const dx of [-0.22, 0.22]) {
        ctx.beginPath();
        ctx.moveTo(ex + dx * r - r * 0.1, y - r * 0.15);
        ctx.lineTo(ex + dx * r + r * 0.1, y - r * 0.05);
        ctx.stroke();
      }
    } else if (av.face === "shades") {
      ctx.fillRect(ex - r * 0.45, y - r * 0.22, r * 0.9, r * 0.24);
    } else {
      for (const dx of [-0.22, 0.22]) {
        ctx.beginPath();
        if (av.face === "wink" && dx > 0) ctx.fillRect(ex + dx * r - r * 0.1, y - r * 0.12, r * 0.2, r * 0.06);
        else ctx.arc(ex + dx * r, y - r * 0.1, r * 0.09, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (av.face === "happy" || av.face === "dots") {
      ctx.lineWidth = lw * 0.8;
      ctx.beginPath();
      ctx.arc(ex, y + r * 0.18, r * 0.22, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }
    ctx.lineWidth = lw;
    ctx.fillStyle = av.hatColor;
    switch (av.hat) {
      case "cap":
        ctx.beginPath();
        ctx.arc(x, y - r * 0.15, r * 0.98, Math.PI * 1.05, Math.PI * 1.95);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillRect(x + (face > 0 ? r * 0.3 : -r * 1.3), y - r * 0.35, r, r * 0.18);
        ctx.strokeRect(x + (face > 0 ? r * 0.3 : -r * 1.3), y - r * 0.35, r, r * 0.18);
        break;
      case "beanie":
        ctx.beginPath();
        ctx.arc(x, y - r * 0.1, r * 1.0, Math.PI, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      case "tophat":
        ctx.fillRect(x - r * 0.6, y - r * 1.9, r * 1.2, r * 1.15);
        ctx.strokeRect(x - r * 0.6, y - r * 1.9, r * 1.2, r * 1.15);
        ctx.fillRect(x - r * 1.0, y - r * 0.85, r * 2.0, r * 0.2);
        ctx.strokeRect(x - r * 1.0, y - r * 0.85, r * 2.0, r * 0.2);
        break;
      case "party":
        ctx.beginPath();
        ctx.moveTo(x - r * 0.6, y - r * 0.75);
        ctx.lineTo(x, y - r * 2.0);
        ctx.lineTo(x + r * 0.6, y - r * 0.75);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      case "crown":
        ctx.fillStyle = sun;
        ctx.beginPath();
        ctx.moveTo(x - r * 0.7, y - r * 0.7);
        ctx.lineTo(x - r * 0.7, y - r * 1.45);
        ctx.lineTo(x - r * 0.35, y - r * 1.05);
        ctx.lineTo(x, y - r * 1.55);
        ctx.lineTo(x + r * 0.35, y - r * 1.05);
        ctx.lineTo(x + r * 0.7, y - r * 1.45);
        ctx.lineTo(x + r * 0.7, y - r * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      case "halo":
        ctx.strokeStyle = sun;
        ctx.lineWidth = lw * 1.6;
        ctx.beginPath();
        ctx.ellipse(x, y - r * 1.35, r * 0.75, r * 0.22, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
    }
  }

  // ---------- HUD ----------
  function rr(x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }
  function chip(x: number, y: number, w: number, h: number, fill: string, lw: number, sh: number) {
    ctx.fillStyle = ink;
    rr(x, y + sh, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = fill;
    rr(x, y, w, h, h / 2);
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  function hud(v: View, dt: number) {
    const k = big ? W / 1920 * 2.6 : u();
    const lw = big ? 3 * (W / 1920) : 2;
    const pad = 12 * k;
    const timerW = 54 * k;
    const barW = (W - pad * 2 - timerW - 16 * k) / 2;
    const barH = 14 * k;
    const top = (big ? 26 : 12) * k;
    for (const side of [0, 1] as const) {
      const f = v.f[side];
      const st = fs[side];
      const x0 = side === 0 ? pad : W - pad - barW;
      const nameY = top;
      // name row: head, callsign, bot tag, "you"
      const hr = 9 * k;
      const hx = side === 0 ? x0 + hr : x0 + barW - hr;
      head(hx, nameY + hr, hr, v.avatars[side], side === 0 ? 1 : -1, 0, Math.max(1.5, lw * 0.8));
      ctx.font = canvasFont("display", 700, 11 * k);
      ctx.textBaseline = "middle";
      ctx.textAlign = side === 0 ? "left" : "right";
      const tx = side === 0 ? x0 + hr * 2 + 6 * k : x0 + barW - hr * 2 - 6 * k;
      ctx.fillStyle = paper;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 3 * k * 0.9;
      ctx.lineJoin = "round";
      const tags: string[] = [];
      if (v.bots[side]) tags.push("bot");
      if (v.me === side) tags.push("you");
      // the callsign shortens with an ellipsis so it never runs into the timer
      ctx.font = canvasFont("mono", 700, 8.5 * k);
      const tagsW = tags.reduce((n, t) => n + ctx.measureText(t).width + 14 * k, 0);
      ctx.font = canvasFont("display", 700, 11 * k);
      const room = barW - hr * 2 - 6 * k - tagsW - 4 * k;
      let label = v.names[side];
      if (ctx.measureText(label).width > room) {
        while (label.length > 1 && ctx.measureText(label + "…").width > room) label = label.slice(0, -1);
        label += "…";
      }
      ctx.strokeText(label, tx, nameY + hr);
      ctx.fillText(label, tx, nameY + hr);
      const tw = ctx.measureText(label).width;
      let tagX = side === 0 ? tx + tw + 6 * k : tx - tw - 6 * k;
      for (const t of tags) {
        ctx.font = canvasFont("mono", 700, 8.5 * k);
        const w = ctx.measureText(t).width + 10 * k;
        const cx = side === 0 ? tagX : tagX - w;
        chip(cx, nameY + hr - 7 * k, w, 14 * k, t === "you" ? sun : ISLAND.white, Math.max(1, lw * 0.7), 2 * k * 0.7);
        ctx.fillStyle = ink;
        ctx.textAlign = "center";
        ctx.fillText(t, cx + w / 2, nameY + hr + 0.5 * k);
        ctx.textAlign = side === 0 ? "left" : "right";
        tagX = side === 0 ? tagX + w + 4 * k : tagX - w - 4 * k;
      }
      // health bar: paper track, coral trail (lost), tang health
      const by = nameY + hr * 2 + 6 * k;
      const hp = Math.max(0, f.hp);
      if (hp < st.lastHp) st.trailHold = 0.45;
      st.lastHp = hp;
      if (st.trailHold > 0) st.trailHold -= dt;
      else st.trail += (hp - st.trail) * Math.min(1, dt * 5);
      if (st.trail < hp) st.trail = hp;
      ctx.fillStyle = ink;
      rr(x0, by + 3 * k * 0.8, barW, barH, barH / 2);
      ctx.fill();
      ctx.fillStyle = paper;
      rr(x0, by, barW, barH, barH / 2);
      ctx.fill();
      const fillW = (n: number) => (barW * Math.max(0, Math.min(100, n))) / 100;
      ctx.save();
      rr(x0, by, barW, barH, barH / 2);
      ctx.clip();
      const tw2 = fillW(st.trail);
      const hw = fillW(hp);
      ctx.fillStyle = coral;
      if (side === 0) ctx.fillRect(x0, by, tw2, barH);
      else ctx.fillRect(x0 + barW - tw2, by, tw2, barH);
      ctx.fillStyle = hp <= 25 ? coral : tang;
      if (side === 0) ctx.fillRect(x0, by, hw, barH);
      else ctx.fillRect(x0 + barW - hw, by, hw, barH);
      ctx.fillStyle = "rgba(255,255,255,.45)";
      if (side === 0) ctx.fillRect(x0, by + barH * 0.15, hw, barH * 0.22);
      else ctx.fillRect(x0 + barW - hw, by + barH * 0.15, hw, barH * 0.22);
      ctx.restore();
      ctx.strokeStyle = ink;
      ctx.lineWidth = lw;
      rr(x0, by, barW, barH, barH / 2);
      ctx.stroke();
      ctx.font = canvasFont("mono", 800, 9 * k);
      ctx.fillStyle = ink;
      ctx.textAlign = side === 0 ? "right" : "left";
      ctx.fillText(String(Math.ceil(hp)), side === 0 ? x0 + barW - 6 * k : x0 + 6 * k, by + barH / 2 + 0.5 * k);
      // round dots: first to two
      for (let i = 0; i < 2; i++) {
        const dx = side === 0 ? x0 + 6 * k + i * 13 * k : x0 + barW - 6 * k - i * 13 * k;
        const dy = by + barH + 11 * k;
        ctx.beginPath();
        ctx.arc(dx, dy, 4.5 * k, 0, Math.PI * 2);
        ctx.fillStyle = i < f.rounds ? sun : paper;
        ctx.fill();
        ctx.lineWidth = Math.max(1.5, lw * 0.8);
        ctx.strokeStyle = ink;
        ctx.stroke();
      }
    }
    // timer chip
    const secs = Math.max(0, Math.ceil((ROUND_TICKS - v.roundTick) / 60));
    const tx = W / 2 - timerW / 2;
    const ty = top + 2 * k;
    chip(tx, ty, timerW, 30 * k, paper, lw, 3 * k * 0.8);
    ctx.font = canvasFont("mono", 800, 17 * k);
    ctx.fillStyle = secs <= 5 && !v.pause ? "#D12B52" : ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(v.pause > 0 && v.roundTick === 0 ? 30 : secs).padStart(2, "0"), W / 2, ty + 15 * k + 1);
    ctx.font = canvasFont("body", 600, 8 * k);
    ctx.fillStyle = muted;
    ctx.fillText(`Round ${v.round}`, W / 2, ty + 30 * k + 12 * k);

    // combo counters, on the attacker's side (the rules keep the count on the attacker)
    for (const side of [0, 1] as const) {
      const st = fs[side];
      const c = v.f[side].combo;
      if (c >= 2 && c !== st.comboShown) {
        st.comboShown = c;
        st.comboPop = 1;
        st.comboFade = 1.1;
      } else if (c < 2 && st.comboFade > 0) st.comboFade -= dt;
      if (c >= 2) st.comboFade = 1.1;
      st.comboPop = Math.max(0, st.comboPop - dt * 4);
      if (st.comboShown >= 2 && st.comboFade > 0) {
        const a = Math.min(1, st.comboFade * 2);
        const sz = (24 + st.comboPop * 10) * k;
        const x = side === 0 ? pad + 4 * k : W - pad - 4 * k;
        const y = top + 80 * k;
        ctx.globalAlpha = a;
        ctx.textAlign = side === 0 ? "left" : "right";
        ctx.font = canvasFont("display", 900, sz);
        ctx.lineWidth = 5 * k;
        ctx.strokeStyle = ink;
        ctx.fillStyle = sun;
        ctx.strokeText(String(st.comboShown), x, y);
        ctx.fillText(String(st.comboShown), x, y);
        const nw = ctx.measureText(String(st.comboShown)).width;
        ctx.font = canvasFont("display", 800, 11 * k);
        ctx.lineWidth = 3.5 * k;
        ctx.fillStyle = paper;
        const hx = side === 0 ? x + nw + 5 * k : x - nw - 5 * k;
        ctx.strokeText("hit combo", hx, y + 3 * k);
        ctx.fillText("hit combo", hx, y + 3 * k);
        ctx.globalAlpha = 1;
      }
    }
  }

  function banner(v: View, dt: number) {
    let text: string | null = null;
    let sub: string | null = null;
    if (v.round !== lastRound) {
      lastRound = v.round;
      bannerT = 0;
    }
    bannerT += dt;
    if (v.over) {
      text = v.winner === null ? "Draw" : `${v.names[v.winner]} wins`;
      sub = `${v.f[0].rounds} – ${v.f[1].rounds}`;
    } else if (v.pause > 0) {
      text = v.pause > 28 ? `Round ${v.round}` : "Fight";
      if (v.pause > 28 && v.round > 1) sub = `${v.f[0].rounds} – ${v.f[1].rounds}`;
    } else if (v.f[0].hp <= 0 || v.f[1].hp <= 0) text = "K.O.";
    if (!text) return;
    const k = big ? W / 1920 * 2.6 : u();
    const pop = opts.reduceMotion ? 1 : 1 + Math.max(0, 0.25 - bannerT) * 1.2;
    ctx.save();
    ctx.translate(W / 2, H * 0.42);
    ctx.scale(pop, pop);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = canvasFont("display", 900, (text.length > 10 ? 26 : 38) * k);
    ctx.lineJoin = "round";
    ctx.lineWidth = 8 * k;
    ctx.strokeStyle = ink;
    ctx.strokeText(text, 0, 4 * k);
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = text === "Fight" || text === "K.O." ? sun : paper;
    ctx.fillText(text, 0, 0);
    if (sub) {
      ctx.font = canvasFont("mono", 800, 16 * k);
      ctx.lineWidth = 5 * k;
      ctx.strokeText(sub, 0, 34 * k);
      ctx.fillStyle = paper;
      ctx.fillText(sub, 0, 34 * k);
    }
    ctx.restore();
  }

  function draw(v: View, now: number) {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    // hits inferred from hp drops or a fresh blockstun
    for (const side of [0, 1] as const) {
      const f = v.f[side];
      const st = fs[side];
      const kind = kindOf(f.act);
      const prevHp = st.j ? st.lastHp : f.hp;
      if (st.j && (f.hp < prevHp || (kind === "bstun" && st.lastKind !== "bstun"))) spawnHit(v, side, kind === "bstun");
      st.lastKind = kind;
    }
    // camera: centre on the pair, zoom to fit them with room for reach
    const mid = (v.f[0].x + v.f[1].x) / 2;
    const span = Math.abs(v.f[0].x - v.f[1].x);
    const wantW = Math.max(big ? 6400 : 5000, Math.min(11800, span + (big ? 4200 : 3400)));
    const k = 1 - Math.exp(-dt * 6);
    cam.w += (wantW - cam.w) * k;
    const half = cam.w / 2;
    const wantX = Math.max(STAGE_MIN - 600 + half, Math.min(STAGE_MAX + 600 - half, mid));
    cam.x += (wantX - cam.x) * k;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    shake = Math.max(0, shake - dt * 5);
    const sh = shake * 6 * u();
    ctx.save();
    if (sh > 0) ctx.translate(Math.sin(now * 0.09) * sh, Math.cos(now * 0.11) * sh * 0.6);
    stage(now);
    const order = v.me === 1 ? [0, 1] : [1, 0];
    for (const side of order as (0 | 1)[]) {
      const f = v.f[side];
      const st = fs[side];
      const target = poseOf(f, now);
      st.j = st.j ? mix(st.j, target, opts.reduceMotion ? 1 : 1 - Math.exp(-dt * 38)) : target;
      const kind = kindOf(f.act);
      fighter(f, st.j, v.avatars[side], kind === "hstun" || kind === "down" || f.hp <= 0 ? 1 : 0);
    }
    // sparks and hit bursts (world units)
    const s = scale();
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.life -= dt * 5;
      if (b.life <= 0) {
        bursts.splice(i, 1);
        continue;
      }
      const x = sx(b.x),
        y = sy(b.y),
        r = (b.blocked ? 160 : 260) * s * (1.4 - b.life * 0.6);
      ctx.fillStyle = b.color;
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(2, 22 * s);
      ctx.beginPath();
      for (let p = 0; p < 16; p++) {
        const a = (p / 16) * Math.PI * 2;
        const rad = p % 2 ? r * 0.45 : r;
        ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
      }
      ctx.closePath();
      ctx.globalAlpha = Math.min(1, b.life * 2);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.life -= dt / p.max;
      if (p.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
      p.vy -= 6 * dt * 60;
      ctx.fillStyle = p.color;
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(1, 14 * s);
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), p.size * s * p.life, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    if (opts.hud !== false) hud(v, dt);
    banner(v, dt);
  }

  return {
    draw,
    resize,
    big,
    hit: () => {
      /* hits are inferred from the state stream; kept for an exact dhit hook */
    },
  };
}
