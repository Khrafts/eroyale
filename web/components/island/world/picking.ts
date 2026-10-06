// Everything you can click: a registry of pickable roots with their halo ring, label anchor and camera framing.
import * as THREE from "three";
import type { Ctx } from "./common";

export type PickOpts = {
  route?: string;
  label?: string;
  line?: string;
  glyph?: string;
  color?: string;
  haloR?: number;
  haloY?: number;
  anchorY?: number;
  anchor?: THREE.Vector3;
  minD?: number;
  maxD?: number;
  prio?: number;
  focusDist?: number;
  noFly?: boolean;
};
export type Pick = PickOpts & {
  id: string;
  root: THREE.Object3D;
  base: THREE.Vector3;
  anchor: THREE.Vector3;
  prio: number;
  halo?: THREE.Mesh;
  el?: HTMLButtonElement;
  w: number;
  h: number;
  on: boolean;
};

export function makePicker(ctx: Ctx, camera: THREE.PerspectiveCamera) {
  const picks = new Map<string, Pick>();
  const pickRoots: THREE.Object3D[] = [];
  function register(id: string, root: THREE.Object3D, o: PickOpts = {}) {
    root.userData.pickId = id;
    pickRoots.push(root);
    const wp = new THREE.Vector3();
    root.getWorldPosition(wp);
    const p: Pick = { prio: 2, ...o, id, root, base: wp.clone(), anchor: o.anchor || wp.clone().add(new THREE.Vector3(0, o.anchorY || 6, 0)), w: 160, h: 44, on: false };
    if (o.haloR) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(o.haloR - 0.45, o.haloR, 96).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: o.color || "#fff", transparent: true, opacity: 0, depthWrite: false }),
      );
      ring.position.set(wp.x, (o.haloY ?? wp.y) + 0.1, wp.z);
      ring.renderOrder = 3;
      ctx.scene.add(ring);
      p.halo = ring;
    }
    picks.set(id, p);
    return p;
  }
  const ray = new THREE.Raycaster();
  function pickAt(n: THREE.Vector2): string | null {
    ray.setFromCamera(n, camera);
    for (const h of ray.intersectObjects(pickRoots, true)) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        if (o.userData.pickId) return o.userData.pickId as string;
        o = o.parent;
      }
    }
    return null;
  }
  return { picks, register, pickAt };
}
