// The royale result before `final` lands: the engine waits for the match's closing one-minute candle (60 to 120 s)
// before it sends `final`. Until then, rank the survivors at the last live marks and price their payouts with the
// shared settle(), so the screens show the result at once. Display only: nothing here feeds a payout.
import { settle, type FinalBook } from "../../shared/scoring";
import { START_BALANCE, type FinalEvent } from "./events";
import type { MatchState } from "./useMatch";

const FEE_BPS = 500n;

/** The match is over (clock at or past its length) but `final` has not arrived. */
export function hasEnded(s: MatchState, clock: number): boolean {
  return !s.final && s.status === "live" && s.startsAt !== null && clock >= s.duration;
}

/** A FinalEvent built from the latest leaderboard: alive rows as finalists, cash = their live equity. */
export function provisionalFinal(s: MatchState): FinalEvent | null {
  const rows = s.board?.rows.filter((r) => r.alive) ?? [];
  if (!rows.length) return null;
  const marks = s.tick?.marks ?? { BTC: "0.00", ETH: "0.00", SOL: "0.00" };
  const book: FinalBook = {
    lobbyId: s.lobbyId ?? 0,
    endTime: s.endTime ?? 0,
    startBalance: START_BALANCE.toFixed(2),
    finalists: rows.map((r) => ({ player: r.player.toLowerCase(), cash: r.equity, positions: [] })),
    logHash: "0x",
  };
  let paid = new Map<string, string>();
  try {
    const out = settle(book, marks, BigInt(s.potUnits || "0"), FEE_BPS);
    paid = new Map(out.winners.map((w, i) => [w, out.amounts[i].toString()]));
  } catch {
    // a malformed row: show the ranking without payouts rather than nothing
  }
  return {
    type: "final",
    marks,
    bookHash: "",
    finalists: rows.map((r) => ({ player: r.player, callsign: r.callsign, equity: r.equity, provisionalPayoutUnits: paid.get(r.player.toLowerCase()) ?? "0" })),
  };
}
