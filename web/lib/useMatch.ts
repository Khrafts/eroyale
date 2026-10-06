"use client";
// One hook feeds every screen, from the mock (?mock=1&speed=&at=) or the live WebSocket.
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  EliminatedEvent,
  FillEvent,
  FinalEvent,
  LeaderboardEvent,
  LobbyPlayer,
  LobbyStatus,
  Market,
  MatchEvent,
  SettledEvent,
  TickEvent,
  WarningEvent,
} from "./events";
import { MOCK_END, MOMENTS, mockMatch } from "../mocks/match";

export type MatchState = {
  lobbyId: number;
  status: LobbyStatus | null;
  players: LobbyPlayer[];
  startsAt: number;
  potUnits: string;
  tick: TickEvent | null;
  prevTick: TickEvent | null;
  board: LeaderboardEvent | null;
  prevBoard: LeaderboardEvent | null;
  fills: FillEvent[]; // newest last, at most 60
  /** Open positions per player, rebuilt from fills: the opening fill per market. */
  positions: Record<string, Partial<Record<Market, FillEvent>>>;
  warning: WarningEvent | null;
  eliminations: EliminatedEvent[]; // oldest first
  final: FinalEvent | null;
  settled: SettledEvent | null;
  /** Match seconds of the latest event that carried a `t`. */
  t: number;
  /** Increments on every applied event; cheap change detector for canvas loops. */
  seq: number;
};

export const emptyState = (lobbyId = 1): MatchState => ({
  lobbyId,
  status: null,
  players: [],
  startsAt: 0,
  potUnits: "0",
  tick: null,
  prevTick: null,
  board: null,
  prevBoard: null,
  fills: [],
  positions: {},
  warning: null,
  eliminations: [],
  final: null,
  settled: null,
  t: 0,
  seq: 0,
});

/** Pure reducer: mutates and returns `s` (callers clone before handing to React). */
export function applyEvent(s: MatchState, ev: MatchEvent): MatchState {
  s.seq++;
  switch (ev.type) {
    case "lobby":
      s.status = ev.status;
      s.players = ev.players;
      s.startsAt = ev.startsAt;
      s.potUnits = ev.potUnits;
      break;
    case "tick":
      s.prevTick = s.tick;
      s.tick = ev;
      s.t = ev.t;
      if (s.warning && ev.nextCheckpoint?.index !== s.warning.checkpoint) s.warning = null;
      break;
    case "leaderboard":
      s.prevBoard = s.board;
      s.board = ev;
      s.t = ev.t;
      break;
    case "fill":
      s.fills = [...s.fills.slice(-59), ev];
      {
        const p = (s.positions[ev.player] ??= {});
        if (ev.kind === "open") p[ev.market] = ev;
        else delete p[ev.market];
      }
      break;
    case "warning":
      s.warning = ev;
      break;
    case "eliminated":
      s.eliminations = [...s.eliminations, ev];
      for (const p of ev.players) delete s.positions[p.player];
      break;
    case "final":
      s.final = ev;
      break;
    case "settled":
      s.settled = ev;
      break;
  }
  return s;
}

export type Match = {
  state: MatchState;
  /** Live reference to the newest state, for requestAnimationFrame loops. */
  ref: React.MutableRefObject<MatchState>;
  /** Continuous match time in seconds, interpolated between server updates. Call every frame. */
  clock: () => number;
  source: "mock" | "live";
  me: string | null;
  connected: boolean;
  reducedMotion: boolean;
  /** Apply a local event (mock mode: echo the player's own orders). */
  inject: (ev: MatchEvent) => void;
};

function readParams() {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const p = readParams().get("motion");
    if (p === "reduce") return setReduced(true);
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function useMatch(): Match {
  const [state, setState] = useState<MatchState>(() => emptyState());
  const ref = useRef<MatchState>(state);
  const clockRef = useRef<() => number>(() => 0);
  const injectRef = useRef<(ev: MatchEvent) => void>(() => undefined);
  const [source, setSource] = useState<"mock" | "live">("mock");
  const [me, setMe] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const q = readParams();
    const lobbyId = Number(q.get("lobby") ?? "1") || 1;
    const mock = q.get("mock") === "1" || !process.env.NEXT_PUBLIC_ENGINE_WS;
    setSource(mock ? "mock" : "live");
    const publish = (s: MatchState) => {
      ref.current = s;
      setState({ ...s });
    };

    if (mock) {
      const { events, cast } = mockMatch(Number(q.get("seed") ?? "7") || 7);
      const meParam = q.get("me");
      setMe(meParam && meParam in cast ? cast[meParam as keyof typeof cast] : (meParam ?? cast.me));
      const atParam = q.get("at") ?? "lobby";
      const at = atParam in MOMENTS ? MOMENTS[atParam] : Number(atParam);
      const start = Number.isFinite(at) ? at : MOMENTS.lobby;
      const speed = Number(q.get("speed") ?? "1");
      const loop = q.get("loop") === "1";
      const t0 = performance.now();
      let vt = start;
      const now = () => {
        let v = start + ((performance.now() - t0) / 1000) * (Number.isFinite(speed) ? speed : 1);
        if (loop && v > MOCK_END) v = events[0].at + ((v - events[0].at) % (MOCK_END - events[0].at));
        return v;
      };
      clockRef.current = () => Math.min(vt, MOCK_END);
      let s = emptyState(lobbyId);
      let i = 0;
      const pump = () => {
        vt = now();
        if (i > 0 && vt < events[i - 1].at) {
          s = emptyState(lobbyId);
          i = 0;
        }
        let changed = false;
        while (i < events.length && events[i].at <= vt) {
          applyEvent(s, events[i].ev);
          i++;
          changed = true;
        }
        if (changed) publish(s);
      };
      injectRef.current = (ev) => {
        applyEvent(s, ev);
        publish(s);
      };
      pump();
      setConnected(true);
      let raf = 0;
      const loopFn = () => {
        pump();
        raf = requestAnimationFrame(loopFn);
      };
      raf = requestAnimationFrame(loopFn);
      return () => cancelAnimationFrame(raf);
    }

    // Live: WebSocket from NEXT_PUBLIC_ENGINE_WS, e.g. ws://localhost:8787/ws
    setMe(q.get("me")?.toLowerCase() ?? null);
    const base = process.env.NEXT_PUBLIC_ENGINE_WS!;
    let s = emptyState(lobbyId);
    let lastT = 0;
    let lastAt = performance.now();
    clockRef.current = () => {
      if (!s.tick || s.status !== "live") return s.t;
      return lastT + Math.min(1, (performance.now() - lastAt) / 1000);
    };
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const url = `${base}${base.includes("?") ? "&" : "?"}lobby=${lobbyId}`;
      ws = new WebSocket(url);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onmessage = (m) => {
        try {
          const ev = JSON.parse(String(m.data)) as MatchEvent;
          applyEvent(s, ev);
          if (ev.type === "tick") {
            lastT = ev.t;
            lastAt = performance.now();
          }
          publish(s);
        } catch {
          /* ignore malformed frames */
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  const clock = useMemo(() => () => clockRef.current(), []);
  const inject = useMemo(() => (ev: MatchEvent) => injectRef.current(ev), []);
  return { state, ref, clock, source, me, connected, reducedMotion, inject };
}
