// What each node reports for consensus: the scored result, not the book. The nodes each fetch the final book and the
// three candles, score them with buildReport, and agree (identical aggregation) on this one JSON string. Its size is
// bounded by the winners (at most 50), not by the book, so it stays under the 25 KB consensus observation limit
// (scripts/check-observation-size.ts checks a full 50-player royale and predict book). bookHash = keccak256 of the
// exact bytes each node received, so agreeing on it is agreeing on the book bytes.
// Runs inside the CRE WASM runtime: no Node built-ins.
import type { Prices } from "../../shared/scoring.ts";
import { buildReport, type OnchainRound } from "./report.ts";

export type Observation = {
  lobbyId: string;
  endTime: number;
  candleStart: number;
  prices: Prices;
  bookHash: `0x${string}`;
  winners: `0x${string}`[];
  amounts: string[];
  report: `0x${string}`;
};

export const MAX_OBSERVATION_BYTES = 25_000;

export function observe(
  rawBook: Uint8Array,
  prices: Prices,
  candleStart: number,
  potUnits: bigint,
  feeBps: bigint,
  chainSelector: bigint,
  onchain: OnchainRound | null,
): string {
  const out = buildReport(rawBook, prices, potUnits, feeBps, chainSelector, onchain);
  const book = JSON.parse(new TextDecoder().decode(rawBook)) as { endTime: number };
  const obs: Observation = {
    lobbyId: out.lobbyId.toString(),
    endTime: book.endTime,
    candleStart,
    prices: { BTC: prices.BTC, ETH: prices.ETH, SOL: prices.SOL },
    bookHash: out.bookHash,
    winners: out.winners,
    amounts: out.amounts.map((a) => a.toString()),
    report: out.report,
  };
  return JSON.stringify(obs);
}
