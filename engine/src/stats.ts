// GET /stats (the spec "Engine HTTP (added): GET /stats"): built only from settlement results, exactly as paid.
// One append-only file per data dir, one line per settlement, written where `settled` is emitted and loaded at boot.
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { PRESETS } from "./types.ts";

export type Win = { player: string; callsign: string; bot: boolean; amountUnits: string };
// bookHash identifies the match: a lobby id reused by a new escrow (same ENGINE_DATA_DIR) is a different settlement.
export type Settlement = { lobbyId: number; mode: "royale" | "predict"; at: number; txHash: string; bookHash: string | null; winners: Win[] };
type Who = { callsign: string; bot: boolean };

const DAY_MS = 86_400_000;
const parseLines = (file: string): any[] =>
  readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

/** Callsign and bot flag of every player in a lobby or round log (from its `lobby` events). */
export function playersInLog(lines: any[]): Map<string, Who> {
  const who = new Map<string, Who>();
  for (const x of lines) if (x.type === "lobby" && Array.isArray(x.players)) for (const p of x.players) who.set(String(p.player).toLowerCase(), { callsign: p.callsign, bot: !!p.bot });
  return who;
}

const keyOf = (mode: string, lobbyId: number, bookHash: string | null, txHash: string) => `${mode}:${lobbyId}:${bookHash ?? txHash}`;

/**
 * When a logged settlement happened, for logs written before settlements.jsonl: the `{"in":"settled","at"}` line the
 * engine now writes beside `settled`; else the match's end time (royale: countdown startsAt + preset duration, predict:
 * the round's endTime), which `final` and `settled` follow; else the log file's mtime.
 */
export function settledAt(lines: any[], path: string): number {
  const mark = lines.find((x) => x.in === "settled" && Number.isFinite(x.at));
  if (mark) return mark.at;
  const create = lines.find((x) => x.in === "create");
  const countdown = [...lines].reverse().find((x) => x.in === "countdown" && Number.isFinite(x.startsAt));
  const duration = create?.preset ? PRESETS[create.preset as keyof typeof PRESETS]?.duration : undefined;
  if (countdown && duration !== undefined) return (countdown.startsAt + duration) * 1000;
  const round = lines.find((x) => x.type === "round" && Number.isFinite(x.endTime));
  if (round) return round.endTime * 1000;
  return Math.floor(statSync(path).mtimeMs);
}

export class Stats {
  private readonly file: string;
  private readonly list: Settlement[] = [];
  private readonly seen = new Set<string>();

  /** Load settlements.jsonl, then backfill any settlement logged in a lobby or round log before this file existed. */
  constructor(private readonly dir: string, private readonly warn: (m: string) => void = (m) => console.error(m)) {
    this.file = resolve(dir, "settlements.jsonl");
    if (existsSync(this.file)) for (const s of parseLines(this.file)) this.keep(s);
    const logs = readdirSync(dir).flatMap((f) => {
      const m = /^(lobby|round)-(\d+)\.jsonl$/.exec(f);
      return m ? [{ f, mode: m[1] === "lobby" ? "royale" as const : "predict" as const, id: Number(m[2]) }] : [];
    }).sort((a, b) => a.id - b.id || a.mode.localeCompare(b.mode));
    for (const { f, mode, id } of logs) {
      const path = resolve(dir, f);
      const lines = parseLines(path);
      const e = lines.find((x) => x.type === "settled");
      if (!e) continue;
      const bookHash = lines.find((x) => x.type === "final")?.bookHash ?? null;
      if (!this.seen.has(keyOf(mode, id, bookHash, e.txHash))) this.record(mode, id, bookHash, e, playersInLog(lines), settledAt(lines, path));
    }
  }

  private keep(s: Settlement) {
    const key = keyOf(s.mode, s.lobbyId, s.bookHash ?? null, s.txHash);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.list.push(s);
    return true;
  }

  /** Record one `settled` event (winners and amounts as paid). Once per match (mode, id, book); repeats are ignored. */
  record(mode: "royale" | "predict", lobbyId: number, bookHash: string | null, e: { txHash: string; winners: string[]; amounts: string[] }, who: Map<string, Who>, at = Date.now()) {
    if (this.seen.has(keyOf(mode, lobbyId, bookHash, e.txHash))) return;
    const winners = e.winners.map((w, i) => {
      const player = w.toLowerCase();
      const p = who.get(player);
      return { player, callsign: p?.callsign ?? "", bot: p?.bot ?? false, amountUnits: BigInt(e.amounts[i]).toString() };
    });
    const s: Settlement = { lobbyId, mode, at, txHash: e.txHash, bookHash, winners };
    if (!this.keep(s)) return;
    // Never throws into the game path (finish/settle): the in-memory record keeps /stats right for this run, and the
    // boot backfill from the lobby/round log's `settled` line restores it after a restart.
    try { appendFileSync(this.file, JSON.stringify(s) + "\n"); }
    catch (err) { this.warn(`stats: could not append ${mode} ${lobbyId} to settlements.jsonl (${(err as Error).message}); kept in memory, backfilled from the log at next boot`); }
  }

  /** The /stats body, `playing` supplied by the server (it depends on live lobbies, not settlements). */
  view(now: number, playing: number) {
    const wins = this.list.flatMap((s) => s.winners.map((w) => ({ lobbyId: s.lobbyId, mode: s.mode, at: s.at, ...w })));
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
    let paidToday = 0n;
    const board = new Map<string, { player: string; callsign: string; bot: boolean; wins: number; earned: bigint }>();
    for (const w of wins) {
      if (w.at >= dayStart) paidToday += BigInt(w.amountUnits);
      const b = board.get(w.player) ?? { player: w.player, callsign: w.callsign, bot: w.bot, wins: 0, earned: 0n };
      b.wins++;
      b.earned += BigInt(w.amountUnits);
      if (w.callsign) b.callsign = w.callsign; // latest known callsign
      board.set(w.player, b);
    }
    const leaderboard = [...board.values()]
      .sort((a, b) => (a.earned !== b.earned ? (b.earned > a.earned ? 1 : -1) : b.wins - a.wins || (a.player < b.player ? -1 : a.player > b.player ? 1 : 0)))
      .slice(0, 10)
      .map((b) => ({ player: b.player, callsign: b.callsign, bot: b.bot, wins: b.wins, earnedUnits: b.earned.toString() }));
    // Newest first: by settlement time, then the later-recorded settlement, then winner order within it.
    const recentWins = wins.map((w, i) => ({ w, i })).sort((a, b) => b.w.at - a.w.at || b.i - a.i).slice(0, 20)
      .map(({ w }) => ({ lobbyId: w.lobbyId, mode: w.mode, player: w.player, callsign: w.callsign, bot: w.bot, amountUnits: w.amountUnits, at: w.at }));
    return { now, playing, paidTodayUnits: paidToday.toString(), leaderboard, recentWins };
  }
}
