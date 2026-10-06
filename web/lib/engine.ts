"use client";
// Engine HTTP client for the phone: burner key, signed joins and signed orders (CLAUDE.md "Order signatures").
// Signing uses viem, the same library the engine verifies with.
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Market, Side } from "./events";
import { engineHttp } from "./engineUrl";

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

function nextNonce(player: string, nowMs: number): bigint {
  const k = `${NONCE}.${player}`;
  let last = 0;
  try {
    last = Number(localStorage.getItem(k) ?? "0") || 0;
  } catch {
    /* ignore */
  }
  const n = Math.max(last + 1, nowMs);
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

/** `serverOffsetMs` (server clock minus local) keeps `ts` inside the engine's 30 s window on a skewed phone. */
export async function signOrder(acct: PrivateKeyAccount, lobbyId: number, order: Order, serverOffsetMs = 0) {
  const player = acct.address.toLowerCase() as `0x${string}`;
  const ts = Math.round(Date.now() + serverOffsetMs);
  const nonce = nextNonce(player, ts);
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

export async function sendOrder(acct: PrivateKeyAccount, lobbyId: number, order: Order, serverOffsetMs = 0) {
  return post("/orders", await signOrder(acct, lobbyId, order, serverOffsetMs));
}

// ---------- Prediction mode (CLAUDE.md "Prediction mode" > "Signed messages"), same domain as orders ----------
export const CREATE_ROUND_TYPES = {
  CreateRound: [
    { name: "creator", type: "address" },
    { name: "market", type: "string" },
    { name: "entryUnits", type: "uint256" },
    { name: "maxPlayers", type: "uint16" },
    { name: "lockAfter", type: "uint32" },
    { name: "resolveAfter", type: "uint32" },
    { name: "winnerBps", type: "uint16" },
    { name: "split", type: "string" },
    { name: "creatorFeeBps", type: "uint16" },
    { name: "nonce", type: "uint256" },
  ],
} as const;
export const PREDICTION_TYPES = {
  Prediction: [
    { name: "lobbyId", type: "uint256" },
    { name: "player", type: "address" },
    { name: "price", type: "string" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The body of POST /rounds `params`. entryUnits is a 6-decimal integer string. */
export type CreateRoundParams = {
  creator: string;
  market: Market;
  entryUnits: string;
  maxPlayers: number;
  lockAfter: number;
  resolveAfter: number;
  winnerBps: number;
  split: "equal" | "linear" | "steep";
  creatorFeeBps: number;
};

const PRICE = /^\d+\.\d{2}$/;

export async function signCreateRound(acct: PrivateKeyAccount, p: Omit<CreateRoundParams, "creator">) {
  const creator = acct.address.toLowerCase() as `0x${string}`;
  const nonce = nextNonce(creator, Date.now());
  const params: CreateRoundParams = { ...p, creator };
  const signature = await acct.signTypedData({
    domain: DOMAIN,
    types: CREATE_ROUND_TYPES,
    primaryType: "CreateRound",
    message: {
      creator,
      market: p.market,
      entryUnits: BigInt(p.entryUnits),
      maxPlayers: p.maxPlayers,
      lockAfter: p.lockAfter,
      resolveAfter: p.resolveAfter,
      winnerBps: p.winnerBps,
      split: p.split,
      creatorFeeBps: p.creatorFeeBps,
      nonce,
    },
  });
  return { params, nonce: nonce.toString(), signature };
}

export async function createRound(acct: PrivateKeyAccount, p: Omit<CreateRoundParams, "creator">) {
  return post("/rounds", await signCreateRound(acct, p));
}

/** `price` must be a positive 2-decimal string; anything else throws before signing. */
export async function signPrediction(acct: PrivateKeyAccount, lobbyId: number, price: string, serverOffsetMs = 0) {
  if (!PRICE.test(price) || /^0+\.00$/.test(price)) throw new Error(`Not a price: ${price}`);
  const player = acct.address.toLowerCase() as `0x${string}`;
  const ts = Math.round(Date.now() + serverOffsetMs);
  const nonce = nextNonce(player, ts);
  const signature = await acct.signTypedData({
    domain: DOMAIN,
    types: PREDICTION_TYPES,
    primaryType: "Prediction",
    message: { lobbyId: BigInt(lobbyId), player, price, nonce },
  });
  return { lobbyId, player, price, nonce: nonce.toString(), ts, signature };
}

export async function sendPrediction(acct: PrivateKeyAccount, lobbyId: number, price: string, serverOffsetMs = 0) {
  return post("/predictions", await signPrediction(acct, lobbyId, price, serverOffsetMs));
}
