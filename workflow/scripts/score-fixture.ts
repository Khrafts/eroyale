// Usage: tsx scripts/score-fixture.ts <book> <prices> <potUnits> <feeBps> <chainSelector>
// Prints {winners, amounts, bookHash, report} as one line of JSON.
// Royale book (no mode) or predict book (mode "predict": the settlement price is prices[params.market]).
// Duel book (mode "duel"): prices, potUnits and feeBps are ignored; prints {winner, bookHash, report, ...}.
import { readFileSync } from "node:fs";

import type { Prices } from "../../shared/scoring.ts";
import { buildDuelReport, buildReport } from "../src/report.ts";

const [bookPath, pricesPath, pot, fee, selector] = process.argv.slice(2);
if (!bookPath || !pricesPath || !pot || !fee || !selector) {
  console.error("usage: score-fixture.ts <book> <prices> <potUnits> <feeBps> <chainSelector>");
  process.exit(2);
}

const rawBook = new Uint8Array(readFileSync(bookPath));
const mode = (JSON.parse(new TextDecoder().decode(rawBook)) as { mode?: unknown }).mode;
if (mode === "duel") {
  // No chain here: onchain is null, so the on-chain duel check is skipped.
  const d = buildDuelReport(rawBook, BigInt(selector), null);
  console.log(
    JSON.stringify({
      duelId: Number(d.duelId),
      winner: d.winner,
      winnerIndex: d.winnerIndex,
      rounds: d.rounds,
      ticks: d.ticks,
      payoutUnits: d.payoutUnits.toString(),
      feeUnits: d.feeUnits.toString(),
      bookHash: d.bookHash,
      report: d.report,
    }),
  );
  process.exit(0);
}
const prices = JSON.parse(readFileSync(pricesPath, "utf8")) as Prices;
// No chain here: onchain is null, so buildReport skips the on-chain lobby check.
const out = buildReport(rawBook, prices, BigInt(pot), BigInt(fee), BigInt(selector), null);

console.log(
  JSON.stringify({
    winners: out.winners,
    amounts: out.amounts.map((a) => a.toString()),
    bookHash: out.bookHash,
    report: out.report,
  }),
);
