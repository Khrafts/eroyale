// Prediction rounds, generated deterministically from a seed. Every wire event matches CLAUDE.md "Prediction mode" >
// "Events"; payouts go through predictSettle in shared/scoring.ts. Times (`at`) are unix seconds.
//
// Lobby 41: the protocol round (BTC, 20 players, 18 predict, top 5 win, linear), the one the screens follow.
// Lobby 42: a user round with a creator fee (ETH, mara.eth's, 3%, steep, top 40%).
// Lobby 43: a user round (SOL, OKONKWO's, equal split, no fee), still filling up.
// Lobby 44: the next protocol round (ETH), which opens when 41 locks.
import { fromCents, predictSettle, toCents } from "../../shared/scoring";
import type { PredictBook } from "../../shared/scoring";
import type { LobbyPlayer, LobbyStatus, Market, MatchEvent, PredictParams, RoundInfo } from "../lib/events";

export type PTimed = { at: number; ev: MatchEvent };

/** Unix seconds when the protocol round (lobby 41) opens. A minute boundary. */
export const PREDICT_OPEN_AT = 1791297000;
export const PROTOCOL_LOBBY = 41;
/** Named moments for `?mock=predict&at=`, in seconds after lobby 41 opens. */
export const PREDICT_MOMENTS: Record<string, number> = {
  open: 42, // most players in, 14 predictions sealed, 18 s to the lock
  locked: 62.5, // just after the lock: every prediction revealed
  close: 150, // 30 s before the resolve, the band is tight
  final: 184, // the settlement price has landed, payouts provisional
  settled: 194, // the settlement report is on chain
  result: 194,
};
export const PREDICT_END = 200;
const FEE_BPS = 500;

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
const hex = (r: () => number, n: number) => {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16);
  return s;
};
const gauss = (r: () => number) => {
  let z = 0;
  for (let i = 0; i < 6; i++) z += r();
  return (z - 3) * 1.41;
};

const CALLSIGNS = [
  "KESTREL", "mara.eth", "longjohn", "OKONKWO", "vanta", "Ledgerlord", "sunny_s", "PIKE",
  "Hollow", "deltaneutral", "QUILL", "rekt_rachel", "Bastion", "nomad", "Fennec", "goblintown",
  "Rook", "tidewater", "Marrow", "RUSTBUCKET",
];
const HUMANS = new Set(["KESTREL", "mara.eth", "OKONKWO", "sunny_s", "rekt_rachel"]);

export type Cast = { me: string; winner: string; loser: string; byCallsign: Record<string, string> };

type Cfg = {
  lobbyId: number;
  seed: number;
  protocol: boolean;
  market: Market;
  price: number;
  openAt: number;
  lockAfter: number;
  resolveAfter: number;
  maxPlayers: number;
  entryUnits: string;
  winnerBps: number;
  split: PredictParams["split"];
  creator: string | null;
  creatorFeeBps: number;
  players: string[]; // callsigns, in join order
  silent: string[]; // callsigns that join but never predict
  /** Rank KESTREL should finish at (tuned after the settlement price is known), or null to leave it alone. */
  meRank: number | null;
};

export type MockRound = { cfg: Cfg; params: PredictParams; lockTime: number; endTime: number; events: PTimed[] };

let cache: { seed: number; rounds: MockRound[]; cast: Cast } | null = null;

export function mockPredict(seed = 7): { rounds: MockRound[]; cast: Cast } {
  if (cache && cache.seed === seed) return cache;
  const ra = rng(seed);
  const addr: Record<string, string> = {};
  for (const c of CALLSIGNS) addr[c] = "0x" + hex(ra, 40);

  const O = PREDICT_OPEN_AT;
  const cfgs: Cfg[] = [
    {
      lobbyId: 41, seed: seed * 31 + 1, protocol: true, market: "BTC", price: 62418.5, openAt: O, lockAfter: 60, resolveAfter: 120,
      maxPlayers: 50, entryUnits: "5000000", winnerBps: 2500, split: "linear", creator: null, creatorFeeBps: 0,
      players: CALLSIGNS, silent: ["Marrow", "goblintown"], meRank: 3,
    },
    {
      lobbyId: 42, seed: seed * 31 + 2, protocol: false, market: "ETH", price: 2431.26, openAt: O - 200, lockAfter: 320, resolveAfter: 900,
      maxPlayers: 24, entryUnits: "10000000", winnerBps: 4000, split: "steep", creator: addr["mara.eth"], creatorFeeBps: 300,
      players: ["mara.eth", "PIKE", "vanta", "QUILL", "Hollow", "nomad", "Bastion", "Fennec", "Rook", "sunny_s", "tidewater", "longjohn"],
      silent: [], meRank: null,
    },
    {
      lobbyId: 43, seed: seed * 31 + 3, protocol: false, market: "SOL", price: 146.83, openAt: O + 30, lockAfter: 570, resolveAfter: 1800,
      maxPlayers: 12, entryUnits: "2000000", winnerBps: 3000, split: "equal", creator: addr["OKONKWO"], creatorFeeBps: 0,
      players: ["OKONKWO", "deltaneutral", "Ledgerlord", "rekt_rachel", "RUSTBUCKET", "Marrow"], silent: [], meRank: null,
    },
    {
      lobbyId: 44, seed: seed * 31 + 4, protocol: true, market: "ETH", price: 2431.26, openAt: O + 60, lockAfter: 60, resolveAfter: 120,
      maxPlayers: 50, entryUnits: "5000000", winnerBps: 2500, split: "linear", creator: null, creatorFeeBps: 0,
      players: ["Bastion", "vanta", "QUILL", "nomad", "PIKE", "Rook", "Fennec", "Hollow", "tidewater", "longjohn", "deltaneutral"],
      silent: [], meRank: null,
    },
  ];
  const rounds = cfgs.map((c) => genRound(c, addr));
  const p = rounds[0];
  const fin = p.events.find((e) => e.ev.type === "final")!.ev as Extract<MatchEvent, { type: "final"; settlementPrice: string }>;
  const ranked = [...fin.winners].sort((a, b) => a.rank - b.rank);
  const winnerSet = new Set(fin.winners.map((w) => w.player));
  const cast: Cast = {
    me: addr.KESTREL,
    winner: ranked[0].player,
    loser: addr[CALLSIGNS.find((c) => !winnerSet.has(addr[c]) && !cfgs[0].silent.includes(c) && c !== "KESTREL")!],
    byCallsign: addr,
  };
  cache = { seed, rounds, cast };
  return cache;
}

const STEP = 0.25;

function genRound(c: Cfg, addr: Record<string, string>): MockRound {
  const r = rng(c.seed);
  const out: PTimed[] = [];
  const push = (t: number, ev: MatchEvent) => out.push({ at: c.openAt + Math.round(t * 1000) / 1000, ev });
  const lockTime = c.openAt + c.lockAfter;
  const endTime = lockTime + c.resolveAfter;
  const params: PredictParams = {
    market: c.market,
    entryUnits: c.entryUnits,
    winnerBps: c.winnerBps,
    split: c.split,
    creator: c.creator,
    creatorFeeBps: c.creatorFeeBps,
    feeBps: FEE_BPS,
  };
  const total = c.lockAfter + c.resolveAfter;

  // Price path, one point per quarter second, in cents.
  const steps = Math.round(total / STEP);
  const path: bigint[] = [];
  let px = c.price;
  const sigma = 0.00009;
  for (let i = 0; i <= steps; i++) {
    if (i > 0) px *= 1 + sigma * gauss(r) + (i > steps * 0.6 ? 0.000012 : -0.000004);
    path.push(BigInt(Math.round(px * 100)));
  }
  const at = (t: number) => path[Math.max(0, Math.min(steps, Math.round(t / STEP)))];

  // Joins.
  const players: LobbyPlayer[] = c.players.map((cs) => ({ player: addr[cs], callsign: cs, bot: !HUMANS.has(cs) }));
  const joinAt = players.map((_, i) => 1 + (i * (c.lockAfter - 12)) / players.length + r() * 1.5);
  const joined: LobbyPlayer[] = [];
  const lobby = (t: number, status: LobbyStatus, list: LobbyPlayer[]) =>
    push(t, {
      type: "lobby",
      status,
      players: list.map((p) => ({ ...p })),
      startsAt: lockTime,
      endTime,
      lockTime,
      market: c.market,
      lobbyId: c.lobbyId,
      mode: "predict",
      potUnits: (BigInt(list.length) * BigInt(c.entryUnits)).toString(),
    });
  lobby(0, "open", []);
  push(0, { type: "round", lobbyId: c.lobbyId, params, lockTime, endTime, protocol: c.protocol });

  // Predictions: each player calls the price some seconds after joining, around where it is then.
  const spread = c.price * 0.0011;
  const firstAt: number[] = [];
  const price = new Map<string, bigint>();
  const taken = new Set<string>();
  players.forEach((p, i) => {
    if (c.silent.includes(p.callsign)) return firstAt.push(Infinity);
    const tp = Math.min(c.lockAfter - 1.5, joinAt[i] + 2 + r() * 8);
    firstAt.push(tp);
    let v = at(tp) + BigInt(Math.round(gauss(r) * spread * 100));
    while (taken.has(v.toString()) || v <= 0n) v += 7n;
    taken.add(v.toString());
    price.set(p.player, v);
  });

  // Settlement: the close of the last minute's candle, a touch off the last mark.
  const settle = at(total) - 137n;
  // Tune KESTREL to a chosen rank: halfway between two neighbours, so the result is never decided by a tie.
  const me = addr.KESTREL;
  if (c.meRank !== null && price.has(me)) {
    const others = [...price.entries()].filter(([a]) => a !== me).map(([, v]) => (v > settle ? v - settle : settle - v)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const lo = others[c.meRank - 2];
    const hi = others[c.meRank - 1];
    let d = (lo + hi) / 2n;
    if (d === lo || d === hi) d = lo + 1n;
    price.set(me, settle + d);
  }
  // Every distance distinct, so the cut-off never rides on joinIndex.
  const dists = new Set<string>();
  for (const [a, v] of price) {
    let x = v;
    const dist = () => (x > settle ? x - settle : settle - x).toString();
    while (dists.has(dist())) x += 3n;
    dists.add(dist());
    price.set(a, x);
  }

  // The timeline before the lock: joins, marks, prediction counts.
  type Ev = { t: number; kind: "join" | "predict"; i: number };
  const evs: Ev[] = [];
  players.forEach((_, i) => {
    evs.push({ t: joinAt[i], kind: "join", i });
    if (Number.isFinite(firstAt[i])) evs.push({ t: firstAt[i], kind: "predict", i });
  });
  evs.sort((a, b) => a.t - b.t);
  let count = 0;
  for (const e of evs) {
    if (e.kind === "join") {
      joined.push(players[e.i]);
      lobby(e.t, "open", joined);
    } else {
      count++;
      push(e.t, { type: "predicted", t: Math.round(e.t * 1000) / 1000, count, lobbyId: c.lobbyId });
    }
  }
  for (let i = 0; i * STEP < c.lockAfter; i++) push(i * STEP, { type: "mark", at: c.openAt + i * STEP, mark: fromCents(path[i]) });

  // Lock: reveal, then 4 Hz pticks through the resolve time.
  const preds = players.filter((p) => price.has(p.player));
  lobby(c.lockAfter, "live", players);
  push(c.lockAfter, {
    type: "locked",
    t: c.lockAfter,
    predictions: preds.map((p) => ({ player: p.player, callsign: p.callsign, bot: p.bot, price: fromCents(price.get(p.player)!) })),
  });
  const n = players.length;
  const k = Math.min(preds.length, Math.max(1, Math.floor((n * c.winnerBps) / 10000)));
  const join = new Map(players.map((p, i) => [p.player, i]));
  const rank = (mark: bigint) =>
    preds
      .map((p) => {
        const v = price.get(p.player)!;
        return { p, v, d: v > mark ? v - mark : mark - v };
      })
      .sort((a, b) => (a.d !== b.d ? (a.d < b.d ? -1 : 1) : join.get(a.p.player)! - join.get(b.p.player)!));
  for (let i = Math.round(c.lockAfter / STEP); i <= steps; i++) {
    const t = i * STEP;
    const m = path[i];
    const top = rank(m).slice(0, k);
    const vs = top.map((x) => x.v);
    const lo = vs.reduce((a, b) => (b < a ? b : a));
    const hi = vs.reduce((a, b) => (b > a ? b : a));
    push(t, {
      type: "ptick",
      t,
      mark: fromCents(m),
      band: { low: fromCents(lo), high: fromCents(hi) },
      leaders: top.map((x, j) => ({ player: x.p.player, rank: j + 1, distance: fromCents(x.d) })),
    });
  }
  lobby(total + 0.001, "settling", players);

  // Final and settlement, through the shared scorer.
  const pot = BigInt(n) * BigInt(c.entryUnits);
  const book: PredictBook = {
    lobbyId: c.lobbyId,
    mode: "predict",
    lockTime,
    endTime,
    params,
    players: players.map((p, i) => ({ player: p.player, joinIndex: i })),
    predictions: preds.map((p) => ({ player: p.player, price: fromCents(price.get(p.player)!), joinIndex: join.get(p.player)! })),
    logHash: "0x" + hex(r, 64),
  };
  const sp = fromCents(settle);
  const res = predictSettle(book, sp, pot);
  const payout = new Map(res.winners.map((w, i) => [w, res.amounts[i]]));
  const ranked = rank(toCents(sp)).slice(0, res.winners.length);
  push(total + 0.5, {
    type: "final",
    settlementPrice: sp,
    bookHash: "0x" + hex(r, 64),
    creatorFeeUnits: res.creatorFeeUnits.toString(),
    winners: ranked.map((x, j) => ({
      player: x.p.player,
      callsign: x.p.callsign,
      price: fromCents(x.v),
      distance: fromCents(x.d),
      rank: j + 1,
      provisionalPayoutUnits: (payout.get(x.p.player) ?? 0n).toString(),
    })),
  });
  push(total + 8, {
    type: "settled",
    txHash: "0x" + hex(r, 64),
    mode: "simulated",
    winners: res.winners,
    amounts: res.amounts.map(String),
  });
  lobby(total + 8, "settled", players);
  out.sort((a, b) => a.at - b.at);
  return { cfg: c, params, lockTime, endTime, events: out };
}

/** What GET /rounds would return at `unix`: open rounds, the protocol round first, then user rounds by lock time. */
export function mockRounds(unix: number, seed = 7): RoundInfo[] {
  const { rounds } = mockPredict(seed);
  const list: RoundInfo[] = [];
  for (const m of rounds) {
    if (unix < m.cfg.openAt || unix >= m.lockTime) continue;
    let players = 0;
    let potUnits = "0";
    let predicted = 0;
    let mark: string | undefined;
    for (const e of m.events) {
      if (e.at > unix) break;
      if (e.ev.type === "lobby") {
        players = e.ev.players.length;
        potUnits = e.ev.potUnits;
      } else if (e.ev.type === "predicted") predicted = e.ev.count;
      else if (e.ev.type === "mark") mark = e.ev.mark;
    }
    list.push({
      lobbyId: m.cfg.lobbyId,
      protocol: m.cfg.protocol,
      status: "open",
      params: m.params,
      maxPlayers: m.cfg.maxPlayers,
      lockAfter: m.cfg.lockAfter,
      resolveAfter: m.cfg.resolveAfter,
      openTime: m.cfg.openAt,
      lockTime: m.lockTime,
      endTime: m.endTime,
      players,
      predicted,
      potUnits,
      mark,
    });
  }
  return list.sort((a, b) => (a.protocol !== b.protocol ? (a.protocol ? -1 : 1) : a.lockTime - b.lockTime));
}

/** KESTREL's own prediction in a mock round (what the phone sent), and when. */
export function mockMine(lobbyId: number, seed = 7): { price: string; at: number } | null {
  const { rounds, cast } = mockPredict(seed);
  const m = rounds.find((x) => x.cfg.lobbyId === lobbyId);
  const lk = m?.events.find((e) => e.ev.type === "locked")?.ev;
  if (!m || !lk || lk.type !== "locked") return null;
  const p = lk.predictions.find((x) => x.player === cast.me);
  if (!p) return null;
  const i = m.cfg.players.indexOf("KESTREL");
  return { price: p.price, at: m.cfg.openAt + 1 + (i * (m.cfg.lockAfter - 12)) / m.cfg.players.length + 4 };
}
