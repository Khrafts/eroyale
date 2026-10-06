// Settlement price helpers (spec: "Settlement price source"). Pure; no Node built-ins.
import type { Market, Prices } from "../../shared/scoring.ts";

export const MARKETS: readonly Market[] = ["BTC", "ETH", "SOL"];

// S = floor(endTime / 60) * 60 - 60: start of the last full one-minute candle before the end.
export function candleStart(endTime: number): number {
  return Math.floor(endTime / 60) * 60 - 60;
}

// 1791288000 -> "2026-10-06T12:34:00Z" (ISO 8601 UTC, no milliseconds).
export function isoSeconds(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function candleUrl(template: string, market: Market, start: number): string {
  const iso = isoSeconds(start);
  return template.replace("{MARKET}", market).replace("{START}", iso).replace("{END}", iso);
}

// Truncates (never rounds) a decimal string to the wire's 2 decimals: "61234.567" -> "61234.56".
export function truncate2(decimal: string): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(decimal);
  if (!m) throw new Error(`bad price ${decimal}`);
  return `${m[1]}.${((m[2] ?? "") + "00").slice(0, 2)}`;
}

// Reads the close (index 4) of the row whose time == start from the raw response text, keeping
// the number's text exactly as received rather than round-tripping it through a float.
export function closeFromCandles(body: string, start: number): string {
  const num = "\\s*(-?[0-9.eE+-]+)\\s*";
  const row = new RegExp(`\\[\\s*${start}\\s*,${num},${num},${num},${num}[,\\]]`).exec(body);
  if (!row) throw new Error(`no candle at ${start}`);
  return truncate2(row[4]);
}

export function pricesFrom(closes: Record<Market, string>): Prices {
  return { BTC: closes.BTC, ETH: closes.ETH, SOL: closes.SOL };
}
