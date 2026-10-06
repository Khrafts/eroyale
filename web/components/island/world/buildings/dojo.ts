// The Dojo islet (Stickman Duel, opening soon): arched bridge with lanterns, pagoda, sparring stickmen, torii.
import * as THREE from "three";
import { C, Box, Cyl, Sph } from "../materials";
import { G, ISLET, ISLET_PH, SAND_Y, f, polar, type Ctx } from "../common";

export function buildDojo(ctx: Ctx) {
  const { P, toon, basic, cTex } = ctx.kit;
  const { scene, addOb } = ctx;
  const bridgeA = (215 * Math.PI) / 180;
  const b0 = 66 * f(bridgeA) - 7;
  const b1 = 102 - 20 * f(bridgeA + Math.PI, ISLET_PH) + 6;
  const bridge = new THREE.Group();
  scene.add(bridge);
  const NB = 30;
  const bp = (t: number): [number, number, number] => {
    const r = b0 + (b1 - b0) * t;
    return [r * Math.cos(bridgeA), SAND_Y + 0.5 + Math.sin(t * Math.PI) * 4.2, r * Math.sin(bridgeA)];
  };
  for (let i = 0; i <= NB; i++) {
    const t = i / NB;
    const [x, y, z] = bp(t);
    const [x2, y2, z2] = bp(Math.min(1, t + 0.01));
    const [x0, y0, z0] = bp(Math.max(0, t - 0.01));
    const slope = Math.atan2(y2 - y0, Math.hypot(x2 - x0, z2 - z0));
    const pl = P(bridge, Box(5, 0.4, ((b1 - b0) / NB) * 1.05), i % 2 ? "#C98B5B" : "#B87A4C", [x, y, z], [0, 0, 0], { ol: 0.03 });
    pl.rotation.order = "YXZ";
    pl.rotation.set(-slope, Math.PI / 2 - bridgeA, 0);
    if (i % 3 === 0)
      [-1, 1].forEach((s) => {
        const px = x + Math.cos(bridgeA + Math.PI / 2) * s * 2.4;
        const pz = z + Math.sin(bridgeA + Math.PI / 2) * s * 2.4;
        P(bridge, Cyl(0.14, 0.14, 1.6, 6), "#8A5A36", [px, y + 0.8, pz], [0, 0, 0], { ol: 0.03 });
        P(bridge, Sph(0.24, 8, 6), basic("#FFB86B"), [px, y + 1.7, pz], [0, 0, 0], { ol: false, shadow: false });
      });
    addOb(x, z, 3.5);
  }
  const dojo = new THREE.Group();
  P(dojo, Box(13, 1, 13), "#FFF1DE", [0, 0.5, 0], [0, 0, 0], { ol: 0.08 });
  ([[8.5, 3.6, 2.8, 9.2, 2.4, 5.8], [6.2, 2.6, 7.3, 7, 2, 9.6], [3.8, 2, 10.7, 4.6, 2.2, 12.8]] as number[][]).forEach(([w, h, y, rr_, rh, ry]) => {
    P(dojo, Box(w, h, w), "#FFF4E6", [0, y, 0], [0, 0, 0], { ol: 0.07 });
    P(dojo, new THREE.ConeGeometry(rr_, rh, 4), "#FF6A3D", [0, ry, 0], [0, Math.PI / 4, 0], { ol: 0.07 });
  });
  P(dojo, Cyl(0.12, 0.12, 2.6, 6), C.sun, [0, 15, 0], [0, 0, 0], { ol: 0.03 });
  P(dojo, Sph(0.4, 10, 8), C.sun, [0, 16.4, 0], [0, 0, 0], { ol: 0.03 });
  P(dojo, Box(2.2, 2.8, 0.3), "#C2410C", [0, 2.4, 4.3], [0, 0, 0], { ol: 0.04 });
  [[-4.6, 4.6], [4.6, 4.6], [-4.6, -4.6], [4.6, -4.6]].forEach(([x, z]) => {
    P(dojo, Cyl(0.12, 0.12, 2.5, 6), C.ink, [x, 2.2, z + (z > 0 ? 1.8 : -1.8)], [0, 0, 0], { ol: false });
    P(dojo, Cyl(0.55, 0.55, 1, 12), basic("#FFB86B"), [x, 3.9, z + (z > 0 ? 1.8 : -1.8)], [0, 0, 0], { ol: 0.04, shadow: false });
  });
  const stripes = cTex(256, 32, (cx, w, h) => {
    cx.fillStyle = C.sun;
    cx.fillRect(0, 0, w, h);
    cx.fillStyle = C.ink;
    for (let x = -32; x < w; x += 40) {
      cx.beginPath();
      cx.moveTo(x, h);
      cx.lineTo(x + 20, h);
      cx.lineTo(x + 52, 0);
      cx.lineTo(x + 32, 0);
      cx.fill();
    }
  }).tex;
  P(dojo, Box(6, 0.5, 0.18), toon("#ffffff", { map: stripes }), [0, 2.1, 6.2], [0, 0, 0], { ol: 0.03 });
  [-2.8, 2.8].forEach((x) => P(dojo, Cyl(0.1, 0.1, 1.8, 6), C.ink, [x, 1.6, 6.2], [0, 0, 0], { ol: false }));
  P(dojo, Box(7, 0.16, 4.2), "#E9CF8E", [0, 0.08, 9.6], [0, 0, 0], { ol: 0.04 });
  type Stick = { hip: THREE.Group; armL: THREE.Group; armR: THREE.Group; legL: THREE.Group; legR: THREE.Group };
  function stickman(color: string) {
    const s = new THREE.Group();
    const m = toon(color);
    const limb = (len: number) => {
      const pv = new THREE.Group();
      const c = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, len, 4, 6), m);
      c.position.y = -len / 2;
      c.castShadow = true;
      pv.add(c);
      return pv;
    };
    const hip = new THREE.Group();
    hip.position.y = 1.0;
    s.add(hip);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.75, 4, 6), m);
    torso.position.y = 0.42;
    torso.castShadow = true;
    hip.add(torso);
    const head = new THREE.Mesh(Sph(0.24, 12, 10), m);
    head.position.y = 1.08;
    head.castShadow = true;
    hip.add(head);
    const armL = limb(0.65);
    const armR = limb(0.65);
    armL.position.set(-0.12, 0.76, 0);
    armR.position.set(0.12, 0.76, 0);
    hip.add(armL, armR);
    const legL = limb(0.95);
    const legR = limb(0.95);
    legL.position.x = -0.1;
    legR.position.x = 0.1;
    hip.add(legL, legR);
    const u: Stick = { hip, armL, armR, legL, legR };
    s.userData = u;
    s.scale.setScalar(1.7);
    return s;
  }
  const fA = stickman(C.ink);
  const fB = stickman("#FF3D3D");
  fA.position.set(-1.7, 0.16, 9.6);
  fA.rotation.y = Math.PI / 2;
  fB.position.set(1.7, 0.16, 9.6);
  fB.rotation.y = -Math.PI / 2;
  dojo.add(fA, fB);
  dojo.position.set(ISLET[0], G, ISLET[1]);
  dojo.lookAt(new THREE.Vector3(0, G, 0));
  scene.add(dojo);
  ctx.roots.push(dojo);
  addOb(ISLET[0], ISLET[1], 11);
  // torii at the islet end of the bridge
  const [tx, tz] = polar(215, b1 - 3);
  const torii = new THREE.Group();
  torii.position.set(tx, G, tz);
  torii.rotation.y = Math.PI / 2 - bridgeA;
  scene.add(torii);
  [-2.8, 2.8].forEach((x) => P(torii, Cyl(0.38, 0.45, 7, 12), "#E63946", [x, 3.5, 0], [0, 0, 0], { ol: 0.05 }));
  P(torii, Box(8.4, 0.7, 0.9), "#E63946", [0, 7.1, 0], [0, 0, 0], { ol: 0.05 });
  P(torii, Box(9.6, 0.5, 1.1), C.ink, [0, 7.65, 0], [0, 0, 0], { ol: false });
  P(torii, Box(7, 0.4, 0.6), "#E63946", [0, 5.6, 0], [0, 0, 0], { ol: 0.04 });

  ctx.onFrame.push((_dt, t) => {
    const A = fA.userData as Stick;
    const B = fB.userData as Stick;
    const ph = (t % 1.8) / 1.8;
    const bob = Math.sin(t * 9) * 0.04;
    const pulse = (a: number, b: number) => (ph > a && ph < b ? Math.sin(((ph - a) / (b - a)) * Math.PI) : 0);
    const punch = pulse(0.08, 0.26);
    const dodge = pulse(0.1, 0.3);
    const kick = pulse(0.5, 0.74);
    const hit = pulse(0.56, 0.8);
    [A, B].forEach((u) => {
      u.hip.position.y = 1.0 + bob;
      u.armL.rotation.x = -1.1;
      u.armR.rotation.x = -0.9;
      u.legL.rotation.x = 0.3;
      u.legR.rotation.x = -0.3;
    });
    A.armR.rotation.x = -0.9 - punch * 0.8;
    A.hip.rotation.x = punch * 0.18 - hit * 0.3;
    B.hip.rotation.x = -dodge * 0.35 + kick * 0.1;
    B.legR.rotation.x = -0.3 - kick * 1.25;
    fA.position.x = -1.7 + punch * 0.4 - hit * 0.35;
  });
  return { dojo };
}
