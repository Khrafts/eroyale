// Open plots: a dashed 14 x 14 lot with a spinning hologram plus sign and a pulse ring.
import * as THREE from "three";
import { canvasFont } from "@/lib/theme";
import { C, Box, Cyl, Sph } from "../materials";
import { LAYOUT, place, type Ctx } from "../common";

export function buildPlots(ctx: Ctx) {
  const { P, toon, basic, cTex } = ctx.kit;
  const plots: { holo: THREE.Group; pulse: THREE.Mesh; ph: number }[] = [];
  function plot(name: string) {
    const g = new THREE.Group();
    const t = cTex(512, 512, (cx, w, h) => {
      cx.fillStyle = "#6FDB7E";
      cx.fillRect(0, 0, w, h);
      cx.strokeStyle = C.white;
      cx.lineWidth = 14;
      cx.setLineDash([40, 26]);
      cx.strokeRect(22, 22, w - 44, h - 44);
      cx.setLineDash([]);
      cx.fillStyle = "rgba(255,255,255,.95)";
      cx.font = canvasFont("display", 800, 50);
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.fillText("OPEN PLOT", w / 2, h / 2 + 90);
      cx.font = canvasFont("mono", 500, 28);
      cx.fillText(name + " · 14 × 14", w / 2, h / 2 + 140);
    }).tex;
    P(g, new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2), toon("#ffffff", { map: t }), [0, 0.06, 0], [0, 0, 0], { ol: false, shadow: false });
    [[-7, -7], [7, -7], [-7, 7], [7, 7]].forEach(([x, z]) => {
      P(g, Cyl(0.16, 0.2, 1.6, 8), "#B07A4F", [x, 0.8, z], [0, 0, 0], { ol: 0.04 });
      P(g, Sph(0.3, 8, 6), C.sky, [x, 1.75, z], [0, 0, 0], { ol: 0.03 });
    });
    const holo = new THREE.Group();
    holo.position.y = 4.5;
    g.add(holo);
    const hm = basic(C.sky, { transparent: true, opacity: 0.85 });
    P(holo, Box(3.6, 1, 1), hm, [0, 0, 0], [0, 0, 0], { ol: 0.05, shadow: false });
    P(holo, Box(1, 3.6, 1), hm, [0, 0, 0], [0, 0, 0], { ol: 0.05, shadow: false });
    const pulse = P(g, new THREE.RingGeometry(1.5, 2, 48).rotateX(-Math.PI / 2), basic(C.sky, { transparent: true, opacity: 0.6, depthWrite: false }), [0, 0.12, 0], [0, 0, 0], { ol: false, shadow: false });
    plots.push({ holo, pulse, ph: ctx.R() * 6 });
    return g;
  }
  const plotA = place(ctx, plot("PLOT 07"), LAYOUT.plotA[0], LAYOUT.plotA[1]);
  const plotB = place(ctx, plot("PLOT 11"), LAYOUT.plotB[0], LAYOUT.plotB[1]);
  ctx.onFrame.push((dt, t) => {
    plots.forEach((p) => {
      p.holo.rotation.y += dt * 0.8;
      p.holo.position.y = 4.5 + Math.sin(t * 1.6 + p.ph) * 0.5;
      const k = (t * 0.5 + p.ph) % 1;
      p.pulse.scale.setScalar(1 + k * 3);
      (p.pulse.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - k);
    });
  });
  return { plotA, plotB };
}
