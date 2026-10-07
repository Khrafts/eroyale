"use client";
// Ranked duel client: the signed DuelQueue (same EIP-712 domain and burner as /play's joins), the queue poll, the free
// bot fight, and the duel WebSocket. Domain, burner and engine URL come from lib/engine.ts and lib/engineUrl.ts.
import type { PrivateKeyAccount } from "viem/accounts";
import { DOMAIN } from "@/lib/engine";
import { engineHttp } from "@/lib/engineUrl";
import type { QueueTicket } from "./types";

export const DUEL_QUEUE_TYPES = {
  DuelQueue: [
    { name: "player", type: "address" },
    { name: "callsign", type: "string" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** Same scheme and storage key as lib/engine.ts nextNonce (not exported there), so every signed message from this
 *  burner keeps one strictly increasing nonce. */
function nextNonce(player: string, nowMs: number): bigint {
  const k = `royale.nonce.${player}`;
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

export async function signDuelQueue(acct: PrivateKeyAccount, callsign: string) {
  const player = acct.address.toLowerCase() as `0x${string}`;
  const nonce = nextNonce(player, Date.now());
  const signature = await acct.signTypedData({ domain: DOMAIN, types: DUEL_QUEUE_TYPES, primaryType: "DuelQueue", message: { player, callsign, nonce } });
  return { player, callsign, nonce: nonce.toString(), signature };
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(engineHttp() + path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data: unknown = null;
  try {
    data = await r.json();
  } catch {
    /* empty */
  }
  if (!r.ok) {
    const msg = (data as { error?: string } | null)?.error;
    throw new Error(msg ? String(msg) : `The engine answered ${r.status}.`);
  }
  return data as T;
}

const ticketOf = (d: Partial<QueueTicket> & Record<string, unknown>): QueueTicket => ({
  status: d.status === "matched" ? "matched" : "waiting",
  duelId: typeof d.duelId === "number" ? d.duelId : null,
  side: d.side === 0 || d.side === 1 ? d.side : null,
  sessionToken: typeof d.sessionToken === "string" ? d.sessionToken : null,
  ranked: d.ranked !== false,
});

export async function queue(acct: PrivateKeyAccount, callsign: string): Promise<string> {
  const d = await call<{ ticket: string }>("/duels/queue", await signDuelQueue(acct, callsign));
  if (!d?.ticket) throw new Error("The engine did not return a queue ticket.");
  return String(d.ticket);
}
export const pollTicket = async (ticket: string) => ticketOf(await call(`/duels/queue/${encodeURIComponent(ticket)}`));
export const botFight = async (ticket: string) => ticketOf(await call(`/duels/queue/${encodeURIComponent(ticket)}/bot`, {}));
export const getDuelFinal = (id: number) => fetch(`${engineHttp()}/duels/${id}/final`, { cache: "no-store" }).then((r) => (r.ok ? r.text() : null));
export const getDuel = (id: number) => call<Record<string, unknown>>(`/duels/${id}`);

export function duelWsUrl(id: number): string | null {
  const base = process.env.NEXT_PUBLIC_ENGINE_WS;
  if (!base) return null;
  return `${base}${base.includes("?") ? "&" : "?"}duel=${id}`;
}

export const engineConfigured = () => !!(process.env.NEXT_PUBLIC_ENGINE_WS || process.env.NEXT_PUBLIC_ENGINE_HTTP);
