"use client";
// The arena in the island's world: the lobby as a toon island under the island's sky, equity as altitude, the zone
// as the island's sea. Prediction lobbies draw the same world as a price chart (b/predict.ts) on the same canvas.
import { useEffect, useRef } from "react";
import type { ArenaProps } from "./types";
import { FONT, RADIUS, SHADOW, canvasFont, ink, ink2, paper, skyTop } from "@/lib/theme";
import { cfgFor, loadAvatar } from "@/lib/island/avatar";
import { rgba } from "./b/draw";
import { Scene } from "./b/scene";
import type { PredictScene } from "./b/predict";

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
    const scene = new Scene();
    // The prediction scene loads in its own chunk, so the royale arena's first load stays small.
    let pscene: PredictScene | null = null;
    let alive = true;
    // A failed chunk load (a flaky network at the venue) retries with backoff; until then the sky is drawn.
    const loadPredict = (tries: number) => {
      import("./b/predict")
        .then((m) => {
          if (!alive) return;
          pscene = new m.PredictScene();
          pscene.me = scene.me;
        })
        .catch(() => {
          if (alive) setTimeout(() => loadPredict(tries + 1), Math.min(30000, 1000 * 2 ** tries));
        });
    };
    loadPredict(0);
    const clear = () => {
      scene.T.cache.clear();
      pscene?.T.cache.clear();
    };
    const fonts = [canvasFont("display", 800, 40), canvasFont("body", 600, 20), canvasFont("mono", 800, 40), canvasFont("mono", 600, 20)];
    Promise.all(fonts.map((f) => document.fonts.load(f)))
      .catch(() => undefined)
      .then(clear);
    document.fonts.addEventListener("loadingdone", clear);

    // Your own avatar, when this browser already has a well-formed burner key (the phone's). burner() would create
    // or replace the key otherwise, so the arena only calls it when the stored key already has burner()'s format.
    // Same rule as /play: your saved look if you saved one, else the address-derived look everyone else sees.
    try {
      if (/^0x[0-9a-f]{64}$/i.test(localStorage.getItem("royale.burner") ?? "")) {
        void import("@/lib/engine")
          .then((e) => {
            if (!alive) return;
            const address = e.burner().address.toLowerCase();
            let saved = false;
            try {
              saved = localStorage.getItem(`royale.avatar.${address}`) !== null;
            } catch {
              /* storage blocked */
            }
            const me = { address, cfg: saved ? loadAvatar(address) : cfgFor(address, "") };
            scene.me = me;
            if (pscene) pscene.me = me;
          })
          .catch(() => undefined);
      }
    } catch {
      /* storage blocked: everyone gets the address-derived look */
    }

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
      ctx.fillStyle = skyTop;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, DW, DH);
      ctx.clip();
      const st = m.ref.current;
      if (st.mode !== "predict") scene.frame(ctx, st, m.clock(), dt, m.reducedMotion);
      else if (pscene) pscene.frame(ctx, st, m.clock(), dt, m.reducedMotion);
      else scene.sky.draw(ctx, 0, true);
      ctx.restore();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.fonts.removeEventListener("loadingdone", clear);
    };
  }, []);

  const st = match.state;
  const alive = st.board ? st.board.rows.filter((r) => r.alive).length : st.players.length;
  const predict = st.mode === "predict";
  const label = predict
    ? `Trading Royale prediction round ${st.lobbyId ?? ""}, ${st.status ?? "loading"}, ${st.players.length} players`
    : `Trading Royale arena, ${st.status ?? "loading"}, ${alive} players standing`;
  return (
    <main style={{ position: "fixed", inset: 0, background: skyTop, overflow: "hidden", fontFamily: FONT.body, color: ink }}>
      <canvas ref={canvasRef} role="img" aria-label={label} style={{ width: "100%", height: "100%", display: "block" }} />
      {(st.error || st.status === "cancelled" || st.cancelled) && (
        <div
          role="alert"
          style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: rgba(ink, 0.45), padding: 48 }}
        >
          <div
            style={{
              background: paper,
              border: `3px solid ${ink}`,
              borderRadius: RADIUS.panel,
              boxShadow: SHADOW.panel,
              padding: "40px 56px",
              textAlign: "center",
              maxWidth: "52ch",
            }}
          >
            <p style={{ fontFamily: FONT.display, fontSize: 56, fontWeight: 800, margin: 0, lineHeight: 1.1 }}>
              {st.error ? "The arena is not connected" : predict ? "This round was called off" : "This match was called off"}
            </p>
            <p style={{ fontSize: 28, margin: "20px auto 0", color: ink2 }}>
              {st.error ??
                (predict
                  ? `${st.cancelReason ? `${st.cancelReason.charAt(0).toUpperCase()}${st.cancelReason.slice(1).replace(/[.\s]+$/, "")}. ` : ""}Every entry is refunded on chain. The next protocol round shows up here.`
                  : "Not enough players made it in. Every entry is refunded on chain. The next lobby opens here.")}
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
