// Price sources. The sim uses a seeded random walk; the live server uses exchange WebSockets.
import WebSocket from "ws";
import { fromCents, toCents } from "../../shared/scoring.ts";
import { MARKETS, type Market, type Prices } from "./types.ts";
import { Rng } from "./rng.ts";

export interface PriceSource {
  /** Latest marks, or null until every market has a price. */
  current(): Prices | null;
  /** Age in ms of the oldest market price (Infinity if missing). */
  ageMs(nowMs: number): number;
  /** Called by the driver before each tick (the random walk moves here). */
  onTick?(k: number): void;
  stop?(): void;
}

/** Format any decimal price string to the 2-decimal wire string by truncation. */
export const toMark = (s: string): string => fromCents(toCents(s));

export class RandomWalkPrices implements PriceSource {
  private rng: Rng;
  private px: Record<Market, number> = { BTC: 62000, ETH: 3000, SOL: 150 };
  private drift: Record<Market, number> = { BTC: 0, ETH: 0, SOL: 0 };
  constructor(seed: number, private vol: Record<Market, number> = { BTC: 0.0004, ETH: 0.0005, SOL: 0.0007 }) {
    this.rng = new Rng(seed);
  }
  onTick(k: number) {
    if (k === 0) return;
    for (const m of MARKETS) {
      // Slowly wandering drift so there are trends to ride.
      if (this.rng.chance(0.02)) this.drift[m] = this.rng.gauss() * this.vol[m] * 0.3;
      this.px[m] *= Math.exp(this.drift[m] + this.vol[m] * this.rng.gauss());
    }
  }
  current(): Prices {
    const out = {} as Prices;
    for (const m of MARKETS) out[m] = (Math.floor(this.px[m] * 100) / 100).toFixed(2);
    return out;
  }
  ageMs() { return 0; }
}

type Feed = { prices: Partial<Record<Market, { mark: string; at: number }>> };

abstract class WsFeed implements PriceSource {
  protected feed: Feed = { prices: {} };
  private ws: WebSocket | null = null;
  private stopped = false;
  constructor(readonly name: string, private url: string, private log = (m: string) => console.log(m)) {}
  protected abstract subscribe(ws: WebSocket): void;
  protected abstract parse(msg: any): void;
  start() {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => { this.log(`[prices] ${this.name} connected`); this.subscribe(ws); });
    ws.on("message", (data) => { try { this.parse(JSON.parse(data.toString())); } catch { /* ignore */ } });
    ws.on("error", (e) => this.log(`[prices] ${this.name} error: ${(e as Error).message}`));
    ws.on("close", () => { if (!this.stopped) setTimeout(() => this.start(), 2000); });
    return this;
  }
  protected set(m: Market, raw: string) {
    try { this.feed.prices[m] = { mark: toMark(raw), at: Date.now() }; } catch { /* ignore bad number */ }
  }
  current(): Prices | null {
    const out = {} as Prices;
    for (const m of MARKETS) { const p = this.feed.prices[m]; if (!p) return null; out[m] = p.mark; }
    return out;
  }
  priceOf(m: Market) { return this.feed.prices[m]; }
  ageMs(now: number) {
    let a = 0;
    for (const m of MARKETS) { const p = this.feed.prices[m]; a = Math.max(a, p ? now - p.at : Infinity); }
    return a;
  }
  stop() { this.stopped = true; this.ws?.close(); }
}

/** Coinbase Exchange public ticker channel. */
export class CoinbaseFeed extends WsFeed {
  constructor(log?: (m: string) => void) { super("coinbase", "wss://ws-feed.exchange.coinbase.com", log); }
  protected subscribe(ws: WebSocket) {
    ws.send(JSON.stringify({ type: "subscribe", product_ids: MARKETS.map((m) => `${m}-USD`), channels: ["ticker"] }));
  }
  protected parse(msg: any) {
    if (msg.type !== "ticker" || typeof msg.price !== "string") return;
    const m = String(msg.product_id).split("-")[0] as Market;
    if (MARKETS.includes(m)) this.set(m, msg.price);
  }
}

/** Kraken WebSocket v2 public ticker channel (fallback). */
export class KrakenFeed extends WsFeed {
  constructor(log?: (m: string) => void) { super("kraken", "wss://ws.kraken.com/v2", log); }
  protected subscribe(ws: WebSocket) {
    ws.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: MARKETS.map((m) => `${m}/USD`) } }));
  }
  protected parse(msg: any) {
    if (msg.channel !== "ticker" || !Array.isArray(msg.data)) return;
    for (const d of msg.data) {
      const m = String(d.symbol).split("/")[0] as Market;
      if (MARKETS.includes(m) && typeof d.last === "number") this.set(m, d.last.toFixed(8));
    }
  }
}

/** Per market: the primary's price unless it is older than `switchMs` and the fallback's is fresher. */
export class FallbackPrices implements PriceSource {
  constructor(private primary: WsFeed, private fallback: WsFeed, private switchMs = 2000) {}
  private pick(m: Market, now: number) {
    const a = this.primary.priceOf(m), b = this.fallback.priceOf(m);
    if (a && (now - a.at <= this.switchMs || !b || a.at >= b.at)) return a;
    return b ?? a;
  }
  current(): Prices | null {
    const now = Date.now();
    const out = {} as Prices;
    for (const m of MARKETS) { const p = this.pick(m, now); if (!p) return null; out[m] = p.mark; }
    return out;
  }
  ageMs(now: number) {
    let a = 0;
    for (const m of MARKETS) { const p = this.pick(m, now); a = Math.max(a, p ? now - p.at : Infinity); }
    return a;
  }
  stop() { this.primary.stop(); this.fallback.stop(); }
}

/**
 * Settlement close per CLAUDE.md "Settlement price source": the close of the one-minute candle
 * starting at S = floor(endTime/60)*60 - 60, fetched no earlier than S + 120.
 */
export function settlementMinute(endTime: number) { return Math.floor(endTime / 60) * 60 - 60; }

export async function fetchSettlementMarks(urlTemplate: string, endTime: number): Promise<Prices> {
  const S = settlementMinute(endTime);
  const iso = new Date(S * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const out = {} as Prices;
  for (const m of MARKETS) {
    const url = urlTemplate.replace("{MARKET}", m).replace("{START}", iso).replace("{END}", iso);
    const res = await fetch(url, { headers: { "User-Agent": "trading-royale-engine" } });
    const body = await res.text();
    if (!res.ok) throw new Error(`${m} candle ${res.status}: ${body.slice(0, 200)}`);
    // Read the close as the exact decimal text received, not via a float.
    const rows = body.match(/\[[^\[\]]*\]/g) ?? [];
    let close: string | null = null;
    for (const r of rows) {
      const cells = r.slice(1, -1).split(",").map((x) => x.trim());
      if (cells.length >= 5 && Number(cells[0]) === S) close = cells[4];
    }
    if (close === null) throw new Error(`${m}: no candle at ${S} in ${body.slice(0, 200)}`);
    if (!/^\d+(\.\d+)?$/.test(close)) throw new Error(`${m}: close is not a plain decimal: ${close}`);
    out[m] = toMark(close);
  }
  return out;
}
