"use client";
// Arena variant A, the pit. Chips are weighted iron, equity is height, the zone is a floor of molten slag.
import { useEffect, useRef } from "react";
import { Big_Shoulders } from "next/font/google";
import type { ArenaProps } from "./types";
import type { MatchState } from "@/lib/useMatch";
import { MARKETS, START_BALANCE, num, unitsToUsd } from "@/lib/events";
import type { EliminationReason, Market } from "@/lib/events";
import { C, H, W, chip, clamp, clockStr, ease, font, hash, initials, money, moneyStr, setFamily, slag, slagWave, tab } from "./a/draw";
import type { Wedges } from "./a/draw";

const face = Big_Shoulders({ subsets: ["latin"], display: "block", axes: ["opsz"] });

// Layout, in 1920x1080 design pixels.
const PIT_L = 230;
const PIT_R = 1540;
const PIT_T = 215;
const PIT_B = H;
const FEED_X = 1590;

type Chip = {
  id: string;
  callsign: string;
  bot: boolean;
  join: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  tilt: number;
  vt: number;
  eq: number; // displayed, rolls toward target
  teq: number;
  rank: number;
  tx: number;
  ty: number;
  pos: Wedges;
  lastFill: number;
};

type Dead = {
  id: string;
  callsign: string;
  bot: boolean;
  reason: EliminationReason;
  checkpoint: number | null;
  t: number;
  ox: number;
  oy: number;
  r: number;
  eq: number;
  rank: number;
  pos: Wedges;
};

type World = {
  chips: Map<string, Chip>;
  dead: Map<string, Dead>;
  lo: number;
  hi: number;
  lanes: number;
  cut: number;
  zone: number;
  pot: number;
  slagY: number;
  first: boolean;
  lastWall: number;
  fillsSeen: WeakSet<object>;
  finalAt: number | null;
  settledAt: number | null;
  press: Record<Market, number>;
};

const newWorld = (): World => ({
  chips: new Map(),
  dead: new Map(),
  lo: 9700,
  hi: 10300,
  lanes: 10,
  cut: 0,
  zone: 9800,
  pot: 0,
  slagY: H,
  first: true,
  lastWall: 0,
  fillsSeen: new WeakSet(),
  finalAt: null,
  settledAt: null,
  press: { BTC: 0, ETH: 0, SOL: 0 },
});

function chipR(lanes: number) {
  return clamp(((PIT_R - PIT_L) / Math.max(lanes, 1)) * 0.36, 15, 30);
}

function survivorsOf(n: number) {
  const s = n - Math.max(1, Math.floor(n / 4));
  return s < 3 ? Math.min(3, n) : s;
}

function zoneNow(s: MatchState, now: number) {
  const tk = s.tick;
  if (!tk) return 9800;
  const z = num(tk.zone);
  const p = s.prevTick;
  if (!p || tk.t <= p.t) return z;
  const slope = (z - num(p.zone)) / (tk.t - p.t);
  return z + slope * clamp(now - tk.t, 0, 0.25);
}

export default function VariantA({ match }: ArenaProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedRef = useRef(match.reducedMotion);
  reducedRef.current = match.reducedMotion;
  const matchRef = useRef(match);
  matchRef.current = match;

  useEffect(() => {
    const cv = canvasRef.current!;
    const ctx = cv.getContext("2d")!;
    setFamily(face.style.fontFamily);
    void document.fonts?.load(`700 40px ${face.style.fontFamily}`);
    const w = newWorld();
    let raf = 0;
    let scale = 1;
    let ox = 0;
    let oy = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const cw = window.innerWidth;
      const ch = window.innerHeight;
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
      cv.style.width = cw + "px";
      cv.style.height = ch + "px";
      scale = Math.min(cw / W, ch / H) * dpr;
      ox = (cv.width - W * scale) / 2;
      oy = (cv.height - H * scale) / 2;
    };
    resize();
    window.addEventListener("resize", resize);

    const frame = (wall: number) => {
      raf = requestAnimationFrame(frame);
      const m = matchRef.current;
      const s = m.ref.current;
      const now = m.clock();
      const rm = reducedRef.current;
      const dt = w.lastWall ? clamp((wall - w.lastWall) / 1000, 0, 0.05) : 0.016;
      w.lastWall = wall;
      const amb = wall / 1000; // ambient time, keeps the slag alive when the clock is frozen
      step(w, s, now, dt, rm);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = C.steelDeep;
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.setTransform(scale, 0, 0, scale, ox, oy);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.clip();
      draw(ctx, w, s, now, amb, rm);
      ctx.restore();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <main className={face.className} style={{ position: "fixed", inset: 0, background: C.steelDeep, overflow: "hidden" }}>
      <canvas ref={canvasRef} style={{ display: "block" }} aria-label="Trading Royale arena" />
      {/* Keeps the face in use so the browser loads it for the canvas. */}
      <span aria-hidden style={{ position: "absolute", opacity: 0, pointerEvents: "none", fontWeight: 800 }}>
        Pit 0123456789
      </span>
    </main>
  );
}

// ---------------------------------------------------------------- simulation

function yOf(w: World, v: number) {
  return PIT_T + 40 + ((w.hi - v) / (w.hi - w.lo)) * (PIT_B - PIT_T - 40);
}
function laneX(w: World, rank: number) {
  return PIT_L + ((rank - 0.5) / w.lanes) * (PIT_R - PIT_L);
}

function step(w: World, s: MatchState, now: number, dt: number, rm: boolean) {
  if (!s.status) return;
  const lobby = !s.board || s.status === "open" || s.status === "countdown";
  const final = s.final;
  const k = (rate: number) => (w.first ? 1 : 1 - Math.exp(-dt * rate));

  // Final and settled clocks: the events carry no time, so anchor them to when we first saw them.
  if (final && w.finalAt === null) w.finalAt = w.first ? (s.tick?.t ?? now) : now;
  if (s.settled && w.settledAt === null) w.settledAt = w.first ? -1e9 : now;

  // Price pressure: how hard each mark is moving right now.
  if (s.tick && s.prevTick) {
    for (const mk of MARKETS) {
      const p0 = num(s.prevTick.marks[mk]);
      const inst = p0 ? (num(s.tick.marks[mk]) - p0) / p0 / 0.0008 : 0;
      w.press[mk] += (inst - w.press[mk]) * k(3);
    }
  }

  const rows = s.board?.rows ?? [];
  const alive = lobby
    ? s.players.map((p, i) => ({ player: p.player, callsign: p.callsign, bot: p.bot, equity: "10000.00", rank: i + 1, alive: true }))
    : rows.filter((r) => r.alive);
  const lanesWas = w.lanes;

  // Deaths.
  for (const r of rows) {
    if (r.alive || lobby) continue;
    let d = w.dead.get(r.player);
    if (!d) {
      const c = w.chips.get(r.player);
      let ev = null as null | { t: number; checkpoint: number | null; reason: EliminationReason; rank: number };
      for (const e of s.eliminations) for (const p of e.players) if (p.player === r.player) ev = { t: e.t, checkpoint: e.checkpoint, reason: p.reason, rank: p.rank };
      d = {
        id: r.player,
        callsign: r.callsign,
        bot: r.bot,
        reason: ev?.reason ?? "cut",
        checkpoint: ev?.checkpoint ?? null,
        t: ev?.t ?? now,
        ox: c && !w.first ? c.x : NaN,
        oy: c && !w.first ? c.y : NaN,
        r: chipR(lanesWas),
        eq: num(r.equity),
        rank: ev?.rank ?? r.rank,
        pos: c?.pos ?? {},
      };
      w.dead.set(r.player, d);
      w.chips.delete(r.player);
    } else if (d.checkpoint === null && d.reason === "cut") {
      for (const e of s.eliminations) for (const p of e.players) if (p.player === d.id) Object.assign(d, { t: e.t, checkpoint: e.checkpoint, reason: p.reason });
    }
  }
  const dying = [...w.dead.values()].filter((d) => now - d.t < 2.6 && now >= d.t - 0.01);

  // Lanes: survivors hold their place while the cut falls, then spread out.
  const lanesTarget = lobby ? Math.max(alive.length, 12) : alive.length + dying.filter((d) => d.reason !== "liquidated").length;
  w.lanes += (lanesTarget - w.lanes) * (rm ? 1 : k(1.6));

  // Vertical scale.
  w.zone = zoneNow(s, now);
  const cutT = s.board ? num(s.board.cutEquity) : START_BALANCE;
  w.cut += (cutT - w.cut) * (w.cut === 0 ? 1 : k(6));
  let mx = -Infinity;
  let mn = Infinity;
  for (const r of alive) {
    const v = num(r.equity);
    mx = Math.max(mx, v);
    mn = Math.min(mn, v);
  }
  for (const d of dying) if (d.reason !== "liquidated") mn = Math.min(mn, d.eq);
  if (!Number.isFinite(mx)) {
    mx = START_BALANCE;
    mn = START_BALANCE;
  }
  mx = Math.max(mx, START_BALANCE, w.cut);
  mn = Math.min(mn, w.zone);
  const span = Math.max(mx - mn, 260);
  const hiT = lobby ? START_BALANCE + 330 : mx + span * 0.12;
  const loT = lobby ? 9800 - 190 : mn - span * 0.42;
  w.hi += (hiT - w.hi) * k(2.2);
  w.lo += (loT - w.lo) * k(2.2);

  const r0 = chipR(w.lanes);
  // Chips for everyone alive.
  alive.forEach((row, i) => {
    let c = w.chips.get(row.player);
    const rank = lobby ? i + 1 : row.rank;
    if (!c) {
      const join = s.players.findIndex((p) => p.player === row.player);
      c = {
        id: row.player,
        callsign: row.callsign,
        bot: row.bot,
        join: join < 0 ? i : join,
        x: laneX(w, rank),
        y: w.first || rm ? yOf(w, num(row.equity)) : PIT_T - 120 - hash(row.player) * 200,
        vx: 0,
        vy: 0,
        tilt: w.first || rm ? 0 : (hash(row.player, 3) - 0.5) * 1.4,
        vt: 0,
        eq: num(row.equity),
        teq: num(row.equity),
        rank,
        tx: 0,
        ty: 0,
        pos: {},
        lastFill: -1e9,
      };
      w.chips.set(row.player, c);
    }
    c.rank = rank;
    c.teq = num(row.equity);
    c.tx = laneX(w, rank);
    c.ty = yOf(w, c.teq) - (lobby ? r0 * 0.6 : 0);
  });

  // Track open positions from fills.
  for (const f of s.fills) {
    if (w.fillsSeen.has(f)) continue;
    w.fillsSeen.add(f);
    const c = w.chips.get(f.player);
    if (!c) continue;
    if (f.kind === "open") c.pos[f.market] = f.side;
    else delete c.pos[f.market];
    c.lastFill = Math.max(c.lastFill, f.t);
    if (!w.first && !rm) {
      c.vy -= 140;
      c.vt += (hash(f.player, f.t) - 0.5) * 3;
    }
  }

  // Final: finalists climb onto their payout stacks.
  if (final && w.finalAt !== null) {
    const order = podiumOrder(final.finalists.length);
    final.finalists.forEach((f, i) => {
      const c = w.chips.get(f.player);
      if (!c) return;
      const slot = order.indexOf(i);
      c.tx = podiumX(slot, final.finalists.length);
      c.ty = PODIUM_BASE - stackH(w, s, i, now) - 30;
      c.teq = num(f.equity);
    });
  }

  // Dead chips that were never seen alive get their origin from where they would have stood.
  for (const d of w.dead.values()) {
    if (Number.isNaN(d.ox)) {
      d.ox = laneX(w, Math.min(d.rank, Math.max(1, Math.floor(w.lanes)))) - (d.reason === "liquidated" ? (PIT_R - PIT_L) / w.lanes / 2 : 0);
      d.oy = d.reason === "liquidated" ? yOf(w, w.zone) - 40 : yOf(w, d.eq);
      d.r = r0;
    }
  }

  // Physics: springs toward targets, momentum, jostle.
  const list = [...w.chips.values()];
  for (const c of list) {
    c.eq += (c.teq - c.eq) * k(7);
    if (w.first || rm) {
      c.x = c.tx;
      c.y = c.ty;
      c.vx = c.vy = 0;
      c.tilt = 0;
      continue;
    }
    const K = 70;
    const D = 2 * Math.sqrt(K) * 0.62;
    c.vx += (K * (c.tx - c.x) - D * c.vx) * dt;
    c.vy += (K * (c.ty - c.y) - D * c.vy) * dt;
    c.vy += 0; // gravity is in the spring; weight shows in the tilt
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    const tt = clamp(c.vx * 0.0022 - c.vy * 0.0006, -0.7, 0.7);
    c.vt += (60 * (tt - c.tilt) - 9 * c.vt) * dt;
    c.tilt += c.vt * dt;
  }
  if (!rm && !w.first && !final) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dx = b.x - a.x;
        const dy = (b.y - a.y) * 1.15;
        const d2 = dx * dx + dy * dy;
        const min = r0 * 2.1;
        if (d2 < min * min && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const push = (min - d) * 0.5;
          const nx = dx / d;
          const ny = dy / d;
          a.x -= nx * push * 0.5;
          b.x += nx * push * 0.5;
          a.y -= ny * push * 0.5;
          b.y += ny * push * 0.5;
          a.vx -= nx * push * 3;
          b.vx += nx * push * 3;
          a.vt -= nx * 0.08;
          b.vt += nx * 0.08;
        }
      }
  }

  // Slag level.
  const slagT = final ? 1000 : lobby ? Math.min(yOf(w, w.zone), H - 70) : yOf(w, w.zone);
  w.slagY += (slagT - w.slagY) * (w.slagY === H ? 1 : k(4));
  w.pot += (Number(unitsToUsd(s.potUnits)) - w.pot) * k(5);
  w.first = false;
}

// ---------------------------------------------------------------- final podium

const PODIUM_BASE = 720;
function podiumOrder(n: number) {
  // index into finalists (sorted by equity) for each slot, left to right: 4 2 1 3 5
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) out.push(i);
    else out.unshift(i);
  }
  return out;
}
function podiumX(slot: number, n: number) {
  const gap = Math.min(250, (PIT_R - PIT_L - 120) / Math.max(n, 1));
  return (PIT_L + PIT_R) / 2 + (slot - (n - 1) / 2) * gap;
}
function payoutShare(s: MatchState, i: number) {
  const f = s.final!;
  const amounts = f.finalists.map((x) => {
    if (s.settled) {
      const j = s.settled.winners.indexOf(x.player);
      return j >= 0 ? Number(s.settled.amounts[j]) : 0;
    }
    return Number(x.provisionalPayoutUnits);
  });
  const max = Math.max(1, ...amounts);
  return amounts[i] / max;
}
function streamProgress(w: World, now: number, rm: boolean) {
  if (w.finalAt === null) return 0;
  const u = now - w.finalAt;
  return rm ? clamp((u - 1) / 1.5, 0, 1) : clamp((u - 1.2) / 3.4, 0, 1);
}
function stackH(w: World, s: MatchState, i: number, now: number) {
  return 30 + 330 * payoutShare(s, i) * ease(streamProgress(w, now, false));
}

// ---------------------------------------------------------------- drawing

function draw(ctx: CanvasRenderingContext2D, w: World, s: MatchState, now: number, amb: number, rm: boolean) {
  ctx.fillStyle = C.steel;
  ctx.fillRect(0, 0, W, H);
  if (!s.status) {
    font(ctx, 40, 700);
    ctx.fillStyle = C.chalk;
    ctx.textAlign = "center";
    ctx.fillText("Waiting for the engine", W / 2, H / 2);
    return;
  }
  const lobby = !s.board || s.status === "open" || s.status === "countdown";
  const final = s.final;
  const lastCp = [...s.eliminations].reverse().find((e) => e.checkpoint !== null);
  const cpU = lastCp ? now - lastCp.t : 99;
  const secsToCp = s.tick?.nextCheckpoint ? s.tick.nextCheckpoint.at - now : 99;
  const heat = !lobby && !final && secsToCp <= 10 && secsToCp > 0 ? 1 - secsToCp / 10 : 0;
  const surge = rm ? 0 : cpU >= 0 && cpU < 2.2 ? Math.sin(Math.min(1, cpU / 0.35) * Math.PI * 0.5) * Math.exp(-cpU * 1.4) * 70 : 0;

  // shake from a cut or a liquidation
  const lastLiq = [...s.eliminations].reverse().find((e) => e.checkpoint === null);
  const liqU = lastLiq ? now - lastLiq.t : 99;
  if (!rm) {
    const sh = (cpU >= 0 && cpU < 0.6 ? (0.6 - cpU) * 14 : 0) + (liqU >= 0 && liqU < 0.4 ? (0.4 - liqU) * 10 : 0);
    if (sh > 0) ctx.translate(Math.sin(amb * 90) * sh, Math.cos(amb * 77) * sh * 0.6);
  }

  drawFloor(ctx, w, lobby, !!final);

  const sy = w.slagY - surge;
  const calm = rm;

  // cut line and the block above the slag
  if (!lobby && !final && s.board) {
    const cy = yOf(w, w.cut);
    if (cy < sy) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(PIT_L - 20, cy, PIT_R - PIT_L + 40, sy - cy);
      ctx.clip();
      ctx.strokeStyle = "rgba(237,232,218,0.07)";
      ctx.lineWidth = 3;
      for (let x = PIT_L - 400; x < PIT_R + 40; x += 22) {
        ctx.beginPath();
        ctx.moveTo(x, sy);
        ctx.lineTo(x + (sy - cy), cy);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // chips sunk below the surface are drawn after the slag so they stay readable
  const chips = [...w.chips.values()].sort((a, b) => a.y - b.y);
  const r0 = chipR(w.lanes);
  const nAlive = chips.length;
  const surv = survivorsOf(nAlive);

  slag(ctx, sy, amb * (1 + heat * 1.5), heat, calm, PIT_L - 24, PIT_R + 24);

  // events are cast into the slag itself, in crust
  const castX = (PIT_L + PIT_R) / 2;
  const castY = H - 60;
  let castRect: Rect | null = null;
  const reserve = (size: number) => (castRect = { x: castX - 560, y: castY - size * 1.3, w: 1120, h: size * 1.3 });
  if (lastCp && cpU >= 0 && cpU < 3.4) {
    const a = clamp(Math.min((cpU - 0.1) / 0.2, (3.4 - cpU) / 0.6), 0, 1);
    const rise = rm ? 0 : (1 - ease(cpU / 0.6)) * 120;
    reserve(230);
    cast(ctx, `${lastCp.players.length} cut`, `Checkpoint ${lastCp.checkpoint} of 3`, castX, castY + rise, a, 230);
  } else if (lastLiq && liqU >= 0 && liqU < 2.6) {
    const a = clamp(Math.min(liqU / 0.15, (2.6 - liqU) / 0.5), 0, 1);
    reserve(170);
    cast(ctx, lastLiq.players[0]?.callsign ?? "", "Liquidated, equity hit zero", castX, castY, a, 170);
  } else if (!lobby && !final && s.warning && secsToCp > 0 && secsToCp <= 10.05) {
    const n = Math.ceil(secsToCp);
    const frac = n - secsToCp;
    const bob = rm ? 0 : Math.exp(-frac * 8) * 40;
    reserve(260);
    cast(ctx, String(n), `Checkpoint ${s.warning.checkpoint}: the bottom ${Math.max(1, Math.floor(nAlive / 4))} go under`, castX, castY + bob, 1, 260);
  }

  if (!lobby && !final && s.board) drawCutLine(ctx, w);

  // dead chips: shatter, or drop whole when liquidated

  // the living
  for (const c of chips) {
    const block = !lobby && !final && c.rank > surv;
    const under = c.y > sy + slagWave(c.x, amb, calm);
    const tremble = block && !rm ? Math.sin(amb * 40 + c.join) * (1.2 + heat * 2.5) : 0;
    const rim = final || lobby ? C.chalk : c.eq >= START_BALANCE ? C.profit : C.loss;
    if (under) {
      ctx.save();
      ctx.shadowColor = C.slagHot;
      ctx.shadowBlur = 24;
    }
    const fu = now - c.lastFill;
    if (fu >= 0 && fu < 0.7 && !final) {
      const side = c.pos.BTC ?? c.pos.ETH ?? c.pos.SOL;
      ctx.strokeStyle = side === -1 ? C.short : C.long;
      ctx.globalAlpha = 1 - fu / 0.7;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, r0 * (1.1 + fu * 1.4), r0 * 0.9 * (1.1 + fu * 1.4), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    chip(ctx, c.x + tremble, c.y, final ? 30 : r0, c.tilt, rim, initials(c.callsign), final ? {} : c.pos);
    if (under) ctx.restore();
    if (block) {
      ctx.setLineDash([7, 6]);
      ctx.strokeStyle = C.chalk;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(c.x + tremble, c.y, r0 * 1.32, r0 * 1.16, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  if (!final) {
    // labels after every chip, highest equity first, so leaders get the clean spots
    const taken: Rect[] = [];
    if (castRect) taken.push(castRect);
    if (!lobby) taken.push({ x: PIT_R - 280, y: yOf(w, w.cut) - 40, w: 300, h: 38 });
    const bodies = chips.map((c) => ({ x: c.x - r0, y: c.y - r0, w: 2 * r0, h: 2 * r0 }));
    for (const c of [...chips].sort((a, b) => a.rank - b.rank)) drawLabel(ctx, c, r0, lobby, sy, taken, bodies.filter((b) => Math.abs(b.x + r0 - c.x) > 1 || Math.abs(b.y + r0 - c.y) > 1));
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(PIT_L - 24, 0, PIT_R - PIT_L + 48, H);
  ctx.clip();
  for (const d of w.dead.values()) drawDead(ctx, w, d, now, sy, rm);
  ctx.restore();

  if (final && w.finalAt !== null) drawPodium(ctx, w, s, now, rm);

  drawHud(ctx, w, s, now, lobby, rm, sy);
  drawFeed(ctx, s, now, rm);
  if (lastCp && cpU >= 0 && cpU < 0.5) {
    ctx.fillStyle = `rgba(255,246,232,${(rm ? 0.25 : 0.7) * (1 - cpU / 0.5)})`;
    ctx.fillRect(-40, -40, W + 80, H + 80);
  }

}

function cast(ctx: CanvasRenderingContext2D, big: string, small: string, x: number, y: number, a: number, size: number) {
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = "center";
  ctx.fillStyle = C.crust;
  font(ctx, size, 900);
  const bw = ctx.measureText(big).width;
  if (bw > 1100) {
    size = Math.floor((size * 1100) / bw);
    font(ctx, size, 900);
  }
  ctx.fillText(big, x, y);
  ctx.strokeStyle = "rgba(255,190,110,0.55)";
  ctx.lineWidth = 2;
  ctx.strokeText(big, x, y);
  font(ctx, 40, 800);
  ctx.fillText(small, x, y - size * 0.9);
  ctx.restore();
}

function drawFloor(ctx: CanvasRenderingContext2D, w: World, lobby: boolean, final: boolean) {
  // pit walls: two iron rails with rivets
  ctx.fillStyle = "#33414D";
  ctx.fillRect(PIT_L - 34, PIT_T, 10, H - PIT_T);
  ctx.fillRect(PIT_R + 24, PIT_T, 10, H - PIT_T);
  ctx.fillStyle = C.steelDeep;
  for (let y = PIT_T + 20; y < H; y += 48) {
    ctx.beginPath();
    ctx.arc(PIT_L - 29, y, 2.5, 0, Math.PI * 2);
    ctx.arc(PIT_R + 29, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (final) return;
  // equity ruler, chalked on the left wall
  const span = w.hi - w.lo;
  const steps = [10, 25, 50, 100, 250, 500, 1000, 2500];
  const st = steps.find((x) => span / x <= 9) ?? 5000;
  font(ctx, 22, 600);
  ctx.textBaseline = "middle";
  for (let v = Math.ceil(w.lo / st) * st; v <= w.hi; v += st) {
    const y = yOf(w, v);
    if (y < PIT_T + 10 || y > H - 10) continue;
    if (Math.abs(y - (w.slagY - 17)) < 40) continue;
    const start = v === START_BALANCE;
    ctx.fillStyle = start ? "rgba(237,232,218,0.85)" : "rgba(237,232,218,0.45)";
    tab(ctx, money(v, 0), PIT_L - 48, y, "right");
    ctx.strokeStyle = start ? "rgba(237,232,218,0.22)" : "rgba(237,232,218,0.06)";
    ctx.lineWidth = start ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(PIT_L - 20, y);
    ctx.lineTo(PIT_R + 20, y);
    ctx.stroke();
    if (start) {
      font(ctx, 18, 600);
      ctx.fillStyle = "rgba(237,232,218,0.6)";
      ctx.fillText("start", PIT_L - 48 - 92, y);
      font(ctx, 22, 600);
    }
  }
  if (lobby) {
    // the ledge everyone starts on
    const y = yOf(w, START_BALANCE);
    ctx.fillStyle = "#3D4C5A";
    ctx.fillRect(PIT_L - 20, y, PIT_R - PIT_L + 40, 12);
    ctx.fillStyle = C.steelDeep;
    ctx.fillRect(PIT_L - 20, y + 12, PIT_R - PIT_L + 40, 4);
  }
  ctx.textBaseline = "alphabetic";
}

function drawCutLine(ctx: CanvasRenderingContext2D, w: World) {
  const y = yOf(w, w.cut);
  ctx.strokeStyle = C.chalk;
  ctx.lineWidth = 3;
  ctx.setLineDash([18, 10]);
  ctx.beginPath();
  ctx.moveTo(PIT_L - 20, y);
  ctx.lineTo(PIT_R + 20, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = C.chalk;
  ctx.textBaseline = "bottom";
  font(ctx, 26, 800);
  const vw = tab(ctx, money(w.cut), PIT_R + 20, y - 6, "right");
  ctx.textAlign = "right";
  font(ctx, 22, 600);
  ctx.fillText("cut line", PIT_R + 20 - vw - 10, y - 8);
  ctx.textBaseline = "alphabetic";
}

type Rect = { x: number; y: number; w: number; h: number };
const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function drawLabel(ctx: CanvasRenderingContext2D, c: Chip, r: number, lobby: boolean, sy: number, taken: Rect[], chipsAt: Rect[]) {
  font(ctx, 22, 800);
  const name = c.callsign;
  const nw = ctx.measureText(name).width;
  const botW = c.bot ? 40 : 0;
  font(ctx, 20, 700);
  const ew = lobby ? 0 : ctx.measureText(money(c.eq)).width + 6;
  const tw = Math.max(nw + botW, ew);
  const th = lobby ? 26 : 48;
  const cands = [c.y + r * 0.9 + 8, c.y - r - th - 4, c.y + r * 0.9 + 8 + th, c.y - r - 2 * th - 4, c.y + r * 0.9 + 8 + 2 * th];
  let top = cands[0];
  for (const cy of cands) {
    const rr = { x: c.x - tw / 2 - 4, y: cy, w: tw + 8, h: th };
    if (!taken.some((t) => hit(t, rr)) && !chipsAt.some((t) => hit(t, rr))) {
      top = cy;
      break;
    }
  }
  taken.push({ x: c.x - tw / 2 - 4, y: top, w: tw + 8, h: th });
  const y0 = top + 20;
  const lx = c.x - (nw + botW) / 2;
  if (c.y > sy || top > sy - th) {
    ctx.fillStyle = "rgba(28,37,45,0.85)";
    ctx.fillRect(c.x - tw / 2 - 6, top - 2, tw + 12, th + 4);
  }
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  font(ctx, 22, 800);
  ctx.fillStyle = C.chalk;
  ctx.fillText(name, lx, y0);
  if (c.bot) {
    ctx.strokeStyle = "rgba(237,232,218,0.7)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(lx + nw + 6, y0 - 15, 31, 17);
    font(ctx, 13, 800);
    ctx.fillStyle = "rgba(237,232,218,0.85)";
    ctx.fillText("BOT", lx + nw + 10, y0 - 1.5);
  }
  if (!lobby) {
    font(ctx, 20, 700);
    ctx.fillStyle = c.eq >= START_BALANCE ? C.profit : C.loss;
    tab(ctx, money(c.eq), c.x, y0 + 22, "center");
  }
}

function drawDead(ctx: CanvasRenderingContext2D, w: World, d: Dead, now: number, sy: number, rm: boolean) {
  const u = now - d.t;
  if (u < 0 || u > 3.2) return;
  const r = d.r;
  if (rm) {
    chip(ctx, d.ox, d.oy, r, 0, d.reason === "liquidated" ? C.loss : C.chalk, initials(d.callsign), {}, { alpha: clamp(1 - u / 1.4, 0, 1) });
    return;
  }
  const G = 1500;
  if (d.reason === "liquidated") {
    // the chip hops, goes over, and sinks slowly into the slag, glowing
    const th = hitTime(d.oy, -260, G, sy) ?? 0;
    const air = Math.min(u, th);
    let y = d.oy - 260 * air + 0.5 * G * air * air;
    const x = d.ox + 60 * air;
    const sunk = Math.max(0, u - th);
    y += sunk * 45;
    const a = clamp(1 - sunk / 2.2, 0, 1);
    if (a > 0) {
      ctx.save();
      ctx.shadowColor = C.slagHot;
      ctx.shadowBlur = sunk > 0 ? 36 : 0;
      chip(ctx, x, y, r * 1.15, air * 7 + sunk * 0.6, C.loss, initials(d.callsign), {}, { alpha: a, white: u < 0.15 ? 1 - u / 0.15 : 0 });
      ctx.restore();
      if (sunk > 0) {
        // the slag closes over it from below
        ctx.save();
        ctx.globalAlpha = clamp(sunk / 1.6, 0, 0.85);
        ctx.fillStyle = C.slag;
        ctx.beginPath();
        ctx.ellipse(x, y + r * 0.4, r * 1.3, r * 0.9, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    splash(ctx, d.ox + 60 * th, sy, u - th, d.id);
    return;
  }
  // cut or zone: heat-cracks, then the chip breaks into shards that sink
  if (u < 0.3) {
    const sh = Math.sin(u * 120) * 3;
    chip(ctx, d.ox + sh, d.oy, r, 0, C.loss, initials(d.callsign), d.pos, { white: u / 0.3 });
    ctx.strokeStyle = C.steelDeep;
    ctx.lineWidth = 2;
    for (let k = 0; k < 5; k++) {
      const a = hash(d.id, k) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(d.ox, d.oy);
      ctx.lineTo(d.ox + Math.cos(a) * r * (u / 0.3), d.oy + Math.sin(a) * r * 0.86 * (u / 0.3));
      ctx.stroke();
    }
    return;
  }
  const v = u - 0.3;
  const N = 7;
  const R = r * 1.35;
  const cuts: number[] = [];
  for (let k = 0; k < N; k++) cuts.push(((k + 0.2 + hash(d.id, k + 10) * 0.6) / N) * Math.PI * 2);
  const wading = d.oy > sy - 10;
  for (let k = 0; k < N; k++) {
    const a0 = cuts[k];
    const a1 = cuts[(k + 1) % N] + (k === N - 1 ? Math.PI * 2 : 0);
    const mid = (a0 + a1) / 2;
    const sp = 120 + hash(d.id, k + 30) * 220;
    const vx = Math.cos(mid) * sp;
    const vy0 = -260 - hash(d.id, k + 40) * 300;
    const g = wading ? 900 : G;
    const x = d.ox + vx * v;
    const y = d.oy + vy0 * v + 0.5 * g * v * v;
    const rot = (hash(d.id, k + 50) - 0.5) * 12 * v;
    const fall = clamp((y - d.oy) / 260, 0, 1);
    const cool = clamp((v - 0.35) / 1.2, 0, 1);
    const a = clamp(1 - fall, 0, 1) * clamp(2.2 - v, 0, 1);
    if (a <= 0) continue;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.translate(-Math.cos(mid) * R * 0.4, -Math.sin(mid) * R * 0.4);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.ellipse(0, 0, R, R * 0.86, 0, a0, a1);
    ctx.closePath();
    ctx.fillStyle = mixHot(0.25 + cool * 0.75);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = cool < 0.4 ? "#FFF6E8" : C.slagHot;
    ctx.stroke();
    ctx.restore();
  }
  const th = wading ? 0.02 : hitTime(d.oy, -260, G, sy);
  if (th !== null) splash(ctx, d.ox, wading ? Math.min(d.oy, H - 20) : sy, v - th, d.id);
}

function mixHot(h: number) {
  // white-hot iron cooling to slag crust as it sinks
  const a = [70, 87, 106];
  const b = [59, 28, 18];
  const m = a.map((x, i) => Math.round(x + (b[i] - x) * h));
  return `rgb(${m[0]},${m[1]},${m[2]})`;
}

function hitTime(y0: number, v0: number, g: number, surf: number): number | null {
  const c = y0 - surf;
  const disc = v0 * v0 - 2 * g * c;
  if (disc < 0) return null;
  return (-v0 + Math.sqrt(disc)) / g;
}

function splash(ctx: CanvasRenderingContext2D, x: number, y: number, u: number, id: string) {
  if (u < 0 || u > 1.2) return;
  // droplets of slag thrown up, part of the zone
  for (let i = 0; i < 12; i++) {
    const ang = -Math.PI / 2 + (hash(id, i + 70) - 0.5) * 2.2;
    const sp = 220 + hash(id, i + 80) * 380;
    const px = x + Math.cos(ang) * sp * u;
    const py = y + Math.sin(ang) * sp * u + 0.5 * 1500 * u * u;
    if (py > y + 10) continue;
    ctx.fillStyle = i % 3 ? C.slag : C.slagHot;
    ctx.beginPath();
    ctx.arc(px, py, 3 + hash(id, i + 90) * 5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (u < 0.6) {
    ctx.strokeStyle = `rgba(255,190,110,${1 - u / 0.6})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(x, y, 16 + u * 70, 4 + u * 12, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawPodium(ctx: CanvasRenderingContext2D, w: World, s: MatchState, now: number, rm: boolean) {
  const f = s.final!;
  const n = f.finalists.length;
  const order = podiumOrder(n);
  const prog = streamProgress(w, now, rm);
  const u = now - (w.finalAt ?? now);
  const potX = 120;
  const potY = 120;
  // the pot pours out over the survivors
  if (!rm && prog > 0 && prog < 1) {
    for (let j = 0; j < 90; j++) {
      const start = 1.2 + (j / 90) * 3.0;
      const fl = (u - start) / 0.8;
      if (fl < 0 || fl > 1) continue;
      const i = j % n;
      const tx = podiumX(order.indexOf(i), n);
      const ty = PODIUM_BASE - stackH(w, s, i, now) - 10;
      const mx = (potX + tx) / 2;
      const my = Math.min(potY, ty) - 220;
      const t = ease(fl);
      const x = (1 - t) * (1 - t) * potX + 2 * (1 - t) * t * mx + t * t * tx;
      const y = (1 - t) * (1 - t) * potY + 2 * (1 - t) * t * my + t * t * ty;
      ctx.fillStyle = C.chalk;
      ctx.strokeStyle = C.steelDeep;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(x, y, 9, 4, t * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  f.finalists.forEach((fi, i) => {
    const slot = order.indexOf(i);
    const x = podiumX(slot, n);
    const h = stackH(w, s, i, now);
    // the stack of paid coins
    const coins = Math.max(1, Math.floor(h / 9));
    for (let k = 0; k < coins; k++) {
      const y = PODIUM_BASE - k * 9;
      ctx.fillStyle = C.steelDeep;
      ctx.beginPath();
      ctx.ellipse(x + Math.sin(k * 1.7 + i) * 2, y + 4, 56, 15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = k % 2 ? "#D9D3C3" : C.chalk;
      ctx.beginPath();
      ctx.ellipse(x + Math.sin(k * 1.7 + i) * 2, y, 56, 15, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // labels on the plinth
    ctx.textAlign = "center";
    ctx.fillStyle = C.chalk;
    font(ctx, 36, 900);
    ctx.fillText(fi.callsign, x, PODIUM_BASE + 64);
    font(ctx, 24, 700);
    const eq = num(fi.equity);
    ctx.fillStyle = eq >= START_BALANCE ? C.profit : C.loss;
    tab(ctx, money(eq), x, PODIUM_BASE + 96, "center");
    const j = s.settled ? s.settled.winners.indexOf(fi.player) : -1;
    const units = s.settled ? (j >= 0 ? s.settled.amounts[j] : "0") : fi.provisionalPayoutUnits;
    ctx.fillStyle = C.chalk;
    font(ctx, 44, 900);
    tab(ctx, moneyStr(unitsToUsd(units)), x, PODIUM_BASE + 148, "center");
    font(ctx, 20, 600);
    ctx.fillStyle = "rgba(237,232,218,0.7)";
    ctx.fillText(s.settled ? "USDC paid" : "USDC provisional", x, PODIUM_BASE + 174);
    if (slot === Math.floor((n - 1) / 2) && i === 0) {
      font(ctx, 22, 800);
      ctx.fillStyle = C.chalk;
      ctx.fillText("top of the pit", x, PODIUM_BASE - h - 80);
    }
  });
  // the stamp
  if (s.settled && w.settledAt !== null) {
    const su = now - w.settledAt;
    const k = rm ? clamp(su / 0.6, 0, 1) : clamp(su / 0.25, 0, 1);
    const sc = rm ? 1 : 1 + 1.4 * (1 - ease(k));
    ctx.save();
    ctx.globalAlpha = rm ? k : Math.min(1, k * 2);
    ctx.translate(1700, 560);
    ctx.rotate(-0.09);
    ctx.scale(sc, sc);
    ctx.strokeStyle = "#7C9BFF";
    ctx.fillStyle = "#7C9BFF";
    ctx.lineWidth = 6;
    ctx.strokeRect(-200, -78, 400, 156);
    ctx.lineWidth = 2;
    ctx.strokeRect(-188, -66, 376, 132);
    ctx.textAlign = "center";
    font(ctx, 42, 900);
    ctx.fillText("Verified by Chainlink", 0, -12);
    font(ctx, 24, 700);
    const tx = s.settled.txHash;
    tab(ctx, `tx ${tx.slice(0, 6)}…${tx.slice(-4)}`, 0, 24, "center");
    font(ctx, 18, 600);
    ctx.fillText(s.settled.mode === "simulated" ? "settled from a simulated CRE report" : "settled by the CRE workflow", 0, 52);
    ctx.restore();
  }
}

function drawHud(ctx: CanvasRenderingContext2D, w: World, s: MatchState, now: number, lobby: boolean, rm: boolean, sy: number) {
  ctx.textBaseline = "alphabetic";
  // pot, top left
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(237,232,218,0.7)";
  font(ctx, 26, 700);
  ctx.fillText(s.final && streamProgress(w, now, rm) >= 1 ? "Left in the pot, the 5% fee" : "Pot", 48, 70);
  ctx.fillStyle = C.chalk;
  font(ctx, 84, 900);
  let potShown = w.pot;
  if (s.final) {
    let paid = 0;
    for (const f of s.final.finalists) paid += Number(unitsToUsd(f.provisionalPayoutUnits));
    potShown = w.pot - paid * ease(streamProgress(w, now, rm));
  }
  const pw = tab(ctx, money(Math.max(0, potShown)), 48, 150);
  font(ctx, 28, 700);
  ctx.fillText("USDC", 60 + pw, 150);

  // clock, centre
  const cx = (PIT_L + PIT_R) / 2;
  ctx.textAlign = "center";
  ctx.fillStyle = C.chalk;
  if (lobby) {
    if (s.status === "countdown") {
      font(ctx, 30, 700);
      ctx.fillText("Starting in", cx, 62);
      font(ctx, 110, 900);
      tab(ctx, String(Math.max(0, Math.ceil(-now))), cx, 160, "center");
    } else {
      font(ctx, 30, 700);
      ctx.fillText("Players dropping in", cx, 62);
      font(ctx, 110, 900);
      tab(ctx, String(s.players.length), cx, 160, "center");
    }
    font(ctx, 34, 800);
    ctx.fillStyle = C.crust;
    ctx.fillText("Two minutes. At 0:30, 1:00 and 1:30 the bottom quarter goes under.", cx, Math.max(sy + 120, H - 70));
  } else if (s.final) {
    font(ctx, 30, 700);
    ctx.fillText(s.settled ? "Paid out" : "Match over", cx, 62);
    font(ctx, 110, 900);
    ctx.fillText(`${s.final.finalists.length} survived`, cx, 160);
  } else {
    const left = 120 - now;
    const nc = s.tick?.nextCheckpoint;
    font(ctx, 30, 700);
    ctx.fillText(nc ? `Checkpoint ${nc.index} in ${clockStr(nc.at - now)}` : "Final in", cx, 62);
    font(ctx, 110, 900);
    tab(ctx, clockStr(left), cx, 160, "center");
  }

  // zone level, chalked in the slag colour at the surface on the left wall
  if (!s.final) {
    const y = clamp(sy, PIT_T + 40, H - 40);
    ctx.textAlign = "right";
    ctx.fillStyle = C.slag;
    font(ctx, 22, 700);
    ctx.fillText("Zone", PIT_L - 48, y - 30);
    font(ctx, 26, 800);
    tab(ctx, money(w.zone), PIT_L - 48, y - 4, "right");
  }

  // pressure dials for the three marks, top right
  const tk = s.final?.marks ?? s.tick?.marks;
  MARKETS.forEach((mk, i) => {
    const x = 1500 + i * 140;
    const y = 112;
    const chg = w.press[mk];
    const ang = -Math.PI / 2 + clamp(chg, -1, 1) * 1.2;
    ctx.strokeStyle = "rgba(237,232,218,0.5)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 50, Math.PI * 1.1, Math.PI * 1.9);
    ctx.stroke();
    for (let k = 0; k <= 6; k++) {
      const a = Math.PI * 1.1 + (k / 6) * Math.PI * 0.8;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * 50, y + Math.sin(a) * 50);
      ctx.lineTo(x + Math.cos(a) * (k === 3 ? 38 : 43), y + Math.sin(a) * (k === 3 ? 38 : 43));
      ctx.stroke();
    }
    ctx.strokeStyle = C.chalk;
    ctx.lineWidth = 4;
    const wob = rm ? 0 : Math.sin(now * 13 + i) * 0.02;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang + wob) * 46, y + Math.sin(ang + wob) * 46);
    ctx.stroke();
    ctx.fillStyle = C.chalk;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = "center";
    font(ctx, 24, 800);
    ctx.fillText(mk, x, y + 30);
    font(ctx, 26, 700);
    if (tk) tab(ctx, moneyStr(tk[mk]), x, y + 60, "center");
    else {
      font(ctx, 20, 600);
      ctx.fillStyle = "rgba(237,232,218,0.55)";
      ctx.fillText("price at start", x, y + 58);
    }
  });
}

function drawFeed(ctx: CanvasRenderingContext2D, s: MatchState, now: number, rm: boolean) {
  if (!s.eliminations.length || s.final) return;
  const x = FEED_X;
  const xr = W - 36;
  let y = 250;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(237,232,218,0.7)";
  font(ctx, 26, 700);
  ctx.fillText("Gone under", x, y);
  y += 12;
  const bot = new Map(s.players.map((p) => [p.player, p.bot]));
  for (const e of [...s.eliminations].reverse()) {
    if (now < e.t || y > H - 40) continue;
    y += 40;
    ctx.globalAlpha = 1;
    font(ctx, 20, 600);
    ctx.fillStyle = "rgba(237,232,218,0.6)";
    ctx.textAlign = "left";
    ctx.fillText(e.checkpoint ? `Checkpoint ${e.checkpoint}` : `Liquidation at ${clockStr(e.t)}`, x, y);
    ctx.fillStyle = "rgba(237,232,218,0.2)";
    ctx.fillRect(x, y + 8, xr - x, 2);
    y += 4;
    e.players.forEach((p, i) => {
      const u = now - e.t - 0.15 - i * 0.06;
      if (u < 0 || y > H - 30) return;
      y += 34;
      const a = rm ? clamp(u / 0.4, 0, 1) : clamp(u / 0.1, 0, 1);
      const dx = rm ? 0 : (1 - ease(u / 0.35)) * 120;
      ctx.globalAlpha = a;
      ctx.textAlign = "left";
      ctx.fillStyle = C.chalk;
      font(ctx, 27, 800);
      ctx.fillText(p.callsign, x + dx, y);
      const cw = ctx.measureText(p.callsign).width;
      if (bot.get(p.player)) {
        ctx.strokeStyle = "rgba(237,232,218,0.6)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + dx + cw + 8, y - 17, 31, 17);
        font(ctx, 13, 800);
        ctx.fillText("BOT", x + dx + cw + 12, y - 3.5);
      }
      font(ctx, 20, 700);
      ctx.textAlign = "right";
      ctx.fillStyle = p.reason === "liquidated" ? C.loss : p.reason === "zone" ? C.slag : "rgba(237,232,218,0.8)";
      ctx.fillText(p.reason === "zone" ? "zone" : p.reason, xr + dx, y);
    });
    y += 6;
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}
