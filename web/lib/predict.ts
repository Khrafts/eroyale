"use client";
// Prediction mode helpers for the phone and the arena: parameter ranges, the payout preview (through the shared
// predictSettle), the rounds list (GET /rounds, or the mock), and integer-cents price handling.
import { useEffect, useState } from "react";
import { fromCents, predictSettle, toCents } from "../../shared/scoring";
import type { PredictBook } from "../../shared/scoring";
import type { Market, PredictParams, RoundInfo, Split } from "./events";
import { engineHttp } from "./engineUrl";
import { mockRoundLists } from "../mocks/predict";
import type { Match } from "./useMatch";

export const PROTOCOL_FEE_BPS = 500;

/** CLAUDE.md "Prediction mode": the user-created ranges, with the step each control moves in. */
export const RANGES = {
  entryUnits: { min: 1_000000, max: 50_000000, step: 1_000000 },
  maxPlayers: { min: 4, max: 50, step: 1 },
  lockAfter: { min: 30, max: 600, step: 30 },
  resolveAfter: { min: 60, max: 3600, step: 60 },
  winnerBps: { min: 1000, max: 5000, step: 500 },
  creatorFeeBps: { min: 0, max: 500, step: 50 },
} as const;
export type RangeKey = keyof typeof RANGES;
export const SPLITS: Split[] = ["equal", "linear", "steep"];

/** Snap to the control's step and clamp to its range: no value outside the range can come out. */
export function inRange(key: RangeKey, v: number): number {
  const r = RANGES[key];
  const snapped = r.min + Math.round((v - r.min) / r.step) * r.step;
  return Math.min(r.max, Math.max(r.min, Number.isFinite(snapped) ? snapped : r.min));
}

export type Draft = {
  market: Market;
  entryUnits: number;
  maxPlayers: number;
  lockAfter: number;
  resolveAfter: number;
  winnerBps: number;
  split: Split;
  creatorFeeBps: number;
};
export const DEFAULT_DRAFT: Draft = {
  market: "ETH",
  entryUnits: 10_000000,
  maxPlayers: 20,
  lockAfter: 120,
  resolveAfter: 600,
  winnerBps: 3000,
  split: "steep",
  creatorFeeBps: 200,
};

export type Preview = {
  k: number;
  potUnits: bigint;
  /** Payout by finishing rank, 1 = closest. */
  byRank: bigint[];
  creatorFeeUnits: bigint;
  feeUnits: bigint;
  error: string | null;
};

/**
 * Payout table for a full lobby where every player predicts and nobody ties, computed by predictSettle itself:
 * player i predicts settlement + (i + 1) cents, so rank i + 1 is player i.
 */
export function previewPayouts(d: Draft, creator = "0x00000000000000000000000000000000000000c0"): Preview {
  const n = d.maxPlayers;
  const players = Array.from({ length: n }, (_, i) => ({ player: "0x" + (i + 1).toString(16).padStart(40, "0"), joinIndex: i }));
  const params: PredictParams = {
    market: d.market,
    entryUnits: String(d.entryUnits),
    winnerBps: d.winnerBps,
    split: d.split,
    creator: d.creatorFeeBps > 0 ? creator : null,
    creatorFeeBps: d.creatorFeeBps,
    feeBps: PROTOCOL_FEE_BPS,
  };
  const book: PredictBook = {
    lobbyId: 0,
    mode: "predict",
    lockTime: 0,
    endTime: d.resolveAfter,
    params,
    players,
    predictions: players.map((p, i) => ({ player: p.player, price: fromCents(100000n + BigInt(i + 1)), joinIndex: i })),
    logHash: "0x",
  };
  const potUnits = BigInt(n) * BigInt(d.entryUnits);
  try {
    const res = predictSettle(book, "1000.00", potUnits);
    const amt = new Map(res.winners.map((w, i) => [w, res.amounts[i]]));
    const byRank = players.map((p) => amt.get(p.player) ?? 0n).filter((a) => a > 0n);
    return { k: byRank.length, potUnits, byRank, creatorFeeUnits: res.creatorFeeUnits, feeUnits: res.feeUnits, error: null };
  } catch (e) {
    return { k: 0, potUnits, byRank: [], creatorFeeUnits: 0n, feeUnits: 0n, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Winners for a lobby of n: max(1, floor(n * winnerBps / 10000)). */
export const winnersOf = (n: number, winnerBps: number) => Math.max(1, Math.floor((n * winnerBps) / 10000));

// ---------- prices as integer cents (never floats on the way to a signature) ----------
export const centsOf = (s: string | null | undefined): bigint | null => {
  if (!s || !/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  try {
    return toCents(s.includes(".") ? s.padEnd(s.indexOf(".") + 3, "0") : s + ".00");
  } catch {
    return null;
  }
};
/** Always a positive 2-decimal string: the smallest price the control can produce is 0.01. */
export const priceStr = (c: bigint) => fromCents(c < 1n ? 1n : c);

/** One drag pixel or nudge in cents, per market: BTC moves in dollars, SOL in cents. */
export const NUDGE: Record<Market, { px: bigint; step: bigint; big: bigint }> = {
  BTC: { px: 50n, step: 100n, big: 1000n },
  ETH: { px: 5n, step: 10n, big: 100n },
  SOL: { px: 1n, step: 1n, big: 10n },
};

export const usd = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** "62480.10" -> "62,480.10" without going through a float. */
export const commas = (s: string) => {
  const [i, d] = s.split(".");
  const neg = i.startsWith("-");
  const body = (neg ? i.slice(1) : i).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + body + (d !== undefined ? "." + d : "");
};
export const durationStr = (sec: number) => {
  if (sec < 60) return `${sec} s`;
  if (sec % 60 === 0) return sec % 3600 === 0 ? `${sec / 3600} h` : `${sec / 60} min`;
  return `${Math.floor(sec / 60)} min ${sec % 60} s`;
};
export const countdown = (sec: number) => {
  const v = Math.max(0, Math.ceil(sec - 1e-6));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = String(v % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

const JOINED = "royale.rounds";
/** Rounds this browser joined, so "your rounds" can find them again in `active` and `recent`. */
export function rememberJoined(lobbyId: number) {
  try {
    const xs = JSON.parse(localStorage.getItem(JOINED) ?? "[]") as number[];
    if (!xs.includes(lobbyId)) localStorage.setItem(JOINED, JSON.stringify([...xs, lobbyId].slice(-50)));
  } catch {
    /* storage blocked */
  }
}
function joinedIds(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(JOINED) ?? "[]") as number[]);
  } catch {
    return new Set();
  }
}

export type Rounds = {
  /** Open rounds, protocol first. */
  rounds: RoundInfo[];
  /** Locked or finished rounds this player is in, newest lock first. */
  mine: RoundInfo[];
  error: string | null;
  loaded: boolean;
};

/** GET /rounds every 3 s, or the mock's lists at the mock clock. */
export function useRounds(match: Match): Rounds {
  const [state, setState] = useState<Rounds>({ rounds: [], mine: [], error: null, loaded: false });
  const { source, mockSeed, clock, me } = match;
  useEffect(() => {
    let stop = false;
    const pick = (b: { rounds?: RoundInfo[]; active?: RoundInfo[]; recent?: RoundInfo[] }, isMine: (r: RoundInfo) => boolean) => {
      const seen = new Set<number>();
      const mine = [...(b.active ?? []), ...(b.recent ?? [])].filter((r) => !seen.has(r.lobbyId) && seen.add(r.lobbyId) && isMine(r));
      return { rounds: b.rounds ?? [], mine: mine.sort((x, y) => y.lockTime - x.lockTime) };
    };
    const pull = async () => {
      if (source === "mock") {
        if (mockSeed === null) return;
        const l = mockRoundLists(clock(), mockSeed);
        const ids = joinedIds();
        setState({ ...pick(l, (r) => ids.has(r.lobbyId) || (!!me && l.playersOf[r.lobbyId]?.includes(me))), error: null, loaded: true });
        return;
      }
      if (new URLSearchParams(window.location.search).get("mock")) return; // the mock is still starting
      if (!process.env.NEXT_PUBLIC_ENGINE_WS && !process.env.NEXT_PUBLIC_ENGINE_HTTP) {
        setState({ rounds: [], mine: [], loaded: true, error: "No engine is configured. Set NEXT_PUBLIC_ENGINE_WS (repo .env) and rebuild, or open this page with ?mock=predict." });
        return;
      }
      try {
        const r = await fetch(`${engineHttp()}/rounds`, { cache: "no-store" });
        const body = (await r.json()) as { rounds?: RoundInfo[]; active?: RoundInfo[]; recent?: RoundInfo[] };
        const ids = joinedIds();
        if (!stop) setState({ ...pick(body, (x) => ids.has(x.lobbyId)), error: null, loaded: true });
      } catch {
        if (!stop) setState((x) => ({ ...x, error: "Cannot reach the engine. Retrying.", loaded: true }));
      }
    };
    void pull();
    const id = setInterval(pull, source === "mock" ? 500 : 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [source, mockSeed, clock, me]);
  return state;
}
