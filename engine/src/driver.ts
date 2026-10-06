// Drives a Lobby from a clock and a price source. The sim passes a virtual clock; the server a real one.
import type { Lobby } from "./lobby.ts";
import type { Bots } from "./bots.ts";
import type { PriceSource } from "./prices.ts";
import { TICKS_PER_SEC, type Prices } from "./types.ts";

export interface Clock { now(): number } // ms since epoch

export class VirtualClock implements Clock {
  constructor(public ms: number) {}
  now() { return this.ms; }
}
export const realClock: Clock = { now: () => Date.now() };

export class Driver {
  /** Called once when the lobby moves from countdown to live (the relayer hooks start() here). */
  onStart: (() => void) | null = null;
  /** Called after each tick is processed, before the bots act (the server logs it for replay). */
  onTick: ((k: number, marks: Prices) => void) | null = null;
  constructor(readonly lobby: Lobby, readonly clock: Clock, readonly prices: PriceSource, readonly bots: Bots | null) {}

  tickAtMs(k: number) { return this.lobby.startsAt! * 1000 + (k * 1000) / TICKS_PER_SEC; }

  /** Match seconds now, clamped inside the current tick interval (for fills between ticks). */
  fillT(): number {
    const l = this.lobby;
    const raw = (this.clock.now() - l.startsAt! * 1000) / 1000;
    return Math.min(Math.max(raw, l.lastT), l.lastT + 0.249);
  }

  marks(): Prices | null { return this.prices.current() ?? this.lobby.marks; }

  /** Process every tick that is due. Returns true once the match has reached its end tick. */
  advance(): boolean {
    const l = this.lobby;
    if (l.status === "countdown" && l.startsAt !== null && this.clock.now() >= l.startsAt * 1000) {
      l.start();
      this.onStart?.();
    }
    while (l.status === "live" && this.clock.now() >= this.tickAtMs(l.k + 1)) {
      const k = l.k + 1;
      this.prices.onTick?.(k);
      const marks = this.marks();
      if (!marks) break;
      l.step(k, marks);
      this.onTick?.(k, marks);
      this.bots?.act(l, marks, k / TICKS_PER_SEC);
    }
    return l.k >= l.endK;
  }
}
