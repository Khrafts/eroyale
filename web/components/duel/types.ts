// Duel wire types (CLAUDE.md "Stickman Duel" > "Engine"). Kept here, beside the duel screens, so lib/events.ts stays
// untouched by this track.
export type DuelStatus = "matching" | "countdown" | "live" | "settling" | "settled" | "cancelled";
export type DuelPlayer = { player: string; callsign: string; bot: boolean };
export type WireFighter = { x: number; y: number; hp: number; facing: 1 | -1; act: string; frame: number; combo: number };

export type DuelEvent =
  | { type: "duel"; status: DuelStatus; players: DuelPlayer[]; stakeUnits: string; startsAt: number | null }
  | { type: "dstate"; tick: number; round: number; roundTick: number; f: [WireFighter, WireFighter]; rounds: [number, number] }
  | { type: "dhit"; tick: number; by: 0 | 1; move: string; damage: number; combo: number; blocked: boolean }
  | { type: "dround"; round: number; winner: 0 | 1 | null; hp: [number, number] }
  | { type: "dfinal"; winner: string | null; bookHash: string; rounds: [number, number]; payoutUnits: string }
  | { type: "settled"; txHash: string; mode?: string; winners?: string[]; amounts?: string[] }
  | { type: "cancelled"; reason?: string };

export type QueueTicket = { status: "waiting" | "matched"; duelId: number | null; side: 0 | 1 | null; sessionToken: string | null; ranked: boolean };

/** GET /duels, read tolerantly: the field names below are the spec's words ("queue size, live duels (id, players,
 *  round, hp), recent results"); anything missing shows as empty. */
export type DuelsLive = { duelId: number; players: DuelPlayer[]; round: number; hp: [number, number]; ranked?: boolean };
export type DuelsRecent = { duelId: number; players: DuelPlayer[]; winner: string | null; rounds: [number, number]; stakeUnits?: string; payoutUnits?: string; at?: number };
export type DuelsInfo = { queue: number; live: DuelsLive[]; recent: DuelsRecent[] };

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const players = (v: unknown): DuelPlayer[] =>
  Array.isArray(v) ? v.map((p) => (typeof p === "string" ? { player: p, callsign: `${p.slice(0, 6)}…`, bot: false } : { player: String(p?.player ?? ""), callsign: String(p?.callsign ?? ""), bot: !!p?.bot })) : [];

export function parseDuels(raw: unknown): DuelsInfo {
  const r = (raw ?? {}) as Record<string, unknown>;
  const q = r.queue ?? r.queueSize ?? r.waiting;
  const queue = typeof q === "number" ? q : Array.isArray(q) ? q.length : num((q as Record<string, unknown>)?.size);
  const live = (Array.isArray(r.live) ? r.live : []).map((d: Record<string, unknown>) => ({
    duelId: num(d.duelId ?? d.id),
    players: players(d.players),
    round: num(d.round, 1),
    hp: (Array.isArray(d.hp) ? [num(d.hp[0], 100), num(d.hp[1], 100)] : [100, 100]) as [number, number],
    ranked: d.ranked === undefined ? undefined : !!d.ranked,
  }));
  const recent = (Array.isArray(r.recent) ? r.recent : Array.isArray(r.results) ? r.results : []).map((d: Record<string, unknown>) => ({
    duelId: num(d.duelId ?? d.id),
    players: players(d.players),
    winner: typeof d.winner === "string" ? d.winner : null,
    rounds: (Array.isArray(d.rounds) ? [num(d.rounds[0]), num(d.rounds[1])] : [0, 0]) as [number, number],
    stakeUnits: typeof d.stakeUnits === "string" ? d.stakeUnits : undefined,
    payoutUnits: typeof d.payoutUnits === "string" ? d.payoutUnits : undefined,
    at: typeof d.at === "number" ? d.at : undefined,
  }));
  return { queue, live, recent };
}
