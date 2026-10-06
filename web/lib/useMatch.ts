"use client";
// One hook feeds every screen, from the mock (?mock=1&speed=&at=) or the live engine (WebSocket plus a
// GET /lobbies/:id snapshot on every connect, so a reload keeps positions and eliminations).
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  EliminatedEvent,
  EliminationReason,
  FillEvent,
  FinalEvent,
  LeaderboardEvent,
  LobbyPlayer,
  LobbyStatus,
  Market,
  MatchEvent,
  SettledEvent,
  Side,
  TickEvent,
  WarningEvent,
} from "./events";
import { presetOf } from "./events";
import { MOCK_END, MOMENTS, mockMatch } from "../mocks/match";
import { engineHttp } from "./engineUrl";

export type MatchState = {
  lobbyId: number | null;
  status: LobbyStatus | null;
  players: LobbyPlayer[];
  startsAt: number | null;
  endTime: number | null;
  preset: string;
  /** Match length in seconds, from endTime - startsAt or the preset. */
  duration: number;
  potUnits: string;
  tick: TickEvent | null;
  prevTick: TickEvent | null;
  board: LeaderboardEvent | null;
  prevBoard: LeaderboardEvent | null;
  fills: FillEvent[]; // newest last, at most 60
  /** Open positions per player: the opening fill per market (seeded from the snapshot on connect). */
  positions: Record<string, Partial<Record<Market, FillEvent>>>;
  warning: WarningEvent | null;
  eliminations: EliminatedEvent[]; // oldest first
  final: FinalEvent | null;
  settled: SettledEvent | null;
  /** Match-clock seconds at which `final` / `settled` arrived (they carry no `t`). */
  finalT: number | null;
  settledT: number | null;
  /** Server clock minus local clock, in ms (from the snapshot's `now`). */
  serverOffsetMs: number;
  /** A message the screens must show instead of the match (no engine configured, unreachable). */
  error: string | null;
  /** Match seconds of the latest event that carried a `t`. */
  t: number;
  /** Increments on every applied event; cheap change detector for canvas loops. */
  seq: number;
};

export const emptyState = (lobbyId: number | null = null): MatchState => ({
  lobbyId,
  status: null,
  players: [],
  startsAt: null,
  endTime: null,
  preset: "stage",
  duration: presetOf("stage").duration,
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
  finalT: null,
  settledT: null,
  serverOffsetMs: 0,
  error: null,
  t: 0,
  seq: 0,
});

const durationOf = (s: MatchState) =>
  s.startsAt !== null && s.endTime !== null && s.endTime > s.startsAt ? s.endTime - s.startsAt : presetOf(s.preset).duration;

/** Pure reducer: mutates and returns `s` (callers clone before handing to React). `at` is the match clock on arrival. */
export function applyEvent(s: MatchState, ev: MatchEvent, at: number = s.t): MatchState {
  s.seq++;
  switch (ev.type) {
    case "lobby":
      s.status = ev.status;
      s.players = ev.players;
      s.startsAt = ev.startsAt ?? null;
      if (ev.endTime !== undefined) s.endTime = ev.endTime ?? null;
      if (ev.preset) s.preset = ev.preset;
      if (typeof ev.lobbyId === "number") s.lobbyId = ev.lobbyId;
      s.potUnits = ev.potUnits;
      s.duration = durationOf(s);
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
      if (!s.final) s.finalT = at;
      s.final = ev;
      break;
    case "settled":
      if (!s.settled) s.settledT = at;
      s.settled = ev;
      break;
  }
  return s;
}

type SnapshotPlayer = {
  player: string;
  callsign: string;
  bot: boolean;
  alive: boolean;
  reason?: EliminationReason | null;
  equity: string;
  positions?: { market: Market; side: Side; margin: string; leverage: number; entry: string }[];
};
type Snapshot = {
  lobbyId: number;
  preset?: string;
  status: LobbyStatus;
  startsAt: number | null;
  endTime: number | null;
  potUnits: string;
  t: number | null;
  now?: number;
  players: SnapshotPlayer[];
  tick?: TickEvent | null;
  leaderboard?: LeaderboardEvent | null;
  final?: FinalEvent | null;
  settled?: SettledEvent | null;
};

/** Merge a GET /lobbies/:id snapshot: lobby fields, clock offset, positions and who is already out. */
export function applySnapshot(s: MatchState, snap: Snapshot, receivedAtMs: number, clockNow: number): MatchState {
  s.seq++;
  if (typeof snap.now === "number") s.serverOffsetMs = snap.now - receivedAtMs;
  s.lobbyId = snap.lobbyId;
  s.status = snap.status;
  s.players = snap.players.map((p) => ({ player: p.player, callsign: p.callsign, bot: p.bot }));
  s.startsAt = snap.startsAt;
  s.endTime = snap.endTime;
  if (snap.preset) s.preset = snap.preset;
  s.potUnits = snap.potUnits;
  s.duration = durationOf(s);
  if (snap.tick && (!s.tick || snap.tick.t >= s.tick.t)) applyEvent(s, { ...snap.tick, type: "tick" });
  if (snap.leaderboard && (!s.board || snap.leaderboard.t >= s.board.t)) applyEvent(s, { ...snap.leaderboard, type: "leaderboard" });
  const t = snap.t ?? s.t;
  s.positions = {};
  for (const p of snap.players) {
    for (const x of p.positions ?? []) {
      (s.positions[p.player] ??= {})[x.market] = {
        type: "fill", t, player: p.player, market: x.market, side: x.side, margin: x.margin, leverage: x.leverage, price: x.entry, kind: "open",
      };
    }
  }
  const known = new Set(s.eliminations.flatMap((e) => e.players.map((p) => p.player)));
  const rankOf = (a: string) => s.board?.rows.find((r) => r.player === a)?.rank ?? s.players.length;
  const out = snap.players.filter((p) => !p.alive && !known.has(p.player));
  if (out.length) {
    // Already out before this page connected: long past, so no sequence replays.
    s.eliminations = [
      {
        type: "eliminated",
        t: t - 3600,
        checkpoint: null,
        players: out.map((p) => ({ player: p.player, callsign: p.callsign, reason: p.reason ?? "cut", rank: rankOf(p.player) })),
      },
      ...s.eliminations,
    ];
  }
  // A reload after the end: the sequences are long finished.
  if (snap.final && !s.final) {
    s.final = { ...snap.final, type: "final" };
    s.finalT = clockNow - 60;
  }
  if (snap.settled && !s.settled) {
    s.settled = { ...snap.settled, type: "settled" };
    s.settledT = clockNow - 60;
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
  const [source, setSource] = useState<"mock" | "live">("live");
  const [me, setMe] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const q = readParams();
    const fixedLobby = q.get("lobby") ? Number(q.get("lobby")) || null : null;
    const mock = q.get("mock") === "1";
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
      let s = emptyState(fixedLobby ?? 1);
      let i = 0;
      const pump = () => {
        vt = now();
        if (i > 0 && vt < events[i - 1].at) {
          s = emptyState(fixedLobby ?? 1);
          i = 0;
        }
        let changed = false;
        while (i < events.length && events[i].at <= vt) {
          applyEvent(s, events[i].ev, events[i].at);
          i++;
          changed = true;
        }
        if (changed) publish(s);
      };
      injectRef.current = (ev) => {
        applyEvent(s, ev, vt);
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
    const base = process.env.NEXT_PUBLIC_ENGINE_WS;
    let s = emptyState(fixedLobby);
    if (!base) {
      s.error = "No engine is configured. Set NEXT_PUBLIC_ENGINE_WS (repo .env) and rebuild, or open this page with ?mock=1.";
      publish(s);
      return;
    }
    let lastT = 0;
    let lastAt = performance.now();
    const serverNow = () => Date.now() + s.serverOffsetMs;
    // Match clock: server time against startsAt when known, so the countdown and the time after the end keep moving.
    const clock = () => {
      if (s.startsAt !== null) return serverNow() / 1000 - s.startsAt;
      if (!s.tick) return s.t;
      return lastT + Math.min(1, (performance.now() - lastAt) / 1000);
    };
    clockRef.current = clock;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let gen = 0;

    const loadSnapshot = async (g: number) => {
      try {
        const t0 = Date.now();
        const r = await fetch(`${engineHttp()}/lobbies/${s.lobbyId ?? "current"}`, { cache: "no-store" });
        if (!r.ok || g !== gen) return;
        const snap = (await r.json()) as Snapshot;
        if (g !== gen) return;
        applySnapshot(s, snap, (t0 + Date.now()) / 2, clock());
        publish(s);
      } catch {
        /* the WebSocket stream still works without it */
      }
    };

    const connect = () => {
      const g = ++gen;
      const id = fixedLobby ?? (s.lobbyId !== null ? s.lobbyId : null);
      const url = id === null ? base : `${base}${base.includes("?") ? "&" : "?"}lobby=${id}`;
      ws = new WebSocket(url);
      ws.onopen = () => {
        failures = 0;
        setConnected(true);
        if (s.error) {
          s.error = null;
          publish(s);
        }
        void loadSnapshot(g);
      };
      ws.onclose = () => {
        if (g !== gen) return;
        setConnected(false);
        failures++;
        if (failures >= 3 && !s.status) {
          s.error = `Cannot reach the engine at ${base}. Retrying.`;
          publish(s);
        }
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onmessage = (m) => {
        if (g !== gen) return;
        try {
          const ev = JSON.parse(String(m.data)) as MatchEvent;
          applyEvent(s, ev, clock());
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

    // Follow the next match: with no ?lobby, switch when the engine's current lobby changes after this one ends.
    const follow = setInterval(async () => {
      if (fixedLobby !== null || closed) return;
      const done =
        s.status === "cancelled" || !!s.settled || (s.final !== null && s.finalT !== null && clock() - s.finalT > 20);
      if (!done) return;
      try {
        const r = await fetch(`${engineHttp()}/lobbies`, { cache: "no-store" });
        const { current } = (await r.json()) as { current: number | null };
        if (current !== null && current !== s.lobbyId) {
          const offset = s.serverOffsetMs;
          s = emptyState(current);
          s.serverOffsetMs = offset;
          publish(s);
          const old = ws;
          gen++;
          old?.close();
          connect();
        }
      } catch {
        /* try again next round */
      }
    }, 5000);

    connect();
    return () => {
      closed = true;
      gen++;
      clearTimeout(retry);
      clearInterval(follow);
      ws?.close();
    };
  }, []);

  const clock = useMemo(() => () => clockRef.current(), []);
  const inject = useMemo(() => (ev: MatchEvent) => injectRef.current(ev), []);
  return { state, ref, clock, source, me, connected, reducedMotion, inject };
}
