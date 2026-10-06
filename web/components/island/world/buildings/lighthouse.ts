// The Lighthouse on its sand bar, with a sweeping beam and rocks.
import * as THREE from "three";
import { C, Cyl } from "../materials";
import { LH, SAND_Y, type Ctx } from "../common";

export function buildLighthouse(ctx: Ctx) {
  const { P, toon, basic, cTex } = ctx.kit;
  const R = ctx.R;
  const lh = new THREE.Group();
  lh.position.set(LH[0], SAND_Y, LH[1]);
  ctx.scene.add(lh);
  ctx.roots.push(lh);
  const lhStripes = cTex(64, 256, (cx, w, h) => {
    for (let i = 0; i < 6; i++) {
      cx.fillStyle = i % 2 ? "#FFFAF2" : "#FF4F5E";
      cx.fillRect(0, (i * h) / 6, w, h / 6 + 1);
    }
  }).tex;
  P(lh, Cyl(3.6, 4.2, 1.2, 16), "#B3A9C9", [0, 0.6, 0], [0, 0, 0], { ol: 0.06 });
  P(lh, Cyl(2.1, 3.1, 16, 20), toon("#ffffff", { map: lhStripes }), [0, 9.2, 0], [0, 0, 0], { ol: 0.08 });
  P(lh, Cyl(3.3, 3.3, 0.5, 20), C.ink, [0, 17.4, 0], [0, 0, 0], { ol: false });
  P(lh, Cyl(1.9, 1.9, 2.4, 14), basic("#FFE9A6"), [0, 18.9, 0], [0, 0, 0], { ol: 0.05, shadow: false });
  P(lh, new THREE.ConeGeometry(2.6, 2.4, 14), "#FF4F5E", [0, 21.3, 0], [0, 0, 0], { ol: 0.06 });
  const lhBeam = new THREE.Group();
  lhBeam.position.y = 18.9;
  lh.add(lhBeam);
  [0, Math.PI].forEach((r) =>
    P(lhBeam, new THREE.ConeGeometry(3.2, 38, 24, 1, true).translate(0, -19, 0).rotateZ(Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#FFF1B8", transparent: true, opacity: 0.08, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }), [0, 0, 0], [0, r, 0], { ol: false, shadow: false }),
  );
  for (let i = 0; i < 9; i++) {
    const a = R() * Math.PI * 2;
    const r = 4 + R() * 4;
    const k = P(ctx.scene, new THREE.DodecahedronGeometry(1 + R() * 1.5, 0), R() < 0.5 ? "#B3A9C9" : "#9F96B8", [LH[0] + r * Math.cos(a), SAND_Y - 0.2, LH[1] + r * Math.sin(a)], [R(), R(), R()], { ol: 0.06 });
    k.scale.y = 0.7;
  }
  ctx.onFrame.push((dt) => {
    lhBeam.rotation.y += dt * 0.6;
  });
  return { lh };
}
