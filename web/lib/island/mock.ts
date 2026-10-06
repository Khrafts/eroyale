// ?mock=island&at=<moment>: the island from the existing mocks, with no engine. The royale lobby is the 20-player
// mock match (web/mocks/match.ts) folded through useMatch's reducer up to the moment; the rounds come from the
// prediction mock (web/mocks/predict.ts). The clock is frozen at the moment, so screenshots are stable.
import { applyEvent, emptyState } from "../useMatch";
import { MOMENTS, mockMatch } from "../../mocks/match";
import { PREDICT_MOMENTS, PREDICT_OPEN_AT, mockRoundLists } from "../../mocks/predict";
import type { Stats } from "../events";
import { royaleFrom, roundFrom, userRoundFrom } from "./live";
import type { IslandSnap } from "./store";

export const ISLAND_MOMENTS = ["overview", "live", "checkpoint", "settled", "studio", "victory"] as const;
export type IslandMoment = (typeof ISLAND_MOMENTS)[number];

/** Royale match seconds shown at each island moment. */
const ROYALE_AT: Record<IslandMoment, number> = {
  overview: MOMENTS.lobby,
  live: MOMENTS.live,
  checkpoint: MOMENTS.checkpoint,
  settled: MOMENTS.settled,
  studio: MOMENTS.lobby,
  victory: MOMENTS.lobby,
};
/** The mock match starts at this unix second (web/mocks/match.ts STARTS_AT). */
const STARTS_AT = 1791297000;
const EARNED = [1284.2, 1102.75, 968.4, 811.05, 702.3, 655.9, 540.15, 488.6, 401.25, 356.8];
const WINS = [31, 27, 22, 19, 17, 15, 12, 12, 9, 8];

export function mockIsland(moment: IslandMoment, seed = 7): Partial<IslandSnap> & { lastSettled: { winners: string[]; amounts: string[] } | null; callsigns: Record<string, string> } {
  const { events } = mockMatch(seed);
  const at = ROYALE_AT[moment];
  const st = emptyState(1);
  for (const e of events) {
    if (e.at > at) break;
    applyEvent(st, e.ev, e.at);
  }
  const now = STARTS_AT + at;
  const royale = royaleFrom(st, 50);
  // the protocol round 18 s before its lock, shifted onto the same clock
  const pAt = PREDICT_OPEN_AT + PREDICT_MOMENTS.open;
  const lists = mockRoundLists(pAt, seed);
  const shift = now - pAt;
  const moveTimes = <T extends { lockTime: number; endTime: number }>(r: T): T => ({ ...r, lockTime: r.lockTime + shift, endTime: r.endTime + shift });
  const proto = lists.rounds.find((r) => r.protocol);
  const firstTick = events.find((e) => e.ev.type === "tick")?.ev;
  const marks = st.tick?.marks ?? (firstTick && firstTick.type === "tick" ? firstTick.marks : null);
  const callsigns: Record<string, string> = {};
  const lobbyPlayers = events.find((e) => e.ev.type === "lobby" && e.ev.players.length >= 20)?.ev;
  const people = lobbyPlayers && lobbyPlayers.type === "lobby" ? lobbyPlayers.players : [];
  people.forEach((p) => (callsigns[p.player] = p.callsign));
  const ranked = [1, 3, 0, 6, 11, 4, 9, 13, 2, 16].map((i) => people[i]).filter(Boolean);
  const stats: Stats = {
    now: now * 1000,
    playing: 37,
    paidTodayUnits: "8420500000",
    leaderboard: ranked.map((p, i) => ({ player: p.player, callsign: p.callsign, bot: p.bot, wins: WINS[i], earnedUnits: String(Math.round(EARNED[i] * 100) * 10000) })),
    recentWins: ranked.slice(0, 3).map((p, i) => ({ lobbyId: 57 - i, mode: i % 2 ? "predict" : "royale", player: p.player, callsign: p.callsign, bot: p.bot, amountUnits: "48400000", at: (now - 140 - i * 300) * 1000 })),
  };
  const moves = [4, -2, 6, 3, -5, 8, -1, 2, -3, 5, 7, -4, 1, 3];
  return {
    source: "mock",
    frozenNow: now,
    offsetMs: 0,
    engine: "ok",
    marks,
    marksRef: firstTick && firstTick.type === "tick" ? firstTick.marks : marks,
    moves,
    royale,
    predict: proto ? moveTimes(roundFrom(proto)) : null,
    userRounds: lists.rounds.filter((r) => !r.protocol).map((r) => moveTimes(userRoundFrom(r))),
    stats,
    statsState: "ok",
    health: { ok: true, chain: true, current: 1, protocolRound: proto?.lobbyId ?? null, priceAgeMs: 900 },
    lastSettled: st.settled ? { winners: st.settled.winners, amounts: st.settled.amounts } : null,
    callsigns,
  };
}
