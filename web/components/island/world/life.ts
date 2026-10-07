// Sky and sea life: clouds, the blimp (its banner shows the open player round with the largest pot), hot-air
// balloons, sailing boats, fireflies, and the confetti burst for payouts.
import * as THREE from "three";
import { canvasFont } from "@/lib/theme";
import { C, Box, Cyl, Ico, Sph } from "./materials";
import { G, type Ctx } from "./common";
import type { IslandSnap } from "@/lib/island/store";
import { promoted } from "@/lib/island/places";
import { usdcShort } from "@/lib/island/format";

export function buildLife(ctx: Ctx, snap0: IslandSnap) {
  const { P, toon, cTex } = ctx.kit;
  const { scene, R } = ctx;
  let snap = snap0;
  const clouds: { g: THREE.Group; a: number; r: number; y: number; s: number }[] = [];
  const cloudMat = toon(C.white, { emissive: "#F2EEFF", emissiveIntensity: 0.35 });
  for (let i = 0; i < 14; i++) {
    const g = new THREE.Group();
    const n = 3 + Math.floor(R() * 4);
    for (let k = 0; k < n; k++) P(g, Ico(4 + R() * 4, 1), cloudMat, [k * 6 - n * 3, R() * 2.5, R() * 4], [0, 0, 0], { ol: 0.16, shadow: false });
    const a = R() * Math.PI * 2;
    const r = 240 + R() * 260;
    const y = 150 + R() * 70;
    g.scale.setScalar(2.4);
    g.position.set(r * Math.cos(a), y, r * Math.sin(a));
    g.lookAt(0, y, 0);
    scene.add(g);
    clouds.push({ g, a, r, y, s: 0.004 + R() * 0.005 });
  }
  const blimp = new THREE.Group();
  scene.add(blimp);
  const bBody = P(blimp, Sph(1, 28, 18), "#B69CFF", [0, 0, 0], [0, 0, 0], { ol: 0.025 });
  bBody.scale.set(9, 3.4, 3.4);
  P(blimp, Cyl(3.42, 3.42, 1.2, 28, 1, true), toon(C.sun, { side: THREE.DoubleSide }), [0, 0, 0], [0, 0, Math.PI / 2], { ol: false });
  [[0, 2.4, 0], [0, -2.4, 0], [0, 0, 2.4], [0, 0, -2.4]].forEach(([x, y, z]) => P(blimp, Box(2.6, y ? 2 : 0.3, z ? 2 : 0.3), C.coral, [-8, y * 0.9, z * 0.9], [0, 0, 0], { ol: 0.05 }));
  P(blimp, Box(3, 1.2, 1.4), C.ink, [0, -3.6, 0], [0, 0, 0], { ol: false });
  const banner = cTex(1024, 256, (cx, w, h) => {
    const u = promoted(snap)[0];
    cx.fillStyle = C.paper;
    cx.fillRect(0, 0, w, h);
    cx.fillStyle = C.coral;
    cx.fillRect(0, 0, 26, h);
    cx.fillRect(w - 26, 0, 26, h);
    cx.fillStyle = C.ink;
    cx.font = canvasFont("display", 800, 70);
    cx.textBaseline = "middle";
    cx.fillText(u ? `${u.market} ROUND #${u.lobbyId}` : "CREATE A ROUND", 60, 100);
    cx.font = canvasFont("mono", 500, 34);
    cx.fillStyle = C.violet;
    cx.fillText(u ? `POT ${usdcShort(u.potUnits)} USDC · JOIN AT THE FOUNTAIN` : "AT THE FOUNTAIN · YOUR MARKET, YOUR RULES", 62, 186);
  });
  P(blimp, new THREE.PlaneGeometry(16, 4), new THREE.MeshBasicMaterial({ map: banner.tex, side: THREE.DoubleSide }), [-14, -2, 0], [0, 0, 0], { ol: false, shadow: false });
  [-1, 1].forEach((s) => P(blimp, Cyl(0.05, 0.05, 6.6, 4), C.ink, [-8.6, -0.5, 0], [0, 0, s * 1.2 + Math.PI / 2], { ol: false, shadow: false }));
  const balloons = ([[C.coral, "#FFFAF2"], [C.violet, C.sun], [C.mint, C.sky]] as [string, string][]).map(([c1, c2], i) => {
    const g = new THREE.Group();
    scene.add(g);
    const t = cTex(256, 64, (cx, w, h) => {
      for (let k = 0; k < 8; k++) {
        cx.fillStyle = k % 2 ? c2 : c1;
        cx.fillRect((k * w) / 8, 0, w / 8 + 1, h);
      }
    }).tex;
    const env = P(g, Sph(1, 24, 18), toon("#ffffff", { map: t }), [0, 0, 0], [0, 0, 0], { ol: 0.025 });
    env.scale.set(4.2, 5, 4.2);
    P(g, Box(1.8, 1.3, 1.8), "#B07A4F", [0, -7.6, 0], [0, 0, 0], { ol: 0.05 });
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([x, z]) => P(g, Cyl(0.04, 0.04, 3.6, 4), C.ink, [x * 0.8, -5.6, z * 0.8], [0, 0, 0], { ol: false, shadow: false }));
    return { g, a: i * 2.1, r: 95 + i * 25, y: 42 + i * 9, s: 0.02 + i * 0.006 };
  });
  function boat(c: string) {
    const b = new THREE.Group();
    scene.add(b);
    P(b, Box(4.6, 1, 1.9), "#FFFAF2", [0, 0.5, 0], [0, 0, 0], { ol: 0.05 });
    P(b, Box(4.7, 0.35, 1.95), c, [0, 0.2, 0], [0, 0, 0], { ol: false });
    P(b, Cyl(0.08, 0.08, 5, 6), C.ink, [0, 3.2, 0], [0, 0, 0], { ol: false });
    const sh = new THREE.Shape();
    sh.moveTo(0, 0);
    sh.lineTo(2.4, 0);
    sh.lineTo(0, 4);
    sh.closePath();
    P(b, new THREE.ShapeGeometry(sh), toon(C.white, { side: THREE.DoubleSide }), [0.1, 1.2, 0], [0, 0, 0], { ol: false });
    return b;
  }
  const boats = [
    { b: boat(C.coral), r: 82, s: 0.03, a: 0 },
    { b: boat(C.violet), r: 142, s: -0.02, a: 2 },
  ];
  const FN = 160;
  const fp = new Float32Array(FN * 3);
  const fseed = new Float32Array(FN * 4);
  for (let i = 0; i < FN; i++) {
    const a = R() * Math.PI * 2;
    const r = 6 + R() * 50;
    fseed[i * 4] = r * Math.cos(a);
    fseed[i * 4 + 1] = r * Math.sin(a);
    fseed[i * 4 + 2] = R() * 6.28;
    fseed[i * 4 + 3] = 3 + R() * 8;
  }
  const ffGeo = new THREE.BufferGeometry();
  ffGeo.setAttribute("position", new THREE.BufferAttribute(fp, 3));
  const fireflies = new THREE.Points(ffGeo, new THREE.PointsMaterial({ size: 0.7, map: ctx.dotTex, color: "#FFE58A", transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
  fireflies.frustumCulled = false;
  scene.add(fireflies);

  // confetti for payouts
  const CN = 320;
  const cp = new Float32Array(CN * 3).fill(-999);
  const cc = new Float32Array(CN * 3);
  const cv = new Float32Array(CN * 3);
  const cl = new Float32Array(CN);
  const cGeo = new THREE.BufferGeometry();
  cGeo.setAttribute("position", new THREE.BufferAttribute(cp, 3));
  cGeo.setAttribute("color", new THREE.BufferAttribute(cc, 3));
  const conf = new THREE.Points(cGeo, new THREE.PointsMaterial({ size: 0.8, vertexColors: true, transparent: true, depthWrite: false }));
  conf.frustumCulled = false;
  scene.add(conf);
  const AVC = [C.coral, C.violet, C.mint, C.sun, C.sky, "#FF7BCB", C.tang];
  const tmpC = new THREE.Color();
  function celebrate(at: THREE.Vector3) {
    for (let i = 0; i < CN; i++) {
      const a = R() * Math.PI * 2;
      const s = 3 + R() * 7;
      cp[i * 3] = at.x;
      cp[i * 3 + 1] = at.y + 5;
      cp[i * 3 + 2] = at.z;
      cv[i * 3] = Math.cos(a) * s;
      cv[i * 3 + 1] = 12 + R() * 10;
      cv[i * 3 + 2] = Math.sin(a) * s;
      cl[i] = 2.4 + R() * 1.2;
      tmpC.set(AVC[i % AVC.length]);
      cc[i * 3] = tmpC.r;
      cc[i * 3 + 1] = tmpC.g;
      cc[i * 3 + 2] = tmpC.b;
    }
    cGeo.attributes.color.needsUpdate = true;
  }

  let bannerKey = "";
  ctx.onFrame.push((dt, t, s) => {
    snap = s;
    const u = promoted(s)[0];
    const k = u ? `${u.lobbyId}:${u.potUnits}` : "";
    if (k !== bannerKey) {
      bannerKey = k;
      banner.redraw();
    }
    for (let i = 0; i < CN; i++) {
      if (cl[i] <= 0) continue;
      cl[i] -= dt;
      cv[i * 3 + 1] -= 14 * dt;
      cv[i * 3] *= 0.985;
      cv[i * 3 + 2] *= 0.985;
      cp[i * 3] += cv[i * 3] * dt;
      cp[i * 3 + 1] += cv[i * 3 + 1] * dt;
      cp[i * 3 + 2] += cv[i * 3 + 2] * dt;
      if (cl[i] <= 0) cp[i * 3 + 1] = -999;
    }
    cGeo.attributes.position.needsUpdate = true;
    clouds.forEach((c) => {
      c.a += dt * c.s;
      c.g.position.set(c.r * Math.cos(c.a), c.y, c.r * Math.sin(c.a));
    });
    const ba = t * 0.02;
    blimp.position.set(92 * Math.cos(ba), 62 + Math.sin(t * 0.5) * 2, 92 * Math.sin(ba));
    blimp.rotation.y = -ba - Math.PI / 2 + Math.PI;
    blimp.rotation.z = Math.sin(t * 0.4) * 0.03;
    balloons.forEach((b) => {
      b.a += dt * b.s;
      b.g.position.set(b.r * Math.cos(b.a), b.y + Math.sin(t * 0.6 + b.a) * 3, b.r * Math.sin(b.a));
    });
    boats.forEach((o) => {
      o.a += dt * o.s;
      o.b.position.set(o.r * Math.cos(o.a), 0.9 + Math.sin(t * 1.3 + o.r) * 0.2, o.r * Math.sin(o.a));
      o.b.rotation.y = -o.a + (o.s > 0 ? 0 : Math.PI);
      o.b.rotation.x = Math.sin(t * 1.1 + o.r) * 0.05;
    });
    for (let i = 0; i < FN; i++) {
      const sd = fseed[i * 4 + 2];
      fp[i * 3] = fseed[i * 4] + Math.sin(t * 0.5 + sd) * 2;
      fp[i * 3 + 1] = G + fseed[i * 4 + 3] + Math.sin(t * 0.8 + sd * 2) * 1.2;
      fp[i * 3 + 2] = fseed[i * 4 + 1] + Math.cos(t * 0.4 + sd) * 2;
    }
    ffGeo.attributes.position.needsUpdate = true;
  });
  return { blimp, celebrate };
}
