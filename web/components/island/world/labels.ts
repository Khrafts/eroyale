// Floating tags over each building. Each frame they are projected to the screen; a lower-priority tag that would
// overlap one already placed (or the top bar, or the open panel) hides instead.
import * as THREE from "three";
import type { Pick } from "./picking";
import { lineOf } from "@/lib/island/format";
import type { IslandSnap } from "@/lib/island/store";

export function makeLabels(host: HTMLElement, onClick: (id: string) => void) {
  const lines = new Map<HTMLElement, string>();
  function create(p: Pick) {
    if (!p.label) return;
    const el = document.createElement("button");
    el.className = "tag off";
    el.style.setProperty("--c", p.color ?? "#fff");
    const ic = document.createElement("span");
    ic.className = "ic";
    ic.textContent = p.glyph ?? "";
    const tx = document.createElement("span");
    tx.className = "tx";
    const tn = document.createElement("span");
    tn.className = "tn";
    tn.textContent = p.label;
    tx.appendChild(tn);
    if (p.line) {
      const tl = document.createElement("span");
      tl.className = "tl";
      tx.appendChild(tl);
      lines.set(tl, p.line);
    }
    el.append(ic, tx);
    el.addEventListener("click", () => onClick(p.id));
    host.appendChild(el);
    p.el = el;
  }
  function refresh(s: IslandSnap) {
    lines.forEach((key, el) => {
      const v = lineOf(key, s);
      if (el.textContent !== v) el.textContent = v;
    });
  }
  function measure(picks: Map<string, Pick>) {
    picks.forEach((p) => {
      if (p.el) {
        p.w = p.el.offsetWidth || p.w;
        p.h = p.el.offsetHeight || p.h;
      }
    });
  }
  const v = new THREE.Vector3();
  const vis: { p: Pick; x: number; y: number; d: number }[] = [];
  type Rect = { l: number; r: number; t: number; b: number };
  function layout(picks: Map<string, Pick>, camera: THREE.PerspectiveCamera, W: number, H: number, selected: string | null, hovered: string | null, panel: Rect | null) {
    vis.length = 0;
    picks.forEach((p) => {
      if (!p.el) return;
      v.copy(p.anchor).project(camera);
      const d = camera.position.distanceTo(p.anchor);
      const ok = v.z < 1 && d >= (p.minD || 0) && d <= (p.maxD || 1e9) && Math.abs(v.x) < 1.02 && Math.abs(v.y) < 1.02;
      if (ok) vis.push({ p, x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, d });
      else p.on = false;
    });
    vis.sort((a, b) => Number(b.p.id === selected) - Number(a.p.id === selected) || b.p.prio - a.p.prio || a.d - b.d);
    const placed: Rect[] = [];
    if (panel) placed.push(panel);
    placed.push({ l: 0, r: W, t: -100, b: 62 });
    vis.forEach((o) => {
      const r = { l: o.x - o.p.w / 2 - 4, r: o.x + o.p.w / 2 + 4, t: o.y - o.p.h - 14, b: o.y - 6 };
      const hit = placed.some((q) => !(r.r < q.l || r.l > q.r || r.b < q.t || r.t > q.b));
      o.p.on = !hit;
      if (!hit) {
        placed.push(r);
        o.p.el!.style.transform = `translate3d(${o.x}px,${o.y - 12}px,0) translate(-50%,-100%)`;
        o.p.el!.style.zIndex = String(2000 - Math.round(o.d));
      }
    });
    picks.forEach((p) => {
      if (!p.el) return;
      if (p.el.classList.contains("off") === p.on) p.el.classList.toggle("off", !p.on);
      const hot = hovered === p.id || selected === (p.route || p.id);
      if (p.el.classList.contains("hot") !== hot) p.el.classList.toggle("hot", hot);
    });
  }
  return { create, refresh, measure, layout };
}
