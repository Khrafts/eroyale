// Pure scoring-to-report step shared by the CRE handler and scripts/score-fixture.ts.
// Runs inside the CRE WASM runtime: no Node built-ins.
import { encodeAbiParameters, keccak256 } from "viem";

import { predictSettle, settle, type FinalBook, type PredictBook, type Prices } from "../../shared/scoring.ts";
import { replay } from "./duel-stub.ts";

export type SettlementReport = {
  lobbyId: bigint;
  winners: `0x${string}`[];
  amounts: bigint[];
  feeUnits: bigint;
  creatorFeeUnits: bigint;
  bookHash: `0x${string}`;
  report: `0x${string}`;
};

// The on-chain lobby as getLobby returns it. Royale lobbies have the zero address and fee 0.
export type OnchainRound = { creator: string; creatorFeeBps: number; entry: bigint; playerCount: number };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const REPORT_PARAMS = [
  { type: "uint64", name: "chainSelector" },
  { type: "uint256", name: "lobbyId" },
  { type: "bytes32", name: "bookHash" },
  { type: "address[]", name: "winners" },
  { type: "uint256[]", name: "amounts" },
] as const;

// Refuses a predict book whose creator, creator fee, entry or player count differs from the on-chain
// lobby's. A null book creator must match the zero address. The handler always calls this (via
// buildReport's `onchain`); scripts/score-fixture.ts has no chain and passes onchain = null explicitly.
export function checkRoundParams(book: PredictBook, onchain: OnchainRound): void {
  const bookCreator = (book.params.creator ?? ZERO_ADDRESS).toLowerCase();
  const chainCreator = onchain.creator.toLowerCase();
  if (bookCreator !== chainCreator) throw new Error(`book creator ${bookCreator} vs onchain creator ${chainCreator}`);
  const bookFee = book.params.creator === null ? 0 : book.params.creatorFeeBps;
  if (bookFee !== onchain.creatorFeeBps) {
    throw new Error(`book creatorFeeBps ${bookFee} vs onchain creatorFeeBps ${onchain.creatorFeeBps}`);
  }
  if (BigInt(book.params.entryUnits) !== onchain.entry) {
    throw new Error(`book entryUnits ${book.params.entryUnits} vs onchain entry ${onchain.entry}`);
  }
  if (book.players.length !== onchain.playerCount) {
    throw new Error(`book has ${book.players.length} players vs onchain playerCount ${onchain.playerCount}`);
  }
}

// rawBook is the exact body served at GET /lobbies/:id/final; bookHash is keccak256 of those bytes,
// hashed as received. A decoded copy is used only for JSON parsing.
// No `mode`: royale, settle(). mode "predict": predictSettle() with prices[params.market]; refuses unless
// feeBps == params.feeBps and potUnits == players.length * entryUnits, and, unless `onchain` is null,
// unless the book's creator, creator fee, entry and player count equal the on-chain lobby's. `onchain` is
// required so a caller cannot skip the check by omission; only the offline score-fixture passes null. A royale book is refused for an
// on-chain lobby that carries a creator or creator fee.
export function buildReport(
  rawBook: Uint8Array,
  prices: Prices,
  potUnits: bigint,
  feeBps: bigint,
  chainSelector: bigint,
  onchain: OnchainRound | null,
): SettlementReport {
  // Also enforced at runtime for untyped or stale callers (e.g. a 5-argument call compiled elsewhere).
  if (onchain === undefined) throw new Error("buildReport: pass the on-chain lobby, or null only when offline");
  const parsed = JSON.parse(new TextDecoder().decode(rawBook)) as FinalBook | PredictBook;
  if ((parsed as { mode?: unknown }).mode === "duel") throw new Error("duel book: use buildDuelReport");
  if (!Number.isSafeInteger(parsed.lobbyId) || parsed.lobbyId < 1) throw new Error(`bad lobbyId ${parsed.lobbyId}`);
  const bookHash = keccak256(rawBook);

  let result: { winners: string[]; amounts: bigint[]; feeUnits: bigint; creatorFeeUnits: bigint };
  const mode = (parsed as { mode?: unknown }).mode;
  if (mode === undefined) {
    if (onchain !== null && (onchain.creator.toLowerCase() !== ZERO_ADDRESS || onchain.creatorFeeBps !== 0)) {
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
    if (onchain !== null) checkRoundParams(book, onchain);
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

// ---- Stickman Duel ----

// The book served at GET /duels/:id/final. players and inputs in side order; inputs from encodeInputs.
export type DuelBook = {
  mode: "duel";
  duelId: number;
  players: [string, string];
  stakeUnits: string;
  feeBps: number;
  inputs: [string, string];
  ticks: number;
  logHash: string;
};

// The on-chain duel as DuelEscrow.getDuel returns it (playerA / playerB in join order).
export type OnchainDuel = { playerA: string; playerB: string; stake: bigint };

export type DuelSettlementReport = {
  duelId: bigint;
  winner: `0x${string}`; // zero address for a draw
  winnerIndex: 0 | 1 | null;
  rounds: [number, number];
  ticks: number;
  payoutUnits: bigint; // to the winner; 0 for a draw (each player gets their stake back)
  feeUnits: bigint; // to the treasury; 0 for a draw
  bookHash: `0x${string}`;
  report: `0x${string}`;
};

// DuelEscrow.FEE_BPS: the contract takes floor(pot * 500 / 10000) from a won pot.
const DUEL_FEE_BPS = 500n;

const DUEL_REPORT_PARAMS = [
  { type: "uint64", name: "chainSelector" },
  { type: "uint256", name: "duelId" },
  { type: "bytes32", name: "bookHash" },
  { type: "address", name: "winner" },
] as const;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// rawBook is the exact body served at GET /duels/:id/final; bookHash is keccak256 of those bytes. Replays both input
// strings with shared/duel.ts and refuses unless the replay's tick count equals the book's. The winner index maps to
// the book's player address (zero address for a draw). Unless `onchain` is null (offline score-fixture only), refuses
// unless the book's players (as a set) and stake equal the on-chain duel's. Also refuses a book whose feeBps is not
// the contract's 500.
export function buildDuelReport(rawBook: Uint8Array, chainSelector: bigint, onchain: OnchainDuel | null): DuelSettlementReport {
  if (onchain === undefined) throw new Error("buildDuelReport: pass the on-chain duel, or null only when offline");
  const book = JSON.parse(new TextDecoder().decode(rawBook)) as DuelBook;
  if (book.mode !== "duel") throw new Error(`not a duel book (mode ${String(book.mode)})`);
  if (!Number.isSafeInteger(book.duelId) || book.duelId < 1) throw new Error(`bad duelId ${book.duelId}`);
  if (!Array.isArray(book.players) || book.players.length !== 2) throw new Error("a duel book needs exactly two players");
  const [a, b] = book.players;
  if (!ADDRESS_RE.test(a) || !ADDRESS_RE.test(b)) throw new Error(`bad player address ${a} / ${b}`);
  if (a === b) throw new Error(`both sides are ${a}`);
  if (!Array.isArray(book.inputs) || book.inputs.length !== 2) throw new Error("a duel book needs two input strings");
  if (typeof book.inputs[0] !== "string" || typeof book.inputs[1] !== "string") throw new Error("inputs must be strings");
  if (!Number.isSafeInteger(book.ticks) || book.ticks < 1) throw new Error(`bad ticks ${book.ticks}`);
  if (typeof book.stakeUnits !== "string" || !/^[1-9]\d*$/.test(book.stakeUnits)) throw new Error(`bad stakeUnits ${book.stakeUnits}`);
  if (BigInt(book.feeBps) !== DUEL_FEE_BPS) throw new Error(`book feeBps ${book.feeBps} vs DuelEscrow ${DUEL_FEE_BPS}`);
  const stake = BigInt(book.stakeUnits);

  if (onchain !== null) {
    const chainPlayers = [onchain.playerA.toLowerCase(), onchain.playerB.toLowerCase()];
    if (!(chainPlayers.includes(a) && chainPlayers.includes(b))) {
      throw new Error(`book players ${a},${b} vs onchain ${chainPlayers.join(",")}`);
    }
    if (stake !== onchain.stake) throw new Error(`book stakeUnits ${stake} vs onchain stake ${onchain.stake}`);
  }

  const r = replay(book.inputs[0], book.inputs[1]);
  if (r.ticks !== book.ticks) throw new Error(`replay ran ${r.ticks} ticks, book says ${book.ticks}`);

  const winner = (r.winner === null ? ZERO_ADDRESS : book.players[r.winner]) as `0x${string}`;
  const pot = 2n * stake;
  const feeUnits = r.winner === null ? 0n : (pot * DUEL_FEE_BPS) / 10000n;
  const payoutUnits = r.winner === null ? 0n : pot - feeUnits;
  const bookHash = keccak256(rawBook);
  const duelId = BigInt(book.duelId);
  const report = encodeAbiParameters(DUEL_REPORT_PARAMS, [chainSelector, duelId, bookHash, winner]);
  return { duelId, winner, winnerIndex: r.winner, rounds: r.rounds, ticks: r.ticks, payoutUnits, feeUnits, bookHash, report };
}
