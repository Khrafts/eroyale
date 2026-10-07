"use client";
// "My activity": live lobbies and rounds you are in (with Play and Watch links), your history with results and the
// settlement transaction, and your wins from GET /stats. Ids come from lib/activity.ts; state from GET /lobbies/:id.
import { useEffect, useState } from "react";
import { Button, Card, GhostButton, Panel, PanelHead } from "@/components/kit";
import { engineHttp } from "@/lib/engineUrl";
import { activity, type ActivityEntry } from "@/lib/activity";
import { isTxHash, unitsToUsd, type RecentWin, type StatsLeader } from "@/lib/events";
import { playRoyale, playRound, watchLobby, watchRound, predictRounds } from "@/lib/nav";
import { CALLSIGN_KEY } from "@/lib/island/avatar";

type Snap = Record<string, any>;
type Row = { e: ActivityEntry; s: Snap | null };

const LIVE = new Set(["open", "countdown", "live", "settling"]);
const TX = (tx: string) => `https://sepolia.basescan.org/tx/${tx}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const when = (ms: number) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

async function get(path: string): Promise<any | null> {
  try {
    const r = await fetch(engineHttp() + path, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** One line on how it went for `me`, from the snapshot's final and settled events. */
function result(s: Snap, me: string): string {
  if (s.status === "cancelled") return "Cancelled, entry refunded";
  const settled = s.settled;
  if (settled?.winners) {
    const i = (settled.winners as string[]).findIndex((w) => w.toLowerCase() === me);
    return i >= 0 ? `Won $${unitsToUsd(String(settled.amounts[i]))}` : "No payout";
  }
  const fin = s.final;
  if (fin) {
    const rows: any[] = fin.finalists ?? fin.winners ?? [];
    const mine = rows.find((r) => r.player === me);
    return mine ? `Provisional $${unitsToUsd(String(mine.provisionalPayoutUnits))}` : "Not in the money";
  }
  const p = (s.players as any[] | undefined)?.find((x) => x.player === me);
  if (s.mode !== "predict" && p) return p.alive === false ? `Out (${p.reason ?? "eliminated"})` : `Equity $${p.equity ?? "10000.00"}`;
  if (s.mode === "predict" && p) return p.predicted ? "Prediction in" : "No prediction yet";
  return "";
}

function ActivityCard({ row, me, live }: { row: Row; me: string; live: boolean }) {
  const { e, s } = row;
  const predict = s?.mode === "predict";
  const game = predict ? "predict" : "royale";
  const title = predict ? `${s?.params?.market ?? ""} prediction #${e.id}` : `Royale lobby #${e.id}`;
  const tx: string | undefined = s?.settled?.txHash;
  const at = s?.endTime ? s.endTime * 1000 : e.at;
  return (
    <Card style={{ padding: "14px 16px", display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <b style={{ font: "700 15px/1.3 var(--display)" }}>{title}</b>
        <span style={{ font: "600 12px/1.6 var(--mono)", color: "var(--muted)", textTransform: "uppercase" }}>
          {s ? s.status : "unknown"}
          {e.role === "creator" ? " · you created it" : ""}
        </span>
      </div>
      <div style={{ font: "400 14px/1.4 var(--body)", color: "var(--ink2)" }}>
        {[s ? result(s, me) : "The engine has no record of this one", when(at)].filter(Boolean).join(" · ")}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {live && <Button color={game} href={predict ? playRound(e.id) : playRoyale(e.id)}>{predict ? "Open round" : "Play"}</Button>}
        {s && <GhostButton href={predict ? watchRound(e.id) : watchLobby(e.id)}>{live ? "Watch" : "Replay result"}</GhostButton>}
        {isTxHash(tx) && (
          <a href={TX(tx!)} target="_blank" rel="noreferrer" style={{ alignSelf: "center", font: "600 13px var(--mono)", color: "var(--ink)" }}>
            Settlement tx ↗
          </a>
        )}
      </div>
    </Card>
  );
}

export default function Activity() {
  const [me, setMe] = useState<string | null>(null);
  const [callsign, setCallsign] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [wins, setWins] = useState<RecentWin[]>([]);
  const [leader, setLeader] = useState<StatsLeader | null>(null);

  useEffect(() => {
    document.title = "My activity · Royale Isle";
    let alive = true;
    void import("@/lib/engine").then(({ burner }) => {
      if (!alive) return;
      setMe(burner().address.toLowerCase());
      try {
        setCallsign(localStorage.getItem(CALLSIGN_KEY));
      } catch {
        /* storage blocked */
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    const load = async () => {
      const list = activity().slice(0, 40);
      const [snaps, stats] = await Promise.all([Promise.all(list.map((e) => get(`/lobbies/${e.id}`))), get("/stats")]);
      if (!alive) return;
      setRows(list.map((e, i) => ({ e, s: snaps[i] })));
      setWins(((stats?.recentWins ?? []) as RecentWin[]).filter((w) => w.player === me));
      setLeader(((stats?.leaderboard ?? []) as StatsLeader[]).find((l) => l.player === me) ?? null);
    };
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [me]);

  const live = (rows ?? []).filter((r) => r.s && LIVE.has(r.s.status));
  const past = (rows ?? []).filter((r) => !r.s || !LIVE.has(r.s.status));

  const section = (h: string) => <h3 style={{ margin: "22px 0 10px", font: "700 16px/1.2 var(--display)" }}>{h}</h3>;
  const empty = (t: string) => <p style={{ margin: 0, color: "var(--muted)", font: "400 14px/1.5 var(--body)" }}>{t}</p>;

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px 48px" }}>
      <Panel>
        <PanelHead color="var(--ink)" eyebrow="You" title={callsign || "My activity"}>
          <span style={{ font: "500 13px var(--mono)" }} title={me ?? ""}>
            {me ? short(me) : "…"}
            {leader ? ` · ${leader.wins} wins · $${unitsToUsd(leader.earnedUnits)} earned` : ""}
          </span>
        </PanelHead>
        <div style={{ padding: "4px 18px 22px" }}>
          {section("Live now")}
          {rows === null ? empty("Loading…") : live.length ? <div style={{ display: "grid", gap: 10 }}>{live.map((r) => <ActivityCard key={r.e.id} row={r} me={me!} live />)}</div> : (
            <div style={{ display: "grid", gap: 10 }}>
              {empty("You are not in a lobby or round right now.")}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button color="royale" href={playRoyale()}>Join Trading Royale</Button>
                <Button color="predict" href={predictRounds()}>Make a prediction</Button>
              </div>
            </div>
          )}

          {section("History")}
          {rows === null ? empty("Loading…") : past.length ? <div style={{ display: "grid", gap: 10 }}>{past.map((r) => <ActivityCard key={r.e.id} row={r} me={me!} live={false} />)}</div> : empty("Nothing finished yet. Games you play in this browser show up here.")}

          {section("Recent wins")}
          {wins.length ? (
            <div style={{ display: "grid", gap: 6 }}>
              {wins.map((w) => (
                <div key={`${w.mode}-${w.lobbyId}`} style={{ display: "flex", justifyContent: "space-between", font: "500 14px var(--mono)" }}>
                  <span>
                    {w.mode} #{w.lobbyId}
                  </span>
                  <span>
                    ${unitsToUsd(w.amountUnits)} · {when(w.at)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            empty("No wins among the last 20 payouts yet.")
          )}
          <p style={{ margin: "22px 0 0", color: "var(--muted)", font: "400 12px/1.5 var(--body)" }}>
            Your account is this browser's game wallet. History lists the games joined from this browser.
          </p>
        </div>
      </Panel>
    </main>
  );
}
