// Relayer: escrow calls through RPC_URL. CHAIN=off turns every call into a no-op so the engine runs before deploy.
// Owner-only calls (createLobby, start, cancel) use PRIVATE_KEY_DEPLOYER; joinFor uses PRIVATE_KEY_RELAYER.
import { createPublicClient, createWalletClient, http, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";

export interface Chain {
  readonly on: boolean;
  createLobby(duration: number, entry: bigint, maxPlayers: number): Promise<number | null>;
  joinFor(id: number, player: string): Promise<string | null>;
  start(id: number): Promise<string | null>;
  cancel(id: number): Promise<string | null>;
}

// Signatures from CLAUDE.md "Contract"; approve/allowance are standard ERC-20.
const ESCROW_ABI = parseAbi([
  "function createLobby(uint32 duration, uint96 entry, uint16 maxPlayers) returns (uint256 id)",
  "function joinFor(uint256 id, address player)",
  "function start(uint256 id)",
  "function cancel(uint256 id)",
]);
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export const offChain: Chain = {
  on: false,
  createLobby: async () => null,
  joinFor: async () => null,
  start: async () => null,
  cancel: async () => null,
};

function need(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`${k} is required when CHAIN is not off`);
  return v;
}

export function makeChain(env: NodeJS.ProcessEnv, log: (m: string) => void): Chain {
  const name = (env.CHAIN ?? "off").trim();
  if (name === "off" || name === "") return offChain;
  const chain = name === "base-sepolia" ? baseSepolia : name === "ethereum-sepolia" ? sepolia : null;
  if (!chain) throw new Error(`CHAIN must be off, base-sepolia or ethereum-sepolia, got ${name}`);
  const transport = http(need(env, "RPC_URL"));
  const pub = createPublicClient({ chain, transport });
  const owner = createWalletClient({ chain, transport, account: privateKeyToAccount(need(env, "PRIVATE_KEY_DEPLOYER") as Hex) });
  const relayer = createWalletClient({ chain, transport, account: privateKeyToAccount(need(env, "PRIVATE_KEY_RELAYER") as Hex) });
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

  async function send(wallet: typeof owner, fn: "createLobby" | "joinFor" | "start" | "cancel", args: readonly unknown[]) {
    const { request, result } = await pub.simulateContract({ address: escrow, abi: ESCROW_ABI, functionName: fn, args: args as never, account: wallet.account });
    const hash = await wallet.writeContract(request as never);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${fn} reverted: ${hash}`);
    log(`[chain] ${fn}(${args.join(", ")}) ${hash}`);
    return { hash, result };
  }

  return {
    on: true,
    createLobby: (duration, entry, maxPlayers) => serial(async () => {
      const { result } = await send(owner, "createLobby", [duration, entry, maxPlayers]);
      return Number(result as bigint);
    }),
    joinFor: (id, player) => serial(async () => {
      if (!approved) {
        const have = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [relayer.account.address, escrow] });
        if (have < 10n ** 30n) {
          const hash = await relayer.writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [escrow, maxUint256] });
          const rc = await pub.waitForTransactionReceipt({ hash });
          if (rc.status !== "success") throw new Error(`approve reverted: ${hash}`);
          log(`[chain] relayer approved escrow ${hash}`);
        }
        approved = true;
      }
      return (await send(relayer, "joinFor", [BigInt(id), player as Address])).hash;
    }),
    start: (id) => serial(async () => (await send(owner, "start", [BigInt(id)])).hash),
    cancel: (id) => serial(async () => (await send(owner, "cancel", [BigInt(id)])).hash),
  };
}
