// GET /stats (the spec "Engine HTTP (added): GET /stats"): built only from settlement results, exactly as paid.
// One append-only file per data dir, one line per settlement, written where `settled` is emitted and loaded at boot.
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type Win = { player: string; callsign: string; bot: boolean; amountUnits: string };
export type Settlement = { lobbyId: number; mode: "royale" | "predict"; at: number; txHash: string; winners: Win[] };
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

export class Stats {
  private readonly file: string;
  private readonly list: Settlement[] = [];
  private readonly seen = new Set<string>();

  /** Load settlements.jsonl, then backfill any settlement logged in a lobby or round log before this file existed. */
  constructor(private readonly dir: string) {
    this.file = resolve(dir, "settlements.jsonl");
    if (existsSync(this.file)) for (const s of parseLines(this.file)) this.keep(s);
    const logs = readdirSync(dir).flatMap((f) => {
      const m = /^(lobby|round)-(\d+)\.jsonl$/.exec(f);
      return m ? [{ f, mode: m[1] === "lobby" ? "royale" as const : "predict" as const, id: Number(m[2]) }] : [];
    }).sort((a, b) => a.id - b.id || a.mode.localeCompare(b.mode));
    for (const { f, mode, id } of logs) {
      if (this.seen.has(`${mode}:${id}`)) continue;
      const path = resolve(dir, f);
      const lines = parseLines(path);
      const e = lines.find((x) => x.type === "settled");
      if (e) this.record(mode, id, e, playersInLog(lines), Math.floor(statSync(path).mtimeMs));
    }
  }

  private keep(s: Settlement) {
    const key = `${s.mode}:${s.lobbyId}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.list.push(s);
    return true;
  }

  /** Record one `settled` event (winners and amounts as paid). Once per lobby; later calls are ignored. */
  record(mode: "royale" | "predict", lobbyId: number, e: { txHash: string; winners: string[]; amounts: string[] }, who: Map<string, Who>, at = Date.now()) {
    if (this.seen.has(`${mode}:${lobbyId}`)) return;
    const winners = e.winners.map((w, i) => {
      const player = w.toLowerCase();
      const p = who.get(player);
      return { player, callsign: p?.callsign ?? "", bot: p?.bot ?? false, amountUnits: BigInt(e.amounts[i]).toString() };
    });
    const s: Settlement = { lobbyId, mode, at, txHash: e.txHash, winners };
    if (this.keep(s)) appendFileSync(this.file, JSON.stringify(s) + "\n");
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
