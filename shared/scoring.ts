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
