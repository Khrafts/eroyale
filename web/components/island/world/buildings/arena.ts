// The Arena (Trading Royale): colonnade, awning, gate, candle bars in the pit, a price ticker ring, a beam that
// flares at every checkpoint cut, and spotlights while a lobby is live.
import * as THREE from "three";
import { C, Box, Cyl } from "../materials";
import { LAYOUT, place, type Ctx } from "../common";
import { MARKETS, type Market } from "@/lib/events";
import { commas } from "@/lib/predict";
import type { IslandSnap } from "@/lib/island/store";

function change(s: IslandSnap, m: Market): number | null {
  const a = s.marks?.[m];
  const b = s.marksRef?.[m];
  if (!a || !b || Number(b) === 0) return null;
  return ((Number(a) - Number(b)) / Number(b)) * 100;
}

export function buildArena(ctx: Ctx, snap0: IslandSnap) {
  const { P, toon, cTex } = ctx.kit;
  const R = ctx.R;
  let snap = snap0;
  const arena = new THREE.Group();
  P(arena, Cyl(11, 11.6, 1.2, 48), "#FFF1DE", [0, 0.6, 0], [0, 0, 0], { ol: 0.1 });
  P(arena, Cyl(8.4, 8.4, 0.2, 48), "#FFC3B4", [0, 1.25, 0], [0, 0, 0], { ol: false });
  P(arena, Cyl(9.2, 9.6, 5, 48, 1, true), toon("#FFE6D2", { side: THREE.DoubleSide }), [0, 3.7, 0], [0, 0, 0], { ol: 0.08 });
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2;
    if (Math.abs(Math.sin(a / 2 - Math.PI / 4)) < 0.02) continue;
    P(arena, Box(0.9, 6.2, 0.9), "#FFFAF2", [10.25 * Math.cos(a), 4.3, 10.25 * Math.sin(a)], [0, -a, 0], { ol: 0.06 });
  }
  P(arena, new THREE.TorusGeometry(10.25, 0.5, 10, 72), C.coral, [0, 7.5, 0], [Math.PI / 2, 0, 0], { ol: 0.06 });
  const awning = cTex(1024, 64, (cx, w, h) => {
    for (let i = 0; i < 32; i++) {
      cx.fillStyle = i % 2 ? "#FFFAF2" : C.coral;
      cx.fillRect((i * w) / 32, 0, w / 32 + 1, h);
    }
  }).tex;
  P(arena, Cyl(10.3, 11.4, 1.6, 64, 1, true), toon("#ffffff", { map: awning, side: THREE.DoubleSide }), [0, 8.5, 0], [0, 0, 0], { ol: 0.06 });
  // gate
  const gateSign = cTex(512, 128, (cx, w, h) => {
    cx.fillStyle = C.coral;
    cx.fillRect(0, 0, w, h);
    cx.fillStyle = "#FFFAF2";
    cx.font = "800 54px Unbounded, system-ui";
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText("ROYALE", w / 2, h / 2 + 3);
  }).tex;
  [-3.2, 3.2].forEach((x) => P(arena, Box(1.4, 7.5, 1.4), "#FFFAF2", [x, 4.9, 10.6], [0, 0, 0], { ol: 0.07 }));
  P(arena, Box(8.6, 2.2, 1.2), [toon(C.coral), toon(C.coral), toon(C.coral), toon(C.coral), toon("#ffffff", { map: gateSign }), toon(C.coral)], [0, 9.3, 10.6], [0, 0, 0], { ol: 0.07 });
  // candle bars in the pit: the latest BTC moves, mint up and coral down
  const bars: { b: THREE.Mesh; m: THREE.MeshToonMaterial; h: number; goal: number; up: boolean }[] = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const m = new THREE.MeshToonMaterial({ color: C.mint, gradientMap: ctx.kit.gradMap });
    const b = P(arena, Box(0.9, 1, 0.9), m, [5 * Math.cos(a), 1.35, 5 * Math.sin(a)], [0, -a, 0], { ol: 0.05 });
    b.geometry = b.geometry.clone().translate(0, 0.5, 0);
    (b.children[0] as THREE.Mesh).geometry = ctx.kit.smooth(b.geometry);
    bars.push({ b, m, h: 1 + R() * 3, goal: 1 + R() * 3, up: true });
  }
  const tickerSrc = (cx: CanvasRenderingContext2D, w: number, h: number) => {
    cx.fillStyle = C.ink;
    cx.fillRect(0, 0, w, h);
    cx.font = '500 70px "JetBrains Mono", ui-monospace, monospace';
    cx.textBaseline = "middle";
    let x = 30;
    if (!snap.marks) {
      while (x < w) {
        const s = "PRICES LOADING ";
        cx.fillStyle = "#FFFBF5";
        cx.fillText(s, x, h / 2);
        x += cx.measureText(s).width;
        cx.fillStyle = C.sun;
        cx.fillText("✦", x, h / 2);
        x += 80;
      }
      return;
    }
    while (x < w)
      for (const m of MARKETS) {
        const ch = change(snap, m);
        const s = m + " " + commas(snap.marks[m]) + " ";
        cx.fillStyle = "#FFFBF5";
        cx.fillText(s, x, h / 2);
        x += cx.measureText(s).width;
        if (ch !== null) {
          const cs = (ch >= 0 ? "▲" : "▼") + Math.abs(ch).toFixed(2) + "%";
          cx.fillStyle = ch >= 0 ? "#5BF0B5" : "#FF8FA6";
          cx.fillText(cs, x, h / 2);
          x += cx.measureText(cs).width + 34;
        }
        cx.fillStyle = C.sun;
        cx.fillText("✦", x, h / 2);
        x += 80;
      }
  };
  const ticker = cTex(3072, 140, tickerSrc);
  const tickerRing = P(arena, Cyl(6.2, 6.2, 1.9, 64, 1, true), new THREE.MeshBasicMaterial({ map: ticker.tex, side: THREE.DoubleSide }), [0, 14, 0], [0, 0, 0], { ol: false, shadow: false });
  const beam = P(arena, Cyl(0.6, 0.6, 60, 16, 1, true), new THREE.MeshBasicMaterial({ color: C.coral, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending }), [0, 31, 0], [0, 0, 0], { ol: false, shadow: false });
  const spots = [-1, 1].map((s) => {
    const piv = new THREE.Group();
    piv.position.set(s * 8, 8, 0);
    arena.add(piv);
    P(piv, new THREE.ConeGeometry(2.6, 18, 20, 1, true).translate(0, -9, 0).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: "#FFE7A8", transparent: true, opacity: 0.14, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }), [0, 0, 0], [0, 0, 0], { ol: false, shadow: false });
    return { piv, s };
  });
  const flags: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.26;
    P(arena, Cyl(0.12, 0.12, 4, 6), C.ink, [10.25 * Math.cos(a), 10.6, 10.25 * Math.sin(a)], [0, 0, 0], { ol: false });
    const sh = new THREE.Shape();
    sh.moveTo(0, 0);
    sh.lineTo(2.4, -0.6);
    sh.lineTo(0, -1.2);
    sh.closePath();
    flags.push(P(arena, new THREE.ShapeGeometry(sh), toon([C.sun, C.sky, C.violet][i % 3], { side: THREE.DoubleSide }), [10.25 * Math.cos(a), 12.5, 10.25 * Math.sin(a)], [0, 0, 0], { ol: false }));
  }
  place(ctx, arena, LAYOUT.arena[0], LAYOUT.arena[1]);

  let beamFlash = 0;
  let marksSeen: unknown = undefined;
  let movesSeen: unknown = undefined;
  const live = () => snap.royale?.status === "live";
  ctx.onFrame.push((dt, t, s) => {
    snap = s;
    if (s.marks !== marksSeen) {
      marksSeen = s.marks;
      ticker.redraw();
    }
    if (s.moves !== movesSeen) {
      movesSeen = s.moves;
      const mv = s.moves.slice(-14);
      bars.forEach((b, i) => {
        const bps = mv[i - (14 - mv.length)];
        if (bps === undefined) return;
        b.goal = Math.max(0.6, Math.min(5.5, 0.6 + Math.abs(bps) * 0.9));
        b.up = bps >= 0;
      });
    }
    tickerRing.rotation.y += dt * 0.22;
    bars.forEach((b) => {
      b.h += (b.goal - b.h) * Math.min(1, dt * 3);
      b.b.scale.y = b.h;
      b.m.color.set(b.up ? C.mint : C.coral);
    });
    beamFlash = Math.max(0, beamFlash - dt * 0.7);
    (beam.material as THREE.MeshBasicMaterial).opacity = (live() ? 0.22 + 0.08 * Math.sin(t * 3) : 0.07) + beamFlash * 0.6;
    beam.scale.x = beam.scale.z = 1 + beamFlash * 2.5;
    spots.forEach((sp) => {
      sp.piv.rotation.z = sp.s * (0.35 + Math.sin(t * 0.9 + sp.s) * 0.35);
      sp.piv.rotation.x = Math.cos(t * 0.7 + sp.s) * 0.3;
      sp.piv.visible = live();
    });
    flags.forEach((fl, i) => {
      fl.rotation.y = Math.sin(t * 3 + i) * 0.35 + i;
    });
  });
  return { arena, flare: () => (beamFlash = 1) };
}
