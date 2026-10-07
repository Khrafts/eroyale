"use client";
// The island in its own chunk, client only (three.js and the world load later still, and only with WebGL).
import dynamic from "next/dynamic";
import { ISLAND } from "@/lib/theme";

const Island = dynamic(() => import("./ui/Island"), { ssr: false, loading: () => <main style={{ position: "fixed", inset: 0, background: ISLAND.backdrop }} /> });
export default function IslandRoot() {
  return <Island />;
}
