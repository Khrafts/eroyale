import type { Market, Prices } from "../../shared/scoring.ts";

export type { Market, Prices };
export const MARKETS: Market[] = ["BTC", "ETH", "SOL"];

export type Status = "open" | "countdown" | "live" | "settling" | "settled" | "cancelled";

export type Preset = {
  name: "stage" | "standard";
  duration: number; // seconds
  checkpoints: number[]; // seconds since start
  zoneCents: bigint[]; // zone line enforced at each checkpoint
};

const START_CENTS = 1000000n;
const line = (bps: bigint) => START_CENTS + (START_CENTS * bps) / 10000n;

export const PRESETS: Record<Preset["name"], Preset> = {
  stage: { name: "stage", duration: 120, checkpoints: [30, 60, 90], zoneCents: [line(50n), line(150n), line(300n)] },
  standard: { name: "standard", duration: 360, checkpoints: [90, 180, 270], zoneCents: [line(100n), line(300n), line(600n)] },
};

export const START_BALANCE = "10000.00";
export const ZONE_START_CENTS = 980000n;
export const ENTRY_UNITS = 5_000000n;
export const FEE_BPS = 500n;
export const TICKS_PER_SEC = 4;

export type OpenOrder = { action: "open"; market: Market; side: 1 | -1; margin: string; leverage: number };
export type CloseOrder = { action: "close"; market: Market };
export type Order = OpenOrder | CloseOrder;

export type EngineEvent = { type: string; [k: string]: unknown };
