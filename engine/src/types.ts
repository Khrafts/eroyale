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

/**
 * How the displayed and enforced zone moves. `linear` (the spec, the default): a straight line from 9800.00 to each
 * checkpoint's zone line. `relative` (ZONE_MODE=relative): each tick the target is the alive players' average equity
 * less a gap that falls linearly from startBps at t=0 to endBps at the last checkpoint, then holds; the zone never
 * goes down, and a checkpoint enforces the zone at that tick.
 */
export type ZoneConfig = { mode: "linear" } | { mode: "relative"; startBps: bigint; endBps: bigint };
export const LINEAR_ZONE: ZoneConfig = { mode: "linear" };

/** A preset with its length replaced: checkpoints at 25/50/75% (whole seconds), the base preset's zone lines. */
export function withDuration(base: Preset, duration: number): Preset {
  if (!Number.isInteger(duration) || duration <= 0 || duration % 60 !== 0) throw new Error(`duration must be a positive multiple of 60 s, got ${duration}`);
  if (duration === base.duration) return base;
  return { ...base, duration, checkpoints: [Math.floor(duration / 4), Math.floor(duration / 2), Math.floor((duration * 3) / 4)] };
}

export const START_BALANCE = "10000.00";
export const ZONE_START_CENTS = 980000n;
export const ENTRY_UNITS = 5_000000n;
export const FEE_BPS = 500n;
export const TICKS_PER_SEC = 4;

export type OpenOrder = { action: "open"; market: Market; side: 1 | -1; margin: string; leverage: number };
export type CloseOrder = { action: "close"; market: Market };
export type Order = OpenOrder | CloseOrder;

export type EngineEvent = { type: string; [k: string]: unknown };

/**
 * How a settlement reached the escrow (extra `settled` field, beyond the spec): `cre-simulator` (SETTLE_MODE=cre: the
 * royale-settle workflow run in the CRE CLI simulator, its report written through Chainlink's MockKeystoneForwarder),
 * `owner-fallback` (the owner's settleFallback with the same report bytes), `cre-don` (SETTLE_MODE=deployed: the
 * deployed workflow through the KeystoneForwarder), `offline` (CHAIN=off: nothing sent on chain, `txHash` is "offline").
 */
export type SettleVia = "cre-simulator" | "owner-fallback" | "cre-don" | "offline";
