// Instanced props: palms, trees, bushes, flowers, rocks and lamps, placed around the obstacle book.
import * as THREE from "three";
import { C, Cyl, Ico, Sph } from "./materials";
import { DECOR, G, ISLET, ISLET_PH, LAYOUT, SAND_Y, f, polar, type Ctx } from "./common";

export function buildProps(ctx: Ctx) {
  const { m4, partsGeo, instanced } = ctx.kit;
  const { R, clear, addOb } = ctx;
  const onGrass = (x: number, z: number, m = 2) => Math.hypot(x, z) < 57 * f(Math.atan2(z, x)) - m;
  const offRing = (x: number, z: number, m = 1.5) => {
    const r = Math.hypot(x, z);
    return r < 25.5 - m || r > 30.5 + m;
  };
  const palmGeo = (() => {
    const parts: [THREE.BufferGeometry, string, THREE.Matrix4][] = [];
    const h = 7;
    const segs = 6;
    let tx = 0;
    for (let i = 0; i < segs; i++) {
      const seg = h / segs;
      const nx = 0.55 * Math.pow((i + 1) / segs, 2) * 2;
      parts.push([Cyl(0.24 - i * 0.022, 0.3 - i * 0.022, seg * 1.06, 7), i % 2 ? "#A96E44" : "#C48A58", m4((tx + nx) / 2, seg * (i + 0.5), 0, 0, 0, -Math.atan2(nx - tx, seg))]);
      tx = nx;
    }
    const fg = new THREE.ConeGeometry(0.95, 5.2, 4);
    fg.translate(0, 2.6, 0);
    fg.scale(0.26, 1, 1);
    for (let k = 0; k < 8; k++) parts.push([fg, k % 2 ? "#20B868" : "#46D98A", m4(tx, h, 0, 0, (k / 8) * Math.PI * 2 + 0.2, -(Math.PI / 2 + 0.3 + (k % 3) * 0.12))]);
    for (let k = 0; k < 3; k++) parts.push([Sph(0.26, 8, 6), "#7A4A2A", m4(tx + Math.cos(k * 2.1) * 0.32, h - 0.3, Math.sin(k * 2.1) * 0.32)]);
    return partsGeo(parts);
  })();
  const trunkGeo = partsGeo([[Cyl(0.35, 0.55, 3.2, 8), "#A96E44", m4(0, 1.6, 0)]]);
  const canopyGeo = partsGeo([[Ico(2.3, 1), "#ffffff", m4(0, 4.6, 0)], [Ico(1.6, 1), "#ffffff", m4(1.4, 3.9, 0.5)], [Ico(1.7, 1), "#ffffff", m4(-1.2, 4.0, -0.6)]]);
  const bushGeo = partsGeo([[Ico(1, 1), "#ffffff", m4(0, 0.5, 0, 0, 0, 0, 1, 0.75, 1)], [Ico(0.7, 1), "#ffffff", m4(0.8, 0.4, 0.2, 0, 0, 0, 1, 0.75, 1)]]);
  const flowerGeo = partsGeo([[Sph(0.3, 8, 6), "#ffffff", m4(0, 0.35, 0)]]);
  const rockGeo = partsGeo([[new THREE.DodecahedronGeometry(1, 0), "#ffffff", m4(0, 0.3, 0, 0, 0, 0, 1, 0.7, 1)]]);
  const lampGeo = partsGeo([[Cyl(0.12, 0.16, 4.2, 8), C.ink, m4(0, 2.1, 0)], [Cyl(0.4, 0.5, 0.3, 10), C.ink, m4(0, 4.2, 0)]]);
  type Item = { m: THREE.Matrix4; c?: string };
  const palms: Item[] = [];
  const trunks: Item[] = [];
  const canopies: Item[] = [];
  const bushes: Item[] = [];
  const flowers: Item[] = [];
  const rocks: Item[] = [];
  const lamps: Item[] = [];
  const lampHeads: THREE.Vector3[] = [];
  const GREENS = ["#2FBF62", "#46D17A", "#25A85A", "#5BD98A"];
  const FUN = ["#FF9EC7", "#C59BFF", "#FFB347", "#FF7BAC"];
  const FLOWERS = [C.coral, C.sun, "#FFFFFF", C.violet, C.tang, C.sky];
  const addTree = (x: number, y: number, z: number, s: number, col: string) => {
    const ry = R() * 6.28;
    trunks.push({ m: m4(x, y, z, 0, ry, 0, s) });
    canopies.push({ m: m4(x, y, z, 0, ry, 0, s), c: col });
    addOb(x, z, 2.2 * s);
  };
  const addPalm = (x: number, y: number, z: number, s: number) => {
    palms.push({ m: m4(x, y, z, 0, R() * 6.28, 0, s) });
    addOb(x, z, 1.6 * s);
  };
  // plaza + promenade lamps
  for (let i = 0; i < 12; i++) {
    const [x, z] = polar(i * 30 + 15, 14);
    lamps.push({ m: m4(x, G + 0.45, z) });
    lampHeads.push(new THREE.Vector3(x, G + 0.45 + 4.6, z));
  }
  for (let i = 0; i < 16; i++) {
    const [x, z] = polar(i * 22.5 + 11, 31.6);
    if (!clear(x, z, 0.5)) continue;
    lamps.push({ m: m4(x, G, z) });
    lampHeads.push(new THREE.Vector3(x, G + 4.6, z));
    addOb(x, z, 1);
  }
  // groves on the grass
  for (let n = 0, g = 0; n < 400 && g < 20; n++) {
    const a = R() * Math.PI * 2;
    const r = 18 + R() * 38;
    const cx = r * Math.cos(a);
    const cz = r * Math.sin(a);
    if (!onGrass(cx, cz, 4) || !offRing(cx, cz, 4) || !clear(cx, cz, 4)) continue;
    g++;
    const kind = R();
    const fun = R() < 0.3 ? FUN[Math.floor(R() * FUN.length)] : null;
    const cnt = 3 + Math.floor(R() * 4);
    for (let k = 0; k < cnt * 4 && cnt > 0; k++) {
      const x = cx + (R() - 0.5) * 11;
      const z = cz + (R() - 0.5) * 11;
      if (!onGrass(x, z, 2) || !offRing(x, z) || !clear(x, z, 1.8)) continue;
      if (kind < 0.3) addPalm(x, G, z, 0.8 + R() * 0.5);
      else addTree(x, G, z, 0.7 + R() * 0.5, fun && R() < 0.7 ? fun : GREENS[Math.floor(R() * 4)]);
    }
  }
  // beach palms in loose clumps
  for (let n = 0, c = 0; n < 500 && c < 22; n++) {
    const a = R() * Math.PI * 2;
    const r = (59 + R() * 4.5) * f(a);
    const cx = r * Math.cos(a);
    const cz = r * Math.sin(a);
    if (!clear(cx, cz, 3)) continue;
    c++;
    const cnt = 1 + Math.floor(R() * 3);
    for (let k = 0; k < cnt; k++) {
      const x = cx + (R() - 0.5) * 5;
      const z = cz + (R() - 0.5) * 5;
      const rr2 = Math.hypot(x, z);
      const ff = f(Math.atan2(z, x));
      if (rr2 < 58.5 * ff || rr2 > 64 * ff || !clear(x, z, 1.4)) continue;
      addPalm(x, SAND_Y, z, 0.9 + R() * 0.5);
    }
  }
  // islet trees: cherry blossoms around the dojo
  for (let n = 0, c = 0; n < 300 && c < 12; n++) {
    const a = R() * Math.PI * 2;
    const r = 9 + R() * 6;
    const x = ISLET[0] + r * Math.cos(a);
    const z = ISLET[1] + r * Math.sin(a);
    if (r > 15 * f(a, ISLET_PH) - 1.5 || !clear(x, z, 2)) continue;
    addTree(x, G, z, 0.8 + R() * 0.4, R() < 0.5 ? "#FF9EC7" : "#FFC1DC");
    c++;
  }
  for (let k = 0; k < 4; k++) {
    const a = R() * Math.PI * 2;
    const r = 2 + R() * 4;
    addPalm(DECOR[0] + r * Math.cos(a), SAND_Y, DECOR[1] + r * Math.sin(a), 0.9 + R() * 0.4);
  }
  // bushes + flower beds
  for (let n = 0, c = 0; n < 900 && c < 70; n++) {
    const a = R() * Math.PI * 2;
    const r = 16 + R() * 40;
    const x = r * Math.cos(a);
    const z = r * Math.sin(a);
    if (!onGrass(x, z, 1.5) || !offRing(x, z) || !clear(x, z, 1)) continue;
    bushes.push({ m: m4(x, G, z, 0, R() * 6, 0, 0.8 + R() * 0.7), c: R() < 0.25 ? FUN[Math.floor(R() * 4)] : GREENS[Math.floor(R() * 4)] });
    c++;
  }
  for (let n = 0, c = 0; n < 2400 && c < 340; n++) {
    const a = R() * Math.PI * 2;
    const r = R() < 0.5 ? 23.5 + R() * 1.4 : 32.2 + R() * 1.6;
    const x = r * Math.cos(a);
    const z = r * Math.sin(a);
    if (!clear(x, z, 0.3)) continue;
    flowers.push({ m: m4(x, G, z, 0, 0, 0, 0.6 + R() * 0.5), c: FLOWERS[Math.floor(R() * FLOWERS.length)] });
    c++;
  }
  {
    const [px, pz] = polar(LAYOUT.park[0], LAYOUT.park[1]);
    for (let k = 0; k < 90; k++) {
      const a = R() * Math.PI * 2;
      const r = 10.6 + R() * 1.2;
      flowers.push({ m: m4(px + r * Math.cos(a), G + 0.3, pz + r * Math.sin(a), 0, 0, 0, 0.7), c: FLOWERS[k % FLOWERS.length] });
    }
  }
  for (let n = 0; n < 40; n++) {
    const a = R() * Math.PI * 2;
    const r = (65 + R() * 3) * f(a);
    rocks.push({ m: m4(r * Math.cos(a), 0.6, r * Math.sin(a), R(), R() * 6, R(), 0.8 + R() * 1.6), c: R() < 0.5 ? "#9285BD" : "#A99DCF" });
  }
  instanced(palmGeo, palms, 0.06);
  instanced(trunkGeo, trunks, 0.06);
  instanced(canopyGeo, canopies, 0.09);
  instanced(bushGeo, bushes, 0.06);
  instanced(flowerGeo, flowers, 0);
  instanced(rockGeo, rocks, 0.07);
  instanced(lampGeo, lamps, 0.04);
  const heads = new THREE.InstancedMesh(Sph(0.45, 10, 8), new THREE.MeshBasicMaterial({ color: "#FFE6A8" }), lampHeads.length);
  lampHeads.forEach((v, i) => heads.setMatrixAt(i, m4(v.x, v.y, v.z)));
  heads.frustumCulled = false;
  ctx.scene.add(heads);
}
