// The island's Dojo from GET /duels: recent results (queue size and live duels are not shown while ranked is "Coming
// soon"). A tiny store of its own (the island's
// IslandSnap stays as it is); the Dojo panel, the list card, the Dojo label and the Duel fountain jet read it.
// Polled every 3 s while the island is open, paused while the tab is hidden; ?mock=island uses mockDuels().
import { useSyncExternalStore } from "react";
import { engineHttp } from "@/lib/engineUrl";
import { parseDuels, type DuelsInfo } from "./types";

export type DojoSnap = { state: "loading" | "ok" | "missing" | "down" | "none"; info: DuelsInfo | null };
let snap: DojoSnap = { state: "loading", info: null };
const subs = new Set<() => void>();
const set = (s: DojoSnap) => {
  snap = s;
  subs.forEach((f) => f());
};
export const getDojo = () => snap;
export const setDojoMock = (info: DuelsInfo) => set({ state: "ok", info });
export const useDojo = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => snap,
    () => snap,
  );

/** The Duel fountain jet's player count: fixed at 0 (the jet stays low) while ranked is "Coming soon" (CLAUDE.md
 *  "Duel tuning"); the queue and live duels are no longer a way in. */
export const dojoPlayers = (_s: DojoSnap = snap) => 0;

export function startDojoPoll(): () => void {
  if (!process.env.NEXT_PUBLIC_ENGINE_WS && !process.env.NEXT_PUBLIC_ENGINE_HTTP) {
    set({ state: "none", info: null });
    return () => {};
  }
  let stop = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    if (stop) return;
    if (document.hidden) {
      timer = setTimeout(poll, 1000);
      return;
    }
    try {
      const r = await fetch(`${engineHttp()}/duels`, { cache: "no-store" });
      if (r.status === 404) set({ state: "missing", info: null });
      else if (!r.ok) set({ state: "down", info: snap.info });
      else set({ state: "ok", info: parseDuels(await r.json()) });
    } catch {
      set({ state: "down", info: snap.info });
    }
    if (!stop) timer = setTimeout(poll, snap.state === "ok" ? 3000 : 5000);
  };
  void poll();
  return () => {
    stop = true;
    clearTimeout(timer);
  };
}

export function dojoLine(_s: DojoSnap = snap): string {
  return "Practice free · ranked coming soon";
}
