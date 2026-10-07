"use client";
// The duel canvas: one requestAnimationFrame loop that asks `view()` for the frame to draw. React mounts it once and
// never re-renders it per frame.
import { useEffect, useRef } from "react";
import { createRenderer, type Renderer, type View } from "./render";

export function Stage({ view, big, hud, className, label, onRenderer }: { view: (now: number) => View | null; big?: boolean; hud?: boolean; className?: string; label: string; onRenderer?: (r: Renderer) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const q = new URLSearchParams(window.location.search);
    const reduceMotion = q.get("motion") === "reduce" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const r = createRenderer(c, { big, reduceMotion, hud });
    onRenderer?.(r);
    let raf = 0;
    const loop = (now: number) => {
      const v = viewRef.current(now);
      if (v) r.draw(v, now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(() => r.resize());
    ro.observe(c);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [big]);
  return <canvas ref={ref} className={className} aria-label={label} role="img" style={{ display: "block", width: "100%", height: "100%", touchAction: "none" }} />;
}
