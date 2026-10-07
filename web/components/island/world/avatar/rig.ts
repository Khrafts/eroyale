// The chibi avatar rig (the prototype's makeAvatar): body, swappable headwear, face and extra.
import * as THREE from "three";
import { C, Box, Cyl, Sph, type Kit } from "../materials";
import type { AvatarCfg } from "@/lib/island/avatar";

export type Rig = {
  root: THREE.Group;
  hips: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  cape: THREE.Group | null;
  cfg: AvatarCfg;
  set: (c: AvatarCfg) => void;
};

export function makeAvatar(kit: Kit, cfg: AvatarCfg): Rig {
  const { P, basic, tm } = kit;
  const root = new THREE.Group();
  const m = { shirt: tm("#fff"), pants: tm("#fff"), skin: tm("#fff"), hat: tm("#fff") };
  const hips = new THREE.Group();
  hips.position.y = 0.95;
  root.add(hips);
  const leg = (sd: number) => {
    const pv = new THREE.Group();
    pv.position.set(sd * 0.16, 0.02, 0);
    hips.add(pv);
    P(pv, new THREE.CapsuleGeometry(0.12, 0.4, 4, 10), m.pants, [0, -0.36, 0], [0, 0, 0], { ol: 0.025 });
    P(pv, Sph(0.15, 10, 8), C.ink, [0, -0.74, 0.05], [0, 0, 0], { ol: false }).scale.set(1, 0.7, 1.35);
    return pv;
  };
  const legL = leg(-1);
  const legR = leg(1);
  P(hips, new THREE.CapsuleGeometry(0.31, 0.34, 6, 14), m.shirt, [0, 0.45, 0], [0, 0, 0], { ol: 0.025 });
  const arm = (sd: number) => {
    const pv = new THREE.Group();
    pv.position.set(sd * 0.37, 0.78, 0);
    hips.add(pv);
    P(pv, new THREE.CapsuleGeometry(0.095, 0.34, 4, 8), m.shirt, [0, -0.25, 0], [0, 0, 0], { ol: 0.02 });
    P(pv, Sph(0.12, 10, 8), m.skin, [0, -0.5, 0], [0, 0, 0], { ol: 0.02 });
    return pv;
  };
  const armL = arm(-1);
  const armR = arm(1);
  const head = new THREE.Group();
  head.position.y = 1.32;
  hips.add(head);
  P(head, Sph(0.45, 22, 16), m.skin, [0, 0, 0], [0, 0, 0], { ol: 0.03 });
  [-1, 1].forEach((sd) => P(head, Sph(0.08, 8, 6), basic("#FF9DB5"), [sd * 0.27, -0.1, 0.35], [0, 0, 0], { ol: false, shadow: false }).scale.set(1, 0.6, 0.4));
  P(head, new THREE.TorusGeometry(0.07, 0.022, 6, 12, Math.PI), basic(C.ink), [0, -0.13, 0.42], [0, 0, Math.PI], { ol: false, shadow: false });
  const hatG = new THREE.Group();
  const faceG = new THREE.Group();
  const extraG = new THREE.Group();
  head.add(hatG, faceG);
  hips.add(extraG);
  const rig: Rig = { root, hips, head, armL, armR, legL, legR, cape: null, cfg, set: () => {} };
  rig.set = (c) => {
    rig.cfg = { ...c };
    m.shirt.color.set(c.shirt);
    m.pants.color.set(c.pants);
    m.skin.color.set(c.skin);
    m.hat.color.set(c.hatColor);
    [hatG, faceG, extraG].forEach((g) => {
      while (g.children.length) g.remove(g.children[0]);
    });
    rig.cape = null;
    const eye = (x: number, kind?: "arc") =>
      kind === "arc"
        ? P(faceG, new THREE.TorusGeometry(0.065, 0.022, 6, 12, Math.PI), basic(C.ink), [x, 0.06, 0.405], [0, 0, 0], { ol: false, shadow: false })
        : P(faceG, Sph(0.06, 10, 8), basic(C.ink), [x, 0.05, 0.41], [0, 0, 0], { ol: false, shadow: false });
    if (c.face === "dots") {
      eye(-0.16);
      eye(0.16);
    } else if (c.face === "happy") {
      eye(-0.16, "arc");
      eye(0.16, "arc");
    } else if (c.face === "wink") {
      eye(-0.16);
      eye(0.16, "arc");
    } else {
      P(faceG, Box(0.66, 0.15, 0.08), C.ink, [0, 0.06, 0.4], [0, 0, 0], { ol: false });
      P(faceG, Box(0.2, 0.05, 0.02), basic(C.wave), [-0.15, 0.09, 0.45], [0, 0, 0], { ol: false, shadow: false });
    }
    const hc = m.hat;
    if (c.hat === "crown") {
      P(hatG, Cyl(0.28, 0.3, 0.24, 8), C.sun, [0, 0.48, 0], [0, 0, 0], { ol: 0.02 });
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        P(hatG, new THREE.ConeGeometry(0.07, 0.18, 4), C.sun, [Math.cos(a) * 0.25, 0.68, Math.sin(a) * 0.25], [0, 0, 0], { ol: false });
        P(hatG, Sph(0.045, 6, 4), basic(i % 2 ? C.coral : C.sky), [Math.cos(a) * 0.29, 0.48, Math.sin(a) * 0.29], [0, 0, 0], { ol: false, shadow: false });
      }
    } else if (c.hat === "cap") {
      P(hatG, Sph(0.47, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), hc, [0, 0.06, 0], [0, 0, 0], { ol: 0.02 });
      P(hatG, Cyl(0.3, 0.3, 0.05, 18), hc, [0, 0.24, 0.44], [-0.25, 0, 0], { ol: 0.02 }).scale.z = 1.2;
      P(hatG, Sph(0.06, 6, 4), C.ink, [0, 0.53, 0], [0, 0, 0], { ol: false });
    } else if (c.hat === "tophat") {
      P(hatG, Cyl(0.3, 0.3, 0.6, 18), C.ink, [0, 0.7, 0], [0, 0, 0], { ol: 0.02 });
      P(hatG, Cyl(0.5, 0.5, 0.05, 22), C.ink, [0, 0.4, 0], [0, 0, 0], { ol: 0.02 });
      P(hatG, Cyl(0.31, 0.31, 0.12, 18), hc, [0, 0.49, 0], [0, 0, 0], { ol: false });
    } else if (c.hat === "beanie") {
      P(hatG, Sph(0.47, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), hc, [0, 0.05, 0], [0, 0, 0], { ol: 0.02 }).scale.y = 1.15;
      P(hatG, new THREE.TorusGeometry(0.44, 0.08, 8, 24), hc, [0, 0.08, 0], [Math.PI / 2, 0, 0], { ol: 0.02 });
      P(hatG, Sph(0.13, 10, 8), C.paper, [0, 0.62, 0], [0, 0, 0], { ol: 0.02 });
    } else if (c.hat === "party") {
      const g = new THREE.Group();
      g.position.set(0.08, 0.38, 0);
      g.rotation.z = -0.22;
      hatG.add(g);
      P(g, new THREE.ConeGeometry(0.24, 0.62, 18), hc, [0, 0.3, 0], [0, 0, 0], { ol: 0.02 });
      P(g, Sph(0.09, 8, 6), C.sun, [0, 0.64, 0], [0, 0, 0], { ol: 0.02 });
    } else if (c.hat === "halo") {
      P(hatG, new THREE.TorusGeometry(0.3, 0.045, 8, 32), basic("#FFE58A"), [0, 0.78, 0], [Math.PI / 2, 0, 0], { ol: false, shadow: false });
    }
    if (c.extra === "scarf") {
      P(extraG, new THREE.TorusGeometry(0.27, 0.09, 8, 22), hc, [0, 0.9, 0], [Math.PI / 2, 0, 0], { ol: 0.02 });
      P(extraG, Box(0.14, 0.38, 0.07), hc, [0.16, 0.72, 0.27], [0, 0, 0.15], { ol: 0.02 });
    } else if (c.extra === "cape") {
      const g = new THREE.Group();
      g.position.set(0, 0.88, -0.22);
      extraG.add(g);
      P(g, Box(0.7, 0.85, 0.04), hc, [0, -0.42, 0], [0, 0, 0], { ol: 0.02 });
      rig.cape = g;
    } else if (c.extra === "chain") {
      P(extraG, new THREE.TorusGeometry(0.23, 0.035, 6, 24), C.sun, [0, 0.78, 0.1], [1.25, 0, 0], { ol: false });
      P(extraG, new THREE.OctahedronGeometry(0.08, 0), C.sun, [0, 0.58, 0.3], [0, 0, 0], { ol: false });
    }
    hatG.traverse((o) => {
      o.castShadow = true;
    });
    extraG.traverse((o) => {
      o.castShadow = true;
    });
  };
  rig.set(cfg);
  return rig;
}
