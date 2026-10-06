"use client";
// Arena variant B, the storm: the lobby as a mountain range, equity as altitude, the zone as a flood.
import { useEffect, useRef } from "react";
import type { ArenaProps } from "./types";
import { condensed, extra } from "./b/fonts";
import { C } from "./b/draw";
import { Scene } from "./b/scene";

const DW = 1920;
const DH = 1080;

export default function VariantB({ match }: ArenaProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const matchRef = useRef(match);
  matchRef.current = match;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const scene = new Scene(condensed.style.fontFamily, extra.style.fontFamily);
    const fonts = [
      `800 40px ${condensed.style.fontFamily}`,
      `500 20px ${condensed.style.fontFamily}`,
      `700 40px ${extra.style.fontFamily}`,
    ];
    Promise.all(fonts.map((f) => document.fonts.load(f)))
      .catch(() => undefined)
      .then(() => scene.T.cache.clear());
    const onFonts = () => scene.T.cache.clear();
    document.fonts.addEventListener("loadingdone", onFonts);

    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
      last = t;
      const m = matchRef.current;
      const s = Math.min(w / DW, h / DH);
      const ox = (w - DW * s) / 2;
      const oy = (h - DH * s) / 2;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = C.sky;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, DW, DH);
      ctx.clip();
      scene.frame(ctx, m.ref.current, m.clock(), dt, m.reducedMotion);
      ctx.restore();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.fonts.removeEventListener("loadingdone", onFonts);
    };
  }, []);

  const st = match.state;
  const alive = st.board ? st.board.rows.filter((r) => r.alive).length : st.players.length;
  return (
    <main
      className={`${condensed.className} ${extra.className}`}
      style={{ position: "fixed", inset: 0, background: C.sky, overflow: "hidden" }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Trading Royale arena, ${st.status ?? "loading"}, ${alive} players standing`}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      {(st.error || st.status === "cancelled") && (
        <div
          role="alert"
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            background: "rgba(23,41,48,0.86)",
            color: C.chalk,
            textAlign: "center",
            padding: 48,
          }}
        >
          <div>
            <p style={{ fontSize: 72, fontWeight: 800, margin: 0 }}>
              {st.error ? "The arena is not connected" : "This match was called off"}
            </p>
            <p style={{ fontSize: 30, margin: "16px auto 0", maxWidth: "40ch" }}>
              {st.error ?? "Not enough players made it in. Every entry is refunded on chain. The next lobby opens here."}
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
