"use client";
// Arena variant C, the specimen: the lobby as a stained culture under the microscope.
import { useEffect, useRef } from "react";
import { Bodoni_Moda } from "next/font/google";
import type { ArenaProps } from "./types";
import { H, PAL, Scene, W } from "./c/scene";

const bodoni = Bodoni_Moda({ subsets: ["latin"], weight: "variable", axes: ["opsz"], display: "block" });

export default function VariantC({ match }: ArenaProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reducedRef = useRef(match.reducedMotion);
  reducedRef.current = match.reducedMotion;
  const { ref, clock } = match;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const scene = new Scene();
    scene.type.setFamily(bodoni.style.fontFamily);
    let alive = true;
    const fonts = [400, 600, 700, 800, 900].map((w) => document.fonts.load(`${w} 40px ${bodoni.style.fontFamily}`));
    Promise.all(fonts).then(() => alive && scene.type.reset());
    const onFonts = () => scene.type.reset();
    document.fonts.addEventListener("loadingdone", onFonts);

    let cw = 0;
    let ch = 0;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cw = Math.round(window.innerWidth * dpr);
      ch = Math.round(window.innerHeight * dpr);
      canvas.width = cw;
      canvas.height = ch;
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      const s = ref.current;
      const t = clock();
      scene.update(dt, s, t, reducedRef.current);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = PAL.eosin;
      ctx.fillRect(0, 0, cw, ch);
      const k = Math.min(cw / W, ch / H);
      ctx.setTransform(k, 0, 0, k, (cw - W * k) / 2, (ch - H * k) / 2);
      scene.draw(ctx, s, t, reducedRef.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.fonts.removeEventListener("loadingdone", onFonts);
    };
  }, [ref, clock]);

  const s = match.state;
  const aliveN = s.board ? s.board.rows.filter((r) => r.alive).length : s.players.length;
  const label = s.final
    ? `Final. ${s.final.finalists.map((f) => f.callsign).join(", ")} survive.`
    : `${s.status ?? "connecting"}: ${aliveN} of ${s.players.length} players alive.`;

  return (
    <main
      className={bodoni.className}
      style={{ position: "fixed", inset: 0, background: PAL.eosin, overflow: "hidden" }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        style={{ width: "100vw", height: "100vh", display: "block" }}
      />
      <span aria-hidden style={{ position: "absolute", opacity: 0, pointerEvents: "none", fontWeight: 800 }}>
        Specimen 0123456789
      </span>
    </main>
  );
}
