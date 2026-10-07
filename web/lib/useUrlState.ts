"use client";
// The URL holds the screen (CLAUDE.md "Navigation" rules 4 and 7). One hook for every in-page move:
//   push(set)        drill down: a new history entry (browser Back returns here)
//   replace(set)     a lateral move (a tab, Island/List, a bot level): same entry
//   back(parent)     go to the parent: history.back() when the previous entry is that parent (so Back and the back
//                    control agree), else replaceState to it (a deep link has no parent entry to go back to)
// `set` changes only the keys it names (null deletes one); every other parameter (mock, at, speed, seed, me, motion,
// ...) is kept. The returned `params` re-read on popstate and after every move, and are empty during server render
// and hydration (read them after mount, as the screens do today).
import { useCallback, useMemo, useSyncExternalStore } from "react";

export type ParamSet = Record<string, string | number | null | undefined>;
const EVT = "urlstate";
const FROM = "__navFrom"; // the URL a pushed entry was pushed from

/** The current path and query with `set` applied (null/undefined deletes a key); every other parameter kept. */
export function withParams(set: ParamSet, path?: string, search: string = typeof location === "undefined" ? "" : location.search): string {
  const q = new URLSearchParams(search);
  for (const [k, v] of Object.entries(set)) {
    if (v === null || v === undefined) q.delete(k);
    else q.set(k, String(v));
  }
  const s = q.toString();
  return `${path ?? (typeof location === "undefined" ? "/" : location.pathname)}${s ? `?${s}` : ""}`;
}

const here = () => location.pathname + location.search;
// Every history write re-reads the URL, whoever makes it: the kit's AppLink moves with Next's router, which writes
// history itself (its HistoryUpdater) and fires no popstate. Wrap pushState/replaceState once and announce each write
// (in a microtask: Next writes from an insertion effect, where no update may be scheduled).
let patched = false;
function patchHistory() {
  if (patched) return;
  patched = true;
  for (const k of ["pushState", "replaceState"] as const) {
    const orig = history[k];
    history[k] = function (this: History, ...a: Parameters<History["pushState"]>) {
      const r = orig.apply(this, a);
      queueMicrotask(() => dispatchEvent(new Event(EVT)));
      return r;
    };
  }
}
const subscribe = (cb: () => void) => {
  patchHistory();
  addEventListener("popstate", cb);
  addEventListener(EVT, cb);
  return () => {
    removeEventListener("popstate", cb);
    removeEventListener(EVT, cb);
  };
};
const snap = () => location.search;
const serverSnap = () => "";

function write(url: string, push: boolean, state: Record<string, unknown> | null) {
  if (url === here()) return;
  try {
    if (push) history.pushState(state, "", url);
    // only our own key: Next's internal flags (__NA) copied into the state would make Next's router ignore the move
    // (useSearchParams would keep the old URL); Next copies its own tree into the new state itself
    else history.replaceState({ [FROM]: (history.state as Record<string, unknown> | null)?.[FROM] ?? null, ...(state ?? {}) }, "", url);
  } catch {
    /* ignore: a sandboxed frame */
  }
  dispatchEvent(new Event(EVT));
}

export function useUrlState() {
  const search = useSyncExternalStore(subscribe, snap, serverSnap);
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const push = useCallback((set: ParamSet, path?: string) => write(withParams(set, path), true, { [FROM]: here() }), []);
  const replace = useCallback((set: ParamSet, path?: string) => write(withParams(set, path), false, null), []);
  const back = useCallback((parent: ParamSet, path?: string) => {
    const url = withParams(parent, path);
    if ((history.state as Record<string, unknown> | null)?.[FROM] === url) history.back();
    else write(url, false, { [FROM]: null });
  }, []);
  return { params, push, replace, back };
}
