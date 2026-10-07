"use client";
// The island in its own chunk, client only (three.js and the world load later still, and only with WebGL).
import dynamic from "next/dynamic";
import { ISLAND, coral, ink, paper, skyTop, sun } from "@/lib/theme";

const Island = dynamic(() => import("./ui/Island"), { ssr: false, loading: Loader });

/** Shown while the island chunk downloads: the wordmark over the sky with a bobbing sun and a bar. */
function Loader() {
  return (
    <main className="isle-loader" style={{ position: "fixed", inset: 0, background: `linear-gradient(${skyTop}, ${ISLAND.backdrop})`, display: "grid", placeItems: "center" }} role="status" aria-label="Loading the island">
      <style>{`
.isle-loader .w{display:flex;flex-direction:column;align-items:center;gap:18px}
.isle-loader .sun{width:64px;height:64px;border-radius:50%;background:${sun};border:3px solid ${ink};box-shadow:0 6px 0 ${ink};animation:ilb 1.1s ease-in-out infinite alternate}
.isle-loader h1{margin:0;font:800 30px/1 var(--display, sans-serif);color:${paper};-webkit-text-stroke:1.5px ${ink};letter-spacing:-.01em}
.isle-loader .bar{width:200px;height:14px;border:3px solid ${ink};border-radius:999px;background:${paper};overflow:hidden;position:relative;box-shadow:0 3px 0 ${ink}}
.isle-loader .bar span{position:absolute;inset:0 auto 0 -40%;width:40%;background:${coral};border-radius:999px;animation:ils 1.2s ease-in-out infinite}
.isle-loader p{margin:0;font:600 14px/1 var(--body, sans-serif);color:${ink}}
@keyframes ilb{to{transform:translateY(-10px)}}@keyframes ils{to{left:100%}}
@media (prefers-reduced-motion:reduce){.isle-loader .sun,.isle-loader .bar span{animation:none}}
`}</style>
      <div className="w">
        <div className="sun" />
        <h1>Royale Isle</h1>
        <div className="bar"><span /></div>
        <p>Raising the island</p>
      </div>
    </main>
  );
}
export default function IslandRoot() {
  return <Island />;
}
