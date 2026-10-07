// CRE workflow royale-settle: settles one lobby of RoyaleEscrow.
// HTTP trigger {"lobbyId": N} -> read the lobby onchain -> on each node: GET the final book, GET the three
// settlement prices, buildReport -> consensus on the scored result -> signed report -> writeReport to the escrow.
// Royale and prediction lobbies share this path: buildReport branches on the book's mode and, for a
// prediction book, refuses unless its creator, creator fee, entry and player count equal the on-chain lobby's.
// Stickman Duel: HTTP trigger {"duelId": N} -> read the duel from DuelEscrow -> on each node: GET /duels/N/final,
// buildDuelReport (replays the inputs with shared/duel.ts) -> consensus -> signed report -> writeReport to DuelEscrow.
import {
  EVMClient,
  HTTPCapability,
  HTTPClient,
  LATEST_BLOCK_NUMBER,
  Runner,
  bytesToHex,
  consensusIdenticalAggregation,
  decodeJson,
  encodeCallMsg,
  getNetwork,
  handler,
  hexToBase64,
  type HTTPPayload,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import { EVM_PB } from "@chainlink/cre-sdk/pb";
import { decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress } from "viem";

import type { Market, Prices } from "../../shared/scoring.ts";
import { MARKETS, candleStart, candleUrl, closeFromCandles } from "./prices.ts";
import { observe, type Observation } from "./observation.ts";
import { buildDuelReport, type OnchainDuel, type OnchainRound } from "./report.ts";

type Config = {
  chainName: string; // CRE chain selector name, e.g. "ethereum-testnet-sepolia-base-1"
  escrowAddress: string;
  duelEscrowAddress: string; // DuelEscrow; the zero address until it is deployed (duel settlement then refuses)
  engineUrl: string; // ENGINE_PUBLIC_URL, no trailing slash
  priceSourceUrl: string; // PRICE_SOURCE_URL with {MARKET}, {START}, {END}
  feeBps: string;
  gasLimit: string;
  authorizedKeys: string[]; // EVM addresses allowed to fire the HTTP trigger; empty only for simulation
};

const ESCROW_ABI = parseAbi([
  "function getLobby(uint256 id) view returns ((uint8 status, uint16 maxPlayers, uint32 duration, uint64 startTime, uint64 endTime, uint96 entry, uint32 playerCount, uint256 pot, bytes32 bookHash, address creator, uint16 creatorFeeBps))",
]);

const DUEL_ESCROW_ABI = parseAbi([
  "function getDuel(uint256 id) view returns ((uint8 status, uint96 stake, address playerA, address playerB, uint256 pot, bytes32 bookHash, address winner))",
]);

const STATUS_LIVE = 2;
const CANDLE_FINAL_DELAY = 70; // 10 s after the match ends; Coinbase publishes the minute within seconds
const MAX_END_SKEW = 60n;

const fetchPrices = (sendRequester: HTTPSendRequester, template: string, start: number): Prices => {
  const closes = {} as Record<Market, string>;
  for (const market of MARKETS) {
    const resp = sendRequester
      .sendRequest({
        url: candleUrl(template, market, start),
        method: "GET",
        multiHeaders: { "User-Agent": { values: ["royale-settle"] }, Accept: { values: ["application/json"] } },
        timeout: "10s",
      })
      .result();
    if (resp.statusCode !== 200) throw new Error(`${market} candle: HTTP ${resp.statusCode}`);
    closes[market] = closeFromCandles(new TextDecoder().decode(resp.body), start);
  }
  return closes;
};

type NodeArgs = {
  bookUrl: string;
  priceTemplate: string;
  lobbyId: bigint;
  lobbyEnd: bigint;
  now: number;
  pot: bigint;
  feeBps: bigint;
  chainSelector: bigint;
  onchain: OnchainRound;
};

// Node mode: fetch the exact book bytes, check them against the on-chain lobby, fetch the settlement candles for
// the book's endTime, score. Returns the observation JSON that consensus compares.
const scoreOnNode = (sendRequester: HTTPSendRequester, a: NodeArgs): string => {
  const resp = sendRequester.sendRequest({ url: a.bookUrl, method: "GET", timeout: "10s" }).result();
  if (resp.statusCode !== 200) throw new Error(`final book: HTTP ${resp.statusCode}`);
  const rawBook = resp.body;
  const book = JSON.parse(new TextDecoder().decode(rawBook)) as { lobbyId: number; endTime: number };
  if (BigInt(book.lobbyId) !== a.lobbyId) throw new Error(`book is for lobby ${book.lobbyId}`);
  // Prices follow the book's endTime so the report matches the arena's final marks. A skew over 60 s
  // (e.g. an engine writing milliseconds) means the book and the chain disagree about the match.
  const skew = BigInt(book.endTime) - a.lobbyEnd;
  if (skew > MAX_END_SKEW || skew < -MAX_END_SKEW) {
    throw new Error(`book endTime ${book.endTime} vs onchain endTime ${a.lobbyEnd}`);
  }
  // Settlement prices: close of the candle starting at S, fetched no earlier than S + 70 s.
  const start = candleStart(book.endTime);
  if (a.now < start + CANDLE_FINAL_DELAY) throw new Error(`candle ${start} not final until ${start + CANDLE_FINAL_DELAY}`);
  const prices = fetchPrices(sendRequester, a.priceTemplate, start);
  return observe(rawBook, prices, start, a.pot, a.feeBps, a.chainSelector, a.onchain);
};

type DuelObservation = { duelId: string; bookHash: `0x${string}`; winner: `0x${string}`; report: `0x${string}` };

type DuelNodeArgs = { bookUrl: string; duelId: bigint; chainSelector: bigint; onchain: OnchainDuel };

// Node mode: fetch the exact duel book bytes, replay and score them. Returns the observation JSON consensus compares.
const scoreDuelOnNode = (sendRequester: HTTPSendRequester, a: DuelNodeArgs): string => {
  const resp = sendRequester.sendRequest({ url: a.bookUrl, method: "GET", timeout: "10s" }).result();
  if (resp.statusCode !== 200) throw new Error(`duel book: HTTP ${resp.statusCode}`);
  const out = buildDuelReport(resp.body, a.chainSelector, a.onchain);
  if (out.duelId !== a.duelId) throw new Error(`book is for duel ${out.duelId}`);
  const obs: DuelObservation = { duelId: out.duelId.toString(), bookHash: out.bookHash, winner: out.winner, report: out.report };
  return JSON.stringify(obs);
};

const writeSigned = (runtime: Runtime<Config>, evmClient: EVMClient, receiver: string, reportHex: `0x${string}`): string => {
  const report = runtime
    .report({
      encodedPayload: hexToBase64(reportHex),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();
  const write = evmClient
    .writeReport(runtime, {
      receiver,
      report,
      gasConfig: { gasLimit: runtime.config.gasLimit },
    })
    .result();
  if (write.txStatus !== EVM_PB.TxStatus.SUCCESS) {
    throw new Error(`writeReport tx status ${write.txStatus}: ${write.errorMessage ?? ""}`);
  }
  if (write.receiverContractExecutionStatus !== EVM_PB.ReceiverContractExecutionStatus.SUCCESS) {
    throw new Error(`escrow execution status ${write.receiverContractExecutionStatus}: ${write.errorMessage ?? ""}`);
  }
  if (!write.txHash) throw new Error("writeReport returned no txHash");
  return bytesToHex(write.txHash);
};

const onSettleDuel = (runtime: Runtime<Config>, duelId: bigint): string => {
  const config = runtime.config;
  if (duelId < 1n) throw new Error(`bad duelId ${duelId}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.duelEscrowAddress) || BigInt(config.duelEscrowAddress) === 0n) {
    throw new Error("duelEscrowAddress is not configured");
  }

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainName });
  if (!network) throw new Error(`unknown chain ${config.chainName}`);
  const chainSelector = network.chainSelector.selector;
  const evmClient = new EVMClient(chainSelector);

  const call = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: config.duelEscrowAddress as `0x${string}`,
        data: encodeFunctionData({ abi: DUEL_ESCROW_ABI, functionName: "getDuel", args: [duelId] }),
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();
  const duel = decodeFunctionResult({ abi: DUEL_ESCROW_ABI, functionName: "getDuel", data: bytesToHex(call.data) });
  if (duel.status !== STATUS_LIVE) throw new Error(`duel ${duelId} is not live (status ${duel.status})`);
  const onchain: OnchainDuel = { playerA: duel.playerA, playerB: duel.playerB, stake: BigInt(duel.stake) };
  runtime.log(`duel ${duelId}: ${onchain.playerA} vs ${onchain.playerB}, stake ${onchain.stake}, pot ${duel.pot}`);

  const http = new HTTPClient();
  const observed = http
    .sendRequest(runtime, scoreDuelOnNode, consensusIdenticalAggregation<string>())({
      bookUrl: `${config.engineUrl}/duels/${duelId}/final`,
      duelId,
      chainSelector,
      onchain,
    })
    .result();
  const out = JSON.parse(observed) as DuelObservation;
  if (out.duelId !== duelId.toString()) throw new Error(`observation is for duel ${out.duelId}`);
  runtime.log(`bookHash ${out.bookHash}, winner ${out.winner}`);
  // Logged before the write so SETTLE_MODE=simulated can pass these exact bytes to DuelEscrow.settleFallback.
  runtime.log(`report ${out.report}`);

  const txHash = writeSigned(runtime, evmClient, config.duelEscrowAddress, out.report);
  runtime.log(`settled duel ${duelId}, txHash ${txHash}`);

  return JSON.stringify({ duelId: duelId.toString(), bookHash: out.bookHash, winner: out.winner, report: out.report, txHash });
};

const onSettle = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const config = runtime.config;
  const input = decodeJson(payload.input) as { lobbyId?: unknown; duelId?: unknown };
  if (input.duelId !== undefined) return onSettleDuel(runtime, BigInt(String(input.duelId)));
  const lobbyId = BigInt(String(input.lobbyId));
  if (lobbyId < 1n) throw new Error(`bad lobbyId ${input.lobbyId}`);

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainName });
  if (!network) throw new Error(`unknown chain ${config.chainName}`);
  const chainSelector = network.chainSelector.selector;
  const evmClient = new EVMClient(chainSelector);

  // 1. Read the lobby at the latest block: Base Sepolia finality is too slow for a 120 s lobby, and
  //    the escrow re-checks status and end time onchain.
  const call = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: config.escrowAddress as `0x${string}`,
        data: encodeFunctionData({ abi: ESCROW_ABI, functionName: "getLobby", args: [lobbyId] }),
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();
  const lobby = decodeFunctionResult({ abi: ESCROW_ABI, functionName: "getLobby", data: bytesToHex(call.data) });
  if (lobby.status !== STATUS_LIVE) throw new Error(`lobby ${lobbyId} is not live (status ${lobby.status})`);
  runtime.log(`lobby ${lobbyId}: pot ${lobby.pot}, endTime ${lobby.endTime}`);

  // 2-4. Each node fetches the final book and the three candles and scores them with the shared scoring code;
  //      consensus is on the scored result (see observation.ts), which includes keccak256 of the book bytes each
  //      node received. Agreeing on the hex book itself would exceed the 25 KB observation limit for 50 players.
  const now = Math.floor(runtime.now().getTime() / 1000);
  if (BigInt(now) <= lobby.endTime) throw new Error(`lobby ${lobbyId} ends at ${lobby.endTime}, now ${now}`);
  const onchain = {
    creator: lobby.creator,
    creatorFeeBps: Number(lobby.creatorFeeBps),
    entry: BigInt(lobby.entry),
    playerCount: Number(lobby.playerCount),
  };
  runtime.log(
    `lobby ${lobbyId}: creator ${onchain.creator}, creatorFeeBps ${onchain.creatorFeeBps}, entry ${onchain.entry}, players ${onchain.playerCount}`,
  );
  const http = new HTTPClient();
  const observed = http
    .sendRequest(runtime, scoreOnNode, consensusIdenticalAggregation<string>())({
      bookUrl: `${config.engineUrl}/lobbies/${lobbyId}/final`,
      priceTemplate: config.priceSourceUrl,
      lobbyId,
      lobbyEnd: lobby.endTime,
      now,
      pot: lobby.pot,
      feeBps: BigInt(config.feeBps),
      chainSelector,
      onchain,
    })
    .result();
  const out = JSON.parse(observed) as Observation;
  if (out.lobbyId !== lobbyId.toString()) throw new Error(`observation is for lobby ${out.lobbyId}`);
  runtime.log(`prices at ${out.candleStart}: BTC ${out.prices.BTC} ETH ${out.prices.ETH} SOL ${out.prices.SOL}`);
  runtime.log(`bookHash ${out.bookHash}, winners ${out.winners.join(",")}, amounts ${out.amounts.join(",")}`);
  // Logged before the write so SETTLE_MODE=simulated can pass these exact bytes to settleFallback.
  runtime.log(`report ${out.report}`);

  // 5. Sign and write.
  const txHash = writeSigned(runtime, evmClient, config.escrowAddress, out.report);
  runtime.log(`settled lobby ${lobbyId}, txHash ${txHash}`);

  return JSON.stringify({
    lobbyId: lobbyId.toString(),
    bookHash: out.bookHash,
    winners: out.winners,
    amounts: out.amounts.map((a) => a.toString()),
    report: out.report,
    txHash,
  });
};

const initWorkflow = (config: Config) => {
  const http = new HTTPCapability();
  const authorizedKeys = config.authorizedKeys.map((publicKey) => ({ type: "KEY_TYPE_ECDSA_EVM" as const, publicKey }));
  return [handler(http.trigger(authorizedKeys.length ? { authorizedKeys } : {}), onSettle)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
