// Procedural poses (the prototype's `pose`): k is intensity (about .3 idle groove, 1 full victory).
import type { Rig } from "./rig";

export function pose(rig: Rig, dance: string, t: number, k: number, baseRy = 0) {
  const { hips, head, armL, armR, legL, legR } = rig;
  const s = Math.sin;
  const c = Math.cos;
  hips.position.set(0, 0.95, 0);
  hips.rotation.set(0, 0, 0);
  head.rotation.set(0, 0, 0);
  armL.rotation.set(0, 0, -0.12);
  armR.rotation.set(0, 0, 0.12);
  legL.rotation.set(0, 0, 0);
  legR.rotation.set(0, 0, 0);
  let ry = 0;
  let fl = 0;
  if (dance === "hype") {
    const b = Math.abs(s(t * 6));
    hips.position.y += b * 0.45 * k;
    fl = b;
    armL.rotation.z = -(0.3 + (s(t * 6) * 0.5 + 0.5) * 2.6 * k);
    armR.rotation.z = 0.3 + (c(t * 6) * 0.5 + 0.5) * 2.6 * k;
    legL.rotation.x = -b * 0.6 * k;
    legR.rotation.x = b * 0.3 * k;
    head.rotation.x = -b * 0.25 * k;
  } else if (dance === "spin") {
    ry = t * 7 * k;
    hips.position.y += Math.abs(s(t * 3.5)) * 0.25 * k;
    fl = 1;
    armL.rotation.z = -1.45 * Math.min(1, k * 1.4);
    armR.rotation.z = 1.45 * Math.min(1, k * 1.4);
    head.rotation.z = s(t * 3.5) * 0.2;
    legL.rotation.z = -0.15 * k;
    legR.rotation.z = 0.15 * k;
  } else if (dance === "floss") {
    const p = s(t * 8);
    const q = c(t * 8);
    hips.position.x = -p * 0.14 * k;
    hips.rotation.z = p * 0.12 * k;
    armL.rotation.set(q * 0.45 * k, 0, p * 0.75 * k - 0.1);
    armR.rotation.set(-q * 0.45 * k, 0, p * 0.75 * k + 0.1);
    head.rotation.z = -p * 0.12 * k;
    fl = Math.abs(p);
  } else if (dance === "robot") {
    const st = Math.floor(t * 4);
    const i = st % 4;
    armL.rotation.x = -[0, 1.57, 1.57, 0.8][i] * k;
    armR.rotation.x = -[1.57, 1.57, 0, 0.8][i] * k;
    armL.rotation.z = -[0.1, 0.1, 1.2, 0.1][i] * k;
    armR.rotation.z = [1.2, 0.1, 0.1, 0.1][i] * k;
    head.rotation.y = [0, 0.6, 0, -0.6][i] * k;
    ry = [0, 0.3, 0, -0.3][Math.floor(st / 4) % 4] * k;
    hips.position.y += (st % 2) * 0.05 * k;
  } else if (dance === "disco") {
    const u = s(t * 4) * 0.5 + 0.5;
    armR.rotation.z = 0.6 + 2.2 * u * k;
    armR.rotation.x = -0.3 * k;
    armL.rotation.set(-0.5 * k, 0, -0.8 * k);
    hips.rotation.z = (u - 0.5) * 0.25 * k;
    hips.position.x = (u - 0.5) * 0.2 * k;
    legR.rotation.z = (u - 0.5) * 0.3 * k;
    head.rotation.z = (u - 0.5) * -0.3 * k;
    ry = (u - 0.5) * 0.4 * k;
    fl = u;
  } else if (dance === "flip") {
    const p = (t % 2.6) / 2.6;
    if (p < 0.45) {
      const q = p / 0.45;
      hips.position.y += s(q * Math.PI) * 1.5 * k;
      hips.rotation.x = -q * Math.PI * 2 * Math.min(1, k);
      armL.rotation.z = -2.7 * k;
      armR.rotation.z = 2.7 * k;
      legL.rotation.x = legR.rotation.x = -s(q * Math.PI) * 1.2 * k;
      fl = 1;
    } else {
      const q = (p - 0.45) / 0.55;
      hips.rotation.x = s(q * Math.PI) * 0.6 * k;
      armR.rotation.x = -s(q * Math.PI) * 1.2 * k;
      armL.rotation.z = -0.4 * k;
      head.rotation.x = s(q * Math.PI) * 0.3 * k;
    }
  } else {
    hips.position.y += Math.abs(s(t * 2)) * 0.04;
    armL.rotation.z = -0.15 - s(t * 2) * 0.05;
    armR.rotation.z = 0.15 + s(t * 2) * 0.05;
  }
  rig.root.rotation.y = baseRy + ry;
  if (rig.cape) rig.cape.rotation.x = 0.15 + fl * 0.5 * Math.min(1, k);
}
