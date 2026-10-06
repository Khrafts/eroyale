// Pure scoring-to-report step shared by the CRE handler and scripts/score-fixture.ts.
// Runs inside the CRE WASM runtime: no Node built-ins.
import { encodeAbiParameters, keccak256 } from "viem";

import { settle, type FinalBook, type Prices } from "../../shared/scoring.ts";

export type SettlementReport = {
  lobbyId: bigint;
  winners: `0x${string}`[];
  amounts: bigint[];
  feeUnits: bigint;
  bookHash: `0x${string}`;
  report: `0x${string}`;
};

const REPORT_PARAMS = [
  { type: "uint64", name: "chainSelector" },
  { type: "uint256", name: "lobbyId" },
  { type: "bytes32", name: "bookHash" },
  { type: "address[]", name: "winners" },
  { type: "uint256[]", name: "amounts" },
] as const;

// rawBook is the exact body served at GET /lobbies/:id/final; bookHash is keccak256 of those bytes,
// hashed as received. A decoded copy is used only for JSON parsing.
export function buildReport(
  rawBook: Uint8Array,
  prices: Prices,
  potUnits: bigint,
  feeBps: bigint,
  chainSelector: bigint,
): SettlementReport {
  const book = JSON.parse(new TextDecoder().decode(rawBook)) as FinalBook;
  if (!Number.isSafeInteger(book.lobbyId) || book.lobbyId < 1) throw new Error(`bad lobbyId ${book.lobbyId}`);
  const bookHash = keccak256(rawBook);
  const { winners, amounts, feeUnits } = settle(book, prices, potUnits, feeBps);
  const lobbyId = BigInt(book.lobbyId);
  const addrs = winners.map((w) => w as `0x${string}`);
  const report = encodeAbiParameters(REPORT_PARAMS, [chainSelector, lobbyId, bookHash, addrs, amounts]);
  return { lobbyId, winners: addrs, amounts, feeUnits, bookHash, report };
}
