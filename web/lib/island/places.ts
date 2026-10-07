// What stands on the island, shared by the 3D world and the React panels (no three.js here, so the list view and
// the panels load without it).
import type { IslandSnap, UserRound } from "./store";
import { short, usdcShort } from "./format";
import { ISLAND, coral, ink, mint, sun, tang, violet } from "../theme";
import { CREATE, navGame } from "../nav";
import { dojoPlayers } from "../../components/duel/dojo";

/** The shared tokens (lib/theme.ts) the panels and the world colour places with. */
export const COLORS = { coral, violet, tang, mint, sky: ISLAND.sky, sun, ink };

export type Game = { id: "royale" | "predict" | "duel" | "create"; name: string; short: string; color: string; route: string; h: (s: IslandSnap) => number };
/** The fountain's four jets (names and colours from lib/nav.ts); each jet's height follows its game's player count. */
export const GAMES: Game[] = [
  {
    id: "royale",
    name: navGame("royale").name,
    short: "TR",
    color: navGame("royale").color,
    route: "arena",
    h: (s) => 2.6 + (s.royale ? Math.min(50, s.royale.status === "live" ? s.royale.alive : s.royale.players) : 0) / 50 * 4.4,
  },
  { id: "predict", name: navGame("predict").name, short: "PP", color: navGame("predict").color, route: "observatory", h: (s) => 2.6 + (Math.min(50, s.predict?.players ?? 0) / 50) * 4.4 },
  // the Duel jet: the queue plus the players in live duels (GET /duels)
  { id: "duel", name: navGame("duel").name, short: "SD", color: navGame("duel").color, route: "dojo", h: () => 1.4 + (Math.min(20, dojoPlayers()) / 20) * 4.4 },
  { id: "create", name: CREATE.name, short: CREATE.short, color: CREATE.color, route: "create", h: () => 3.4 },
];

export type AdSlot = { id: "bb1" | "bb2" | "bb3" | "bb4"; deg: number; kind: "promo" | "sponsor" | "open"; rank?: number; bg: string };
/** Two boards show the biggest open player rounds (not paid ads), one a fictional sponsor, one the open slot. */
export const ADS: AdSlot[] = [
  { id: "bb1", deg: 352, kind: "promo", rank: 0, bg: COLORS.coral },
  { id: "bb2", deg: 92, kind: "sponsor", bg: "#1B2A6B" },
  { id: "bb3", deg: 150, kind: "promo", rank: 1, bg: COLORS.violet },
  { id: "bb4", deg: 252, kind: "open", bg: "#FFF3E4" },
];
export const SPONSOR = { brand: "TIDEPOOL", name: "Tidepool", tag: "Swaps that settle before the tide turns." };

/** Open user rounds, largest pot first (ties: more players, then lower id). */
export function promoted(s: IslandSnap): UserRound[] {
  return [...s.userRounds].sort((a, b) => {
    const d = BigInt(b.potUnits) - BigInt(a.potUnits);
    return d !== 0n ? (d > 0n ? 1 : -1) : b.players - a.players || a.lobbyId - b.lobbyId;
  });
}
export const promoHead = (u: UserRound) => `Call the ${u.market} close. ${u.split[0].toUpperCase() + u.split.slice(1)} split.`;
export const promoFoot = (u: UserRound) =>
  `Pot ${usdcShort(u.potUnits)} USDC  ·  ${u.players}${u.maxPlayers ? "/" + u.maxPlayers : ""} seats  ·  by ${short(u.creator) || "a player"}`;
