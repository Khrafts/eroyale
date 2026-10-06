// Wire types for every event in CLAUDE.md "Events". Phantom money is a 2-decimal string,
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
  startsAt: number; // unix seconds
  potUnits: string;
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
  cutEquity: string;
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
  finalists: { player: string; callsign: string; equity: string; provisionalPayoutUnits: string }[];
};

export type SettledEvent = {
  type: "settled";
  txHash: string;
  mode: "deployed" | "simulated";
  winners: string[];
  amounts: string[];
};

export type MatchEvent =
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

/** "10212.50" -> 10212.5, for drawing only. Never feed the result back into money math. */
export const num = (s: string | undefined | null): number => (s ? Number(s) : 0);

/** 6-decimal token units -> display dollars string with 2 decimals, truncated. */
export function unitsToUsd(units: string): string {
  const u = BigInt(units);
  const whole = u / 1_000_000n;
  const cents = (u % 1_000_000n) / 10_000n;
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}
