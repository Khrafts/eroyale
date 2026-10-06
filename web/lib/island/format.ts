// The short lines shown on the island's labels, panels and list view. Money goes through unitsToUsd.
import { unitsToUsd } from "../events";
import { commas } from "../predict";
import { danceName } from "./avatar";
import { nowSec, type IslandSnap, type PredictInfo, type UserRound } from "./store";

export const mmss = (s: number) => {
  const v = Math.max(0, Math.ceil(s));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const ss = String(v % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
/** "48400000" -> "48.40 USDC" */
export const usdc = (units: string) => `${commas(unitsToUsd(units))} USDC`;
export const usdcShort = (units: string) => {
  const s = unitsToUsd(units);
  return commas(s.endsWith(".00") ? s.slice(0, -3) : s);
};
export const short = (a: string | null | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");
export const price = (s: string | null | undefined) => (s ? commas(s) : "–");

export function royaleLine(s: IslandSnap): string {
  const r = s.royale;
  if (!r) return s.engine === "down" ? "Engine offline" : s.engine === "none" ? "No engine configured" : "No lobby open";
  const now = nowSec(s);
  if (r.status === "live") return r.endTime ? `LIVE · ${r.alive} left · ${mmss(r.endTime - now)}` : `LIVE · ${r.alive} left`;
  if (r.status === "settling") return `Lobby #${r.lobbyId} · settling`;
  if (r.status === "settled") return `Lobby #${r.lobbyId} · paid out`;
  if (r.status === "cancelled") return `Lobby #${r.lobbyId} · cancelled`;
  const seats = r.maxPlayers ? `${r.players}/${r.maxPlayers}` : `${r.players} in`;
  return r.startsAt ? `Lobby #${r.lobbyId} · starts ${mmss(r.startsAt - now)} · ${seats}` : `Lobby #${r.lobbyId} · open · ${seats}`;
}
export function royaleStatus(s: IslandSnap): string {
  const r = s.royale;
  if (!r) return "No lobby";
  const now = nowSec(s);
  if (r.status === "live") return r.endTime ? `Live · ${mmss(r.endTime - now)} left` : "Live";
  if (r.status === "open" || r.status === "countdown") return r.startsAt ? `Starts in ${mmss(r.startsAt - now)}` : "Open, waiting for players";
  return r.status === "settling" ? "Settling" : r.status === "settled" ? "Paid out" : "Cancelled";
}
export const royalePlayers = (s: IslandSnap) => {
  const r = s.royale;
  if (!r) return "–";
  if (r.status === "live") return `${r.alive} of ${r.players} alive`;
  return r.maxPlayers ? `${r.players} / ${r.maxPlayers}` : String(r.players);
};
/** 0..100 through the match, for the Arena panel's progress bar. */
export function royaleProgress(s: IslandSnap): number {
  const r = s.royale;
  if (!r || !r.startsAt || !r.endTime) return 0;
  if (r.status === "settling" || r.status === "settled") return 100;
  if (r.status !== "live") return 0;
  return Math.min(100, Math.max(0, ((nowSec(s) - r.startsAt) / (r.endTime - r.startsAt)) * 100));
}

export function predictLine(s: IslandSnap): string {
  const p = s.predict;
  if (!p) return s.engine === "down" ? "Engine offline" : s.engine === "none" ? "No engine configured" : "No round open";
  return `${p.market} #${p.lobbyId} · locks ${mmss(p.lockTime - nowSec(s))} · ${p.players} in`;
}
export const lockIn = (s: IslandSnap, r: PredictInfo) => mmss(r.lockTime - nowSec(s));
export const seats = (r: PredictInfo) => (r.maxPlayers ? `${r.players}/${r.maxPlayers}` : `${r.players} in`);
export const roundTitle = (u: UserRound) => `${u.market} call · round #${u.lobbyId}`;
export const roundSub = (u: UserRound) =>
  `by ${short(u.creator) || "a player"} · ${u.split} split · ${usdcShort(u.entryUnits)} USDC${u.creatorFeeBps ? ` · ${u.creatorFeeBps / 100}% creator fee` : ""}`;

export function parkLine(s: IslandSnap): string {
  if (s.statsState === "missing") return "Stats not served yet";
  if (s.statsState === "down") return "Stats unavailable";
  const t = s.stats?.leaderboard[0];
  if (!t) return s.statsState === "loading" ? "Loading" : "Waiting for the first payout";
  return `#1 ${t.callsign} · ${usdcShort(t.earnedUnits)}`;
}

export function lighthouseLine(s: IslandSnap): string {
  if (s.engine === "none") return "No engine configured";
  if (s.engine === "down" || !s.health) return s.engine === "loading" ? "Checking" : "Engine offline";
  const fresh = s.health.priceAgeMs !== null && s.health.priceAgeMs < 15000;
  if (s.health.chain && fresh) return "All systems live";
  if (!fresh) return "Prices stale";
  return "Chain off · prices live";
}

export function lastPayoutAgo(s: IslandSnap): string {
  const w = s.stats?.recentWins[0];
  if (!w) return s.statsState === "ok" ? "None yet" : "Unknown";
  return `${mmss(nowSec(s) - w.at / 1000)} ago`;
}

export function lineOf(key: string, s: IslandSnap): string {
  switch (key) {
    case "royale.line":
    case "game.royale":
      return royaleLine(s);
    case "predict.line":
    case "game.predict":
      return predictLine(s);
    case "game.duel":
    case "duel.line":
      return "Opening soon";
    case "game.create":
      return "Your market, your rules";
    case "park.line":
      return parkLine(s);
    case "fountain.line":
      return "Start here · 4 games";
    case "plot.line":
      return "Open for building";
    case "wheel.line":
      return "Coming later";
    case "lh.line":
      return lighthouseLine(s);
    case "me.line":
      return `${s.avatar.name} · ${danceName(s.avatar.dance)}`;
  }
  return "";
}
