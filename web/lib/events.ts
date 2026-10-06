// Wire types for every event in the spec "Events". Phantom money is a 2-decimal string,
// token amounts are 6-decimal integer strings, addresses are lowercase.

export type Market = "BTC" | "ETH" | "SOL";
export const MARKETS: Market[] = ["BTC", "ETH", "SOL"];
export type Marks = Record<Market, string>;
export type Side = 1 | -1;

export type LobbyStatus = "open" | "countdown" | "live" | "settling" | "settled" | "cancelled";
export type LobbyPlayer = { player: string; callsign: string; bot: boolean };

export type LobbyEvent = {
  type: "lobby";
  status: LobbyStatus;
  players: LobbyPlayer[];
  startsAt: number | null; // unix seconds, null until the countdown starts
  potUnits: string;
  lobbyId?: number;
  preset?: string;
  endTime?: number | null;
  /** Absent on royale lobbies. Predict lobbies also send lockTime and market (startsAt is the lock time). */
  mode?: "royale" | "predict";
  lockTime?: number;
  market?: Market;
};

export type TickEvent = {
  type: "tick";
  t: number;
  marks: Marks;
  zone: string;
  nextCheckpoint: { index: number; at: number } | null;
};

export type LeaderboardRow = {
  player: string;
  callsign: string;
  bot: boolean;
  equity: string;
  rank: number;
  alive: boolean;
};

export type LeaderboardEvent = {
  type: "leaderboard";
  t: number;
  rows: LeaderboardRow[];
  cutEquity: string | null; // null after the last checkpoint
};

export type FillKind = "open" | "close" | "liquidation";
export type FillEvent = {
  type: "fill";
  t: number;
  player: string;
  market: Market;
  side: Side;
  margin: string;
  leverage: number;
  price: string;
  kind: FillKind;
};

export type WarningEvent = { type: "warning"; checkpoint: number; secondsLeft: number };

export type EliminationReason = "cut" | "zone" | "liquidated";
export type EliminatedEvent = {
  type: "eliminated";
  t: number;
  checkpoint: 1 | 2 | 3 | null;
  players: { player: string; callsign: string; reason: EliminationReason; rank: number }[];
};

export type FinalEvent = {
  type: "final";
  marks: Marks;
  bookHash: string;
  feeUnits?: string;
  finalists: { player: string; callsign: string; equity: string; provisionalPayoutUnits: string }[];
};

export type SettledEvent = {
  type: "settled";
  txHash: string;
  mode: "deployed" | "simulated";
  winners: string[];
  amounts: string[];
};

// ---------- Prediction mode (the spec "Prediction mode" > "Events") ----------
export type Split = "equal" | "linear" | "steep";
export type PredictParams = {
  market: Market;
  entryUnits: string;
  winnerBps: number;
  split: Split;
  creator: string | null;
  creatorFeeBps: number;
  feeBps: number;
};

export type RoundEvent = {
  type: "round";
  lobbyId: number;
  params: PredictParams;
  lockTime: number; // unix seconds
  endTime: number; // unix seconds, the resolve time
  protocol: boolean;
};
/** How many players have a prediction. No prices before the lock. */
export type PredictedEvent = { type: "predicted"; t: number; count: number; lobbyId?: number };
export type LockedPrediction = { player: string; callsign: string; bot: boolean; price: string };
export type LockedEvent = { type: "locked"; t: number; predictions: LockedPrediction[] };
export type PtickEvent = {
  type: "ptick";
  t: number;
  mark: string;
  band: { low: string; high: string };
  leaders: { player: string; rank: number; distance: string }[];
};
export type PredictWinner = {
  player: string;
  callsign: string;
  price: string;
  distance: string;
  rank: number;
  provisionalPayoutUnits: string;
};
export type PredictFinalEvent = {
  type: "final";
  settlementPrice: string;
  bookHash: string;
  winners: PredictWinner[];
  creatorFeeUnits: string;
};
export type CancelledEvent = { type: "cancelled"; lobbyId?: number; reason?: string };
/**
 * Client-side only, never on the wire: the round market's price before the lock, read from the optional `mark`
 * of GET /rounds (the engine sends no price stream until `ptick`). `at` is unix seconds.
 */
export type MarkEvent = { type: "mark"; at: number; mark: string };

/** One entry of GET /rounds (the response is `{rounds: RoundInfo[]}`, protocol round first). Counts, not lists. */
export type RoundInfo = {
  lobbyId: number;
  protocol: boolean;
  status?: LobbyStatus;
  params: PredictParams;
  maxPlayers?: number;
  lockAfter?: number;
  resolveAfter?: number;
  openTime?: number;
  lockTime: number;
  endTime: number;
  players: number;
  predicted?: number;
  potUnits: string;
  mark?: string;
};

export const isPredictFinal = (e: { type: string }): e is PredictFinalEvent => e.type === "final" && "settlementPrice" in e;

export type MatchEvent =
  | RoundEvent
  | PredictedEvent
  | LockedEvent
  | PtickEvent
  | PredictFinalEvent
  | CancelledEvent
  | MarkEvent
  | LobbyEvent
  | TickEvent
  | LeaderboardEvent
  | FillEvent
  | WarningEvent
  | EliminatedEvent
  | FinalEvent
  | SettledEvent;

// Stage preset, used by screens that need to know the shape of a match.
export const STAGE = {
  duration: 120,
  checkpoints: [30, 60, 90],
  zoneLines: ["10050.00", "10150.00", "10300.00"],
  startBalance: "10000.00",
  zoneStart: "9800.00",
} as const;

export const START_BALANCE = 10000;

export type Preset = { name: string; duration: number; checkpoints: number[]; zoneLines: string[] };
export const PRESETS: Record<string, Preset> = {
  stage: { name: "stage", duration: 120, checkpoints: [30, 60, 90], zoneLines: ["10050.00", "10150.00", "10300.00"] },
  standard: { name: "standard", duration: 360, checkpoints: [90, 180, 270], zoneLines: ["10100.00", "10300.00", "10600.00"] },
};
export const presetOf = (name: string | null | undefined): Preset => PRESETS[name ?? ""] ?? PRESETS.stage;

/** "10212.50" -> 10212.5, for drawing only. Never feed the result back into money math. */
export const num = (s: string | undefined | null): number => (s ? Number(s) : 0);

/** 6-decimal token units -> display dollars string with 2 decimals, truncated. */
export function unitsToUsd(units: string): string {
  const u = BigInt(units);
  const whole = u / 1_000_000n;
  const cents = (u % 1_000_000n) / 10_000n;
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}

// ---------- Island (the spec "Island"): the polled engine routes ----------
/** GET /stats. Units are 6-decimal integer strings, addresses lowercase. */
export type StatsLeader = { player: string; callsign: string; bot: boolean; wins: number; earnedUnits: string };
export type RecentWin = {
  lobbyId: number;
  mode: "royale" | "predict";
  player: string;
  callsign: string;
  bot: boolean;
  amountUnits: string;
  at: number; // unix ms
};
export type Stats = { now: number; playing: number; paidTodayUnits: string; leaderboard: StatsLeader[]; recentWins: RecentWin[] };
/** GET /health. */
export type Health = { ok: boolean; chain: boolean; current: number | null; protocolRound: number | null; priceAgeMs: number | null };
/** GET /marks. `now` is unix ms. */
export type MarksInfo = { marks: Marks | null; stale: boolean; now: number };
/** GET /lobbies. */
export type LobbiesInfo = {
  current: number | null;
  lobbies: { lobbyId: number; status: LobbyStatus; players: number; startsAt: number | null }[];
};
/** GET /rounds. */
export type RoundsInfo = { protocol: number | null; rounds: RoundInfo[]; active?: RoundInfo[]; recent?: RoundInfo[] };

/** A real settlement transaction. An engine run with CHAIN=off settles offline (txHash "offline"): nothing on chain. */
export const isTxHash = (tx: string | null | undefined): boolean => !!tx && /^0x[0-9a-fA-F]{64}$/.test(tx);
