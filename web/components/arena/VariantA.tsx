"use client";
import type { ArenaProps } from "./types";

export default function VariantA({ match }: ArenaProps) {
  const { state } = match;
  return (
    <main style={{ width: "100vw", height: "100vh", display: "grid", placeItems: "center" }}>
      <p>Variant A placeholder: {state.status} t={state.t} alive={state.board?.rows.filter((r) => r.alive).length}</p>
    </main>
  );
}
