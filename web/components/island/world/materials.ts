// Banded toon materials, ink outlines (inverted hull, pushed out in the vertex shader), merged multi-colour
// geometry, instancing and canvas textures. A port of the prototype's helpers onto three r186.
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ISLAND, coral, ink, ink2, mint, paper, sun, tang, violet } from "@/lib/theme";

/** The shared tokens (lib/theme.ts) under the short names the world uses. */
export const C = { coral, violet, tang, mint, sky: ISLAND.sky, sun, ink, ink2, paper, wave: ISLAND.wave, white: ISLAND.white, silver: ISLAND.silver, bronze: ISLAND.bronze };

export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PartOpts = { ol?: number | boolean; shadow?: boolean; receive?: boolean };
type Vec3 = [number, number, number];

export type Kit = ReturnType<typeof makeKit>;

export function makeKit(scene: THREE.Scene) {
  const gradMap = (() => {
    const d = new Uint8Array([110, 110, 110, 255, 175, 175, 175, 255, 228, 228, 228, 255, 255, 255, 255, 255]);
    const t = new THREE.DataTexture(d, 4, 1, THREE.RGBAFormat);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  })();
  const MC: Record<string, THREE.Material> = {};
  const toon = (c: string, o: THREE.MeshToonMaterialParameters = {}) => {
    const k = c + JSON.stringify(o, (_k, v) => (v && typeof v === "object" && "isTexture" in v ? v.uuid : v));
    return (MC[k] ??= new THREE.MeshToonMaterial({ color: c, gradientMap: gradMap, ...o })) as THREE.MeshToonMaterial;
  };
  const basic = (c: string, o: THREE.MeshBasicMaterialParameters = {}) => {
    const k = "b" + c + JSON.stringify(o);
    return (MC[k] ??= new THREE.MeshBasicMaterial({ color: c, ...o })) as THREE.MeshBasicMaterial;
  };
  /** A fresh toon material (one the caller will recolour). */
  const tm = (c: string) => new THREE.MeshToonMaterial({ color: c, gradientMap: gradMap });

  const OLC: Record<string, THREE.MeshBasicMaterial> = {};
  function outlineMat(th: number) {
    const key = th.toFixed(3);
    if (OLC[key]) return OLC[key];
    const m = new THREE.MeshBasicMaterial({ color: C.ink, side: THREE.BackSide });
    m.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\n transformed += normalize(normal) * ${key};`);
    };
    m.customProgramCacheKey = () => "ol" + key;
    return (OLC[key] = m);
  }
  const SM = new Map<string, THREE.BufferGeometry>();
  function smooth(geo: THREE.BufferGeometry) {
    const hit = SM.get(geo.uuid);
    if (hit) return hit;
    let g = geo.clone();
    ["normal", "uv", "uv1", "uv2", "color"].forEach((a) => g.attributes[a] && g.deleteAttribute(a));
    g = mergeVertices(g, 1e-3);
    g.computeVertexNormals();
    SM.set(geo.uuid, g);
    return g;
  }
  function addOutline(mesh: THREE.Mesh, th: number) {
    const o = new THREE.Mesh(smooth(mesh.geometry), outlineMat(th));
    o.raycast = () => {};
    mesh.add(o);
    return o;
  }
  /** One part: toon-shaded when `c` is a colour string, outlined unless `ol` is false. */
  function P(parent: THREE.Object3D, geo: THREE.BufferGeometry, c: string | THREE.Material | THREE.Material[], pos: Vec3 = [0, 0, 0], rot: Vec3 = [0, 0, 0], o: PartOpts = {}) {
    const m = new THREE.Mesh(geo, typeof c === "string" ? toon(c) : c);
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.set(rot[0], rot[1], rot[2]);
    m.castShadow = o.shadow !== false;
    m.receiveShadow = o.receive !== false;
    if (o.ol !== false && (typeof c === "string" || o.ol)) addOutline(m, typeof o.ol === "number" ? o.ol : 0.08);
    parent.add(m);
    return m;
  }
  const m4 = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  function partsGeo(parts: [THREE.BufferGeometry, string, THREE.Matrix4?][]) {
    return mergeGeometries(
      parts.map(([geo, color, m]) => {
        const g = geo.index ? geo.toNonIndexed() : geo.clone();
        ["uv", "uv1", "uv2"].forEach((a) => g.attributes[a] && g.deleteAttribute(a));
        if (m) g.applyMatrix4(m);
        const n = g.attributes.position.count;
        const col = new Float32Array(n * 3);
        const c = new THREE.Color(color);
        for (let i = 0; i < n; i++) {
          col[i * 3] = c.r;
          col[i * 3 + 1] = c.g;
          col[i * 3 + 2] = c.b;
        }
        g.setAttribute("color", new THREE.BufferAttribute(col, 3));
        return g;
      }),
    );
  }
  function instanced(geo: THREE.BufferGeometry, items: { m: THREE.Matrix4; c?: string }[], ol = 0.07) {
    if (!items.length) return null;
    const im = new THREE.InstancedMesh(geo, toon("#ffffff", { vertexColors: true }), items.length);
    items.forEach((it, i) => {
      im.setMatrixAt(i, it.m);
      im.setColorAt(i, new THREE.Color(it.c || "#ffffff"));
    });
    im.castShadow = im.receiveShadow = true;
    im.frustumCulled = false;
    scene.add(im);
    if (ol) {
      const o = new THREE.InstancedMesh(smooth(geo), outlineMat(ol), items.length);
      o.instanceMatrix = im.instanceMatrix;
      o.frustumCulled = false;
      o.raycast = () => {};
      scene.add(o);
    }
    return im;
  }
  const texRedraws: (() => void)[] = [];
  function cTex(w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 8;
    const redraw = () => {
      ctx.clearRect(0, 0, w, h);
      draw(ctx, w, h);
      t.needsUpdate = true;
    };
    redraw();
    texRedraws.push(redraw);
    return { tex: t, redraw };
  }
  return { scene, gradMap, toon, basic, tm, outlineMat, smooth, addOutline, P, m4, partsGeo, instanced, cTex, texRedraws };
}

export function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
export function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number) {
  let line = "";
  for (const w of text.split(" ")) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      ctx.fillText(line, x, y);
      line = w;
      y += lh;
    } else line = t;
  }
  ctx.fillText(line, x, y);
  return y;
}

export const Cyl = (...a: ConstructorParameters<typeof THREE.CylinderGeometry>) => new THREE.CylinderGeometry(...a);
export const Box = (...a: ConstructorParameters<typeof THREE.BoxGeometry>) => new THREE.BoxGeometry(...a);
export const Sph = (...a: ConstructorParameters<typeof THREE.SphereGeometry>) => new THREE.SphereGeometry(...a);
export const Ico = (...a: ConstructorParameters<typeof THREE.IcosahedronGeometry>) => new THREE.IcosahedronGeometry(...a);
