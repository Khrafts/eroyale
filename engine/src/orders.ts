// Signed orders. The player's burner key signs EIP-712 typed data; the engine verifies it.
// Set ORDER_SIG=off to accept unsigned orders (the hour-7 cut line).
import { verifyTypedData, type Address, type Hex } from "viem";
import { MARKETS, type Order } from "./types.ts";

export const ORDER_DOMAIN = { name: "TradingRoyale", version: "1" } as const;
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

export type OrderRequest = { lobbyId: number; player: string; nonce: number | string; ts: number; order: Order; signature?: string };

/** The typed-data message a client signs. Close orders sign side 0, margin "0", leverage 0. */
export function orderMessage(r: OrderRequest) {
  const o = r.order as Partial<Order & { side: number; margin: string; leverage: number }>;
  const open = o.action === "open";
  return {
    lobbyId: BigInt(r.lobbyId), player: r.player.toLowerCase() as Address, nonce: BigInt(r.nonce), ts: BigInt(r.ts),
    action: String(o.action), market: String(o.market),
    side: open ? Number(o.side) : 0, margin: open ? String(o.margin) : "0", leverage: open ? Number(o.leverage) : 0,
  };
}

export function parseOrderRequest(body: any): OrderRequest | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  if (!Number.isInteger(body.lobbyId)) return "lobbyId must be an integer";
  if (typeof body.player !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.player)) return "player must be an address";
  if (!/^\d{1,30}$/.test(String(body.nonce))) return "nonce must be a non-negative integer";
  if (!Number.isInteger(body.ts)) return "ts must be unix milliseconds";
  const o = body.order;
  if (!o || typeof o !== "object") return "order missing";
  if (!MARKETS.includes(o.market)) return "order.market must be BTC, ETH or SOL";
  if (o.action === "open") {
    if (o.side !== 1 && o.side !== -1) return "order.side must be 1 or -1";
    if (typeof o.margin !== "string") return "order.margin must be a 2-decimal string";
    if (!Number.isInteger(o.leverage)) return "order.leverage must be an integer";
    return { ...body, player: body.player.toLowerCase(), order: { action: "open", market: o.market, side: o.side, margin: o.margin, leverage: o.leverage } };
  }
  if (o.action === "close") return { ...body, player: body.player.toLowerCase(), order: { action: "close", market: o.market } };
  return "order.action must be open or close";
}

export async function verifyOrder(r: OrderRequest): Promise<boolean> {
  if (typeof r.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(r.signature)) return false;
  try {
    return await verifyTypedData({
      address: r.player as Address, domain: ORDER_DOMAIN, types: ORDER_TYPES, primaryType: "Order",
      message: orderMessage(r), signature: r.signature as Hex,
    });
  } catch {
    return false;
  }
}

// Joins are signed too, so nobody can spend the relayer's entry on someone else's address.
export const JOIN_TYPES = {
  Join: [
    { name: "lobbyId", type: "uint256" },
    { name: "player", type: "address" },
    { name: "callsign", type: "string" },
  ],
} as const;

export function joinMessage(lobbyId: number, player: string, callsign: string) {
  return { lobbyId: BigInt(lobbyId), player: player.toLowerCase() as Address, callsign };
}

export async function verifyJoin(lobbyId: number, player: string, callsign: string, signature: unknown): Promise<boolean> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return false;
  try {
    return await verifyTypedData({
      address: player as Address, domain: ORDER_DOMAIN, types: JOIN_TYPES, primaryType: "Join",
      message: joinMessage(lobbyId, player, callsign), signature: signature as Hex,
    });
  } catch {
    return false;
  }
}

// Prediction mode (the spec "Signed messages"): same domain.
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

export type CreateRoundParams = {
  creator: string; market: string; entryUnits: string | number; maxPlayers: number; lockAfter: number; resolveAfter: number;
  winnerBps: number; split: string; creatorFeeBps: number;
};

export function createRoundMessage(p: CreateRoundParams, nonce: number | string) {
  return {
    creator: p.creator.toLowerCase() as Address, market: p.market, entryUnits: BigInt(p.entryUnits), maxPlayers: p.maxPlayers,
    lockAfter: p.lockAfter, resolveAfter: p.resolveAfter, winnerBps: p.winnerBps, split: p.split, creatorFeeBps: p.creatorFeeBps, nonce: BigInt(nonce),
  };
}

export async function verifyCreateRound(p: CreateRoundParams, nonce: number | string, signature: unknown): Promise<boolean> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return false;
  try {
    return await verifyTypedData({
      address: p.creator as Address, domain: ORDER_DOMAIN, types: CREATE_ROUND_TYPES, primaryType: "CreateRound",
      message: createRoundMessage(p, nonce), signature: signature as Hex,
    });
  } catch {
    return false;
  }
}

export const PREDICTION_TYPES = {
  Prediction: [
    { name: "lobbyId", type: "uint256" },
    { name: "player", type: "address" },
    { name: "price", type: "string" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function predictionMessage(lobbyId: number, player: string, price: string, nonce: number | string) {
  return { lobbyId: BigInt(lobbyId), player: player.toLowerCase() as Address, price, nonce: BigInt(nonce) };
}

export async function verifyPrediction(lobbyId: number, player: string, price: string, nonce: number | string, signature: unknown): Promise<boolean> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return false;
  try {
    return await verifyTypedData({
      address: player as Address, domain: ORDER_DOMAIN, types: PREDICTION_TYPES, primaryType: "Prediction",
      message: predictionMessage(lobbyId, player, price, nonce), signature: signature as Hex,
    });
  } catch {
    return false;
  }
}
