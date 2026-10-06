// Relayer: escrow calls through RPC_URL. CHAIN=off turns every call into a no-op so the engine runs before deploy.
// Owner-only calls (createLobby, start, cancel, settleFallback) use PRIVATE_KEY_DEPLOYER; joinFor uses PRIVATE_KEY_RELAYER.
import { BaseError, ContractFunctionRevertedError, HttpRequestError, numberToHex, type Transport, InvalidInputRpcError, InvalidParamsRpcError, NonceTooHighError, NonceTooLowError, TimeoutError, createPublicClient, createWalletClient, http, maxUint256, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry, sepolia } from "viem/chains";

export type OnchainLobby = { status: number; endTime: bigint; pot: bigint; playerCount: number; entry: bigint; creator: string; creatorFeeBps: number };
export const LOBBY_OPEN = 1; // IRoyaleEscrow.Status.Open
export const LOBBY_LIVE = 2; // IRoyaleEscrow.Status.Live
export const LOBBY_SETTLED = 3; // IRoyaleEscrow.Status.Settled

export interface Chain {
  readonly on: boolean;
  createLobby(duration: number, entry: bigint, maxPlayers: number): Promise<number | null>;
  joinFor(id: number, player: string): Promise<string | null>;
  start(id: number): Promise<string | null>;
  cancel(id: number): Promise<string | null>;
  getLobby(id: number): Promise<OnchainLobby>;
  blockTime(): Promise<bigint>;
  /** Owner sends the report bytes; resolves to the tx hash once the receipt shows success. */
  settleFallback(report: Hex): Promise<string>;
  /** Hash of the tx that emitted Settled(id), or null if none yet (searches the last `lookback` blocks). */
  findSettled(id: number, lookback: bigint): Promise<string | null>;
}

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

/** Nonce or transport trouble (a lagging or load-balanced RPC), worth resending; never a contract revert. */
export function retryable(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  if (e.walk((x) => x instanceof ContractFunctionRevertedError)) return false;
  const hit = e.walk((x) =>
    x instanceof NonceTooLowError || x instanceof NonceTooHighError || x instanceof HttpRequestError || x instanceof TimeoutError ||
    x instanceof InvalidParamsRpcError || x instanceof InvalidInputRpcError);
  return !!hit || /nonce|missing or invalid parameters|timed? ?out|fetch failed|socket|ECONN/i.test(e.message);
}

// Signatures from CLAUDE.md "Contract"; approve/allowance are standard ERC-20.
const ESCROW_ABI = parseAbi([
  "function createLobby(uint32 duration, uint96 entry, uint16 maxPlayers) returns (uint256 id)",
  "function joinFor(uint256 id, address player)",
  "function start(uint256 id)",
  "function cancel(uint256 id)",
  "function settleFallback(bytes report)",
  "struct Lobby { uint8 status; uint16 maxPlayers; uint32 duration; uint64 startTime; uint64 endTime; uint96 entry; uint32 playerCount; uint256 pot; bytes32 bookHash; address creator; uint16 creatorFeeBps; }",
  "function getLobby(uint256 id) view returns (Lobby)",
  // Errors from contracts/src/interfaces/IRoyaleEscrow.sol, so reverts decode to a name.
  "error LobbyNotOpen(uint256 id)", "error LobbyNotLive(uint256 id)", "error AlreadyJoined(uint256 id, address player)",
  "error LobbyFull(uint256 id)", "error NotEnoughPlayers(uint256 id, uint256 count)", "error NotRelayer(address caller)",
  "error WrongChainSelector(uint64 expected, uint64 actual)", "error SettleBeforeEnd(uint256 id, uint64 endTime)",
  "error LengthMismatch(uint256 winners, uint256 amounts)", "error NotPlayer(uint256 id, address winner)",
  "error WinnersNotAscending(uint256 index)", "error AmountsOverBudget(uint256 total, uint256 budget)", "error TransferFailed()",
  "error OwnableUnauthorizedAccount(address account)",
]);
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
  joinFor: async () => null,
  start: async () => null,
  cancel: async () => null,
  getLobby: async () => { throw new Error("CHAIN=off"); },
  blockTime: async () => { throw new Error("CHAIN=off"); },
  settleFallback: async () => { throw new Error("CHAIN=off"); },
  findSettled: async () => null,
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
      if (/nonce/i.test(e instanceof BaseError ? e.message : String(e))) {
        const rpc = await pub.getTransactionCount({ address: who, blockTag: "pending" }).catch(() => 0);
        nonces.set(who, Math.max(nonce + 1, rpc));
      } else nonces.set(who, nonce); // not consumed (if it was, the next send hits a nonce error and resyncs)
      throw e;
    }
  }
  const escrow = need(env, "ESCROW_ADDRESS") as Address;
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
  type EscrowFn = "createLobby" | "joinFor" | "start" | "cancel" | "settleFallback";
  const LAG_REVERTS: Record<EscrowFn, string[]> = {
    joinFor: ["LobbyNotOpen("], // the engine only joins while its lobby is open, after createLobby was confirmed
    start: ["LobbyNotOpen(", "NotEnoughPlayers("], // start follows confirmed joins
    settleFallback: ["LobbyNotLive(", "SettleBeforeEnd("], // the engine checked block time and status first
    cancel: [], createLobby: [],
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
  const lobbyStatus = async (id: bigint) => (await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "getLobby", args: [id] })).status;

  async function send(wallet: typeof owner, fn: EscrowFn, args: readonly unknown[]) {
    const { request, result } = await simulate(wallet, fn, args);
    const hash = await write(wallet, request as never);
    const rc = await pub.waitForTransactionReceipt({ hash });
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
    joinFor: (id, player) => serial(async () => {
      if (!approved) {
        const bal = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [relayer.account.address] });
        if (bal < RELAYER_FLOOR) {
          const hash = await write(relayer, { address: token, abi: ERC20_ABI, functionName: "mint", args: [relayer.account.address, RELAYER_MINT] } as never);
          const rc = await pub.waitForTransactionReceipt({ hash });
          if (rc.status !== "success") throw new Error(`mint reverted: ${hash}`);
          log(`[chain] relayer minted ${RELAYER_MINT} MockUSDC units ${hash}`);
          await confirmRead("the relayer's minted balance", async () =>
            (await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [relayer.account.address] })) >= RELAYER_FLOOR);
        }
        const have = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [relayer.account.address, escrow] });
        if (have < 10n ** 30n) {
          const hash = await write(relayer, { address: token, abi: ERC20_ABI, functionName: "approve", args: [escrow, maxUint256] } as never);
          const rc = await pub.waitForTransactionReceipt({ hash });
          if (rc.status !== "success") throw new Error(`approve reverted: ${hash}`);
          log(`[chain] relayer approved escrow ${hash}`);
          await confirmRead("the relayer's allowance", async () =>
            (await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [relayer.account.address, escrow] })) >= 10n ** 30n);
        }
        approved = true;
      }
      // Up to 3 resends on nonce or transport errors. If an earlier attempt did land, the resend reverts with
      // AlreadyJoined, which counts as joined.
      let lastErr: unknown;
      for (let attempt = 1; attempt <= JOIN_TRIES; attempt++) {
        try { return (await send(relayer, "joinFor", [BigInt(id), player as Address])).hash; } catch (e) {
          lastErr = e;
          if (failReason(e).startsWith("AlreadyJoined(")) { log(`[chain] joinFor(${id}, ${player}): already joined on chain`); return null; }
          if (!retryable(e) || attempt === JOIN_TRIES) throw e;
          log(`[chain] joinFor(${id}, ${player}) attempt ${attempt} failed, resending: ${failReason(e)}`);
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      throw lastErr;
    }),
    start: (id) => serial(async () => {
      const { hash } = await send(owner, "start", [BigInt(id)]);
      await confirmRead(`lobby ${id} Live`, async () => (await lobbyStatus(BigInt(id))) === LOBBY_LIVE);
      return hash;
    }),
    cancel: (id) => serial(async () => (await send(owner, "cancel", [BigInt(id)])).hash),
    getLobby: async (id) => {
      const l = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "getLobby", args: [BigInt(id)] });
      return { status: l.status, endTime: l.endTime, pot: l.pot, playerCount: l.playerCount, entry: l.entry, creator: l.creator, creatorFeeBps: l.creatorFeeBps };
    },
    blockTime: async () => (await pub.getBlock({ blockTag: "latest" })).timestamp,
    settleFallback: (report) => serial(async () => (await send(owner, "settleFallback", [report])).hash),
    findSettled: async (id, lookback) => {
      const to = await pub.getBlockNumber();
      const logs = await pub.getLogs({ address: escrow, event: SETTLED_EVENT, args: { id: BigInt(id) }, fromBlock: to > lookback ? to - lookback : 0n, toBlock: to });
      return logs.length ? logs[logs.length - 1].transactionHash : null;
    },
  };
}
