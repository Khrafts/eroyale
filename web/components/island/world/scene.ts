// The island world: renderer, camera and controls, the build (order matters: one seeded random stream lays out
// everything), pointer picking, camera flights, the panel view offset, and the frame loop. Plain TypeScript; React
// talks to it through the returned API and it reads the store snapshot every frame.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { C, Cyl, makeKit, rng } from "./materials";
import { G, HORIZON, SAND_Y, SUN_DIR, type Ctx, type Ob } from "./common";
import { buildSky } from "./sky";
import { buildTerrain } from "./terrain";
import { buildWater } from "./water";
import { buildFountain, buildPlaza } from "./plaza";
import { buildArena } from "./buildings/arena";
import { buildObservatory } from "./buildings/observatory";
import { buildPark } from "./buildings/park";
import { buildWheel } from "./buildings/wheel";
import { buildPlots } from "./buildings/plots";
import { buildDojo } from "./buildings/dojo";
import { buildLighthouse } from "./buildings/lighthouse";
import { ADS, buildBillboards } from "./buildings/billboards";
import { buildProps } from "./props";
import { buildLife } from "./life";
import { makePicker } from "./picking";
import { makeLabels } from "./labels";
import { makeAvatar, type Rig } from "./avatar/rig";
import { pose } from "./avatar/dances";
import type { IslandSnap } from "@/lib/island/store";
import type { AvatarCfg } from "@/lib/island/avatar";

export type WorldCallbacks = {
  /** A building, jet, billboard or tag was clicked. */
  onPick: (id: string) => void;
  /** A click on nothing pickable. */
  onEmpty: () => void;
  /** The first drag, wheel or pinch. */
  onUserMoved: () => void;
};

export type World = {
  /** Fly the camera to a pickable. */
  focus: (id: string) => void;
  has: (id: string) => boolean;
  /** The open panel (for halos, tag hiding and the view offset). */
  setPanel: (route: string | null, el: HTMLElement | null) => void;
  resetView: () => void;
  /** List view: stop rendering. */
  setPaused: (p: boolean) => void;
  flare: () => void;
  celebrate: () => void;
  victory: () => void;
  mountPreview: (host: HTMLElement, cfg: AvatarCfg) => void;
  previewSet: (cfg: AvatarCfg) => void;
  dispose: () => void;
};

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

export function createWorld(canvas: HTMLCanvasElement, labelsHost: HTMLElement, getSnap: () => IslandSnap, cb: WorldCallbacks, reduceMotion: boolean): World | null {
  // r147 colour behaviour on a current three: no colour management, linear output.
  THREE.ColorManagement.enabled = false;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  let W = canvas.clientWidth || innerWidth;
  let H = canvas.clientHeight || innerHeight;
  const mobile = Math.min(W, H) < 640;
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.75 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // r186 dropped PCFSoftShadowMap (it falls back to this anyway)
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HORIZON, 260, 720);
  const kit = makeKit(scene);
  const disposers: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, k: K, f: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
    el.addEventListener(k, f as EventListener, o);
    disposers.push(() => el.removeEventListener(k, f as EventListener, o));
  };

  buildSky(scene);

  // camera + controls (the smooth wheel zoom is ours; registered before OrbitControls so it wins)
  const camera = new THREE.PerspectiveCamera(38, W / H, 0.5, 3000);
  const HOME = { target: new THREE.Vector3(0, 4, 0), pos: new THREE.Vector3(118, 104, 132).multiplyScalar(mobile ? 1.2 : 1) };
  camera.position.set(HOME.pos.x * 1.9, HOME.pos.y * 2.4, HOME.pos.z * 1.9);
  let zoomGoal: number | null = null;
  let fly: { t0: number; dur: number; fT: THREE.Vector3; tT: THREE.Vector3; fP: THREE.Vector3; tP: THREE.Vector3 } | null = null;
  let intro = true;
  const userMoved = () => {
    fly = null;
    intro = false;
    controls.autoRotate = false;
    cb.onUserMoved();
  };
  on(
    canvas,
    "wheel",
    (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const d = camera.position.distanceTo(controls.target);
      zoomGoal = THREE.MathUtils.clamp((zoomGoal ?? d) * Math.exp(e.deltaY * 0.0011), controls.minDistance, controls.maxDistance);
      fly = null;
      userMoved();
    },
    { capture: true, passive: false },
  );
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(HOME.target);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.065, rotateSpeed: 0.55, zoomSpeed: 0.8, panSpeed: 0.8, minDistance: 22, maxDistance: 300, maxPolarAngle: 1.32, minPolarAngle: 0.2, screenSpacePanning: false, autoRotate: false, autoRotateSpeed: 0.3 });
  controls.addEventListener("start", userMoved);

  // light (three r155+ lights are physical: intensities are the prototype's legacy values times PI)
  const PI = Math.PI;
  scene.add(new THREE.HemisphereLight("#C9B8FF", "#FFB38A", 0.5 * PI));
  scene.add(new THREE.AmbientLight("#ffffff", 0.06 * PI));
  const sunL = new THREE.DirectionalLight("#FFF1D6", 0.82 * PI);
  sunL.position.copy(SUN_DIR).multiplyScalar(260);
  sunL.castShadow = true;
  sunL.shadow.mapSize.set(mobile ? 2048 : 4096, mobile ? 2048 : 4096);
  Object.assign(sunL.shadow.camera, { left: -140, right: 140, top: 140, bottom: -140, near: 50, far: 600 });
  sunL.shadow.bias = -0.0004;
  sunL.shadow.normalBias = 0.05;
  scene.add(sunL);

  const dotTex = kit.cTex(64, 64, (cx) => {
    const g = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.45, "rgba(255,255,255,.9)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    cx.fillStyle = g;
    cx.fillRect(0, 0, 64, 64);
  }).tex;

  const obstacles: Ob[] = [];
  const ctx: Ctx = {
    kit,
    scene,
    R: rng(23),
    mobile,
    reduceMotion,
    obstacles,
    addOb: (x, z, r) => void obstacles.push({ x, z, r }),
    clear: (x, z, r) => obstacles.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r),
    roots: [],
    onFrame: [],
    dotTex,
    camera,
  };
  const snap0 = getSnap();

  // build, in the prototype's order (the random stream lays out every prop)
  buildTerrain(ctx);
  buildWater(ctx);
  buildPlaza(ctx);
  const { fountain, jetProxies } = buildFountain(ctx, snap0);
  const arenaH = buildArena(ctx, snap0);
  const { obs } = buildObservatory(ctx);
  const parkH = buildPark(ctx, snap0);
  const { wheelG } = buildWheel(ctx);
  const { plotA, plotB } = buildPlots(ctx);
  const { dojo } = buildDojo(ctx);
  const { lh } = buildLighthouse(ctx);
  const bb = buildBillboards(ctx, snap0);
  buildProps(ctx);
  const life = buildLife(ctx, snap0);

  // pickables
  let selected: string | null = null;
  let hovered: string | null = null;
  let panelEl: HTMLElement | null = null;
  const picker = makePicker(ctx, camera);
  const labels = makeLabels(labelsHost, (id) => cb.onPick(id));
  const reg = (id: string, root: THREE.Object3D, o: Parameters<typeof picker.register>[2]) => {
    const p = picker.register(id, root, o);
    labels.create(p);
    return p;
  };
  reg("fountain", fountain, { label: "The Fountain", line: "fountain.line", glyph: "✦", color: "#1EB3B0", haloR: 9.4, haloY: G + 0.45, anchorY: 14, minD: 70, prio: 3, focusDist: 52 });
  jetProxies.forEach(({ proxy, game }) => {
    const wp = new THREE.Vector3();
    proxy.getWorldPosition(wp);
    reg("jet:" + game.id, proxy, { route: game.route, label: game.name, line: "game." + game.id, glyph: game.short, color: game.color, haloR: 1.9, haloY: G + 1.9, anchor: new THREE.Vector3(wp.x, G + 13, wp.z), maxD: 70, prio: 1 });
  });
  reg("arena", arenaH.arena, { label: "The Arena", line: "royale.line", glyph: "TR", color: C.coral, haloR: 13.5, anchorY: 17, focusDist: 62 });
  reg("observatory", obs, { label: "The Observatory", line: "predict.line", glyph: "PP", color: C.violet, haloR: 8, anchorY: 20, focusDist: 60 });
  reg("dojo", dojo, { label: "The Dojo", line: "duel.line", glyph: "SD", color: C.tang, haloR: 11, anchorY: 18, focusDist: 62 });
  reg("park", parkH.park, { label: "Leaderboard Park", line: "park.line", glyph: "★", color: C.mint, haloR: 14.5, anchorY: 10, focusDist: 56 });
  reg("wheel", wheelG, { label: "Sky Wheel", line: "wheel.line", glyph: "◎", color: C.sky, haloR: 9, anchorY: 31, focusDist: 70, prio: 1.5 });
  reg("lighthouse", lh, { label: "The Lighthouse", line: "lh.line", glyph: "⚑", color: "#FF4F5E", haloR: 5.5, anchorY: 24, focusDist: 58, prio: 1.5 });
  reg("plotA", plotA, { label: "Plot 07", line: "plot.line", glyph: "+", color: "#3AAFD9", haloR: 10, anchorY: 7, focusDist: 48, prio: 1.2 });
  reg("plotB", plotB, { label: "Plot 11", line: "plot.line", glyph: "+", color: "#3AAFD9", haloR: 10, anchorY: 7, focusDist: 48, prio: 1.2 });
  ADS.forEach((ad) => reg(ad.id, bb.groups[ad.id], { color: "#FFFFFF", haloR: 7.5, haloY: SAND_Y, anchorY: 10, focusDist: 42 }));
  reg("blimp", life.blimp, { noFly: true });
  const mePick = reg("me", parkH.mine.root, { route: "studio", label: "You", line: "me.line", glyph: "☺", color: C.sun, anchorY: 5.6, focusDist: 26, prio: 2.5 });

  // camera flights
  const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  function flyTo(target: THREE.Vector3, pos: THREE.Vector3, dur = 1400) {
    controls.autoRotate = false;
    zoomGoal = null;
    if (reduceMotion || dur <= 0) {
      controls.target.copy(target);
      camera.position.copy(pos);
      return;
    }
    fly = { t0: performance.now(), dur, fT: controls.target.clone(), tT: target.clone(), fP: camera.position.clone(), tP: pos.clone() };
  }
  function focus(id: string) {
    const p = picker.picks.get(id) ?? picker.picks.get("fountain")!;
    if (p.noFly) return;
    const target = p.base.clone().add(new THREE.Vector3(0, (p.anchorY || 6) * 0.35, 0));
    const dir = camera.position.clone().sub(controls.target);
    dir.y = 0;
    dir.normalize();
    const out = new THREE.Vector3(p.base.x, 0, p.base.z);
    if (out.lengthSq() > 1) dir.lerp(out.normalize(), 0.7).normalize();
    const d = (p.focusDist || 50) * (W < 640 ? 1.55 : 1.22);
    flyTo(target, target.clone().add(new THREE.Vector3(dir.x * d * 0.8, d * 0.6, dir.z * d * 0.8)));
  }

  // pointer
  const ndc = new THREE.Vector2();
  let needHover = false;
  let down: { x: number; y: number } | null = null;
  const toNdc = (e: PointerEvent, out: THREE.Vector2) => {
    const r = canvas.getBoundingClientRect();
    return out.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  on(canvas, "pointermove", (e) => {
    if (e.pointerType === "mouse") {
      toNdc(e, ndc);
      needHover = true;
    }
  });
  on(canvas, "pointerleave", () => {
    hovered = null;
    canvas.style.cursor = "";
  });
  on(canvas, "pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
  });
  on(canvas, "pointerup", (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 6) return;
    const id = picker.pickAt(toNdc(e, new THREE.Vector2()));
    if (id) cb.onPick(id);
    else cb.onEmpty();
  });

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width || innerWidth;
    H = r.height || innerHeight;
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.fov = W < 640 ? 50 : 38;
    camera.updateProjectionMatrix();
    labels.measure(picker.picks);
  }
  on(window, "resize", resize);
  resize();
  const measureId = setInterval(() => labels.measure(picker.picks), 1500);
  disposers.push(() => clearInterval(measureId));
  if (document.fonts?.ready) {
    void document.fonts.ready
      .then(() => Promise.all(['800 40px Unbounded', '500 40px "JetBrains Mono"', '600 30px "Instrument Sans"'].map((s) => document.fonts.load(s).catch(() => []))))
      .then(() => {
        if (disposed) return;
        kit.texRedraws.forEach((fn) => fn());
        labels.measure(picker.picks);
      });
  }

  // victory: you take the top step and do your dance
  function startVictory() {
    const spot = parkH.startVictory();
    life.celebrate(parkH.parkPos);
    const toPlaza = new THREE.Vector3(-parkH.parkPos.x, 0, -parkH.parkPos.z).normalize();
    const d = W < 640 ? 24 : 17;
    flyTo(spot.clone().add(new THREE.Vector3(0, 2.4, 0)), spot.clone().add(toPlaza.multiplyScalar(d)).add(new THREE.Vector3(0, d * 0.45, 0)), 1700);
  }

  // studio preview: its own small renderer on a turntable
  let prev: { cv: HTMLCanvasElement; r: THREE.WebGLRenderer; sc: THREE.Scene; cam: THREE.PerspectiveCamera; rig: Rig; ry: number; vr: number; drag: number | null; shadow: THREE.Mesh; running: boolean } | null = null;
  function mountPreview(host: HTMLElement, cfg: AvatarCfg) {
    if (!prev) {
      const cv = document.createElement("canvas");
      cv.className = "stage-cv";
      const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
      r.outputColorSpace = THREE.LinearSRGBColorSpace;
      r.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.75 : 2));
      const sc = new THREE.Scene();
      sc.add(new THREE.HemisphereLight("#E4DAFF", "#FFC9A8", 0.7 * PI));
      const dl = new THREE.DirectionalLight("#FFF1D6", 0.85 * PI);
      dl.position.set(2, 4, 3);
      sc.add(dl);
      const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
      cam.position.set(0, 1.75, 5.9);
      cam.lookAt(0, 1.3, 0);
      const disc = new THREE.Mesh(Cyl(1.5, 1.6, 0.3, 40), kit.tm("#FFFBF5"));
      disc.position.y = -0.15;
      sc.add(disc);
      kit.addOutline(disc, 0.03);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.05, 6, 48), kit.basic(C.sun));
      ring.rotation.x = Math.PI / 2;
      sc.add(ring);
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.75, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: C.ink, transparent: true, opacity: 0.18 }));
      shadow.position.y = 0.01;
      sc.add(shadow);
      const rig = makeAvatar(kit, cfg);
      sc.add(rig.root);
      const p = { cv, r, sc, cam, rig, ry: 0.5, vr: 0, drag: null as number | null, shadow, running: false };
      prev = p;
      cv.addEventListener("pointerdown", (e) => {
        p.drag = e.clientX;
        cv.setPointerCapture(e.pointerId);
      });
      cv.addEventListener("pointermove", (e) => {
        if (p.drag == null) return;
        p.vr = (e.clientX - p.drag) * 0.012;
        p.ry += p.vr;
        p.drag = e.clientX;
      });
      cv.addEventListener("pointerup", () => {
        p.drag = null;
      });
    }
    const p = prev;
    host.prepend(p.cv);
    const w = host.clientWidth || 340;
    const h = host.clientHeight || 260;
    p.r.setSize(w, h, false);
    p.cam.aspect = w / h;
    p.cam.updateProjectionMatrix();
    p.rig.set(cfg);
    if (!p.running) {
      p.running = true;
      const loop = (ms: number) => {
        if (!p.cv.isConnected || disposed) {
          p.running = false;
          return;
        }
        requestAnimationFrame(loop);
        const t = ms / 1000;
        if (p.drag == null) {
          p.vr *= 0.94;
          p.ry += p.vr + (reduceMotion ? 0 : 0.004);
        }
        pose(p.rig, p.rig.cfg.dance, t, 1, p.ry);
        p.shadow.scale.setScalar(1 - Math.min(0.5, (p.rig.hips.position.y - 0.95) * 0.4));
        p.r.render(p.sc, p.cam);
      };
      requestAnimationFrame(loop);
    }
  }

  // frame loop
  let paused = false;
  let shift = 0;
  let shiftY = 0;
  let disposed = false;
  let raf = 0;
  const popStart = performance.now() + 250;
  ctx.roots.forEach((r, i) => {
    r.userData.base = r.scale.x;
    r.userData.delay = i * 110;
    r.userData.hs = 1;
    r.scale.setScalar(0.001);
  });
  const popEnd = popStart + (ctx.roots.length - 1) * 110 + 700;
  const backOut = (k: number) => {
    const c1 = 1.9;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
  };
  flyTo(HOME.target, HOME.pos, reduceMotion ? 0 : 3400);
  let last = performance.now();
  let lastLines = 0;
  let readyFlag = false;
  function frame(ms: number) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    if (paused) {
      last = ms;
      return;
    }
    const dt = Math.min(0.05, (ms - last) / 1000);
    last = ms;
    const t = ms / 1000;
    const s = getSnap();

    // pop-in + hover springs
    ctx.roots.forEach((r) => {
      const k = Math.min(1, Math.max(0, (ms - popStart - r.userData.delay) / 700));
      const id = r.userData.pickId as string | undefined;
      const p = id ? picker.picks.get(id) : undefined;
      const hot = !!id && (hovered === id || (!!p && selected === (p.route || id)));
      r.userData.hs += ((hot ? 1.035 : 1) - r.userData.hs) * Math.min(1, dt * 10);
      r.scale.setScalar(Math.max(0.001, (reduceMotion ? 1 : backOut(k)) * r.userData.base * r.userData.hs));
    });
    for (const f of ctx.onFrame) f(dt, t, s, ms);
    mePick.anchor.copy(parkH.mine.root.position).add(new THREE.Vector3(0, (5.6 * parkH.mine.root.scale.x) / 1.5, 0));
    mePick.base.copy(parkH.mine.root.position);

    // camera
    if (fly) {
      const k = Math.min(1, (ms - fly.t0) / fly.dur);
      const e = ease(k);
      controls.target.lerpVectors(fly.fT, fly.tT, e);
      camera.position.lerpVectors(fly.fP, fly.tP, e);
      if (k >= 1) {
        fly = null;
        if (intro) {
          intro = false;
          controls.autoRotate = !reduceMotion;
        }
      }
    }
    if (zoomGoal != null) {
      const off = camera.position.clone().sub(controls.target);
      const d = off.length();
      const nd = d + (zoomGoal - d) * Math.min(1, dt * 7);
      camera.position.copy(controls.target).add(off.setLength(nd));
      if (Math.abs(nd - zoomGoal) < 0.05) zoomGoal = null;
    }
    controls.update();
    const tg = controls.target;
    const tr = Math.hypot(tg.x, tg.z);
    if (tr > 115) {
      tg.x *= 115 / tr;
      tg.z *= 115 / tr;
    }
    tg.y = Math.min(20, Math.max(1, tg.y));
    const sxGoal = selected && W >= 900 ? 200 : 0;
    const syGoal = selected && W <= 640 ? H * 0.3 : 0;
    shift += (sxGoal - shift) * Math.min(1, dt * 6);
    shiftY += (syGoal - shiftY) * Math.min(1, dt * 6);
    if (Math.abs(shift) > 0.5 || Math.abs(shiftY) > 0.5) camera.setViewOffset(W, H, shift, shiftY, W, H);
    else if (camera.view) {
      camera.clearViewOffset();
      shift = shiftY = 0;
    }

    if (needHover) {
      needHover = false;
      const id = picker.pickAt(ndc);
      if (id !== hovered) {
        hovered = id;
        canvas.style.cursor = id ? "pointer" : "";
      }
    }
    picker.picks.forEach((p) => {
      if (!p.halo) return;
      const want = selected === (p.route || p.id) ? 0.75 + 0.2 * Math.sin(t * 4) : hovered === p.id ? 0.6 : 0;
      const m = p.halo.material as THREE.MeshBasicMaterial;
      m.opacity += (want - m.opacity) * Math.min(1, dt * 9);
      p.halo.scale.setScalar(1 + (want > 0 ? 0.04 * Math.sin(t * 4) : 0));
    });

    renderer.render(scene, camera);

    if (ms - lastLines > 250) {
      lastLines = ms;
      labels.refresh(s);
    }
    let panelRect = null;
    if (selected && panelEl && W > 640) {
      const pr = panelEl.getBoundingClientRect();
      panelRect = { l: pr.left - 8, r: pr.right, t: pr.top - 8, b: pr.bottom };
    }
    labels.layout(picker.picks, camera, W, H, selected, hovered, panelRect);
    if (!readyFlag && (reduceMotion || ms > popEnd)) {
      readyFlag = true;
      (window as unknown as { __islandReady?: boolean }).__islandReady = true;
    }
  }
  raf = requestAnimationFrame(frame);

  return {
    focus,
    has: (id) => picker.picks.has(id),
    setPanel: (route, el) => {
      selected = route;
      panelEl = el;
    },
    resetView: () => flyTo(HOME.target, HOME.pos, 1600),
    setPaused: (p) => {
      paused = p;
    },
    flare: () => arenaH.flare(),
    celebrate: () => {
      parkH.celebrate();
      life.celebrate(parkH.parkPos);
    },
    victory: startVictory,
    mountPreview,
    previewSet: (cfg) => prev?.rig.set(cfg),
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(raf);
      disposers.forEach((d) => d());
      controls.dispose();
      prev?.r.dispose();
      prev?.cv.remove();
      renderer.dispose();
      labelsHost.replaceChildren();
      (window as unknown as { __islandReady?: boolean }).__islandReady = false;
    },
  };
}
