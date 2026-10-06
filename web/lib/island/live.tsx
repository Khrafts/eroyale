"use client";
// Live engine data into the island store (CLAUDE.md "Island" > "What each part shows").
// Polling: /lobbies, /rounds, /marks, /health, /stats every 3 s (backing off to 15 s while the engine is down),
// paused while the tab is hidden. WebSockets go through useMatch: the current royale lobby (it follows the next one
// by itself), the open protocol round, and every locked protocol round still waiting for its result.
import { useEffect, useRef, useState } from "react";
import { useMatch, type Match, type MatchState } from "../useMatch";
import { engineHttp } from "../engineUrl";
import { burner } from "../engine";
import type { Health, LobbiesInfo, Marks, MarksInfo, RoundInfo, RoundsInfo, Stats } from "../events";
import { MARKETS } from "../events";
import { emit, getSnapshot, setSnap, type FeedItem, type PredictInfo, type RoyaleInfo, type UserRound } from "./store";
import { usdc } from "./format";
import { commas } from "../predict";

const ENTRY_UNITS = "5000000";
const POLL_MS = 3000;
const MAX_POLL_MS = 15000;

async function getJson<T>(path: string): Promise<{ status: number; body: T | null }> {
  const r = await fetch(engineHttp() + path, { cache: "no-store" });
  if (!r.ok) return { status: r.status, body: null };
  return { status: r.status, body: (await r.json()) as T };
}

let feedSeq = 0;
export const feed = (kind: FeedItem["kind"], text: string, bold?: string) => emit({ kind: "feed", item: { id: `f${++feedSeq}`, kind, bold, text } });

/** Lobbies and rounds whose payout already reached the feed (from a `settled` event), so /stats does not repeat it. */
const announced = new Set<string>();

// ---------- the royale lobby from useMatch state ----------
export function royaleFrom(s: MatchState, maxPlayers: number | null): RoyaleInfo | null {
  if (s.lobbyId === null || s.status === null) return null;
  const out = new Set<string>();
  s.eliminations.forEach((e) => e.players.forEach((p) => out.add(p.player)));
  return {
    lobbyId: s.lobbyId,
    status: s.status,
    players: s.players.length,
    maxPlayers,
    potUnits: s.potUnits,
    startsAt: s.startsAt,
    endTime: s.endTime,
    alive: Math.max(0, s.players.length - out.size),
    checkpoints: [],
    next: s.tick?.nextCheckpoint ?? null,
    entryUnits: ENTRY_UNITS,
  };
}

export function roundFrom(r: RoundInfo): PredictInfo {
  return {
    lobbyId: r.lobbyId,
    market: r.params.market,
    players: r.players,
    maxPlayers: r.maxPlayers ?? null,
    predicted: r.predicted ?? 0,
    potUnits: r.potUnits,
    entryUnits: r.params.entryUnits,
    lockTime: r.lockTime,
    endTime: r.endTime,
    mark: r.mark ?? null,
  };
}
export function userRoundFrom(r: RoundInfo): UserRound {
  return { ...roundFrom(r), split: r.params.split, creator: r.params.creator, creatorFeeBps: r.params.creatorFeeBps };
}

// ---------- marks: the ticker reference and the Arena's candle bars ----------
const marksLog: { at: number; marks: Marks }[] = [];
export function sampleMarks(marks: Marks, atMs: number) {
  const last = marksLog[marksLog.length - 1];
  if (last && atMs - last.at < 2000) return;
  const prev = last?.marks;
  marksLog.push({ at: atMs, marks });
  while (marksLog.length > 1 && atMs - marksLog[0].at > 10 * 60_000) marksLog.shift();
  const s = getSnapshot();
  const patch: Parameters<typeof setSnap>[0] = { marks, marksRef: marksLog[0].marks };
  if (prev && prev.BTC !== marks.BTC && Number(prev.BTC) > 0) {
    const bps = ((Number(marks.BTC) - Number(prev.BTC)) / Number(prev.BTC)) * 10000;
    patch.moves = [...s.moves, bps].slice(-14);
  }
  setSnap(patch);
}

// ---------- feed lines and payouts from one subscribed lobby ----------
function nameOf(s: MatchState, player: string) {
  return s.players.find((p) => p.player === player)?.callsign ?? `${player.slice(0, 6)}…`;
}

function payout(s: MatchState, game: string, key: string) {
  const st = s.settled;
  if (!st || !st.winners.length) return;
  announced.add(key);
  const me = getSnapshot().me;
  let top = 0;
  st.amounts.forEach((a, i) => {
    if (BigInt(a) > BigInt(st.amounts[top])) top = i;
  });
  const mine = me ? st.winners.indexOf(me) : -1;
  if (mine >= 0) emit({ kind: "victory", amountUnits: st.amounts[mine], game });
  else {
    const others = st.winners.length - 1;
    feed("win", ` won ${usdc(st.amounts[top])} in ${game}${others > 0 ? ` (and ${others} more)` : ""}`, nameOf(s, st.winners[top]));
    emit({ kind: "celebrate" });
  }
}

type Seen = { lobby: number | null; readyAt: number; ready: boolean; status: string | null; elims: number; locked: boolean; final: boolean; settled: boolean; cancelled: boolean };
function useFeedFrom(m: Match, kind: "royale" | "predict") {
  const seen = useRef<Seen>({ lobby: null, readyAt: 0, ready: false, status: null, elims: 0, locked: false, final: false, settled: false, cancelled: false });
  const s = m.state;
  useEffect(() => {
    const k = seen.current;
    const now = performance.now();
    if (s.lobbyId !== k.lobby) Object.assign(k, { lobby: s.lobbyId, readyAt: now + 1500, ready: false });
    const silent = !k.ready;
    if (silent && now >= k.readyAt && s.status !== null) k.ready = true;
    const id = s.lobbyId;
    if (id === null) return;
    if (kind === "royale") {
      if (s.status === "live" && k.status !== "live" && !silent) feed("live", `Lobby #${id} is live with ${s.players.length} traders`);
      for (let i = k.elims; i < s.eliminations.length && !silent; i++) {
        const e = s.eliminations[i];
        const out = new Set<string>();
        s.eliminations.slice(0, i + 1).forEach((x) => x.players.forEach((p) => out.add(p.player)));
        const left = s.players.length - out.size;
        if (e.checkpoint !== null) {
          feed("cut", `Checkpoint ${e.checkpoint}: ${e.players.length} cut in the Arena, ${left} left`);
          emit({ kind: "cut" });
        } else e.players.forEach((p) => feed("cut", ` was liquidated in the Arena, ${left} left`, p.callsign));
      }
      if (s.final && !k.final && !silent) feed("final", `Lobby #${id} is over: ${s.final.finalists.length} finalists split the pot`);
      if (s.settled && !k.settled && !silent) payout(s, `Trading Royale #${id}`, `royale:${id}`);
    } else {
      const mk = s.round?.params.market ?? "";
      if (s.locked && !k.locked && !silent) feed("lock", `Round #${id} locked with ${s.locked.predictions.length} predictions on ${mk}`);
      if (s.pfinal && !k.final && !silent) {
        const w = s.pfinal.winners.find((x) => x.rank === 1);
        feed("final", `Round #${id} resolved at $${commas(s.pfinal.settlementPrice)}${w ? `. Closest: ${w.callsign}` : ""}`);
      }
      if (s.cancelled && !k.cancelled && !silent) feed("lock", `Round #${id} was cancelled and every entry refunded`);
      if (s.settled && !k.settled && !silent) payout(s, `Prediction #${id}`, `predict:${id}`);
    }
    k.status = s.status;
    k.elims = s.eliminations.length;
    k.locked = !!s.locked;
    k.final = !!(s.final || s.pfinal);
    k.settled = !!s.settled;
    k.cancelled = s.cancelled;
  }, [s, kind]);
}

function RoyaleWatch() {
  const m = useMatch();
  useFeedFrom(m, "royale");
  const maxOf = useRef(new Map<number, number | null>());
  const s = m.state;
  useEffect(() => {
    const id = s.lobbyId;
    if (id !== null && !maxOf.current.has(id)) {
      maxOf.current.set(id, null);
      void getJson<{ maxPlayers?: number }>(`/lobbies/${id}`)
        .then(({ body }) => {
          maxOf.current.set(id, body?.maxPlayers ?? null);
          const r = getSnapshot().royale;
          if (r && r.lobbyId === id) setSnap({ royale: { ...r, maxPlayers: body?.maxPlayers ?? null } });
        })
        .catch(() => maxOf.current.delete(id));
    }
    setSnap({ royale: royaleFrom(s, id !== null ? (maxOf.current.get(id) ?? null) : null) });
    if (s.status === "live" && s.tick) sampleMarks(s.tick.marks, Date.now());
  }, [s]);
  return null;
}

function PredictWatch({ lobby }: { lobby: number }) {
  const m = useMatch({ predict: true, lobby });
  useFeedFrom(m, "predict");
  return null;
}

/** Mount once on the island when no mock is asked for. */
export function IslandLive() {
  const [watch, setWatch] = useState<number[]>([]);
  useEffect(() => {
    try {
      setSnap({ me: burner().address.toLowerCase() });
    } catch {
      /* no storage: no "you" */
    }
    if (!process.env.NEXT_PUBLIC_ENGINE_WS && !process.env.NEXT_PUBLIC_ENGINE_HTTP) {
      setSnap({ engine: "none", statsState: "down" });
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wait = POLL_MS;
    let firstStats = true;
    let lastWinAt = 0;
    let busy = false;
    const poll = async () => {
      if (stop || busy) return;
      if (document.hidden) {
        timer = setTimeout(poll, 1000);
        return;
      }
      const t0 = Date.now();
      busy = true;
      const [lob, rnd, mk, hl, st] = await Promise.allSettled([
        getJson<LobbiesInfo>("/lobbies"),
        getJson<RoundsInfo>("/rounds"),
        getJson<MarksInfo>("/marks"),
        getJson<Health>("/health"),
        getJson<Stats>("/stats"),
      ]);
      busy = false;
      if (stop) return;
      const ok = [lob, rnd, mk, hl].some((x) => x.status === "fulfilled" && x.value.body);
      const patch: Parameters<typeof setSnap>[0] = { engine: ok ? "ok" : "down" };
      if (mk.status === "fulfilled" && mk.value.body) {
        const b = mk.value.body;
        patch.offsetMs = b.now - (t0 + Date.now()) / 2;
        if (b.marks && MARKETS.every((x) => b.marks![x])) sampleMarks(b.marks, b.now);
      }
      if (hl.status === "fulfilled") patch.health = hl.value.body;
      if (lob.status === "fulfilled" && lob.value.body && lob.value.body.current === null && getSnapshot().royale?.status !== "live") {
        // the engine runs no royale lobby (predict only)
        patch.royale = null;
      }
      if (rnd.status === "fulfilled" && rnd.value.body) {
        const b = rnd.value.body;
        const open = b.rounds ?? [];
        const proto = open.find((r) => r.protocol);
        patch.predict = proto ? roundFrom(proto) : null;
        patch.userRounds = open.filter((r) => !r.protocol).map(userRoundFrom);
        const ids = [...(proto ? [proto.lobbyId] : []), ...(b.active ?? []).filter((r) => r.protocol).map((r) => r.lobbyId)];
        setWatch((w) => (w.join() === ids.join() ? w : ids));
      }
      if (st.status === "fulfilled") {
        const { status, body } = st.value;
        if (body) {
          patch.stats = body;
          patch.statsState = "ok";
          const wins = body.recentWins ?? [];
          const fresh = firstStats ? wins.slice(0, 1).filter((w) => Date.now() - w.at < 30 * 60_000) : wins.filter((w) => w.at > lastWinAt);
          fresh
            .reverse()
            .filter((w) => !announced.has(`${w.mode}:${w.lobbyId}`))
            .forEach((w) => feed("win", ` won ${usdc(w.amountUnits)} in ${w.mode === "royale" ? "Trading Royale" : "Prediction"} #${w.lobbyId}`, w.callsign));
          if (wins[0]) lastWinAt = Math.max(lastWinAt, wins[0].at);
          firstStats = false;
        } else patch.statsState = status === 404 ? "missing" : "down";
      } else patch.statsState = "down";
      setSnap(patch);
      wait = ok ? POLL_MS : Math.min(MAX_POLL_MS, wait * 2);
      timer = setTimeout(poll, wait);
    };
    void poll();
    const vis = () => {
      if (!document.hidden && !stop) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", vis);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);
  // useMatch streams from NEXT_PUBLIC_ENGINE_WS; without it only the polled parts are live.
  if (!process.env.NEXT_PUBLIC_ENGINE_WS) return null;
  return (
    <>
      <RoyaleWatch />
      {watch.map((id) => (
        <PredictWatch key={id} lobby={id} />
      ))}
    </>
  );
}
