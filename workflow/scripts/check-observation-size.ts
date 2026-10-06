// Usage: tsx scripts/check-observation-size.ts
// Builds a worst-case 50-player royale book (every finalist in profit with three positions, so 50 winners) and a
// worst-case 50-player predict book (winnerBps 5000, creator fee, max entry), runs the node-side observe() the
// handler uses, and fails unless each consensus observation is under MAX_OBSERVATION_BYTES (25 KB simulation limit).
// Also prints what the old design (consensus on the hex book) would have sent, for comparison.
import { keccak256, toHex } from "viem";

import type { Prices } from "../../shared/scoring.ts";
import { MAX_OBSERVATION_BYTES, observe } from "../src/observation.ts";

const N = 50;
const SELECTOR = 10344971235874465080n; // Base Sepolia
const prices: Prices = { BTC: "123456.78", ETH: "4567.89", SOL: "234.56" };
const addr = (i: number) => keccak256(toHex(`royale-size:${i}`)).slice(0, 42).toLowerCase();
const players = Array.from({ length: N }, (_, i) => addr(i)).sort();
const bytes = (s: string) => new TextEncoder().encode(s);

let failed = false;
function check(name: string, book: unknown, pot: bigint, onchain: Parameters<typeof observe>[6]) {
  // Pretty-printed, like the gate fixtures: larger than the engine's compact book, so a stricter test.
  const raw = bytes(JSON.stringify(book, null, 2));
  const obs = observe(raw, prices, 1791287940, pot, 500n, SELECTOR, onchain);
  const size = bytes(obs).length;
  const winners = (JSON.parse(obs) as { winners: string[] }).winners.length;
  const ok = size < MAX_OBSERVATION_BYTES;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${N} players, ${winners} winners, book ${raw.length} B (hex ${raw.length * 2 + 2} B), observation ${size} B, limit ${MAX_OBSERVATION_BYTES} B`);
}

check(
  "royale",
  {
    lobbyId: 999999,
    endTime: 1791288000,
    startBalance: "10000.00",
    finalists: players.map((player, i) => ({
      player,
      cash: `${10000 + i}.99`,
      positions: (["BTC", "ETH", "SOL"] as const).map((market) => ({
        market,
        side: 1,
        notional: "999999.99",
        entry: (Number(prices[market]) * 0.9).toFixed(2),
      })),
    })),
    logHash: keccak256(toHex("log")),
  },
  BigInt(N) * 5_000000n,
  { creator: "0x0000000000000000000000000000000000000000", creatorFeeBps: 0, entry: 5_000000n, playerCount: N },
);

const creator = addr(1000);
check(
  "predict",
  {
    lobbyId: 999999,
    mode: "predict",
    lockTime: 1791284400,
    endTime: 1791288000,
    params: { market: "BTC", entryUnits: "50000000", winnerBps: 5000, split: "steep", creator, creatorFeeBps: 500, feeBps: 500 },
    players: players.map((player, i) => ({ player, joinIndex: i })),
    predictions: players.map((player, i) => ({ player, price: `${123400 + i * 3}.${String(i).padStart(2, "0")}`, joinIndex: i })),
    logHash: keccak256(toHex("log")),
  },
  BigInt(N) * 50_000000n,
  { creator, creatorFeeBps: 500, entry: 50_000000n, playerCount: N },
);

process.exit(failed ? 1 : 0);
