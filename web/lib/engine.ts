"use client";
// Engine HTTP client for the phone: burner key, signed joins and signed orders (CLAUDE.md "Order signatures").
// Signing uses viem, the same library the engine verifies with.
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Market, Side } from "./events";

export const DOMAIN = { name: "TradingRoyale", version: "1" } as const;
export const ORDER_TYPES = {
  Order: [
    { name: "lobbyId", type: "uint256" },
    { name: "player", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "ts", type: "uint256" },
    { name: "action", type: "string" },
    { name: "market", type: "string" },
    { name: "side", type: "int8" },
    { name: "margin", type: "string" },
    { name: "leverage", type: "uint8" },
  ],
} as const;
export const JOIN_TYPES = {
  Join: [
    { name: "lobbyId", type: "uint256" },
    { name: "player", type: "address" },
    { name: "callsign", type: "string" },
  ],
} as const;

export type Order =
  | { action: "open"; market: Market; side: Side; margin: string; leverage: number }
  | { action: "close"; market: Market };

/** HTTP base: NEXT_PUBLIC_ENGINE_HTTP, else NEXT_PUBLIC_ENGINE_WS with ws->http and the /ws path dropped. */
export function engineHttp(): string {
  const explicit = process.env.NEXT_PUBLIC_ENGINE_HTTP;
  if (explicit) return explicit.replace(/\/$/, "");
  const ws = process.env.NEXT_PUBLIC_ENGINE_WS ?? "ws://localhost:8787/ws";
  return ws.replace(/^ws/, "http").replace(/\/ws\/?(\?.*)?$/, "");
}

const KEY = "royale.burner";
const NONCE = "royale.nonce";

/** A burner key kept in this browser. Testnet game key only; it never holds funds. */
export function burner(): PrivateKeyAccount {
  let pk: `0x${string}` | null = null;
  try {
    pk = localStorage.getItem(KEY) as `0x${string}` | null;
  } catch {
    /* storage blocked: key lives for this page only */
  }
  if (!pk || !/^0x[0-9a-f]{64}$/i.test(pk)) {
    pk = generatePrivateKey();
    try {
      localStorage.setItem(KEY, pk);
    } catch {
      /* ignore */
    }
  }
  return privateKeyToAccount(pk);
}

function nextNonce(player: string): bigint {
  const k = `${NONCE}.${player}`;
  let last = 0;
  try {
    last = Number(localStorage.getItem(k) ?? "0") || 0;
  } catch {
    /* ignore */
  }
  const n = Math.max(last + 1, Date.now());
  try {
    localStorage.setItem(k, String(n));
  } catch {
    /* ignore */
  }
  return BigInt(n);
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const r = await fetch(engineHttp() + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await r.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  return { ok: r.ok, status: r.status, data };
}

export async function signJoin(acct: PrivateKeyAccount, lobbyId: number, callsign: string) {
  const player = acct.address.toLowerCase() as `0x${string}`;
  const signature = await acct.signTypedData({
    domain: DOMAIN,
    types: JOIN_TYPES,
    primaryType: "Join",
    message: { lobbyId: BigInt(lobbyId), player, callsign },
  });
  return { player, callsign, signature };
}

export async function join(acct: PrivateKeyAccount, lobbyId: number, callsign: string) {
  return post(`/lobbies/${lobbyId}/join`, await signJoin(acct, lobbyId, callsign));
}

export async function signOrder(acct: PrivateKeyAccount, lobbyId: number, order: Order) {
  const player = acct.address.toLowerCase() as `0x${string}`;
  const nonce = nextNonce(player);
  const ts = Date.now();
  const open = order.action === "open";
  const signature = await acct.signTypedData({
    domain: DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      lobbyId: BigInt(lobbyId),
      player,
      nonce,
      ts: BigInt(ts),
      action: order.action,
      market: order.market,
      side: open ? order.side : 0,
      margin: open ? order.margin : "0",
      leverage: open ? order.leverage : 0,
    },
  });
  return { lobbyId, player, nonce: nonce.toString(), ts, order, signature };
}

export async function sendOrder(acct: PrivateKeyAccount, lobbyId: number, order: Order) {
  return post("/orders", await signOrder(acct, lobbyId, order));
}
