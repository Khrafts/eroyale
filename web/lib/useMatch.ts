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
  LockedEvent,
  MatchEvent,
  PredictFinalEvent,
  PtickEvent,
  RoundEvent,
  SettledEvent,
  Side,
  TickEvent,
  WarningEvent,
} from "./events";
import { isPredictFinal, presetOf } from "./events";
import { MOCK_END, MOMENTS, mockMatch } from "../mocks/match";
import { PREDICT_MOMENTS, PROTOCOL_LOBBY, PREDICT_OPEN_AT, mockPredict } from "../mocks/predict";
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

  // ---------- prediction lobbies (all null/empty on a royale lobby) ----------
  mode: "royale" | "predict";
  round: RoundEvent | null;
  /** How many players have a prediction (the `predicted` count, or every locked prediction). */
  predictedCount: number;
  locked: LockedEvent | null;
  ptick: PtickEvent | null;
  prevPtick: PtickEvent | null;
  /** The round market's price over time, unix seconds: `mark` events before the lock, every ptick after. */
  path: { u: number; p: number }[];
  /** Unix seconds of predict-event t = 0 (the round's open). */
  tOrigin: number | null;
  pfinal: PredictFinalEvent | null;
  /** Clock value (unix seconds in predict mode) when `pfinal` arrived. */
  pfinalT: number | null;
  cancelled: boolean;
  /** Why the round was called off (the `cancelled` event's or the snapshot's reason), when the engine says. */
  cancelReason: string | null;
  /** Who has a prediction in, from the snapshot's players[].predicted (no prices before the lock). */
  predictedBy: Record<string, boolean>;
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
  mode: "royale",
  round: null,
  predictedCount: 0,
  locked: null,
  ptick: null,
  prevPtick: null,
  path: [],
  tOrigin: null,
  pfinal: null,
  pfinalT: null,
  cancelled: false,
  cancelReason: null,
  predictedBy: {},
});

const PATH_MAX = 4000;
function pushPath(s: MatchState, u: number, p: number) {
  const last = s.path[s.path.length - 1];
  if (last && u <= last.u) {
    if (u === last.u) last.p = p;
    return;
  }
  s.path = s.path.length >= PATH_MAX ? [...s.path.slice(-PATH_MAX + 1), { u, p }] : [...s.path, { u, p }];
}

const durationOf = (s: MatchState) =>
  s.startsAt !== null && s.endTime !== null && s.endTime > s.startsAt ? s.endTime - s.startsAt : presetOf(s.preset).duration;

/**
 * Pure reducer: mutates and returns `s` (callers clone before handing to React). `at` is the match clock on arrival.
 * `catchUp`: the event is part of the burst a WebSocket sends on connect, so it happened earlier than `at`: it must not
 * set the time origin, and a final or settled from it is long past (no reveal replays on a reload).
 */
export function applyEvent(s: MatchState, ev: MatchEvent, at: number = s.t, catchUp = false): MatchState {
  s.seq++;
  switch (ev.type) {
    case "round":
      s.mode = "predict";
      s.round = ev;
      s.lobbyId = ev.lobbyId;
      break;
    case "predicted":
      s.mode = "predict";
      s.predictedCount = Math.max(s.predictedCount, ev.count);
      if (s.tOrigin === null && !catchUp) s.tOrigin = at - ev.t;
      break;
    case "locked":
      s.mode = "predict";
      s.locked = ev;
      s.predictedCount = ev.predictions.length;
      s.tOrigin = s.round ? s.round.lockTime - ev.t : at - ev.t;
      break;
    case "ptick":
      s.mode = "predict";
      if (s.tOrigin === null) s.tOrigin = s.round && s.locked ? s.round.lockTime - s.locked.t : at - ev.t;
      s.prevPtick = s.ptick;
      s.ptick = ev;
      pushPath(s, s.tOrigin + ev.t, Number(ev.mark));
      break;
    case "mark":
      pushPath(s, ev.at, Number(ev.mark));
      break;
    case "cancelled":
      s.cancelled = true;
      if (ev.reason) s.cancelReason = ev.reason;
      s.status = "cancelled";
      break;
    case "lobby":
      if (ev.mode === "predict") s.mode = "predict";
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
      if (isPredictFinal(ev)) {
        s.mode = "predict";
        if (!s.pfinal) s.pfinalT = catchUp ? at - 60 : at;
        s.pfinal = ev;
        break;
      }
      if (!s.final) s.finalT = at;
      s.final = ev;
      break;
    case "settled":
      if (!s.settled) s.settledT = catchUp ? at - 60 : at;
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

const STATUS_ORDER: Record<LobbyStatus, number> = { open: 0, countdown: 1, live: 2, settling: 3, settled: 4, cancelled: 5 };

/**
 * Merge a GET /lobbies/:id snapshot: lobby fields, clock offset, positions and who is already out.
 * `lobbyNewer`: a `lobby` frame arrived after the request was sent, so the snapshot's status, players, times and pot
 * may be older than what the stream already applied; they are then kept unless the snapshot's status is further along.
 */
export function applySnapshot(s: MatchState, snap: Snapshot, receivedAtMs: number, clockNow: number, lobbyNewer = false): MatchState {
  if (s.lobbyId !== null && snap.lobbyId !== s.lobbyId) return s; // a different lobby: not ours
  s.seq++;
  if (typeof snap.now === "number") s.serverOffsetMs = snap.now - receivedAtMs;
  s.lobbyId = snap.lobbyId;
  if (!lobbyNewer || s.status === null || STATUS_ORDER[snap.status] > STATUS_ORDER[s.status]) {
    s.status = snap.status;
    s.players = snap.players.map((p) => ({ player: p.player, callsign: p.callsign, bot: p.bot }));
    s.startsAt = snap.startsAt;
    s.endTime = snap.endTime;
    s.potUnits = snap.potUnits;
  }
  if (snap.preset) s.preset = snap.preset;
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

/** GET /lobbies/:id for a predict lobby (prices only after the lock). */
type PredictSnapshot = {
  lobbyId: number;
  mode: "predict";
  protocol?: boolean;
  status: LobbyStatus;
  params: RoundEvent["params"];
  lockTime: number;
  endTime: number;
  potUnits: string;
  players: { player: string; callsign: string; bot: boolean; predicted?: boolean }[];
  predictedCount?: number;
  mark?: string | null;
  now?: number;
  openTime?: number;
  cancelReason?: string | null;
  locked?: LockedEvent | null;
  ptick?: PtickEvent | null;
  final?: PredictFinalEvent | null;
  settled?: SettledEvent | null;
};

export function applyPredictSnapshot(s: MatchState, snap: PredictSnapshot, receivedAtMs: number, lobbyNewer = false, withMark = true): MatchState {
  if (s.lobbyId !== null && snap.lobbyId !== s.lobbyId) return s;
  s.seq++;
  s.mode = "predict";
  if (typeof snap.now === "number") s.serverOffsetMs = snap.now - receivedAtMs;
  const nowU = (Date.now() + s.serverOffsetMs) / 1000;
  s.lobbyId = snap.lobbyId;
  if (!lobbyNewer || s.status === null || STATUS_ORDER[snap.status] > STATUS_ORDER[s.status]) {
    s.status = snap.status;
    s.players = snap.players.map((p) => ({ player: p.player, callsign: p.callsign, bot: p.bot }));
    s.potUnits = snap.potUnits;
    s.startsAt = snap.lockTime;
    s.endTime = snap.endTime;
  }
  if (snap.status === "cancelled") s.cancelled = true;
  if (snap.cancelReason) s.cancelReason = snap.cancelReason;
  if (typeof snap.openTime === "number") s.tOrigin = snap.openTime;
  s.predictedBy = Object.fromEntries(snap.players.map((p) => [p.player, !!p.predicted]));
  if (!s.round && snap.params)
    s.round = { type: "round", lobbyId: snap.lobbyId, params: snap.params, lockTime: snap.lockTime, endTime: snap.endTime, protocol: !!snap.protocol };
  s.predictedCount = Math.max(s.predictedCount, snap.predictedCount ?? 0);
  if (snap.locked && !s.locked) applyEvent(s, { ...snap.locked, type: "locked" }, nowU);
  if (snap.ptick && (!s.ptick || snap.ptick.t >= s.ptick.t)) applyEvent(s, { ...snap.ptick, type: "ptick" }, nowU);
  if (withMark && snap.mark && !s.locked) applyEvent(s, { type: "mark", at: nowU, mark: snap.mark }, nowU);
  // A reload after the resolve: the reveal is long finished.
  if (snap.final && !s.pfinal) {
    s.pfinal = { ...snap.final, type: "final" };
    s.pfinalT = nowU - 60;
  }
  if (snap.settled && !s.settled) {
    s.settled = { ...snap.settled, type: "settled" };
    s.settledT = nowU - 60;
  }
  return s;
}

export type Match = {
  state: MatchState;
  /** Live reference to the newest state, for requestAnimationFrame loops. */
  ref: React.MutableRefObject<MatchState>;
  /**
   * Continuous match time in seconds, interpolated between server updates. Call every frame.
   * Prediction lobbies: unix seconds (server time), since rounds are timed by lockTime and endTime.
   */
  clock: () => number;
  /** Seed of the prediction mock (`?mock=predict`), else null. */
  mockSeed: number | null;
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

export type MatchOptions = {
  /** Follow this lobby instead of ?lobby= or the engine's current one. Changing it reconnects. */
  lobby?: number | null;
  /** Prediction mode: follow the protocol round (GET /rounds) instead of the current royale lobby. */
  predict?: boolean;
};

export function useMatch(opts: MatchOptions = {}): Match {
  const [state, setState] = useState<MatchState>(() => emptyState());
  const ref = useRef<MatchState>(state);
  const clockRef = useRef<() => number>(() => 0);
  const injectRef = useRef<(ev: MatchEvent) => void>(() => undefined);
  const [source, setSource] = useState<"mock" | "live">("live");
  const [me, setMe] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [mockSeed, setMockSeed] = useState<number | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const q = readParams();
    const fixedLobby = opts.lobby ?? (q.get("lobby") ? Number(q.get("lobby")) || null : null);
    const mockPred = q.get("mock") === "predict";
    const mock = q.get("mock") === "1" || mockPred;
    const predict = !!opts.predict || mockPred || q.get("mode") === "predict";
    setSource(mock ? "mock" : "live");
    const publish = (s: MatchState) => {
      ref.current = s;
      setState({ ...s });
    };

    if (mock) {
      const seed = Number(q.get("seed") ?? "7") || 7;
      const meParam = q.get("me");
      const atParam = q.get("at");
      let events: { at: number; ev: MatchEvent }[];
      let start: number;
      let end: number;
      let lobby0: number;
      if (mockPred) {
        // Prediction rounds: the clock is unix seconds; `at` counts from the protocol round's open.
        const { rounds, cast } = mockPredict(seed);
        lobby0 = fixedLobby ?? PROTOCOL_LOBBY;
        const round = rounds.find((r) => r.cfg.lobbyId === lobby0) ?? rounds[0];
        lobby0 = round.cfg.lobbyId;
        events = round.events;
        const c = cast as unknown as Record<string, string>;
        setMe(meParam && meParam !== "byCallsign" && typeof c[meParam] === "string" ? c[meParam] : (meParam?.toLowerCase() ?? cast.me));
        const a = atParam === null ? PREDICT_MOMENTS.open : atParam in PREDICT_MOMENTS ? PREDICT_MOMENTS[atParam] : Number(atParam);
        start = PREDICT_OPEN_AT + (Number.isFinite(a) ? a : PREDICT_MOMENTS.open);
        end = Math.max(events[events.length - 1].at + 10, PREDICT_OPEN_AT + 60);
      } else {
        const m = mockMatch(seed);
        events = m.events;
        lobby0 = fixedLobby ?? 1;
        setMe(meParam && meParam in m.cast ? m.cast[meParam as keyof typeof m.cast] : (meParam ?? m.cast.me));
        const a = (atParam ?? "lobby") in MOMENTS ? MOMENTS[atParam ?? "lobby"] : Number(atParam);
        start = Number.isFinite(a) ? a : MOMENTS.lobby;
        end = MOCK_END;
      }
      const first = events[0].at;
      const speed = Number(q.get("speed") ?? "1");
      const loop = q.get("loop") === "1";
      const t0 = performance.now();
      let vt = start;
      const now = () => {
        let v = start + ((performance.now() - t0) / 1000) * (Number.isFinite(speed) ? speed : 1);
        if (loop && v > end) v = first + ((v - first) % (end - first));
        return v;
      };
      clockRef.current = () => Math.min(vt, end);
      let s = emptyState(lobby0);
      let i = 0;
      const pump = () => {
        vt = now();
        if (i > 0 && vt < events[i - 1].at) {
          s = emptyState(lobby0);
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
      setMockSeed(mockPred ? seed : null);
      pump();
      publish(s);
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
    if (predict) s.mode = "predict";
    publish(s);
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
      if (predict || s.mode === "predict") return serverNow() / 1000;
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
    let lobbyFrames = 0; // `lobby` frames applied so far, to tell whether one landed while a snapshot was in flight
    let snapshotGen = -1; // the connection generation whose snapshot has been requested

    // Called on the first `lobby` frame of each connection, with that frame's lobby id (never `current`, which may
    // already point at the next lobby).
    const loadSnapshot = async (g: number, id: number) => {
      try {
        const t0 = Date.now();
        const framesAtRequest = lobbyFrames;
        const r = await fetch(`${engineHttp()}/lobbies/${id}`, { cache: "no-store" });
        if (!r.ok || g !== gen) return;
        const snap = (await r.json()) as Snapshot | PredictSnapshot;
        if (g !== gen) return;
        if ("mode" in snap && snap.mode === "predict") applyPredictSnapshot(s, snap, (t0 + Date.now()) / 2, lobbyFrames !== framesAtRequest);
        else applySnapshot(s, snap as Snapshot, (t0 + Date.now()) / 2, clock(), lobbyFrames !== framesAtRequest);
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
      let openedAt = Infinity;
      ws.onopen = () => {
        openedAt = performance.now();
        failures = 0;
        setConnected(true);
        if (s.error) {
          s.error = null;
          publish(s);
        }
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
          if (ev.type === "lobby" && s.lobbyId !== null && typeof ev.lobbyId === "number" && ev.lobbyId !== s.lobbyId) return;
          // The engine sends its catch-up burst right on connect; anything in the first 400 ms is treated as past.
          applyEvent(s, ev, clock(), performance.now() - openedAt < 400);
          if (ev.type === "lobby") {
            lobbyFrames++;
            const id = typeof ev.lobbyId === "number" ? ev.lobbyId : s.lobbyId;
            if (snapshotGen !== g && id !== null) {
              snapshotGen = g;
              void loadSnapshot(g, id);
            }
          }
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

    // The protocol round to show, from GET /rounds: the locked protocol round whose reveal comes next (after the one on
    // screen), else the open one taking predictions.
    type Row = { lobbyId: number; protocol: boolean; endTime: number };
    const protocolRound = async (): Promise<number | null> => {
      const r = await fetch(`${engineHttp()}/rounds`, { cache: "no-store" });
      const body = (await r.json()) as { protocol?: number | null; rounds?: Row[]; active?: Row[] };
      const after = s.round?.endTime ?? 0;
      const next = (body.active ?? [])
        .filter((x) => x.protocol && x.endTime > after && x.lobbyId !== s.lobbyId)
        .sort((x, y) => x.endTime - y.endTime)[0];
      return next?.lobbyId ?? body.protocol ?? body.rounds?.find((x) => x.protocol)?.lobbyId ?? null;
    };

    // Follow the next match: with no ?lobby, switch when the engine's current lobby changes after this one ends.
    // Prediction mode follows the protocol round instead, switching once this round is resolved.
    const follow = setInterval(async () => {
      if (fixedLobby !== null || closed) return;
      const done = predict
        ? s.lobbyId === null || s.cancelled || !!s.settled || (s.pfinal !== null && s.pfinalT !== null && clock() - s.pfinalT > 20)
        : s.status === "cancelled" || !!s.settled || (s.final !== null && s.finalT !== null && clock() - s.finalT > 20);
      if (!done) return;
      try {
        let current: number | null;
        if (predict) current = await protocolRound();
        else {
          const r = await fetch(`${engineHttp()}/lobbies`, { cache: "no-store" });
          current = ((await r.json()) as { current: number | null }).current;
        }
        if (current !== null && current !== s.lobbyId) {
          const offset = s.serverOffsetMs;
          s = emptyState(current);
          s.serverOffsetMs = offset;
          if (predict) s.mode = "predict";
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

    // Before the lock a prediction lobby streams no price: the engine's marks feed (WS /ws?feed=marks, 4 Hz) carries it.
    let feed: WebSocket | null = null;
    let feedAt = 0; // performance.now() of the last feed frame
    let feedRetry: ReturnType<typeof setTimeout> | undefined;
    const openFeed = () => {
      if (closed || !predict) return;
      const f = new WebSocket(`${base}${base.includes("?") ? "&" : "?"}feed=marks`);
      feed = f;
      f.onmessage = (m) => {
        try {
          const ev = JSON.parse(String(m.data)) as { type: string; marks: Record<string, string> | null; at: number };
          if (ev.type !== "marks" || !ev.marks || !s.round || s.locked) return;
          const mark = ev.marks[s.round.params.market];
          if (!mark) return;
          feedAt = performance.now();
          applyEvent(s, { type: "mark", at: ev.at / 1000, mark }, clock());
          publish(s);
        } catch {
          /* ignore */
        }
      };
      f.onclose = () => {
        if (feed === f && !closed) feedRetry = setTimeout(openFeed, 2000);
      };
    };
    openFeed();

    // The snapshot every few seconds before the lock: who has called (players[].predicted), and the price only as a
    // fallback when the marks feed has been quiet for 3 s.
    const marks = setInterval(async () => {
      if (closed || s.mode !== "predict" || s.locked || s.lobbyId === null || s.cancelled) return;
      const g = gen;
      try {
        const t0 = Date.now();
        const r = await fetch(`${engineHttp()}/lobbies/${s.lobbyId}`, { cache: "no-store" });
        if (!r.ok || g !== gen) return;
        const snap = (await r.json()) as PredictSnapshot;
        if (g !== gen || snap.mode !== "predict") return;
        applyPredictSnapshot(s, snap, (t0 + Date.now()) / 2, true, performance.now() - feedAt > 3000);
        publish(s);
      } catch {
        /* next time */
      }
    }, 2000);

    if (predict && fixedLobby === null) {
      // Find the protocol round first; until then the follow loop retries.
      void protocolRound()
        .then((id) => {
          if (closed || id === null || s.lobbyId !== null) return;
          s.lobbyId = id;
          publish(s);
          connect();
        })
        .catch(() => {
          s.error = `Cannot reach the engine at ${base}. Retrying.`;
          publish(s);
        });
    } else connect();
    return () => {
      closed = true;
      gen++;
      clearTimeout(retry);
      clearInterval(follow);
      clearInterval(marks);
      clearTimeout(feedRetry);
      feed?.close();
      ws?.close();
    };
  }, [opts.lobby, opts.predict]);

  const clock = useMemo(() => () => clockRef.current(), []);
  const inject = useMemo(() => (ev: MatchEvent) => injectRef.current(ev), []);
  return { state, ref, clock, mockSeed, source, me, connected, reducedMotion, inject };
}
