"use client";
// /arena follows the engine's royale lobby (?mode=royale asks for it explicitly), or the protocol prediction round with
// ?mode=predict (or ?mock=predict). ?lobby=N pins one royale lobby or prediction round, ?duel=N one duel.
// With no ?lobby= and no mode, it falls back to prediction mode when the engine runs no royale lobby (GET /lobbies
// reports current: null twice in a row, 3 s apart, as with --predict-only); once there it stays, a royale arena keeps
// checking every 10 s. The overlay (components/arena/Overlay.tsx) appears on input only; ?kiosk=1 turns it off.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useMatch } from "@/lib/useMatch";
import { engineHttp } from "@/lib/engineUrl";
import { useUrlState } from "@/lib/useUrlState";
import { docTitle } from "@/lib/nav";
import Storm from "@/components/arena/VariantB";
import Overlay from "@/components/arena/Overlay";

// ?duel=:id (or ?mock=duel) is the Stickman Duel big screen, in its own lazily loaded chunk (React.lazy: /arena's
// first-load JS stays as it was).
const DuelArena = lazy(() => import("@/components/duel/DuelArena"));
const posInt = (v: string | null) => {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 ? n : null;
};

export default function ArenaPage() {
  // a picker move changes the query without a reload: start over on the new one
  const { params } = useUrlState();
  return <ArenaRoute key={params.toString()} />;
}

function ArenaRoute() {
  const [predict, setPredict] = useState<boolean | null>(null);
  const [duel, setDuel] = useState<{ id: number | null; mock: boolean } | null>(null);
  const [lobby, setLobby] = useState<number | null>(null);
  const [mock, setMock] = useState(false);
  const [duelOver, setDuelOver] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setMock(!!q.get("mock"));
    setLobby(posInt(q.get("lobby")));
    if (q.get("duel") || q.get("mock") === "duel") {
      setDuel({ id: posInt(q.get("duel")), mock: q.get("mock") === "duel" });
      return;
    }
    if (q.get("mock") || q.get("lobby") || q.get("mode") || !process.env.NEXT_PUBLIC_ENGINE_WS) {
      setPredict(q.get("mode") === "predict" || q.get("mock") === "predict");
      return;
    }
    let stop = false;
    let nulls = 0;
    const check = async () => {
      try {
        const r = await fetch(`${engineHttp()}/lobbies`, { cache: "no-store" });
        const { current } = (await r.json()) as { current: number | null };
        nulls = current === null ? nulls + 1 : 0;
        if (stop) return;
        if (nulls >= 2) setPredict(true);
        else if (nulls === 1) setTimeout(() => void (!stop && check()), 3000);
        else setPredict((was) => was ?? false);
      } catch {
        if (!stop) setPredict((was) => was ?? false);
      }
    };
    void check();
    const id = setInterval(() => {
      if (!stop) void check();
    }, 10000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
  useEffect(() => {
    if (duel) document.title = docTitle("duel", duel.id ? `Duel #${duel.id} on the big screen` : "Big screen");
  }, [duel]);
  if (duel)
    return (
      <>
        <Suspense fallback={<main style={{ position: "fixed", inset: 0, background: "var(--sky-top)" }} />}>
          <DuelArena duelId={duel.id} mock={duel.mock} onOver={setDuelOver} />
        </Suspense>
        <Overlay game="duel" lobby={null} duel={duel.id} ended={!!duel.id && duelOver} mock={duel.mock} />
      </>
    );
  if (predict === null) return <main style={{ position: "fixed", inset: 0, background: "var(--sky-top)" }} />;
  return <Arena predict={predict} lobby={lobby} mock={mock} />;
}

/** Seconds a pinned lobby or round stays on its end before the overlay offers the next one (the podium, the reveal). */
const HOLD_FINAL = 30;
const HOLD_SETTLED = 12;
const HOLD_CANCELLED = 4;

function Arena({ predict, lobby, mock }: { predict: boolean; lobby: number | null; mock: boolean }) {
  const match = useMatch({ predict });
  const game = match.state.mode === "predict" ? "predict" : "royale";
  const [ended, setEnded] = useState(false);
  const mref = useRef(match);
  mref.current = match;
  useEffect(() => {
    if (lobby === null) return;
    let cancelledAt: number | null = null;
    const id = setInterval(() => {
      const m = mref.current;
      const s = m.ref.current;
      const now = m.clock();
      if (s.cancelled || s.status === "cancelled") {
        cancelledAt ??= Date.now();
        if (Date.now() - cancelledAt >= HOLD_CANCELLED * 1000) setEnded(true);
        return;
      }
      const fin = s.mode === "predict" ? (s.pfinal ? s.pfinalT : null) : s.final ? s.finalT : null;
      if ((s.settled && s.settledT !== null && now - s.settledT >= HOLD_SETTLED) || (fin !== null && now - fin >= HOLD_FINAL)) setEnded(true);
    }, 1000);
    return () => clearInterval(id);
  }, [lobby]);
  useEffect(() => {
    const id = match.state.lobbyId ?? lobby;
    document.title = docTitle(game, id ? `${game === "predict" ? "Round" : "Lobby"} #${id} on the big screen` : "Big screen");
  }, [game, match.state.lobbyId, lobby]);
  return (
    <>
      <Storm match={match} pinned={lobby !== null} />
      <Overlay game={game} lobby={lobby} duel={null} ended={ended} mock={mock} />
    </>
  );
}
