// The Sky Wheel landmark with chasing rim bulbs.
import * as THREE from "three";
import { C, Box, Cyl, Sph } from "../materials";
import { LAYOUT, place, type Ctx } from "../common";

export function buildWheel(ctx: Ctx) {
  const { P, m4 } = ctx.kit;
  const wheelG = new THREE.Group();
  const HUB = 16;
  P(wheelG, Cyl(7, 7.4, 0.8, 24), "#FFF1DE", [0, 0.4, 0], [0, 0, 0], { ol: 0.08 });
  [-2.6, 2.6].forEach((z) =>
    [-1, 1].forEach((s) => {
      const L = Math.hypot(5.8, HUB);
      P(wheelG, Box(0.8, L, 0.8), C.ink, [s * 2.9, HUB / 2, z], [0, 0, s * Math.atan2(5.8, HUB)], { ol: false });
    }),
  );
  P(wheelG, Cyl(0.7, 0.7, 6.4, 14), C.sun, [0, HUB, 0], [Math.PI / 2, 0, 0], { ol: 0.05 });
  const wheel = new THREE.Group();
  wheel.position.y = HUB;
  wheelG.add(wheel);
  P(wheel, new THREE.TorusGeometry(12, 0.42, 10, 96), C.sky, [0, 0, 0], [0, 0, 0], { ol: 0.06 });
  P(wheel, new THREE.TorusGeometry(10.8, 0.2, 8, 96), "#FFFAF2", [0, 0, 0], [0, 0, 0], { ol: 0.04 });
  const RAIN = [C.coral, C.tang, C.sun, C.mint, C.sky, C.violet];
  const gondolas: THREE.Group[] = [];
  for (let k = 0; k < 12; k++) {
    const phi = (k / 12) * Math.PI * 2;
    P(wheel, Box(0.26, 12, 0.26), "#FFFAF2", [Math.cos(phi) * 6, Math.sin(phi) * 6, 0], [0, 0, phi - Math.PI / 2], { ol: 0.03 });
    const hang = new THREE.Group();
    hang.position.set(Math.cos(phi) * 12, Math.sin(phi) * 12, 0);
    wheel.add(hang);
    P(hang, Cyl(0.08, 0.08, 1.2, 6), C.ink, [0, -0.6, 0], [0, 0, 0], { ol: false });
    P(hang, Cyl(1.1, 1.25, 1.7, 14), RAIN[k % 6], [0, -2, 0], [0, 0, 0], { ol: 0.05 });
    P(hang, new THREE.ConeGeometry(1.35, 0.7, 14), "#FFFAF2", [0, -0.85, 0], [0, 0, 0], { ol: 0.04 });
    gondolas.push(hang);
  }
  const white = new THREE.Color(C.white);
  const tmpC = new THREE.Color();
  const wb = new THREE.InstancedMesh(Sph(0.22, 8, 6), new THREE.MeshBasicMaterial(), 48);
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    wb.setMatrixAt(i, m4(Math.cos(a) * 12.6, Math.sin(a) * 12.6, 0));
    wb.setColorAt(i, white);
  }
  wb.frustumCulled = false;
  wheel.add(wb);
  place(ctx, wheelG, LAYOUT.wheel[0], LAYOUT.wheel[1]);
  ctx.onFrame.push((dt, t) => {
    wheel.rotation.z += dt * 0.12;
    gondolas.forEach((g) => {
      g.rotation.z = -wheel.rotation.z;
    });
    const step = Math.floor(t * 5);
    for (let i = 0; i < 48; i++) wb.setColorAt(i, tmpC.set((i + step) % 4 === 0 ? "#FFF6B0" : RAIN[i % 6]));
    wb.instanceColor!.needsUpdate = true;
  });
  return { wheelG };
}
