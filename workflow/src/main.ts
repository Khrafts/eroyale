// CRE workflow royale-settle: settles one lobby of RoyaleEscrow.
// HTTP trigger {"lobbyId": N} -> read the lobby onchain -> GET the final book -> GET the three
// settlement prices -> buildReport -> signed report -> writeReport to the escrow.
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
import { decodeFunctionResult, encodeFunctionData, hexToBytes, parseAbi, zeroAddress } from "viem";

import type { Market, Prices } from "../../shared/scoring.ts";
import { MARKETS, candleStart, candleUrl, closeFromCandles } from "./prices.ts";
import { buildReport } from "./report.ts";

type Config = {
  chainName: string; // CRE chain selector name, e.g. "ethereum-testnet-sepolia-base-1"
  escrowAddress: string;
  engineUrl: string; // ENGINE_PUBLIC_URL, no trailing slash
  priceSourceUrl: string; // PRICE_SOURCE_URL with {MARKET}, {START}, {END}
  feeBps: string;
  gasLimit: string;
  authorizedKeys: string[]; // EVM addresses allowed to fire the HTTP trigger; empty only for simulation
};

const ESCROW_ABI = parseAbi([
  "function getLobby(uint256 id) view returns ((uint8 status, uint16 maxPlayers, uint32 duration, uint64 startTime, uint64 endTime, uint96 entry, uint32 playerCount, uint256 pot, bytes32 bookHash))",
]);

const STATUS_LIVE = 2;
const CANDLE_FINAL_DELAY = 120;
const MAX_END_SKEW = 60n;

// Returns the body as hex so consensus compares the exact bytes, with no text decoding.
const fetchFinalBook = (sendRequester: HTTPSendRequester, url: string): string => {
  const resp = sendRequester.sendRequest({ url, method: "GET", timeout: "10s" }).result();
  if (resp.statusCode !== 200) throw new Error(`final book: HTTP ${resp.statusCode}`);
  return bytesToHex(resp.body);
};

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

const onSettle = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const config = runtime.config;
  const input = decodeJson(payload.input) as { lobbyId?: unknown };
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

  const http = new HTTPClient();

  // 2. Final book, byte-identical on every node.
  const bookHex = http
    .sendRequest(runtime, fetchFinalBook, consensusIdenticalAggregation<string>())(
      `${config.engineUrl}/lobbies/${lobbyId}/final`,
    )
    .result();
  const rawBook = hexToBytes(bookHex as `0x${string}`);
  const book = JSON.parse(new TextDecoder().decode(rawBook)) as { lobbyId: number; endTime: number };
  if (BigInt(book.lobbyId) !== lobbyId) throw new Error(`book is for lobby ${book.lobbyId}`);
  // Prices follow the book's endTime so the report matches the arena's final marks. A skew over 60 s
  // (e.g. an engine writing milliseconds) means the book and the chain disagree about the match.
  const skew = BigInt(book.endTime) - lobby.endTime;
  if (skew > MAX_END_SKEW || skew < -MAX_END_SKEW) {
    throw new Error(`book endTime ${book.endTime} vs onchain endTime ${lobby.endTime}`);
  }

  // 3. Settlement prices: close of the candle starting at S, fetched no earlier than S + 120 s,
  //    and only once the onchain end time has passed (the escrow requires it too).
  const start = candleStart(book.endTime);
  const now = Math.floor(runtime.now().getTime() / 1000);
  if (BigInt(now) <= lobby.endTime) throw new Error(`lobby ${lobbyId} ends at ${lobby.endTime}, now ${now}`);
  if (now < start + CANDLE_FINAL_DELAY) throw new Error(`candle ${start} not final until ${start + CANDLE_FINAL_DELAY}`);
  const prices = http
    .sendRequest(runtime, fetchPrices, consensusIdenticalAggregation<Prices>())(config.priceSourceUrl, start)
    .result();
  runtime.log(`prices at ${start}: BTC ${prices.BTC} ETH ${prices.ETH} SOL ${prices.SOL}`);

  // 4. Score and encode with the shared scoring code.
  const out = buildReport(rawBook, prices, lobby.pot, BigInt(config.feeBps), chainSelector);
  runtime.log(`bookHash ${out.bookHash}, winners ${out.winners.join(",")}, amounts ${out.amounts.join(",")}`);
  // Logged before the write so SETTLE_MODE=simulated can pass these exact bytes to settleFallback.
  runtime.log(`report ${out.report}`);

  // 5. Sign and write.
  const report = runtime
    .report({
      encodedPayload: hexToBase64(out.report),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();
  const write = evmClient
    .writeReport(runtime, {
      receiver: config.escrowAddress,
      report,
      gasConfig: { gasLimit: config.gasLimit },
    })
    .result();
  if (write.txStatus !== EVM_PB.TxStatus.SUCCESS) {
    throw new Error(`writeReport tx status ${write.txStatus}: ${write.errorMessage ?? ""}`);
  }
  if (write.receiverContractExecutionStatus !== EVM_PB.ReceiverContractExecutionStatus.SUCCESS) {
    throw new Error(`escrow execution status ${write.receiverContractExecutionStatus}: ${write.errorMessage ?? ""}`);
  }
  if (!write.txHash) throw new Error("writeReport returned no txHash");
  const txHash = bytesToHex(write.txHash);
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
