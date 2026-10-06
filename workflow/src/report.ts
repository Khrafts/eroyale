// Pure scoring-to-report step shared by the CRE handler and scripts/score-fixture.ts.
// Runs inside the CRE WASM runtime: no Node built-ins.
import { encodeAbiParameters, keccak256 } from "viem";

import { predictSettle, settle, type FinalBook, type PredictBook, type Prices } from "../../shared/scoring.ts";

export type SettlementReport = {
  lobbyId: bigint;
  winners: `0x${string}`[];
  amounts: bigint[];
  feeUnits: bigint;
  creatorFeeUnits: bigint;
  bookHash: `0x${string}`;
  report: `0x${string}`;
};

// The on-chain lobby's creator and creator fee (getLobby). Royale lobbies have the zero address and 0.
export type OnchainRound = { creator: string; creatorFeeBps: number };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const REPORT_PARAMS = [
  { type: "uint64", name: "chainSelector" },
  { type: "uint256", name: "lobbyId" },
  { type: "bytes32", name: "bookHash" },
  { type: "address[]", name: "winners" },
  { type: "uint256[]", name: "amounts" },
] as const;

// Refuses a predict book whose creator or creator fee differs from the on-chain lobby's. A null book
// creator must match the zero address. The handler always calls this (via buildReport's `onchain`);
// scripts/score-fixture.ts has no chain and skips it.
export function checkRoundParams(book: PredictBook, onchain: OnchainRound): void {
  const bookCreator = (book.params.creator ?? ZERO_ADDRESS).toLowerCase();
  const chainCreator = onchain.creator.toLowerCase();
  if (bookCreator !== chainCreator) throw new Error(`book creator ${bookCreator} vs onchain creator ${chainCreator}`);
  const bookFee = book.params.creator === null ? 0 : book.params.creatorFeeBps;
  if (bookFee !== onchain.creatorFeeBps) {
    throw new Error(`book creatorFeeBps ${bookFee} vs onchain creatorFeeBps ${onchain.creatorFeeBps}`);
  }
}

// rawBook is the exact body served at GET /lobbies/:id/final; bookHash is keccak256 of those bytes,
// hashed as received. A decoded copy is used only for JSON parsing.
// No `mode`: royale, settle(). mode "predict": predictSettle() with prices[params.market]; refuses unless
// feeBps == params.feeBps and potUnits == players.length * entryUnits, and, when `onchain` is given,
// unless the book's creator and creator fee equal the on-chain lobby's. A royale book is refused for an
// on-chain lobby that carries a creator or creator fee.
export function buildReport(
  rawBook: Uint8Array,
  prices: Prices,
  potUnits: bigint,
  feeBps: bigint,
  chainSelector: bigint,
  onchain?: OnchainRound,
): SettlementReport {
  const parsed = JSON.parse(new TextDecoder().decode(rawBook)) as FinalBook | PredictBook;
  if (!Number.isSafeInteger(parsed.lobbyId) || parsed.lobbyId < 1) throw new Error(`bad lobbyId ${parsed.lobbyId}`);
  const bookHash = keccak256(rawBook);

  let result: { winners: string[]; amounts: bigint[]; feeUnits: bigint; creatorFeeUnits: bigint };
  const mode = (parsed as { mode?: unknown }).mode;
  if (mode === undefined) {
    if (onchain && (onchain.creator.toLowerCase() !== ZERO_ADDRESS || onchain.creatorFeeBps !== 0)) {
      throw new Error(`royale book for a lobby with creator ${onchain.creator} and fee ${onchain.creatorFeeBps}`);
    }
    result = { ...settle(parsed as FinalBook, prices, potUnits, feeBps), creatorFeeUnits: 0n };
  } else if (mode === "predict") {
    const book = parsed as PredictBook;
    if (BigInt(book.params.feeBps) !== feeBps) throw new Error(`feeBps ${feeBps} vs book feeBps ${book.params.feeBps}`);
    if (!/^\d+$/.test(book.params.entryUnits)) throw new Error(`bad entryUnits ${book.params.entryUnits}`);
    const expectedPot = BigInt(book.players.length) * BigInt(book.params.entryUnits);
    if (potUnits !== expectedPot) {
      throw new Error(`pot ${potUnits} vs ${book.players.length} players * ${book.params.entryUnits} = ${expectedPot}`);
    }
    if (onchain) checkRoundParams(book, onchain);
    const price = prices[book.params.market];
    if (typeof price !== "string") throw new Error(`no settlement price for ${book.params.market}`);
    result = predictSettle(book, price, potUnits);
  } else {
    throw new Error(`unknown book mode ${String(mode)}`);
  }

  const lobbyId = BigInt(parsed.lobbyId);
  const addrs = result.winners.map((w) => w as `0x${string}`);
  const report = encodeAbiParameters(REPORT_PARAMS, [chainSelector, lobbyId, bookHash, addrs, result.amounts]);
  return {
    lobbyId,
    winners: addrs,
    amounts: result.amounts,
    feeUnits: result.feeUnits,
    creatorFeeUnits: result.creatorFeeUnits,
    bookHash,
    report,
  };
}
