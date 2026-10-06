// A full 120-second Stage match for 20 players, generated deterministically from a seed.
// Every event matches CLAUDE.md "Events". Scoring goes through shared/scoring.ts.
import { cut, equityCents, fromCents, settle, toCents } from "../../shared/scoring";
import type { FinalBook, Finalist, Position } from "../../shared/scoring";
import type {
  EliminatedEvent,
  LeaderboardRow,
  LobbyPlayer,
  LobbyStatus,
  Market,
  Marks,
  MatchEvent,
} from "../lib/events";
import { MARKETS, STAGE } from "../lib/events";

export type Timed = { at: number; ev: MatchEvent };

/** Named moments for `?at=`. Values are match seconds. */
export const MOMENTS: Record<string, number> = {
  lobby: -9, // players still joining
  countdown: -4,
  start: 0,
  warning: 22, // ten-second warning before checkpoint 1
  checkpoint: 31, // one second into checkpoint 1: ten players cut
  live: 42, // mid-match, nine alive, nothing happening
  liquidation: 46.2, // RUSTBUCKET liquidated at 45.75
  danger: 88, // KESTREL (me) is below the cut line two seconds before checkpoint 3
  eliminated: 92, // KESTREL cut at checkpoint 3
  final: 121.8,
  settled: 130,
  result: 130,
};

export const MOCK_END = 134;
const POT_UNITS = 20n * 5_000000n;
const FEE_BPS = 500n;
const STARTS_AT = 1791297000;
const TICK = 0.25;
const SKILL_TOP = 0.9;
const SKILL_BOTTOM = 0.3;
const LOOKAHEAD = 32; // ticks

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CALLSIGNS = [
  "KESTREL", "mara.eth", "longjohn", "OKONKWO", "vanta", "Ledgerlord", "sunny_s", "PIKE",
  "Hollow", "deltaneutral", "QUILL", "rekt_rachel", "Bastion", "nomad", "Fennec", "goblintown",
  "Rook", "tidewater", "Marrow", "RUSTBUCKET",
];

type Sim = {
  info: LobbyPlayer;
  joinIndex: number;
  cash: bigint;
  pos: Map<Market, { side: 1 | -1; notional: bigint; entry: bigint; margin: bigint }>;
  alive: boolean;
  aggression: number;
  churn: number;
  skill: number;
  deadRank: number;
  deadAt: number;
};

const money = (c: bigint) => fromCents(c);
const priceStr = (p: number) => p.toFixed(2);

function finalistOf(p: Sim): Finalist {
  const positions: Position[] = [];
  for (const [market, q] of p.pos) {
    positions.push({ market, side: q.side, notional: money(q.notional), entry: money(q.entry) });
  }
  return { player: p.info.player, cash: money(p.cash), positions };
}

function hex(r: () => number, n: number) {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16);
  return s;
}

let cache: { seed: number; events: Timed[]; cast: Cast } | null = null;

export type Cast = { me: string; winner: string; liquidated: string };

export function mockMatch(seed = 7): { events: Timed[]; cast: Cast } {
  if (cache && cache.seed === seed) return cache;
  const r = rng(seed);
  const out: Timed[] = [];
  const push = (at: number, ev: MatchEvent) => out.push({ at: Math.round(at * 1000) / 1000, ev });

  // Cast. Five humans, fifteen bots. Index 0 is "me" for the phone, index 19 is the liquidation.
  const humans = new Set([0, 1, 3, 6, 11]);
  const players: Sim[] = CALLSIGNS.map((callsign, i) => ({
    info: { player: "0x" + hex(r, 40), callsign, bot: !humans.has(i) },
    joinIndex: i,
    cash: toCents(STAGE.startBalance),
    pos: new Map(),
    alive: true,
    aggression: 4 + Math.floor(r() * 30),
    churn: 0.01 + r() * 0.03,
    skill: 0,
    deadRank: 0,
    deadAt: 0,
  }));
  const me = players[0];
  const rust = players[19];
  // Skill is how often a player trades with the next few seconds of price, so the field spreads out.
  const order = [7, 10, 6, 1, 13, 5, 16, 3, 19, 0, 8, 11, 4, 14, 2, 17, 9, 12, 15, 18];
  order.forEach((idx, k) => (players[idx].skill = SKILL_TOP - (k * (SKILL_TOP - SKILL_BOTTOM)) / (order.length - 1)));

  // Lobby phase: joins from -30 s, countdown at -10 s.
  const joined: LobbyPlayer[] = [];
  const lobby = (at: number, status: LobbyStatus) =>
    push(at, {
      type: "lobby",
      status,
      players: joined.map((p) => ({ ...p })),
      startsAt: STARTS_AT,
      potUnits: (BigInt(joined.length) * 5_000000n).toString(),
    });
  players.forEach((p, i) => {
    joined.push(p.info);
    lobby(-30 + i * 1.0 + r() * 0.4, "open");
  });
  lobby(-10, "countdown");
  lobby(0, "live");

  // Price path. SOL takes a hard 1.6% dip at 44-46.5 s, which liquidates RUSTBUCKET.
  const price: Record<Market, number> = { BTC: 62418.5, ETH: 2431.26, SOL: 146.83 };
  const sigma: Record<Market, number> = { BTC: 0.0005, ETH: 0.0007, SOL: 0.0009 };
  const drift: Record<Market, number> = { BTC: 0.00004, ETH: -0.00003, SOL: 0.00002 };
  const marksAt = (): Marks => ({ BTC: priceStr(price.BTC), ETH: priceStr(price.ETH), SOL: priceStr(price.SOL) });

  const zoneAt = (t: number): string => {
    const pts = [0, ...STAGE.checkpoints];
    const vals = [STAGE.zoneStart, ...STAGE.zoneLines].map((v) => toCents(v));
    if (t >= pts[pts.length - 1]) return money(vals[vals.length - 1]);
    let i = 0;
    while (t >= pts[i + 1]) i++;
    const f = (t - pts[i]) / (pts[i + 1] - pts[i]);
    const c = vals[i] + BigInt(Math.floor(Number(vals[i + 1] - vals[i]) * f));
    return money(c);
  };

  const eq = (p: Sim, m: Marks) => equityCents(finalistOf(p), m);
  let deadOrder = 0;

  const ranking = (m: Marks) => {
    const alive = players.filter((p) => p.alive).map((p) => ({ p, e: eq(p, m) }));
    alive.sort((a, b) => (a.e !== b.e ? (a.e > b.e ? -1 : 1) : a.p.joinIndex - b.p.joinIndex));
    return alive;
  };

  const leaderboard = (t: number, m: Marks) => {
    const alive = ranking(m);
    const rows: LeaderboardRow[] = alive.map(({ p, e }, i) => ({
      player: p.info.player,
      callsign: p.info.callsign,
      bot: p.info.bot,
      equity: money(e),
      rank: i + 1,
      alive: true,
    }));
    const dead = players.filter((p) => !p.alive).sort((a, b) => b.deadAt - a.deadAt || a.deadRank - b.deadRank);
    dead.forEach((p, i) =>
      rows.push({
        player: p.info.player,
        callsign: p.info.callsign,
        bot: p.info.bot,
        equity: money(p.cash),
        rank: alive.length + i + 1,
        alive: false,
      }),
    );
    // cutEquity: equity of the lowest rank that would survive a cut right now (rank only).
    const gone = new Set(cut(alive.map(({ p, e }) => ({ player: p.info.player, equityCents: e, joinIndex: p.joinIndex })), 0n).map((x) => x.player));
    const safe = alive.filter(({ p }) => !gone.has(p.info.player));
    const cutEquity = safe.length ? money(safe[safe.length - 1].e) : "0.00";
    push(t, { type: "leaderboard", t, rows, cutEquity });
  };

  const fill = (t: number, p: Sim, market: Market, side: 1 | -1, margin: bigint, leverage: number, kind: "open" | "close" | "liquidation") =>
    push(t, {
      type: "fill",
      t,
      player: p.info.player,
      market,
      side,
      margin: money(margin),
      leverage,
      price: priceStr(price[market]),
      kind,
    });

  const closePos = (t: number, p: Sim, market: Market, m: Marks, kind: "close" | "liquidation") => {
    const q = p.pos.get(market)!;
    const mark = toCents(m[market]);
    const pnl = (BigInt(q.side) * q.notional * (mark - q.entry)) / q.entry;
    p.cash += pnl;
    p.pos.delete(market);
    fill(t, p, market, q.side, q.margin, Number(q.notional / q.margin), kind);
  };

  const openPos = (t: number, p: Sim, market: Market, side: 1 | -1, frac: number, lev: number, m: Marks) => {
    let used = 0n;
    for (const q of p.pos.values()) used += q.margin;
    const free = eq(p, m) - used;
    const margin = (free * BigInt(Math.floor(frac * 1000))) / 1000n;
    if (margin < 100n) return;
    p.pos.set(market, { side, notional: margin * BigInt(lev), entry: toCents(m[market]), margin });
    fill(t, p, market, side, margin, lev, "open");
  };

  const kill = (p: Sim, rank: number, t: number) => {
    p.alive = false;
    p.deadRank = rank;
    p.deadAt = t + deadOrder++ * 1e-6;
  };

  const steps = Math.round(STAGE.duration / TICK);
  const path: Record<Market, number[]> = { BTC: [], ETH: [], SOL: [] };
  for (let s = 0; s <= steps + LOOKAHEAD; s++) {
    const t = s * TICK;
    if (s > 0) {
      for (const k of MARKETS) {
        let z = 0;
        for (let i = 0; i < 4; i++) z += r();
        z = (z - 2) * 1.7;
        price[k] *= 1 + drift[k] + sigma[k] * z;
      }
      if (t > 44 && t <= 46.5) price.SOL *= 1 - 0.0016;
    }
    for (const k of MARKETS) path[k].push(price[k]);
  }
  const ahead = (k: Market, s: number): 1 | -1 => (path[k][s + LOOKAHEAD] >= path[k][s] ? 1 : -1);
  let warned = 0;
  for (let s = 0; s <= steps; s++) {
    const t = s * TICK;
    for (const k of MARKETS) price[k] = path[k][s];
    const m = marksAt();
    const cp = STAGE.checkpoints.find((c) => c > t);
    const cpIndex = cp ? STAGE.checkpoints.indexOf(cp) + 1 : 0;
    push(t, { type: "tick", t, marks: m, zone: zoneAt(t), nextCheckpoint: cp ? { index: cpIndex, at: cp } : null });

    // Trading.
    if (t > 0.5 && t < STAGE.duration) {
      for (const p of players) {
        if (!p.alive || (p === rust && t >= 38)) continue;
        if (r() > p.churn * 4) continue;
        const market = MARKETS[Math.floor(r() * 3)];
        if (p.pos.has(market)) closePos(t, p, market, m, "close");
        else {
          const side: 1 | -1 = r() < p.skill ? ahead(market, s) : ((-ahead(market, s)) as 1 | -1);
          const lev = Math.max(1, Math.min(100, Math.round(p.aggression * (0.6 + r() * 0.8))));
          openPos(t, p, market, side, 0.25 + r() * 0.5, lev, m);
        }
      }
      // RUSTBUCKET goes all in on SOL at 100x right before the dip.
      if (t === 40) for (const k of [...rust.pos.keys()]) closePos(t, rust, k, m, "close");
      if (t === 41) openPos(t, rust, "SOL", 1, 0.98, 100, m);
    }

    // Liquidations.
    for (const p of players) {
      if (!p.alive) continue;
      if (eq(p, m) <= 0n) {
        const rank = ranking(m).findIndex((x) => x.p === p) + 1;
        for (const k of [...p.pos.keys()]) closePos(t, p, k, m, "liquidation");
        if (p.cash > 0n) p.cash = 0n;
        kill(p, rank, t);
        push(t, { type: "eliminated", t, checkpoint: null, players: [{ player: p.info.player, callsign: p.info.callsign, reason: "liquidated", rank }] });
      }
    }

    // Warnings at ten seconds out.
    if (cp && cp - t === 10 && warned < cpIndex) {
      warned = cpIndex;
      push(t, { type: "warning", checkpoint: cpIndex, secondsLeft: 10 });
    }

    // Checkpoints: freeze marks, compute equity, cut.
    const ci = STAGE.checkpoints.indexOf(t as 30 | 60 | 90);
    if (ci >= 0) {
      const ranked = ranking(m);
      const zone = toCents(STAGE.zoneLines[ci]);
      const elim = cut(
        ranked.map(({ p, e }) => ({ player: p.info.player, equityCents: e, joinIndex: p.joinIndex })),
        zone,
      );
      const ev: EliminatedEvent = { type: "eliminated", t, checkpoint: (ci + 1) as 1 | 2 | 3, players: [] };
      for (const e of elim) {
        const idx = ranked.findIndex((x) => x.p.info.player === e.player);
        const p = ranked[idx].p;
        ev.players.push({ player: p.info.player, callsign: p.info.callsign, reason: e.reason, rank: idx + 1 });
      }
      ev.players.sort((a, b) => a.rank - b.rank);
      for (const e of ev.players) {
        const p = players.find((x) => x.info.player === e.player)!;
        p.cash = eq(p, m);
        p.pos.clear();
        kill(p, e.rank, t);
      }
      leaderboard(t, m);
      push(t + 0.001, ev);
    } else {
      leaderboard(t, m);
    }
  }

  // Final: freeze marks, settle through the shared scorer.
  const end = STAGE.duration;
  const m = marksAt();
  lobby(end, "settling");
  const finalists = players.filter((p) => p.alive);
  const book: FinalBook = {
    lobbyId: 1,
    endTime: STARTS_AT + end,
    startBalance: STAGE.startBalance,
    finalists: finalists.map(finalistOf).sort((a, b) => (a.player < b.player ? -1 : 1)),
    logHash: "0x" + hex(r, 64),
  };
  const res = settle(book, m, POT_UNITS, FEE_BPS);
  const payout = new Map(res.winners.map((w, i) => [w, res.amounts[i]]));
  const byEq = finalists.map((p) => ({ p, e: eq(p, m) })).sort((a, b) => (a.e > b.e ? -1 : a.e < b.e ? 1 : 0));
  push(end + 0.01, {
    type: "final",
    marks: m,
    bookHash: "0x" + hex(r, 64),
    finalists: byEq.map(({ p, e }) => ({
      player: p.info.player,
      callsign: p.info.callsign,
      equity: money(e),
      provisionalPayoutUnits: (payout.get(p.info.player) ?? 0n).toString(),
    })),
  });
  push(end + 8, {
    type: "settled",
    txHash: "0x" + hex(r, 64),
    mode: "simulated",
    winners: res.winners,
    amounts: res.amounts.map(String),
  });
  joined.splice(0, joined.length, ...players.map((p) => p.info));
  lobby(end + 8, "settled");

  out.sort((a, b) => a.at - b.at);
  const winner = byEq[0].p.info.player;
  const cast: Cast = { me: me.info.player, winner, liquidated: rust.info.player };
  cache = { seed, events: out, cast };
  return cache;
}
