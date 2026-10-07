"use client";
// /arena?duel=:id, the big screen at 1920x1080: the fight full bleed on one canvas, island chips for the duel, the
// stake and the status, and at the end the result with the replay hash (re-run here from the book's inputs).
// /arena?mock=duel&at=fight shows a frozen mock fight. Loaded lazily by app/arena/page.tsx, so /arena does not grow.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Chip, kit } from "@/components/kit";
import { cfgFor, type AvatarCfg } from "@/lib/island/avatar";
import { isTxHash, unitsToUsd } from "@/lib/events";
import { Stage } from "./Stage";
import type { View } from "./render";
import { DuelLink, winnerSideOf } from "./link";
import { MOCK_DUEL_ID, MOCK_PLAYERS, MOCK_STAKE, mockRun, pickTick } from "./mock";
import { useVerify } from "./verify";
import type { DuelPlayer } from "./types";

const css = `
.da{position:fixed;inset:0;background:var(--sky-top);color:var(--ink);font-family:var(--body);overflow:hidden}
.da-top{position:absolute;left:32px;right:32px;bottom:28px;display:flex;align-items:center;gap:16px;pointer-events:none}
.da-top > span{font-size:22px;padding:12px 24px;border-width:3px}
.da-top .grow{margin-left:auto}
.da-end{position:absolute;left:50%;top:230px;transform:translateX(-50%);width:820px;padding:26px 30px;display:grid;gap:12px;border-width:3px}
.da-end h2{margin:0;font:900 44px/1.05 var(--display);letter-spacing:-.02em}
.da-end p{margin:0;font:400 22px/1.4 var(--body);color:var(--ink2)}
.da-end .row{display:flex;justify-content:space-between;gap:20px;font:400 20px/1.3 var(--body);color:var(--ink2);border-top:1px solid var(--line);padding-top:10px}
.da-end .row b{font:600 20px/1.3 var(--mono);color:var(--ink)}
.da-sun{display:inline-block;padding:2px 14px;border:3px solid var(--ink);border-radius:999px;background:var(--sun);font:700 22px/1.3 var(--mono);color:var(--ink)}
.da-wait{position:absolute;inset:0;display:grid;place-items:center;font:800 40px/1.2 var(--display);color:var(--paper);text-shadow:0 3px 0 var(--ink)}
`;

export default function DuelArena({ duelId, mock }: { duelId: number | null; mock: boolean }) {
  return (
    <main className="da">
      <style>{css}</style>
      {mock || duelId === null ? <MockArena /> : <LiveArena duelId={duelId} />}
    </main>
  );
}

const stakeLine = (stakeUnits: string | null, ranked: boolean) => (ranked ? `Stake ${unitsToUsd(stakeUnits ?? "5000000")} USDC each` : "Free bot fight · no stake");

function MockArena() {
  const run = useMemo(() => mockRun([3, 2]), []);
  const st = run.states[useMemo(() => pickTick(run, 620), [run])];
  const names: [string, string] = [MOCK_PLAYERS[0].callsign, MOCK_PLAYERS[1].callsign];
  const avatars: [AvatarCfg, AvatarCfg] = [cfgFor(MOCK_PLAYERS[0].player, names[0]), cfgFor(MOCK_PLAYERS[1].player, names[1])];
  const view = (): View => ({ f: [{ ...st.f[0] }, { ...st.f[1] }], round: st.round, roundTick: st.roundTick, pause: st.pause, over: st.over, winner: st.winner, names, bots: [false, false], avatars, me: null });
  return (
    <>
      <Stage view={view} big label="Mock duel on the big screen" />
      <Bottom duelId={MOCK_DUEL_ID} stake={stakeLine(MOCK_STAKE, true)} status="Live · mock data" pot={`Pot ${unitsToUsd(String(BigInt(MOCK_STAKE) * 2n))} USDC`} />
    </>
  );
}

function Bottom({ duelId, stake, status, pot }: { duelId: number; stake: string; status: string; pot?: string }) {
  return (
    <div className="da-top">
      <Chip>
        <b style={{ fontFamily: "var(--display)", fontWeight: 800 }}>Stickman Duel</b> · duel <b>#{duelId}</b>
      </Chip>
      <Chip>{stake}</Chip>
      {pot && <Chip>{pot}</Chip>}
      <Chip className="grow">{status}</Chip>
    </div>
  );
}

function LiveArena({ duelId }: { duelId: number }) {
  const link = useMemo(() => (typeof window === "undefined" ? null : new DuelLink(duelId, null, null)), [duelId]);
  useEffect(() => () => link?.close(), [link]);
  const info = useSyncExternalStore((f) => link?.subscribe(f) ?? (() => {}), () => link?.info ?? null, () => null);
  const players: DuelPlayer[] = info?.players ?? [];
  const verify = useVerify(duelId, info?.final ?? null, players);
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    if (!info?.final) return;
    const id = setTimeout(() => setEnded(true), 2500);
    return () => clearTimeout(id);
  }, [info?.final]);
  const ranked = info?.ranked ?? !players.some((p) => p.bot);
  const name = (i: 0 | 1) => players[i]?.callsign || `fighter ${i + 1}`;
  const endedRef = useRef(false);
  endedRef.current = ended;
  const view = (now: number): View | null => {
    const fr = link?.frame(now);
    if (!fr) return null;
    return { ...fr, names: [name(0), name(1)], bots: [!!players[0]?.bot, !!players[1]?.bot], avatars: [cfgFor(players[0]?.player ?? "a", name(0)), cfgFor(players[1]?.player ?? "b", name(1))], me: null, quietEnd: endedRef.current };
  };
  const fin = info?.final;
  const ws = fin ? winnerSideOf(fin, players) : undefined;
  const winnerName = ws === 0 || ws === 1 ? players[ws]?.callsign || `fighter ${ws + 1}` : null;
  const offline = !!info?.settled && !isTxHash(info.settled.txHash);
  const status = info?.missing ? "No such duel on this engine" : info?.cancelled ? `Cancelled: ${info.cancelled}` : !info?.connected ? "Connecting to the engine" : fin ? (info.settled ? (offline ? "Settled offline" : "Paid") : "Replaying the match") : info.status === "live" ? "Live" : "Get ready";
  return (
    <>
      <Stage view={view} big label={`Duel ${duelId} on the big screen`} />
      {!info?.connected && !fin && <div className="da-wait">{info?.missing ? `There is no duel #${duelId} on this engine` : `Waiting for duel #${duelId}`}</div>}
      <Bottom duelId={duelId} stake={stakeLine(info?.stakeUnits ?? null, ranked)} status={status} pot={ranked && info?.stakeUnits ? `Pot ${unitsToUsd(String(BigInt(info.stakeUnits) * 2n))} USDC` : undefined} />
      {ended && fin && ws !== undefined && (
        <section className={`${kit.panel} da-end`}>
          <h2>{winnerName ? `${winnerName} wins` : "A draw"} <span style={{ fontFamily: "var(--mono)" }}>{fin.rounds[0]}–{fin.rounds[1]}</span></h2>
          {ranked && (
            <>
              <div className="row">
                {winnerName ? "Payout" : "Stakes"}
                <b>
                  {winnerName ? offline ? `${unitsToUsd(fin.payoutUnits)} USDC` : <span className="da-sun">{unitsToUsd(fin.payoutUnits)} USDC</span> : "stakes back to both"}
                  {!info?.settled ? " provisional" : offline ? " not paid, offline" : ""}
                </b>
              </div>
              <div className="row">
                Settlement<b>{!info?.settled ? "waiting for the replay report" : offline ? "settled offline (no chain), nothing paid" : `${winnerName ? "paid" : "refunded"}, tx ${info.settled.txHash.slice(0, 12)}…`}</b>
              </div>
            </>
          )}
          <div className="row">
            Replay hash<b>{verify ? `${verify.hash}${verify.matches ? " · same winner" : " · differs"}` : "replaying…"}</b>
          </div>
          <div className="row">
            Book hash<b>{fin.bookHash.slice(0, 14)}…{fin.bookHash.slice(-8)}</b>
          </div>
        </section>
      )}
    </>
  );
}

