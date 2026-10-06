// Mosaic plaza, promenade ring, avenues to every district, and the fountain launcher: one jet per game whose
// height follows its player count, a centre jet, and gold coins orbiting overhead.
import * as THREE from "three";
import { C, Cyl } from "./materials";
import { G, LAYOUT, PATH, PATH_EDGE, polar, type Ctx } from "./common";
import type { IslandSnap } from "@/lib/island/store";
import { GAMES, type Game } from "@/lib/island/places";

export function buildPlaza(ctx: Ctx) {
  const { P, toon, cTex, addOutline } = ctx.kit;
  const { scene, addOb } = ctx;
  const mosaic = cTex(1024, 1024, (cx, w) => {
    const c = w / 2;
    cx.fillStyle = "#FFF3E4";
    cx.fillRect(0, 0, w, w);
    const pal = ["#FF8FA8", "#AF95FF", "#5FE3B5", "#FFD24D", "#6FD3F5", "#FFA46B"];
    [[150, 12], [210, 18], [280, 26], [350, 34], [420, 42], [480, 48]].forEach(([r, n], ri) => {
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 0.82) / n) * Math.PI * 2;
        cx.beginPath();
        cx.arc(c, c, r, a0, a1);
        cx.arc(c, c, r - 46, a1, a0, true);
        cx.closePath();
        cx.fillStyle = pal[(i + ri) % pal.length];
        cx.fill();
      }
    });
    cx.strokeStyle = "rgba(43,29,82,.18)";
    cx.lineWidth = 4;
    [104, 500].forEach((r) => {
      cx.beginPath();
      cx.arc(c, c, r, 0, Math.PI * 2);
      cx.stroke();
    });
  }).tex;
  const plaza = new THREE.Mesh(Cyl(15, 15.5, 0.45, 72), [toon("#FFE3CC"), toon("#ffffff", { map: mosaic }), toon("#FFE3CC")]);
  plaza.position.y = G + 0.22;
  plaza.receiveShadow = true;
  scene.add(plaza);
  addOutline(plaza, 0.12);
  addOb(0, 0, 17);
  P(scene, new THREE.RingGeometry(25.5, 30.5, 160).rotateX(-Math.PI / 2), PATH, [0, G + 0.04, 0], [0, 0, 0], { ol: false, shadow: false });
  [[25.1, 25.5], [30.5, 30.9]].forEach(([a, b]) =>
    P(scene, new THREE.RingGeometry(a, b, 160).rotateX(-Math.PI / 2), PATH_EDGE, [0, G + 0.05, 0], [0, 0, 0], { ol: false, shadow: false }),
  );
  function avenue(deg: number, r0: number, r1: number, wdt = 4.4) {
    const len = r1 - r0;
    if (len <= 0.3) return;
    const [mx, mz] = polar(deg, (r0 + r1) / 2);
    const ry = Math.PI / 2 - (deg * Math.PI) / 180;
    P(scene, new THREE.BoxGeometry(wdt + 0.8, 0.06, len), PATH_EDGE, [mx, G + 0.03, mz], [0, ry, 0], { ol: false, shadow: false });
    P(scene, new THREE.BoxGeometry(wdt, 0.08, len), PATH, [mx, G + 0.045, mz], [0, ry, 0], { ol: false, shadow: false });
    for (let s = r0; s <= r1; s += 2.5) {
      const [x, z] = polar(deg, s);
      addOb(x, z, wdt / 2 + 0.8);
    }
  }
  Object.values(LAYOUT).forEach(([deg, r, inner]) => {
    avenue(deg, 15, 25.5);
    avenue(deg, 30.5, r - inner);
    const [x, z] = polar(deg, r);
    addOb(x, z, inner + 2);
  });
  avenue(215, 15, 25.5);
  avenue(296, 15, 25.5);
}

export function buildFountain(ctx: Ctx, snap0: IslandSnap) {
  const { P, toon, basic, gradMap } = ctx.kit;
  const { scene, R } = ctx;
  let snap = snap0;
  const FS = 1.7;
  const fountain = new THREE.Group();
  fountain.position.y = G + 0.45;
  fountain.scale.setScalar(FS);
  scene.add(fountain);
  ctx.roots.push(fountain);
  const fWater = new THREE.MeshToonMaterial({ color: "#5DE8DD", gradientMap: gradMap, emissive: "#1B9FA8", emissiveIntensity: 0.35 });
  P(fountain, Cyl(4.6, 4.9, 1, 48, 1, true), toon("#FFF3E4", { side: THREE.DoubleSide }), [0, 0.5, 0], [0, 0, 0], { ol: 0.05 });
  P(fountain, new THREE.TorusGeometry(4.65, 0.26, 8, 56), "#FFB3C2", [0, 1, 0], [Math.PI / 2, 0, 0], { ol: 0.04 });
  P(fountain, Cyl(4.5, 4.5, 0.1, 48), fWater, [0, 0.78, 0], [0, 0, 0], { ol: false });
  P(fountain, Cyl(0.65, 1, 2.6, 12), "#FFF3E4", [0, 1.8, 0], [0, 0, 0], { ol: 0.05 });
  P(fountain, Cyl(2.2, 0.9, 0.7, 32), "#C9B6FF", [0, 3.1, 0], [0, 0, 0], { ol: 0.05 });
  P(fountain, Cyl(2.05, 2.05, 0.08, 32), fWater, [0, 3.4, 0], [0, 0, 0], { ol: false });
  const finial = P(fountain, new THREE.OctahedronGeometry(0.5, 0), C.sun, [0, 4.1, 0], [0, 0, 0], { ol: 0.04 });
  const GRAV = 16;
  type Jet = { x: number; z: number; y0: number; floor: number; col: THREE.Color; h: () => number; spread: number; game?: Game };
  const jetDefs: Jet[] = GAMES.map((g, i) => {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    return { x: 3.05 * Math.cos(a), z: 3.05 * Math.sin(a), y0: 0.85, floor: 0.8, col: new THREE.Color(g.color), h: () => g.h(snap), spread: 0.5, game: g };
  });
  jetDefs.push({ x: 0, z: 0, y0: 4.2, floor: 3.45, col: new THREE.Color("#E9FBFF"), h: () => 4.4, spread: 1.0 });
  const PER = 150;
  const NP = PER * jetDefs.length;
  const pp = new Float32Array(NP * 3);
  const pc = new Float32Array(NP * 3);
  const pv = new Float32Array(NP * 3);
  const white = new THREE.Color("#ffffff");
  const tmpC = new THREE.Color();
  function spawn(i: number, stagger: boolean) {
    const j = jetDefs[(i / PER) | 0];
    const h = j.h();
    const v = Math.sqrt(2 * GRAV * h) * (0.9 + R() * 0.14);
    const ang = R() * Math.PI * 2;
    const s = j.spread * R();
    pv[i * 3] = Math.cos(ang) * s;
    pv[i * 3 + 1] = v;
    pv[i * 3 + 2] = Math.sin(ang) * s;
    pp[i * 3] = j.x;
    pp[i * 3 + 1] = j.y0;
    pp[i * 3 + 2] = j.z;
    if (stagger) {
      const t = R() * ((2 * v) / GRAV);
      pp[i * 3] += pv[i * 3] * t;
      pp[i * 3 + 1] += v * t - 0.5 * GRAV * t * t;
      pp[i * 3 + 2] += pv[i * 3 + 2] * t;
      pv[i * 3 + 1] -= GRAV * t;
    }
    tmpC.copy(j.col).lerp(white, R() * 0.5);
    pc[i * 3] = tmpC.r;
    pc[i * 3 + 1] = tmpC.g;
    pc[i * 3 + 2] = tmpC.b;
  }
  for (let i = 0; i < NP; i++) spawn(i, true);
  const jetGeo = new THREE.BufferGeometry();
  jetGeo.setAttribute("position", new THREE.BufferAttribute(pp, 3));
  jetGeo.setAttribute("color", new THREE.BufferAttribute(pc, 3));
  const jets = new THREE.Points(jetGeo, new THREE.PointsMaterial({ size: 0.62, map: ctx.dotTex, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
  jets.frustumCulled = false;
  fountain.add(jets);
  const jetProxies: { proxy: THREE.Mesh; game: Game }[] = [];
  jetDefs.slice(0, 4).forEach((j) => {
    P(fountain, Cyl(0.22, 0.3, 0.34, 12), "#FFF3E4", [j.x, 0.9, j.z], [0, 0, 0], { ol: 0.03 });
    P(fountain, new THREE.TorusGeometry(0.62, 0.1, 8, 28), basic(j.game!.color), [j.x, 0.84, j.z], [Math.PI / 2, 0, 0], { ol: false, shadow: false });
    const proxy = new THREE.Mesh(Cyl(1, 1, 7.5, 8), new THREE.MeshBasicMaterial({ visible: false }));
    proxy.position.set(j.x, 3.8, j.z);
    fountain.add(proxy);
    jetProxies.push({ proxy, game: j.game! });
  });
  // gold coins orbiting overhead
  const coinGeo = Cyl(1, 1, 0.22, 24);
  const coins: { c: THREE.Mesh; a: number; y: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const c = P(scene, coinGeo, C.sun, [0, 0, 0], [Math.PI / 2, 0, 0], { ol: 0.06, shadow: true });
    P(c, Cyl(0.62, 0.62, 0.25, 24), "#FFE08A", [0, 0, 0], [0, 0, 0], { ol: false, shadow: false });
    coins.push({ c, a: (i / 9) * Math.PI * 2, y: 14 + (i % 3) * 1.4 });
  }
  ctx.onFrame.push((dt, t, s) => {
    snap = s;
    let respawned = false;
    for (let i = 0; i < NP; i++) {
      pv[i * 3 + 1] -= GRAV * dt;
      pp[i * 3] += pv[i * 3] * dt;
      pp[i * 3 + 1] += pv[i * 3 + 1] * dt;
      pp[i * 3 + 2] += pv[i * 3 + 2] * dt;
      if (pp[i * 3 + 1] < jetDefs[(i / PER) | 0].floor && pv[i * 3 + 1] < 0) {
        spawn(i, false);
        respawned = true;
      }
    }
    jetGeo.attributes.position.needsUpdate = true;
    if (respawned) jetGeo.attributes.color.needsUpdate = true;
    finial.rotation.y += dt * 1.2;
    finial.position.y = 4.1 + Math.sin(t * 2) * 0.12;
    coins.forEach((c, i) => {
      c.a += dt * 0.25;
      c.c.position.set(Math.cos(c.a) * 10, G + c.y + Math.sin(t * 1.6 + i) * 0.6, Math.sin(c.a) * 10);
      c.c.rotation.z = t * 2 + i;
    });
  });
  return { fountain, jetProxies };
}
