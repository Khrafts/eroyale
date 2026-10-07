"use client";
// The island screen: mounts the 3D world (loaded on demand, only with WebGL) and renders the UI around it: top bar,
// floating tags, feed, panels, avatar studio and the list view. React never re-renders per frame; the world reads
// the store snapshot itself.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useUrlState } from "@/lib/useUrlState";
import "./island.css";
import { emit, getSnapshot, onBus, setSnap, useIsland } from "@/lib/island/store";
import { IslandLive, feed } from "@/lib/island/live";
import { ISLAND_MOMENTS, mockIsland, type IslandMoment } from "@/lib/island/mock";
import { CALLSIGN_KEY, danceName, loadAvatar } from "@/lib/island/avatar";
import { burner } from "@/lib/engine";
import { usdc } from "@/lib/island/format";
import { ink } from "@/lib/theme";
import type { World } from "../world/scene";
import { TopBar } from "./TopBar";
import { Feed } from "./Feed";
import { Panel } from "./Panel";
import { ListView } from "./ListView";
import { mockDuels } from "../../duel/mock";
import { setDojoMock, startDojoPoll } from "../../duel/dojo";

/** A pickable's panel: jets open their game, your avatar opens the studio. */
const ROUTE: Record<string, string> = { "jet:royale": "arena", "jet:predict": "observatory", "jet:duel": "dojo", "jet:create": "create", me: "studio" };
export const routeOf = (id: string) => ROUTE[id] ?? id;
/** The pickable the camera frames for a panel. */
const focusOf = (route: string) => (route === "studio" ? "me" : route);

// The island was already shown in this document (an in-app page came back to it): no intro swoop the second time.
let shownBefore = false;
function arrivedInApp(): boolean {
  if (shownBefore) return true;
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return !!nav && new URL(nav.name).pathname !== "/";
  } catch {
    return false;
  }
}

export type IslandApi = {
  select: (id: string) => void;
  close: () => void;
  toast: (t: string) => void;
  world: World | null;
  setList: (b: boolean) => void;
  /** The brand chip on the island: close the panel, leave the list, reset the camera. */
  home: () => void;
};

export default function Island() {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const mock = params.get("mock") === "island";
  const moment = (ISLAND_MOMENTS as readonly string[]).includes(params.get("at") ?? "") ? (params.get("at") as IslandMoment) : "overview";
  const reduceMotion = params.get("motion") === "reduce" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // the URL holds the open panel (?place=) and the list view (?view=list); Back closes a panel (CLAUDE.md "Navigation")
  const search = useSearchParams();
  const place = search.get("place");
  const view = search.get("view");
  const url = useUrlState();
  const [skipIntro] = useState(() => !!params.get("place") || arrivedInApp());
  const [panel, setPanel] = useState<string | null>(null);
  const [list, setListState] = useState(params.get("view") === "list");
  const [hint, setHint] = useState(true);
  const [toastMsg, setToast] = useState<{ t: string; k: number } | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [glOk, setGlOk] = useState<boolean | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const worldRef = useRef<World | null>(null);
  const panelState = useRef<string | null>(null);
  const me = useIsland((s) => s.me);

  const toast = useCallback((t: string) => setToast({ t, k: Math.random() }), []);
  useEffect(() => {
    if (!toastMsg) return;
    const id = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(id);
  }, [toastMsg]);

  useEffect(() => {
    shownBefore = true;
  }, []);

  const closeLocal = useCallback(() => {
    panelState.current = null;
    setPanel(null);
    worldRef.current?.setPanel(null, null);
  }, []);
  const { push, replace, back } = url;
  /** Close the panel: back to the island entry it was opened from (or drop ?place= from a deep link). */
  const close = useCallback(() => {
    closeLocal();
    if (new URLSearchParams(location.search).get("place")) back({ place: null });
  }, [closeLocal, back]);
  const setList = useCallback(
    (b: boolean) => {
      if (!b && !worldRef.current) {
        toast("3D is not available in this browser.");
        return;
      }
      setListState(b);
      replace({ view: b ? "list" : null });
    },
    [toast, replace],
  );
  /** Open a panel without touching the URL (a deep link, Back, a mock moment). */
  const openLocal = useCallback((route: string, id: string = route) => {
    panelState.current = route;
    setPanel(route);
    const w = worldRef.current;
    if (!w) return;
    w.setPanel(route, panelRef.current);
    w.focus(route === "studio" ? "me" : w.has(route) ? route : w.has(id) ? id : "fountain");
  }, []);
  /** Open a panel from a click: pushed onto history from the bare island, replaced when one is already open. */
  const select = useCallback(
    (id: string) => {
      const route = routeOf(id);
      openLocal(route, id);
      if (new URLSearchParams(location.search).get("place")) replace({ place: route });
      else push({ place: route });
    },
    [openLocal, push, replace],
  );
  const home = useCallback(() => {
    close();
    if (worldRef.current) {
      setListState(false);
      replace({ view: null });
      worldRef.current.resetView();
    }
  }, [close, replace]);

  // ?place= changed (deep link on mount, Back/Forward, a link such as the you chip's "My avatar"): follow it
  const lastPlace = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastPlace.current;
    lastPlace.current = place;
    if (place) {
      if (place !== panelState.current) openLocal(place, focusOf(place));
    } else if (prev && panelState.current) closeLocal();
  }, [place, openLocal, closeLocal]);
  const lastView = useRef(view);
  useEffect(() => {
    if (lastView.current === view) return;
    lastView.current = view;
    if ((view === "list") !== list && (view === "list" || worldRef.current)) setListState(view === "list");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // data: the mock moment, or the live engine (IslandLive below)
  useEffect(() => {
    let addr: string | null = null;
    try {
      addr = burner().address.toLowerCase();
    } catch {
      /* storage blocked */
    }
    if (mock) {
      const m = mockIsland(moment);
      const { lastSettled: _l, callsigns: _c, ...snap } = m;
      setSnap({ ...snap, me: addr });
    } else setSnap({ me: addr });
    setSnap({ avatar: loadAvatar(addr) });
    // a callsign set on /play in another tab shows here too
    const onStorage = (e: StorageEvent) => {
      if (e.key === CALLSIGN_KEY || (addr && e.key === `royale.avatar.${addr}`)) setSnap({ avatar: loadAvatar(addr) });
    };
    addEventListener("storage", onStorage);
    return () => removeEventListener("storage", onStorage);
  }, [mock, moment]);

  // the Dojo: GET /duels, or the mock
  useEffect(() => {
    if (!mock) return startDojoPoll();
    setDojoMock(mockDuels());
  }, [mock]);

  // the world: only with WebGL, loaded in its own chunk
  useEffect(() => {
    let dead = false;
    let w: World | null = null;
    void import("../world/scene").then((mod) => {
      if (dead) return;
      const ok = mod.webglAvailable();
      setGlOk(ok);
      if (!ok || !canvasRef.current || !labelsRef.current) {
        setListState(true);
        toast("3D is not available in this browser, so the island opened as a list.");
        return;
      }
      w = mod.createWorld(canvasRef.current, labelsRef.current, getSnapshot, {
        onPick: (id) => select(id),
        onEmpty: () => close(),
        onUserMoved: () => setHint(false),
      }, reduceMotion, skipIntro);
      if (!w) {
        setGlOk(false);
        setListState(true);
        return;
      }
      worldRef.current = w;
      setWorld(w);
      if (panelState.current) {
        w.setPanel(panelState.current, panelRef.current);
        w.focus(focusOf(panelState.current));
      }
    });
    return () => {
      dead = true;
      w?.dispose();
      worldRef.current = null;
    };
  }, [select, close, toast, reduceMotion, skipIntro]);

  useEffect(() => {
    world?.setPaused(list);
  }, [world, list]);
  useEffect(() => {
    world?.setPanel(panel, panelRef.current);
  }, [world, panel]);

  // one-off moments from the live feed (or the mock)
  useEffect(
    () =>
      onBus((e) => {
        const w = worldRef.current;
        if (e.kind === "cut") w?.flare();
        else if (e.kind === "celebrate") w?.celebrate();
        else if (e.kind === "toast") toast(e.text);
        else if (e.kind === "victory") {
          const a = getSnapshot().avatar;
          const amount = e.amountUnits ? usdc(e.amountUnits) : null;
          const off = e.offline ? ". Offline run, nothing paid on chain" : "";
          // with no callsign stored the name is the default "you": say "You" once, not "you (you)"
          const named = a.name !== "you";
          const who = named ? " (you)" : "";
          feed("win", amount ? `${who} won ${amount} in ${e.game} and hit the ${danceName(a.dance)}${off}` : `${who} took the top step and hit the ${danceName(a.dance)}`, named ? a.name : "You");
          if (w) w.victory();
        }
      }),
    [toast],
  );

  // mock moments that are events rather than state
  useEffect(() => {
    if (!mock || !world) return;
    let stop = false;
    const go = () => {
      if (stop) return;
      if (!(window as unknown as { __islandReady?: boolean }).__islandReady && !reduceMotion) return void setTimeout(go, 200);
      const m = mockIsland(moment);
      if (moment === "overview") feed("win", " won 48.40 USDC in Prediction #41", m.stats?.leaderboard[1]?.callsign);
      if (moment === "live") feed("live", `Lobby #1 is live with ${m.royale?.players ?? 0} traders`);
      if (moment === "checkpoint") {
        emit({ kind: "cut" });
        feed("cut", `Checkpoint 1: ${(m.royale?.players ?? 0) - (m.royale?.alive ?? 0)} cut in the Arena, ${m.royale?.alive ?? 0} left`);
      }
      if (moment === "settled" && m.lastSettled) {
        const s = m.lastSettled;
        let top = 0;
        s.amounts.forEach((a, i) => {
          if (BigInt(a) > BigInt(s.amounts[top])) top = i;
        });
        feed("win", ` won ${usdc(s.amounts[top])} in Trading Royale #1 (and ${s.winners.length - 1} more)`, m.callsigns[s.winners[top]]);
        emit({ kind: "celebrate" });
      }
      if (moment === "studio") openLocal("studio", "me");
      if (moment === "dojo") openLocal("dojo");
      if (moment === "victory") emit({ kind: "victory", amountUnits: "48400000", game: "Prediction #41" });
    };
    go();
    return () => {
      stop = true;
    };
  }, [mock, moment, world, openLocal, reduceMotion]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [close]);

  const api: IslandApi = { select, close, toast, world, setList, home };
  return (
    <div className={`isle${panel ? " has-panel" : ""}${list ? " is-list" : ""}`}>
      <canvas ref={canvasRef} className="scene" aria-label="Royale Isle, a 3D island. Drag to orbit, scroll to zoom, click a building to open it." />
      <div ref={labelsRef} className="labels" hidden={list} />
      <TopBar api={api} list={list} />
      <Feed />
      <div className={`hint${hint ? "" : " gone"}`} hidden={list || glOk === false}>
        <span className="hide-sm">Drag to orbit · Scroll or pinch to zoom · Click anything that glows</span>
        <span className="show-sm">Drag to orbit · Pinch to zoom · Tap a building</span>
      </div>
      <div className="corner" hidden={list}>
        <Badge mock={mock} />
        <button
          className="iconbtn"
          aria-label="Reset view"
          title="Reset view"
          onClick={() => {
            close();
            world?.resetView();
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke={ink} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M15.5 8.5l-2 5-5 2 2-5z" />
          </svg>
        </button>
      </div>
      {list && <ListView api={api} />}
      {panel && <Panel key={panel} id={panel} api={api} ref={panelRef} me={me} />}
      {toastMsg && (
        <div key={toastMsg.k} className="toast" role="status">
          {toastMsg.t}
        </div>
      )}
      {!mock && <IslandLive />}
    </div>
  );
}

function Badge({ mock }: { mock: boolean }) {
  const engine = useIsland((s) => s.engine);
  if (mock) return <span className="badge hide-sm">Mock data</span>;
  if (engine === "down") return <span className="badge hide-sm">Engine offline · retrying</span>;
  if (engine === "none") return <span className="badge hide-sm">No engine configured</span>;
  return null;
}
