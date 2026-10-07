// TEMPORARY: stands in for shared/duel.ts until the duel-sim track lands it in feat/duel. Same signature as
// CLAUDE.md "Rules: shared/duel.ts". Deleted (and the import switched to ../../shared/duel.ts) after the merge.
export function replay(_a: string, _b: string): { winner: 0 | 1 | null; rounds: [number, number]; ticks: number; hash: string } {
  throw new Error("shared/duel.ts has not landed yet");
}
