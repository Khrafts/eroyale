// Scoring shared by the engine and the CRE workflow. No imports: it also runs in the CRE WASM runtime.
// Phantom money is bigint cents; token amounts are bigint 6-decimal units. No floats.

export type Market = "BTC" | "ETH" | "SOL";
export type Position = { market: Market; side: 1 | -1; notional: string; entry: string };
export type Finalist = { player: string; cash: string; positions: Position[] };
export type FinalBook = { lobbyId: number; endTime: number; startBalance: string; finalists: Finalist[]; logHash: string };
export type Prices = Record<Market, string>;
export type Alive = { player: string; equityCents: bigint; joinIndex: number };
export type Eliminated = { player: string; reason: "cut" | "zone" };

// "10212.50" -> 1021250n. Accepts 0 to 2 decimals; extra digits are truncated.
export function toCents(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s.trim());
  if (!m) throw new Error(`bad money string: ${s}`);
  const frac = ((m[3] ?? "") + "00").slice(0, 2);
  const c = BigInt(m[2]) * 100n + BigInt(frac);
  return m[1] === "-" ? -c : c;
}

// 1021250n -> "10212.50"
export function fromCents(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const frac = (a % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${a / 100n}.${frac}`;
}

// cash + Σ side * notional * (mark - entry) / entry, each position truncated toward zero.
export function equityCents(f: Finalist, prices: Prices): bigint {
  let eq = toCents(f.cash);
  for (const p of f.positions) {
    const notional = toCents(p.notional);
    const entry = toCents(p.entry);
    const mark = toCents(prices[p.market]);
    eq += (BigInt(p.side) * notional * (mark - entry)) / entry;
  }
  return eq;
}

// Checkpoint cut. Returns the eliminated players; order is not part of the contract.
export function cut(alive: Alive[], zoneCents: bigint): Eliminated[] {
  const n = alive.length;
  if (n === 0) return [];
  const ranked = [...alive].sort((a, b) =>
    a.equityCents !== b.equityCents ? (a.equityCents > b.equityCents ? -1 : 1) : a.joinIndex - b.joinIndex,
  );
  const k = Math.max(1, Math.floor(n / 4));
  const reasons = ranked.map((a, i): Eliminated["reason"] | null =>
    i >= n - k ? "cut" : a.equityCents < zoneCents ? "zone" : null,
  );
  const survivors = reasons.filter((r) => r === null).length;
  const keep = survivors < 3 ? Math.min(3, n) : -1;
  const out: Eliminated[] = [];
  ranked.forEach((a, i) => {
    if (keep >= 0) {
      if (i >= keep) out.push({ player: a.player, reason: reasons[i] ?? "cut" });
    } else if (reasons[i]) {
      out.push({ player: a.player, reason: reasons[i]! });
    }
  });
  return out;
}

// Final payout. Winners ascending by lowercase address; dust goes to the fee.
export function settle(
  book: FinalBook,
  prices: Prices,
  potUnits: bigint,
  feeBps: bigint,
): { winners: string[]; amounts: bigint[]; feeUnits: bigint } {
  const start = toCents(book.startBalance);
  const rows = book.finalists
    .map((f) => ({ player: f.player.toLowerCase(), equity: equityCents(f, prices) }))
    .sort((a, b) => (a.player < b.player ? -1 : a.player > b.player ? 1 : 0));
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].player === rows[i - 1].player) throw new Error(`duplicate finalist ${rows[i].player}`);
  }
  if (feeBps < 0n || feeBps > 10000n || potUnits < 0n) throw new Error("fee or pot out of range");
  const pos = (x: bigint) => (x > 0n ? x : 0n);
  let weights = rows.map((r) => pos(r.equity - start));
  if (weights.every((w) => w === 0n)) weights = rows.map((r) => pos(r.equity));
  if (weights.every((w) => w === 0n)) weights = rows.map(() => 1n);
  const total = weights.reduce((s, w) => s + w, 0n);
  const distributable = (potUnits * (10000n - feeBps)) / 10000n;
  const winners: string[] = [];
  const amounts: bigint[] = [];
  let paid = 0n;
  rows.forEach((r, i) => {
    const amount = total === 0n ? 0n : (distributable * weights[i]) / total;
    if (amount === 0n) return;
    winners.push(r.player);
    amounts.push(amount);
    paid += amount;
  });
  return { winners, amounts, feeUnits: potUnits - paid };
}

// ---- Prediction rounds ----

export type Split = "equal" | "linear" | "steep";
export type Prediction = { player: string; price: string; joinIndex: number };
export type PredictParams = {
  market: Market;
  entryUnits: string;
  winnerBps: number;
  split: Split;
  creator: string | null;
  creatorFeeBps: number;
  feeBps: number;
};
export type PredictBook = {
  lobbyId: number;
  mode: "predict";
  lockTime: number;
  endTime: number;
  params: PredictParams;
  players: { player: string; joinIndex: number }[];
  predictions: Prediction[];
  logHash: string;
};

function bpsOf(x: number, what: string): bigint {
  if (!Number.isSafeInteger(x) || x < 0 || x > 10000) throw new Error(`${what} out of range: ${x}`);
  return BigInt(x);
}

// Prediction payout. Winners ascending by lowercase address; dust goes to the fee.
export function predictSettle(
  book: PredictBook,
  settlementPrice: string,
  potUnits: bigint,
): { winners: string[]; amounts: bigint[]; creatorFeeUnits: bigint; feeUnits: bigint } {
  if (book.mode !== "predict") throw new Error(`not a predict book: ${book.mode}`);
  const p = book.params;
  if (p.split !== "equal" && p.split !== "linear" && p.split !== "steep") throw new Error(`bad split: ${p.split}`);
  if (!/^\d+$/.test(p.entryUnits)) throw new Error(`bad entryUnits: ${p.entryUnits}`);
  const entry = BigInt(p.entryUnits);
  const winnerBps = bpsOf(p.winnerBps, "winnerBps");
  const feeBps = bpsOf(p.feeBps, "feeBps");
  const creatorBps = p.creator === null ? 0n : bpsOf(p.creatorFeeBps, "creatorFeeBps");
  if (feeBps + creatorBps > 10000n) throw new Error("fees exceed the pot");
  if (potUnits < 0n) throw new Error("pot out of range");
  const settle = toCents(settlementPrice);
  if (settle < 0n) throw new Error(`negative settlement price: ${settlementPrice}`);

  // Players: unique addresses, unique join indexes.
  const joinOf = new Map<string, number>();
  const seenJoin = new Set<number>();
  for (const pl of book.players) {
    const a = pl.player.toLowerCase();
    if (joinOf.has(a)) throw new Error(`duplicate player ${a}`);
    if (!Number.isSafeInteger(pl.joinIndex) || pl.joinIndex < 0 || seenJoin.has(pl.joinIndex)) {
      throw new Error(`bad or duplicate joinIndex ${pl.joinIndex} for ${a}`);
    }
    joinOf.set(a, pl.joinIndex);
    seenJoin.add(pl.joinIndex);
  }

  // Predictions: at most one per player, only from players, joinIndex consistent.
  const seenPred = new Set<string>();
  const rows: { player: string; dist: bigint; joinIndex: number }[] = [];
  for (const pr of book.predictions) {
    const a = pr.player.toLowerCase();
    const j = joinOf.get(a);
    if (j === undefined) throw new Error(`prediction from non-player ${a}`);
    if (j !== pr.joinIndex) throw new Error(`joinIndex mismatch for ${a}`);
    if (seenPred.has(a)) throw new Error(`duplicate prediction for ${a}`);
    seenPred.add(a);
    const c = toCents(pr.price);
    if (c < 0n) throw new Error(`negative prediction for ${a}`);
    rows.push({ player: a, dist: c > settle ? c - settle : settle - c, joinIndex: j });
  }
  rows.sort((x, y) => (x.dist !== y.dist ? (x.dist < y.dist ? -1 : 1) : x.joinIndex - y.joinIndex));

  const n = BigInt(book.players.length);
  let k = (n * winnerBps) / 10000n;
  if (k < 1n) k = 1n;
  if (k > BigInt(rows.length)) k = BigInt(rows.length);
  const top = rows.filter((_, i) => BigInt(i) < k);

  const protocolFee = (potUnits * feeBps) / 10000n;
  const creatorFeeUnits = (potUnits * creatorBps) / 10000n;
  const distributable = potUnits - protocolFee - creatorFeeUnits;

  const paid = new Map<string, bigint>();
  if (k > 0n) {
    if (p.split === "equal") {
      const each = distributable / k;
      for (const r of top) paid.set(r.player, each);
    } else {
      const R = distributable - k * entry;
      if (R < 0n) throw new Error("pot too small to refund every winner's entry");
      const weightAt = (rank: bigint) => (p.split === "linear" ? k - rank + 1n : (k - rank + 1n) * (k - rank + 1n));
      let total = 0n;
      for (let r = 1n; r <= k; r++) total += weightAt(r);
      // Group winners at exactly the same distance; each group pools the weights of the ranks it occupies.
      let i = 0;
      while (i < top.length) {
        let j = i;
        let pool = 0n;
        while (j < top.length && top[j].dist === top[i].dist) {
          pool += weightAt(BigInt(j + 1));
          j++;
        }
        const count = BigInt(j - i);
        for (let m = i; m < j; m++) paid.set(top[m].player, entry + (R * pool) / (count * total));
        i = j;
      }
    }
  }

  const winners = [...paid.keys()].filter((a) => paid.get(a)! > 0n).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const amounts = winners.map((a) => paid.get(a)!);
  const sum = amounts.reduce((s, x) => s + x, 0n);
  const feeUnits = potUnits - creatorFeeUnits - sum;
  if (feeUnits < 0n) throw new Error("payout exceeds the pot");
  return { winners, amounts, creatorFeeUnits, feeUnits };
}
