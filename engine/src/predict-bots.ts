// Seeded prediction bots. Each watches the round's market, picks a moment before the lock, and predicts the price at
// the resolve time: the current mark, nudged by recent momentum (followers ride it, faders lean against it), plus its
// own spread scaled to the volatility it has seen over the time left. Some revise once; a few never predict.
import { Rng, hashSeed } from "./rng.ts";
import type { PredictRound } from "./predict.ts";

type Brain = { player: string; rng: Rng; predictAt: number; reviseAt: number | null; trend: number; spread: number };

const WINDOW = 40; // ticks of history used for volatility and momentum
const VOL_FLOOR = 0.00005; // per-tick; a calm live tape still spreads the field

export class PredictBots {
  private brains: Brain[] = [];
  private history: number[] = [];

  constructor(private seed: number, private submit: (player: string, price: string) => void) {}

  /** Call before the round's first tick. */
  add(round: PredictRound, player: string, i: number) {
    const rng = new Rng(hashSeed(this.seed, "pbot", i));
    const lockK = round.lockK;
    const willPredict = rng.chance(0.95);
    // A bot that joins late (slow on-chain joins) picks from the time still left.
    const lo = Math.max(1, Math.floor(lockK * 0.1), round.k + 1), hi = Math.max(lo, Math.floor(lockK * 0.85));
    const predictAt = willPredict && lo < lockK ? rng.int(lo, Math.min(hi, lockK - 1)) : Infinity;
    const reviseAt = willPredict && rng.chance(0.35) ? rng.int(Math.min(predictAt + 4, lockK - 1), lockK - 1) : null;
    // trend in [-1, 1]: >0 follows momentum, <0 fades it. spread: how wide this bot guesses around its centre.
    this.brains.push({ player, rng, predictAt, reviseAt, trend: rng.next() * 2 - 1, spread: 0.3 + rng.next() * 1.5 });
  }

  private vol(): number {
    const h = this.history.slice(-WINDOW - 1);
    if (h.length < 3) return VOL_FLOOR;
    const r: number[] = [];
    for (let i = 1; i < h.length; i++) r.push(Math.log(h[i] / h[i - 1]));
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const v = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length);
    return Math.max(v, VOL_FLOOR);
  }

  private momentum(): number {
    const h = this.history;
    if (h.length <= WINDOW) return 0;
    return h[h.length - 1] / h[h.length - 1 - WINDOW] - 1;
  }

  /** Tick k (before the lock) with the market's mark. */
  act(round: PredictRound, mark: string, k: number) {
    const px = Number(mark);
    this.history.push(px);
    if (round.status !== "open" || k >= round.lockK) return;
    const left = round.endK - k;
    for (const b of this.brains) {
      if (k !== b.predictAt && k !== b.reviseAt) continue;
      const sigma = this.vol() * Math.sqrt(left) * b.spread;
      // Momentum over WINDOW ticks, extrapolated over the time left, damped.
      const drift = this.momentum() * (left / WINDOW) * 0.25 * b.trend;
      const guess = px * Math.exp(Math.max(-0.2, Math.min(0.2, drift)) + sigma * b.rng.gauss());
      const cents = Math.max(1, Math.round(guess * 100));
      this.submit(b.player, `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`);
    }
  }
}
