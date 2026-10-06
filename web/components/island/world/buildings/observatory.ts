// The Observatory (Price Prediction) on its hill: tower, dome, telescope, orbit rings and a floating crystal.
import * as THREE from "three";
import { C, Box, Cyl, Sph } from "../materials";
import { G, GRASS, LAYOUT, PATH, place, polar, type Ctx } from "../common";

export function buildObservatory(ctx: Ctx) {
  const { P, basic, toon } = ctx.kit;
  const [ox, oz] = polar(LAYOUT.observatory[0], LAYOUT.observatory[1]);
  const hill = P(ctx.scene, Sph(17, 24, 12), GRASS, [ox, G - 1.6, oz], [0, 0, 0], { ol: 0.12 });
  hill.scale.y = 0.3;
  const OBS_Y = G + 3.3;
  const obs = new THREE.Group();
  for (let i = 0; i < 6; i++) P(obs, Box(4, 0.5, 1.4), PATH, [0, -2.9 + i * 0.55, 15 - i * 1.6], [0, 0, 0], { ol: 0.04 });
  P(obs, Cyl(6.4, 6.8, 0.7, 12), "#FFF1DE", [0, 0.35, 0], [0, 0, 0], { ol: 0.08 });
  P(obs, Cyl(4, 4.7, 8.5, 12), "#F2EBFF", [0, 4.9, 0], [0, 0, 0], { ol: 0.08 });
  P(obs, Cyl(4.25, 4.25, 0.9, 12), C.violet, [0, 7.6, 0], [0, 0, 0], { ol: 0.06 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    P(obs, Box(0.8, 1.4, 0.3), basic("#FFE58A"), [4.05 * Math.cos(a), 4.2, 4.05 * Math.sin(a)], [0, Math.PI / 2 - a, 0], { ol: 0.03 });
  }
  P(obs, Box(2, 3, 0.4), C.ink, [0, 2.2, 4.45], [0, 0, 0], { ol: false });
  P(obs, Sph(4.5, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), C.sun, [0, 9.1, 0], [0, 0, 0], { ol: 0.08 });
  const scope = new THREE.Group();
  scope.position.y = 11.2;
  obs.add(scope);
  P(scope, Cyl(0.6, 0.95, 6, 14), "#3A2A6B", [1.7, 1.3, 0], [0, 0, -1.0], { ol: 0.05 });
  const orbits: { g: THREE.Group; sp: number }[] = [];
  ([[7.5, 0.5, C.tang, 0.55], [9, -0.35, "#7FA0FF", 0.38], [10.5, 0.2, C.mint, 0.27]] as [number, number, string, number][]).forEach(([r, tilt, c, sp], i) => {
    const g = new THREE.Group();
    g.position.y = 9;
    g.rotation.x = tilt;
    g.rotation.z = i * 0.4;
    obs.add(g);
    P(g, new THREE.TorusGeometry(r, 0.07, 6, 90), basic(c, { transparent: true, opacity: 0.75 }), [0, 0, 0], [Math.PI / 2, 0, 0], { ol: false, shadow: false });
    P(g, Sph(0.85, 18, 12), c, [r, 0, 0], [0, 0, 0], { ol: 0.06 });
    orbits.push({ g, sp });
  });
  const crystal = P(obs, new THREE.OctahedronGeometry(1.3, 0), toon(C.violet, { emissive: "#5B2FD0", emissiveIntensity: 0.4 }), [0, 17.5, 0], [0, 0, 0], { ol: 0.07 });
  place(ctx, obs, LAYOUT.observatory[0], LAYOUT.observatory[1], OBS_Y);
  ctx.onFrame.push((dt, t) => {
    scope.rotation.y = Math.sin(t * 0.3) * 1.4;
    orbits.forEach((o) => {
      o.g.rotation.y += dt * o.sp;
    });
    crystal.rotation.y += dt * 0.9;
    crystal.position.y = 17.5 + Math.sin(t * 1.5) * 0.6;
  });
  return { obs };
}
