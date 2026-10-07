// Relayer: escrow calls through RPC_URL. CHAIN=off turns every call into a no-op so the engine runs before deploy.
// Owner-only calls (createLobby, start, cancel, settleFallback) use PRIVATE_KEY_DEPLOYER; joinFor uses PRIVATE_KEY_RELAYER.
import { BaseError, ContractFunctionRevertedError, HttpRequestError, numberToHex, type Transport, InvalidInputRpcError, InvalidParamsRpcError, NonceTooHighError, NonceTooLowError, TimeoutError, WaitForTransactionReceiptTimeoutError, createPublicClient, createWalletClient, http, maxUint256, parseAbi, parseAbiItem, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry, sepolia } from "viem/chains";

export type OnchainLobby = { status: number; endTime: bigint; pot: bigint; entry: bigint; playerCount: number; creator: string; creatorFeeBps: number };
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const LOBBY_OPEN = 1; // IRoyaleEscrow.Status.Open
export const LOBBY_LIVE = 2; // IRoyaleEscrow.Status.Live
export const LOBBY_SETTLED = 3; // IRoyaleEscrow.Status.Settled
export const LOBBY_CANCELLED = 4; // IRoyaleEscrow.Status.Cancelled

export interface Chain {
  readonly on: boolean;
  createLobby(duration: number, entry: bigint, maxPlayers: number): Promise<number | null>;
  /** A user-created prediction round (creator and creator fee on chain). Null with CHAIN=off. */
  createRound(duration: number, entry: bigint, maxPlayers: number, creator: string, creatorFeeBps: number): Promise<{ id: number; txHash: string } | null>;
  /**
   * `until` (unix ms): the join window's close. A join still queued at that time is not sent, and no resend starts
   * after it, so one stuck join cannot hold the serial queue past the window it was for.
   */
  joinFor(id: number, player: string, until?: number): Promise<string | null>;
  start(id: number): Promise<string | null>;
  cancel(id: number): Promise<string | null>;
  getLobby(id: number): Promise<OnchainLobby>;
  blockTime(): Promise<bigint>;
  /** Owner sends the report bytes; resolves to the tx hash once the receipt shows success. */
  settleFallback(report: Hex): Promise<string>;
  blockNumber(): Promise<bigint>;
  /**
   * Hash of the tx that emitted Settled(id) in blocks [from, to] (to defaults to the head), or null. Scans newest
   * first in windows of LOGS_BLOCK_SPAN blocks (default 10: the RPC plan's eth_getLogs limit). Errors are thrown.
   */
  findSettled(id: number, from: bigint, to?: bigint): Promise<string | null>;
  /** Every Settled(id) the escrow emitted in blocks [from, to], any id, oldest first (windows of LOGS_BLOCK_SPAN). */
  settledBetween(from: bigint, to: bigint): Promise<{ id: number; hash: string }[]>;
  /** The settlement tx's receipt, checked: success, and the escrow emitted Settled(id). Null while not mined. */
  settlementReceipt(id: number, hash: Hex): Promise<SettlementReceipt | null>;
  /** DuelEscrow (Stickman Duel), on the same queue and nonces. Null when DUEL_ESCROW_ADDRESS is unset or CHAIN=off. */
  readonly duel: DuelChain | null;
}

export type OnchainDuel = { status: number; stake: bigint; playerA: string; playerB: string; pot: bigint; bookHash: string; winner: string };
export interface DuelChain {
  readonly address: string;
  /** The id comes from the DuelCreated event in the mined receipt (never from a simulation, which a lagging node can answer stale). */
  createDuel(stake: bigint): Promise<{ id: number; txHash: string; block: bigint }>;
  /** `until` (unix ms): as for royale joinFor, a join still queued then is not sent. */
  joinFor(id: number, player: string, until?: number): Promise<string | null>;
  start(id: number): Promise<string>;
  cancel(id: number): Promise<string>;
  getDuel(id: number): Promise<OnchainDuel>;
  settleFallback(report: Hex): Promise<string>;
  /** Hash of the tx that emitted DuelEscrow Settled(id) in blocks [from, head], or null (windows of LOGS_BLOCK_SPAN). */
  findSettled(id: number, from: bigint): Promise<string | null>;
}

export type SettlementReceipt = { ok: boolean; reason: string; bookHash: Hex | null; to: string | null; block: bigint };

/** Replaces every http(s)/ws(s) URL with <rpc>: RPC URLs carry API keys and must never reach a log. */
export function redact(s: string): string {
  return s.replace(/\b(?:https?|wss?):\/\/[^\s"'`<>()\[\]{},]+/gi, "<rpc>");
}

/** Short, stable reason for a failed call: the decoded custom error name when there is one. URLs redacted. */
export function failReason(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data?.errorName) return `${r.data.errorName}(${(r.data.args ?? []).map(String).join(", ")})`;
    return redact(e.shortMessage);
  }
  return redact(e instanceof Error ? e.message : String(e));
}

/**
 * What the node said, without viem's decoration. A write error's `message` also prints the request arguments
 * ("nonce: 837"), so matching it against /nonce/ calls every failed send a nonce error. Only the root cause's details
 * and the short messages along the chain are the node's answer.
 */
export function nodeText(e: BaseError): string {
  const parts: string[] = [];
  e.walk((x) => {
    if (x instanceof BaseError) parts.push(x.shortMessage, x.details ?? "");
    else if (x instanceof Error) parts.push(x.message);
    return false;
  });
  return parts.join(" | ");
}

/**
 * Whether a failed send consumed its nonce (the node already has a tx at it: "nonce too low", "already known",
 * "replacement transaction underpriced") or the nonce is ahead of the node ("nonce too high"). Null for anything else
 * (transport failures, timeouts, reverts): the nonce was not consumed as far as we know, so it is reused.
 */
export function nonceProblem(e: unknown): "used" | "ahead" | null {
  if (!(e instanceof BaseError)) return null;
  if (e.walk((x) => x instanceof NonceTooLowError)) return "used";
  if (e.walk((x) => x instanceof NonceTooHighError)) return "ahead";
  const t = nodeText(e);
  if (/nonce too low|already known|replacement transaction underpriced|nonce has already been used|known transaction/i.test(t)) return "used";
  if (/nonce too high|nonce gap/i.test(t)) return "ahead";
  return null;
}

/** Nonce or transport trouble (a lagging or load-balanced RPC), worth resending; never a contract revert. */
export function retryable(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  if (e.walk((x) => x instanceof ContractFunctionRevertedError)) return false;
  const hit = e.walk((x) =>
    x instanceof NonceTooLowError || x instanceof NonceTooHighError || x instanceof HttpRequestError || x instanceof TimeoutError ||
    x instanceof InvalidParamsRpcError || x instanceof InvalidInputRpcError || x instanceof WaitForTransactionReceiptTimeoutError);
  return !!hit || nonceProblem(e) !== null || /missing or invalid parameters|timed? ?out|fetch failed|socket|ECONN/i.test(nodeText(e));
}

// Signatures from the spec "Contract" and "Prediction mode > Contract changes"; approve/allowance are standard ERC-20.
const ESCROW_ABI = parseAbi([
  "function createLobby(uint32 duration, uint96 entry, uint16 maxPlayers) returns (uint256 id)",
  "function createRound(uint32 duration, uint96 entry, uint16 maxPlayers, address creator, uint16 creatorFeeBps) returns (uint256 id)",
  "function joinFor(uint256 id, address player)",
  "function start(uint256 id)",
  "function cancel(uint256 id)",
  "function settleFallback(bytes report)",
  // Prediction-mode layout: creator and creatorFeeBps appended after bookHash. GET_LOBBY_V1 reads an escrow deployed before it.
  "struct Lobby { uint8 status; uint16 maxPlayers; uint32 duration; uint64 startTime; uint64 endTime; uint96 entry; uint32 playerCount; uint256 pot; bytes32 bookHash; address creator; uint16 creatorFeeBps; }",
  "function getLobby(uint256 id) view returns (Lobby)",
  "error CreatorFeeTooHigh(uint16 creatorFeeBps, uint16 max)", "error ZeroCreatorWithFee(uint16 creatorFeeBps)", "error InvalidLobbyConfig()",
  "error LobbyNotCancellable(uint256 id)",
  // Errors from contracts/src/interfaces/IRoyaleEscrow.sol, so reverts decode to a name.
  "error LobbyNotOpen(uint256 id)", "error LobbyNotLive(uint256 id)", "error AlreadyJoined(uint256 id, address player)",
  "error LobbyFull(uint256 id)", "error NotEnoughPlayers(uint256 id, uint256 count)", "error NotRelayer(address caller)",
  "error WrongChainSelector(uint64 expected, uint64 actual)", "error SettleBeforeEnd(uint256 id, uint64 endTime)",
  "error LengthMismatch(uint256 winners, uint256 amounts)", "error NotPlayer(uint256 id, address winner)",
  "error WinnersNotAscending(uint256 index)", "error AmountsOverBudget(uint256 total, uint256 budget)", "error TransferFailed()",
  "error OwnableUnauthorizedAccount(address account)",
]);
const GET_LOBBY_V1 = parseAbi([
  "struct Lobby { uint8 status; uint16 maxPlayers; uint32 duration; uint64 startTime; uint64 endTime; uint96 entry; uint32 playerCount; uint256 pot; bytes32 bookHash; }",
  "function getLobby(uint256 id) view returns (Lobby)",
]);
// From contracts/src/interfaces/IDuelEscrow.sol (duel-contracts track).
const DUEL_ABI = parseAbi([
  "function createDuel(uint96 stake) returns (uint256 id)",
  "function joinFor(uint256 id, address player)",
  "function start(uint256 id)",
  "function cancel(uint256 id)",
  "function settleFallback(bytes report)",
  "struct Duel { uint8 status; uint96 stake; address playerA; address playerB; uint256 pot; bytes32 bookHash; address winner; }",
  "function getDuel(uint256 id) view returns (Duel)",
  "error ZeroAddress()", "error ZeroStake()", "error DuelNotOpen(uint256 id)", "error DuelNotLive(uint256 id)",
  "error DuelNotCancellable(uint256 id)", "error AlreadyJoined(uint256 id, address player)", "error DuelFull(uint256 id)",
  "error NotEnoughPlayers(uint256 id)", "error NotRelayer(address caller)", "error WrongChainSelector(uint64 expected, uint64 actual)",
  "error NotPlayer(uint256 id, address winner)", "error TransferFailed()", "error OwnableUnauthorizedAccount(address account)",
]);
const DUEL_CREATED_EVENT = parseAbiItem("event DuelCreated(uint256 indexed id, uint96 stake)");
const DUEL_SETTLED_EVENT = parseAbiItem("event Settled(uint256 indexed id, bytes32 bookHash, address winner)");
export const DUEL_OPEN = 1, DUEL_LIVE = 2, DUEL_SETTLED = 3, DUEL_CANCELLED = 4; // IDuelEscrow.Status
const SETTLED_EVENT = parseAbiItem("event Settled(uint256 indexed id, bytes32 bookHash)");
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function mint(address to, uint256 amount)", // MockUSDC: open mint
]);
// The relayer pays every entry; top it up from MockUSDC's open mint when it runs below this.
const RELAYER_FLOOR = 1_000n * 10n ** 6n;
const RELAYER_MINT = 1_000_000n * 10n ** 6n;
const JOIN_TRIES = 4; // first send plus 3 retries
// A load-balanced RPC can answer from a node a few blocks behind. A revert that contradicts what we just saw mined
// (LobbyNotOpen right after createLobby, NotEnoughPlayers right after the joins, ...) is retried this many times.
const LAG_TRIES = 4;
const LAG_WAIT_MS = 1500;
// After a state-changing receipt, poll reads until the RPC shows the new state, for at most this long.
const CONFIRM_READ_MS = 30_000;
// Receipt wait per tx (viem's default is 180 s). Base Sepolia mines every 2 s; a tx not mined in this long is stuck,
// and every escrow call waits behind it on the one serial queue.
const RECEIPT_TIMEOUT_MS = Number(process.env.RECEIPT_TIMEOUT_MS ?? 60_000);
const RECEIPT_WAITS = 3; // a tx the node can still mine is waited on this many times RECEIPT_TIMEOUT_MS
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Test-only (ENGINE_READ_LAG_MS): answers eth_call and eth_estimateGas at the newest block that was already the head
 * lagMs ago, the way a load-balanced RPC node that is behind does. Sends, receipts and nonces are untouched.
 */
export function laggedTransport(base: Transport, lagMs: number): Transport {
  return (opts) => {
    const b = base(opts);
    const heads: { t: number; n: bigint }[] = [];
    const poll = async () => {
      try { heads.push({ t: Date.now(), n: BigInt(await b.request({ method: "eth_blockNumber" }) as Hex) }); } catch { /* next poll */ }
      while (heads.length > 1 && heads[1].t <= Date.now() - lagMs) heads.shift();
    };
    void poll();
    setInterval(poll, 100).unref();
    const request = (async (args: { method: string; params?: unknown[] }) => {
      if ((args.method === "eth_call" || args.method === "eth_estimateGas") && heads.length) {
        const params = [...(args.params ?? [])];
        if (params[1] === undefined || params[1] === "latest" || params[1] === "pending") {
          params[1] = numberToHex(heads[0].n);
          return b.request({ ...args, params } as never);
        }
      }
      return b.request(args as never);
    }) as typeof b.request;
    return { ...b, request };
  };
}

export const offChain: Chain = {
  on: false,
  createLobby: async () => null,
  createRound: async () => null,
  joinFor: async () => null,
  start: async () => null,
  cancel: async () => null,
  getLobby: async () => { throw new Error("CHAIN=off"); },
  blockTime: async () => { throw new Error("CHAIN=off"); },
  settleFallback: async () => { throw new Error("CHAIN=off"); },
  blockNumber: async () => { throw new Error("CHAIN=off"); },
  findSettled: async () => null,
  settledBetween: async () => [],
  settlementReceipt: async () => null,
  duel: null,
};

function need(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`${k} is required when CHAIN is not off`);
  return v;
}

/** Builds the relayer; with the chain on, refuses an RPC whose chain id is not the configured CHAIN's. */
export async function makeChain(env: NodeJS.ProcessEnv, log: (m: string) => void): Promise<Chain> {
  const name = (env.CHAIN ?? "off").trim();
  if (name === "off" || name === "") return offChain;
  // anvil: a local dev chain (chain id 31337) for scripts/e2e-local.sh.
  const chain = name === "base-sepolia" ? baseSepolia : name === "ethereum-sepolia" ? sepolia : name === "anvil" ? foundry : null;
  if (!chain) throw new Error(`CHAIN must be off, base-sepolia, ethereum-sepolia or anvil, got ${name}`);
  const lagMs = Number(env.ENGINE_READ_LAG_MS ?? 0);
  const transport = lagMs > 0 ? laggedTransport(http(need(env, "RPC_URL")), lagMs) : http(need(env, "RPC_URL"));
  if (lagMs > 0) log(`[chain] test mode: reads lag ${lagMs} ms behind the head (ENGINE_READ_LAG_MS)`);
  // Receipts polled every second (viem defaults to 4 s): joins are sequential, so this sets the join rate.
  const pub = createPublicClient({ chain, transport, pollingInterval: 1_000 });
  const rpcChainId = await pub.getChainId().catch((e) => { throw new Error(`RPC_URL chain id check failed: ${failReason(e)}`); });
  if (rpcChainId !== chain.id) throw new Error(`RPC_URL serves chain id ${rpcChainId}, but CHAIN=${name} is chain id ${chain.id}`);
  const owner = createWalletClient({ chain, transport, account: privateKeyToAccount(need(env, "PRIVATE_KEY_DEPLOYER") as Hex) });
  const relayer = createWalletClient({ chain, transport, account: privateKeyToAccount(need(env, "PRIVATE_KEY_RELAYER") as Hex) });
  // Local nonce per account. A load-balanced RPC's pending count can lag behind a tx we already saw mined, so the
  // count is read once ('pending') and then incremented here. A nonce error resyncs to max(local + 1, RPC count).
  const nonces = new Map<Address, number>();
  async function write(wallet: typeof owner, request: Parameters<typeof owner.writeContract>[0]): Promise<Hex> {
    const who = wallet.account.address;
    let nonce = nonces.get(who);
    if (nonce === undefined) nonce = await pub.getTransactionCount({ address: who, blockTag: "pending" });
    try {
      const hash = await wallet.writeContract({ ...request, nonce } as never);
      nonces.set(who, nonce + 1);
      return hash;
    } catch (e) {
      const p = nonceProblem(e);
      if (p === "used") {
        const rpc = await pub.getTransactionCount({ address: who, blockTag: "pending" }).catch(() => 0);
        nonces.set(who, Math.max(nonce + 1, rpc));
      } else if (p === "ahead") nonces.delete(who); // re-read from the node on the next send
      else nonces.set(who, nonce); // not consumed (if it was, the next send hits "nonce too low"/"already known" and resyncs)
      throw e;
    }
  }
  /**
   * A tx whose receipt has not come after RECEIPT_TIMEOUT_MS. If the node can execute it (it knows the tx and its
   * pending nonce is past it), the chain is just slow: keep waiting (true). If the node does not know it, or its
   * nonce is at or past the node's pending nonce (a gap below it: it can never be mined), forget the local nonce so
   * the next send re-reads the node's pending count and fills the gap (false), instead of queueing every later tx
   * behind it until each one times out.
   */
  async function receiptTimedOut(wallet: typeof owner, hash: Hex): Promise<boolean> {
    const who = wallet.account.address;
    const tx = await pub.getTransaction({ hash }).catch(() => null);
    const pending = await pub.getTransactionCount({ address: who, blockTag: "pending" }).catch(() => null);
    if (tx && pending !== null && tx.nonce < pending) {
      log(`[chain] no receipt for ${hash} after ${RECEIPT_TIMEOUT_MS / 1000} s; the node has it queued to mine (nonce ${tx.nonce}), still waiting`);
      return true;
    }
    log(`[chain] no receipt for ${hash} after ${RECEIPT_TIMEOUT_MS / 1000} s; ${tx ? `nonce ${tx.nonce} is not below the node's pending nonce ${pending ?? "?"} (a gap)` : "the node does not know it"}; local nonce ${nonces.get(who) ?? "?"} dropped, re-read on the next send`);
    nonces.delete(who);
    return false;
  }
  async function receipt(wallet: typeof owner, hash: Hex) {
    for (let n = 1; ; n++) {
      try { return await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }); } catch (e) {
        if (!(e instanceof WaitForTransactionReceiptTimeoutError) || !(await receiptTimedOut(wallet, hash)) || n >= RECEIPT_WAITS) throw e;
      }
    }
  }
  const escrow = need(env, "ESCROW_ADDRESS") as Address;
  const duelAddr = (env.DUEL_ESCROW_ADDRESS ?? "").trim() as Address | "";
  if (duelAddr && !/^0x[0-9a-fA-F]{40}$/.test(duelAddr)) throw new Error("DUEL_ESCROW_ADDRESS must be an address");
  const token = need(env, "TOKEN_ADDRESS") as Address;
  let approved = false;
  // One transaction at a time, so the relayer and owner nonces never race.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const p = queue.then(f, f);
    queue = p.catch(() => undefined);
    return p;
  };

  // Reverts that, at the moment each call is made, can only come from a node that has not seen our last tx yet.
  type EscrowFn = "createLobby" | "createRound" | "joinFor" | "start" | "cancel" | "settleFallback";
  const LAG_REVERTS: Record<EscrowFn, string[]> = {
    joinFor: ["LobbyNotOpen("], // the engine only joins while its lobby is open, after createLobby was confirmed
    start: ["LobbyNotOpen(", "NotEnoughPlayers("], // start follows confirmed joins
    settleFallback: ["LobbyNotLive(", "SettleBeforeEnd("], // the engine checked block time and status first
    cancel: [], createLobby: [], createRound: [],
  };
  async function simulate(wallet: typeof owner, fn: EscrowFn, args: readonly unknown[]) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await pub.simulateContract({ address: escrow, abi: ESCROW_ABI, functionName: fn, args: args as never, account: wallet.account });
      } catch (e) {
        const why = failReason(e);
        if (attempt >= LAG_TRIES || !LAG_REVERTS[fn].some((p) => why.startsWith(p))) throw e;
        log(`[chain] ${fn} simulation reverted ${why}; RPC may lag, retry ${attempt}/${LAG_TRIES - 1} in ${LAG_WAIT_MS} ms`);
        await sleep(LAG_WAIT_MS);
      }
    }
  }

  /** Poll a read until it shows the state a mined tx produced (a lagging node may not have it yet). */
  async function confirmRead(what: string, ok: () => Promise<boolean>) {
    const until = Date.now() + CONFIRM_READ_MS;
    for (let n = 1; ; n++) {
      if (await ok().catch(() => false)) return;
      if (Date.now() > until) throw new Error(`RPC still does not show ${what} after ${CONFIRM_READ_MS / 1000} s`);
      if (n === 2) log(`[chain] waiting for the RPC to show ${what}`);
      await sleep(500);
    }
  }
  const reads = escrowReader(pub as unknown as PublicClient, escrow, env, log);
  const readLobby = (id: bigint) => reads.getLobby(Number(id));
  const lobbyStatus = async (id: bigint) => (await readLobby(id)).status;

  async function send(wallet: typeof owner, fn: EscrowFn, args: readonly unknown[]) {
    const { request, result } = await simulate(wallet, fn, args);
    const hash = await write(wallet, request as never);
    const rc = await receipt(wallet, hash);
    if (rc.status !== "success") throw new Error(`${fn} reverted: ${hash}`);
    log(`[chain] ${fn}(${fn === "settleFallback" ? "report" : args.join(", ")}) ${hash}`);
    return { hash, result };
  }

  return {
    on: true,
    createLobby: (duration, entry, maxPlayers) => serial(async () => {
      const { result } = await send(owner, "createLobby", [duration, entry, maxPlayers]);
      const id = result as bigint;
      await confirmRead(`lobby ${id} Open`, async () => (await lobbyStatus(id)) === LOBBY_OPEN);
      return Number(id);
    }),
    createRound: (duration, entry, maxPlayers, creator, creatorFeeBps) => serial(async () => {
      const { hash, result } = await send(owner, "createRound", [duration, entry, maxPlayers, creator as Address, creatorFeeBps]);
      const id = result as bigint;
      await confirmRead(`round ${id} Open`, async () => (await lobbyStatus(id)) === LOBBY_OPEN);
      return { id: Number(id), txHash: hash };
    }),
    joinFor: (id, player, until) => serial(async () => {
      const closed = () => until !== undefined && Date.now() > until;
      if (closed()) throw new Error("join window closed while the join waited for the relayer");
      if (!approved) {
        await fundRelayer(escrow);
        approved = true;
      }
      return joinWithRetries(() => send(relayer, "joinFor", [BigInt(id), player as Address]), id, player, closed);
    }),
    start: (id) => serial(async () => {
      const { hash } = await send(owner, "start", [BigInt(id)]);
      await confirmRead(`lobby ${id} Live`, async () => (await lobbyStatus(BigInt(id))) === LOBBY_LIVE);
      return hash;
    }),
    cancel: (id) => serial(async () => (await send(owner, "cancel", [BigInt(id)])).hash),
    settleFallback: (report) => serial(async () => (await send(owner, "settleFallback", [report])).hash),
    ...reads,
    duel: duelAddr ? duelChain(duelAddr) : null,
  };

  /** Mint the relayer MockUSDC when low and approve `spender` (an escrow) once. Runs inside the serial queue. */
  async function fundRelayer(spender: Address) {
    const bal = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [relayer.account.address] });
    if (bal < RELAYER_FLOOR) {
      const hash = await write(relayer, { address: token, abi: ERC20_ABI, functionName: "mint", args: [relayer.account.address, RELAYER_MINT] } as never);
      const rc = await receipt(relayer, hash);
      if (rc.status !== "success") throw new Error(`mint reverted: ${hash}`);
      log(`[chain] relayer minted ${RELAYER_MINT} MockUSDC units ${hash}`);
      await confirmRead("the relayer's minted balance", async () =>
        (await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [relayer.account.address] })) >= RELAYER_FLOOR);
    }
    const have = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [relayer.account.address, spender] });
    if (have < 10n ** 30n) {
      const hash = await write(relayer, { address: token, abi: ERC20_ABI, functionName: "approve", args: [spender, maxUint256] } as never);
      const rc = await receipt(relayer, hash);
      if (rc.status !== "success") throw new Error(`approve reverted: ${hash}`);
      log(`[chain] relayer approved ${spender} ${hash}`);
      await confirmRead("the relayer's allowance", async () =>
        (await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [relayer.account.address, spender] })) >= 10n ** 30n);
    }
  }

  /** Up to 3 resends on nonce or transport errors. If an earlier attempt landed, the resend reverts AlreadyJoined: joined. */
  async function joinWithRetries(go: () => Promise<{ hash: Hex }>, id: number, player: string, closed: () => boolean): Promise<string | null> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= JOIN_TRIES; attempt++) {
      try { return (await go()).hash; } catch (e) {
        lastErr = e;
        if (failReason(e).startsWith("AlreadyJoined(")) { log(`[chain] joinFor(${id}, ${player}): already joined on chain`); return null; }
        if (!retryable(e) || attempt === JOIN_TRIES || closed()) throw e;
        log(`[chain] joinFor(${id}, ${player}) attempt ${attempt} failed, resending: ${failReason(e)}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    throw lastErr;
  }

  /** DuelEscrow calls: same owner and relayer keys, same serial queue and local nonces as the royale escrow. */
  function duelChain(addr: Address): DuelChain {
    type DuelFn = "createDuel" | "joinFor" | "start" | "cancel" | "settleFallback";
    const DUEL_LAG: Record<DuelFn, string[]> = {
      joinFor: ["DuelNotOpen("], start: ["DuelNotOpen(", "NotEnoughPlayers("], settleFallback: ["DuelNotLive("], createDuel: [], cancel: [],
    };
    let duelApproved = false;
    const readDuel = async (id: number): Promise<OnchainDuel> => {
      const d = await pub.readContract({ address: addr, abi: DUEL_ABI, functionName: "getDuel", args: [BigInt(id)] });
      return { status: d.status, stake: d.stake, playerA: d.playerA.toLowerCase(), playerB: d.playerB.toLowerCase(), pot: d.pot, bookHash: d.bookHash, winner: d.winner.toLowerCase() };
    };
    async function dsend(wallet: typeof owner, fn: DuelFn, args: readonly unknown[]) {
      let sim;
      for (let attempt = 1; ; attempt++) {
        try { sim = await pub.simulateContract({ address: addr, abi: DUEL_ABI, functionName: fn, args: args as never, account: wallet.account }); break; } catch (e) {
          const why = failReason(e);
          if (attempt >= LAG_TRIES || !DUEL_LAG[fn].some((p) => why.startsWith(p))) throw e;
          log(`[chain] duel ${fn} simulation reverted ${why}; RPC may lag, retry ${attempt}/${LAG_TRIES - 1} in ${LAG_WAIT_MS} ms`);
          await sleep(LAG_WAIT_MS);
        }
      }
      const hash = await write(wallet, sim.request as never);
      const rc = await receipt(wallet, hash);
      if (rc.status !== "success") throw new Error(`duel ${fn} reverted: ${hash}`);
      log(`[chain] duel ${fn}(${fn === "settleFallback" ? "report" : args.join(", ")}) ${hash}`);
      return { hash, result: sim.result, rc };
    }
    const LOGS_SPAN = BigInt(env.LOGS_BLOCK_SPAN ?? 10);
    return {
      address: addr.toLowerCase(),
      createDuel: (stake) => serial(async () => {
        const { hash, rc } = await dsend(owner, "createDuel", [stake]);
        const ev = parseEventLogs({ abi: [DUEL_CREATED_EVENT], logs: rc.logs }).filter((l) => l.address.toLowerCase() === addr.toLowerCase());
        if (ev.length !== 1) throw new Error(`createDuel ${hash}: expected one DuelCreated in the receipt, found ${ev.length}`);
        const id = Number(ev[0].args.id);
        await confirmRead(`duel ${id} Open`, async () => (await readDuel(id)).status === DUEL_OPEN);
        return { id, txHash: hash, block: rc.blockNumber };
      }),
      joinFor: (id, player, until) => serial(async () => {
        const closed = () => until !== undefined && Date.now() > until;
        if (closed()) throw new Error("join window closed while the join waited for the relayer");
        if (!duelApproved) { await fundRelayer(addr); duelApproved = true; }
        return joinWithRetries(() => dsend(relayer, "joinFor", [BigInt(id), player as Address]), id, player, closed);
      }),
      start: (id) => serial(async () => {
        const { hash } = await dsend(owner, "start", [BigInt(id)]);
        await confirmRead(`duel ${id} Live`, async () => (await readDuel(id)).status === DUEL_LIVE);
        return hash;
      }),
      cancel: (id) => serial(async () => (await dsend(owner, "cancel", [BigInt(id)])).hash),
      settleFallback: (report) => serial(async () => (await dsend(owner, "settleFallback", [report])).hash),
      getDuel: readDuel,
      findSettled: async (id, from) => {
        const head = await pub.getBlockNumber();
        for (let hi = head; hi >= from && hi >= 0n; hi -= LOGS_SPAN) {
          const lo = hi - LOGS_SPAN + 1n > from ? hi - LOGS_SPAN + 1n : from;
          const logs = await pub.getLogs({ address: addr, event: DUEL_SETTLED_EVENT, args: { id: BigInt(id) }, fromBlock: lo, toBlock: hi });
          if (logs.length) return logs[logs.length - 1].transactionHash;
        }
        return null;
      },
    };
  }
}

export type EscrowReads = Pick<Chain, "getLobby" | "blockTime" | "blockNumber" | "findSettled" | "settledBetween" | "settlementReceipt">;

/** Read-only escrow access (no keys): shared by the engine's Chain and scripts/cre-settler.mts. */
export function escrowReader(pub: PublicClient, escrow: Address, env: NodeJS.ProcessEnv, log: (m: string) => void): EscrowReads {
  // eth_getLogs block window. The Base Sepolia RPC plan in use refuses more than 10 blocks per call.
  const LOGS_SPAN = BigInt(env.LOGS_BLOCK_SPAN ?? 10);
  if (LOGS_SPAN < 1n) throw new Error("LOGS_BLOCK_SPAN must be at least 1");
  /** getLobby in the Prediction-mode layout; an escrow deployed before it answers in the old one (no creator, fee 0). */
  let v1 = false;
  async function readLobby(id: bigint): Promise<OnchainLobby> {
    if (!v1) {
      try {
        const l = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "getLobby", args: [id] });
        return { status: l.status, endTime: l.endTime, pot: l.pot, entry: l.entry, playerCount: l.playerCount, creator: l.creator.toLowerCase(), creatorFeeBps: l.creatorFeeBps };
      } catch (e) {
        if (!(e instanceof BaseError) || !/decod|data size|out of bounds|position/i.test(e.message)) throw e;
        v1 = true;
        log("[chain] escrow getLobby has the pre-prediction layout; reading creator as zero");
      }
    }
    const l = await pub.readContract({ address: escrow, abi: GET_LOBBY_V1, functionName: "getLobby", args: [id] });
    return { status: l.status, endTime: l.endTime, pot: l.pot, entry: l.entry, playerCount: l.playerCount, creator: ZERO_ADDRESS, creatorFeeBps: 0 };
  }
  return {
    getLobby: (id) => readLobby(BigInt(id)),
    blockTime: async () => (await pub.getBlock({ blockTag: "latest" })).timestamp,
    blockNumber: () => pub.getBlockNumber(),
    findSettled: async (id, from, to) => {
      const head = to ?? await pub.getBlockNumber();
      for (let hi = head; hi >= from && hi >= 0n; hi -= LOGS_SPAN) {
        const lo = hi - LOGS_SPAN + 1n > from ? hi - LOGS_SPAN + 1n : from;
        const logs = await pub.getLogs({ address: escrow, event: SETTLED_EVENT, args: { id: BigInt(id) }, fromBlock: lo, toBlock: hi });
        if (logs.length) return logs[logs.length - 1].transactionHash;
      }
      return null;
    },
    settledBetween: async (from, to) => {
      const out: { id: number; hash: string }[] = [];
      for (let lo = from; lo <= to; lo += LOGS_SPAN) {
        const hi = lo + LOGS_SPAN - 1n < to ? lo + LOGS_SPAN - 1n : to;
        const logs = await pub.getLogs({ address: escrow, event: SETTLED_EVENT, fromBlock: lo, toBlock: hi });
        for (const l of logs) if (l.args.id !== undefined) out.push({ id: Number(l.args.id), hash: l.transactionHash });
      }
      return out;
    },
    settlementReceipt: async (id, hash) => {
      const rc = await pub.getTransactionReceipt({ hash }).catch((e) => {
        if (e instanceof BaseError && /not be found|not found/i.test(e.message)) return null;
        throw e;
      });
      if (!rc) return null;
      const to = rc.to ? rc.to.toLowerCase() : null;
      if (rc.status !== "success") return { ok: false, reason: `tx ${hash} reverted`, bookHash: null, to, block: rc.blockNumber };
      const ev = parseEventLogs({ abi: [SETTLED_EVENT], logs: rc.logs })
        .find((l) => l.address.toLowerCase() === escrow.toLowerCase() && l.args.id === BigInt(id));
      // A Keystone forwarder tx succeeds even when the receiver reverts, so success alone proves nothing.
      if (!ev) return { ok: false, reason: `tx ${hash} succeeded but the escrow emitted no Settled(${id})`, bookHash: null, to, block: rc.blockNumber };
      return { ok: true, reason: "", bookHash: ev.args.bookHash, to, block: rc.blockNumber };
    },
  };
}
