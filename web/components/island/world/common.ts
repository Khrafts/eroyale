// Shared layout of the island: shoreline shape, heights, districts, and the obstacle book used to place props.
import * as THREE from "three";
import type { Kit } from "./materials";
import type { IslandSnap } from "@/lib/island/store";

export const G = 2.3;
export const SAND_Y = 1.6;
export const SAND = "#FFCF86";
export const GRASS = "#5FD36F";
export const PATH = "#FFEBDA";
export const PATH_EDGE = "#F7BFA6";
export const HORIZON = "#FFD1C1";
export const SUN_DIR = new THREE.Vector3(120, 150, 70).normalize();

/** Shoreline wobble: radius factor at angle `a`. */
export const f = (a: number, ph = 0) => 1 + 0.07 * Math.sin(3 * a + 0.5 + ph) + 0.04 * Math.sin(5 * a + 2 + ph * 2) + 0.02 * Math.sin(11 * a + ph * 3);
export function warp<T extends THREE.BufferGeometry>(geo: T, ph = 0): T {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    if (Math.abs(x) + Math.abs(z) < 1e-6) continue;
    const k = f(Math.atan2(z, x), ph);
    p.setX(i, x * k);
    p.setZ(i, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}
export const polar = (deg: number, r: number, c: [number, number] = [0, 0]): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
};

export const ISLET = polar(215, 102);
export const ISLET_PH = 1.3;
export const DECOR = polar(28, 108);
export const LH = polar(296, 72);

/** District: [angle in degrees, radius, inner clearance]. */
export const LAYOUT: Record<string, [number, number, number]> = {
  park: [38, 43, 14],
  observatory: [112, 44, 10],
  plotB: [74, 46, 7.5],
  wheel: [168, 45, 9],
  plotA: [258, 42, 7.5],
  arena: [322, 43, 13.5],
};

export type Ob = { x: number; z: number; r: number };

/** What every module gets: the scene kit, the seeded random stream (call order matters), and the placement book. */
export type Ctx = {
  kit: Kit;
  scene: THREE.Scene;
  R: () => number;
  mobile: boolean;
  reduceMotion: boolean;
  obstacles: Ob[];
  addOb: (x: number, z: number, r: number) => void;
  clear: (x: number, z: number, r: number) => boolean;
  /** Building roots that pop in on load and bounce on hover. */
  roots: THREE.Object3D[];
  /** Frame callbacks: dt seconds, t seconds since load, the current snapshot. */
  onFrame: ((dt: number, t: number, s: IslandSnap, ms: number) => void)[];
  dotTex: THREE.Texture;
  camera: THREE.PerspectiveCamera;
};

/** Put a building on its district, facing the plaza. */
export function place(ctx: Ctx, g: THREE.Object3D, deg: number, r: number, y = G) {
  const [x, z] = polar(deg, r);
  g.position.set(x, y, z);
  g.lookAt(0, y, 0);
  ctx.scene.add(g);
  ctx.roots.push(g);
  return g;
}
