// Usage: tsx scripts/score-fixture.ts <book> <prices> <potUnits> <feeBps> <chainSelector>
// Prints {winners, amounts, bookHash, report} as one line of JSON.
// Royale book (no mode) or predict book (mode "predict": the settlement price is prices[params.market]).
import { readFileSync } from "node:fs";

import type { Prices } from "../../shared/scoring.ts";
import { buildReport } from "../src/report.ts";

const [bookPath, pricesPath, pot, fee, selector] = process.argv.slice(2);
if (!bookPath || !pricesPath || !pot || !fee || !selector) {
  console.error("usage: score-fixture.ts <book> <prices> <potUnits> <feeBps> <chainSelector>");
  process.exit(2);
}

const rawBook = new Uint8Array(readFileSync(bookPath));
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
