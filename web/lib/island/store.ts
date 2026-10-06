// One external store for the island. React reads it with useSyncExternalStore (useIsland); the 3D world reads
// getSnapshot() each frame. A small bus carries one-off moments (feed lines, a checkpoint flare, confetti, a victory).
import { useSyncExternalStore } from "react";
import type { LobbyStatus, Market, Marks, Split, Stats, Health } from "../events";
import { DEFAULT_AVATAR, type AvatarCfg } from "./avatar";

export type RoyaleInfo = {
  lobbyId: number;
  status: LobbyStatus;
  players: number;
  maxPlayers: number | null;
  potUnits: string;
  /** Unix seconds; null until the countdown starts. */
  startsAt: number | null;
  endTime: number | null;
  alive: number;
  /** Match seconds of each checkpoint, and the next one (from tick.nextCheckpoint). */
  checkpoints: number[];
  next: { index: number; at: number } | null;
  entryUnits: string;
};

export type PredictInfo = {
  lobbyId: number;
  market: Market;
  players: number;
  maxPlayers: number | null;
  predicted: number;
  potUnits: string;
  entryUnits: string;
  lockTime: number;
  endTime: number;
  mark: string | null;
};

export type UserRound = PredictInfo & { split: Split; creator: string | null; creatorFeeBps: number };

export type FeedKind = "win" | "live" | "cut" | "lock" | "promo" | "final";
export type FeedItem = { id: string; kind: FeedKind; bold?: string; text: string };

export type IslandSnap = {
  source: "mock" | "live";
  /** Mock moments freeze the clock at this unix second. */
  frozenNow: number | null;
  /** Server clock minus local clock, ms. */
  offsetMs: number;
  /** Engine reachability: `none` when no engine URL is configured. */
  engine: "loading" | "ok" | "down" | "none";
  marks: Marks | null;
  /** The oldest mark in the last ten minutes, for the ticker's change. */
  marksRef: Marks | null;
  /** Recent BTC moves in basis points (newest last), for the candle bars in the Arena. */
  moves: number[];
  royale: RoyaleInfo | null;
  predict: PredictInfo | null;
  userRounds: UserRound[];
  stats: Stats | null;
  /** `missing`: the engine has no /stats yet (404). `down`: the request failed. */
  statsState: "loading" | "ok" | "missing" | "down";
  health: Health | null;
  me: string | null;
  avatar: AvatarCfg;
  escrow: { chain: string | null; address: string | null };
};

export type BusEvent =
  | { kind: "feed"; item: FeedItem }
  | { kind: "cut" }
  | { kind: "celebrate" }
  | { kind: "victory"; amountUnits: string | null; game: string }
  | { kind: "toast"; text: string };

const escrow = { chain: process.env.NEXT_PUBLIC_ESCROW_CHAIN ?? null, address: process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? null };

let snap: IslandSnap = {
  source: "live",
  frozenNow: null,
  offsetMs: 0,
  engine: "loading",
  marks: null,
  marksRef: null,
  moves: [],
  royale: null,
  predict: null,
  userRounds: [],
  stats: null,
  statsState: "loading",
  health: null,
  me: null,
  avatar: DEFAULT_AVATAR,
  escrow,
};
const subs = new Set<() => void>();
const busSubs = new Set<(e: BusEvent) => void>();

export const getSnapshot = () => snap;
export function setSnap(patch: Partial<IslandSnap>) {
  snap = { ...snap, ...patch };
  subs.forEach((f) => f());
}
export function subscribe(f: () => void) {
  subs.add(f);
  return () => void subs.delete(f);
}
export function useIsland<T>(sel: (s: IslandSnap) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => sel(snap),
    () => sel(snap),
  );
}

export function emit(e: BusEvent) {
  busSubs.forEach((f) => f(e));
}
export function onBus(f: (e: BusEvent) => void) {
  busSubs.add(f);
  return () => void busSubs.delete(f);
}

/** Unix seconds on the island clock (server time live, frozen on a mock moment). */
export const nowSec = (s: IslandSnap = snap) => (s.frozenNow !== null ? s.frozenNow : (Date.now() + s.offsetMs) / 1000);
