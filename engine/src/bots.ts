// Seeded bots. Each has a temperament; all of them try to be above the next zone line when it lands.
import { fromCents } from "../../shared/scoring.ts";
import { keccak256, toBytes } from "viem";
import type { Lobby, PlayerState } from "./lobby.ts";
import { Rng, hashSeed } from "./rng.ts";
import { MARKETS, type Market, type Order, type Prices } from "./types.ts";

type Style = "degen" | "trend" | "fade" | "steady";
type Brain = { rng: Rng; style: Style; lev: [number, number]; marginPct: [number, number]; openP: number; tp: number; sl: number };

const NAMES = ["VIPER", "NOVA", "RAZOR", "GHOST", "BLAZE", "ONYX", "COMET", "FALCON", "JINX", "KILO", "LYNX", "MAMBA", "NEON", "ORBIT", "PIKE", "QUASAR", "RUMBLE", "SABLE", "TANGO", "ULTRA", "VOLT", "WRAITH", "XENON", "YETI", "ZERO"];

export function botAddress(seed: number, i: number): string {
  return "0x" + keccak256(toBytes(`royale-bot:${seed}:${i}`)).slice(26);
}
export function botCallsign(i: number): string {
  return `${NAMES[i % NAMES.length]}${i >= NAMES.length ? Math.floor(i / NAMES.length) + 1 : ""}`;
}

const STYLES: Style[] = ["degen", "trend", "steady", "fade", "degen", "trend", "steady", "fade"];

export class Bots {
  private brains = new Map<string, Brain>();
  private history: Prices[] = [];

  constructor(private seed: number) {}

  add(player: string, i: number) {
    const rng = new Rng(hashSeed(this.seed, "bot", i));
    const style = STYLES[i % STYLES.length];
    const b: Brain =
      style === "degen" ? { rng, style, lev: [80, 100], marginPct: [85, 100], openP: 0.12, tp: 0.6, sl: 2 }
      : style === "trend" ? { rng, style, lev: [15, 40], marginPct: [30, 60], openP: 0.06, tp: 0.35, sl: 0.25 }
      : style === "fade" ? { rng, style, lev: [10, 30], marginPct: [30, 50], openP: 0.05, tp: 0.25, sl: 0.3 }
      : { rng, style, lev: [5, 20], marginPct: [40, 70], openP: 0.04, tp: 0.2, sl: 0.2 };
    this.brains.set(player, b);
  }

  private momentum(m: Market, ticks: number): number {
    const h = this.history;
    if (h.length <= ticks) return 0;
    return Number(h[h.length - 1][m]) / Number(h[h.length - 1 - ticks][m]) - 1;
  }

  /** Per-tick volatility of a market over the recent window (floored so a flat tape still gives a number). */
  private vol(m: Market, ticks = 40): number {
    const h = this.history.slice(-ticks - 1);
    if (h.length < 5) return 0.0004;
    const rs: number[] = [];
    for (let i = 1; i < h.length; i++) rs.push(Math.log(Number(h[i][m]) / Number(h[i - 1][m])));
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const v = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length);
    return Math.max(v, 0.00001);
  }

  /** Decide and send orders for every alive bot at tick time t. */
  act(lobby: Lobby, marks: Prices, t: number) {
    this.history.push(marks);
    if (this.history.length > 200) this.history.shift();
    if (!lobby.acceptingOrders) return;
    const next = lobby.preset.checkpoints.find((c) => c > t);
    const cpIdx = next === undefined ? -1 : lobby.preset.checkpoints.indexOf(next);
    const line = cpIdx >= 0 ? lobby.preset.zoneCents[cpIdx] : 0n;
    const secsLeft = (next ?? lobby.preset.duration) - t;
    for (const p of lobby.players) {
      const b = this.brains.get(p.player);
      if (!b || !p.alive) continue;
      for (const o of this.decide(lobby, p, b, marks, line, secsLeft, next === undefined)) lobby.order(p.player, o, marks, t);
    }
  }

  private decide(lobby: Lobby, p: PlayerState, b: Brain, marks: Prices, line: bigint, secsLeft: number, afterLast: boolean): Order[] {
    const r = b.rng;
    const eq = lobby.equity(p, marks);
    const orders: Order[] = [];
    // Safe above the next line with a checkpoint close: bank it.
    const cushion = line + line / 200n;
    if (!afterLast && secsLeft <= 6 && eq >= cushion && p.positions.size && r.chance(0.5)) {
      for (const m of p.positions.keys()) orders.push({ action: "close", market: m });
      return orders;
    }
    // Manage open positions.
    for (const [m, x] of p.positions) {
      const ret = Number(marks[m]) / Number(fromCents(x.entry)) - 1;
      const onMargin = ret * x.side * x.leverage; // fraction of margin won or lost
      if ((onMargin >= b.tp && r.chance(0.25)) || (onMargin <= -b.sl && r.chance(0.3)) || r.chance(0.004)) {
        orders.push({ action: "close", market: m });
      }
    }
    if (orders.length) return orders;
    // Open something new.
    const flat = p.positions.size === 0;
    const behind = eq < line;
    const urgency = behind && secsLeft < 12 ? 3 : 1;
    const holdingTheLine = !afterLast && eq >= cushion && secsLeft < 15;
    if (holdingTheLine || !r.chance(b.openP * urgency * (flat ? 1 : 0.3))) return orders;
    const free = eq - lobby.marginInUse(p);
    if (free <= 100n) return orders;
    const open = MARKETS.filter((m) => !p.positions.has(m));
    if (!open.length) return orders;
    const m = r.pick(open);
    const mom = this.momentum(m, 8);
    let side: 1 | -1 = r.chance(0.5) ? 1 : -1;
    if (b.style === "trend" && mom !== 0) side = mom > 0 ? 1 : -1;
    if (b.style === "fade" && mom !== 0) side = mom > 0 ? -1 : 1;
    let lev = r.int(b.lev[0], b.lev[1]);
    if (urgency > 1) lev = Math.min(100, lev * 2);
    let pct = BigInt(r.int(b.marginPct[0], b.marginPct[1]));
    // On a quiet tape, lift leverage (and size) until a half-sigma move over the time left reaches the line.
    if (!afterLast) {
      const needFrac = eq < line ? Number(line - eq) / Number(eq) : 0.005;
      const sigma = this.vol(m) * Math.sqrt(Math.max(secsLeft * 4, 20));
      const needed = Math.ceil((2 * needFrac) / ((Number(pct) / 100) * sigma));
      if (needed > lev) {
        lev = Math.min(100, needed);
        if (needed > 100 && pct < 80n) pct = 80n;
      }
    }
    const margin = (free * pct) / 100n;
    if (margin <= 0n) return orders;
    orders.push({ action: "open", market: m, side, margin: fromCents(margin), leverage: lev });
    return orders;
  }
}

