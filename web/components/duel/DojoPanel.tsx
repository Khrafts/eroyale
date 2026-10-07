"use client";
// The island's Dojo panel body (inside components/island/ui/Panel.tsx, in the island's panel classes): queue size,
// live duels with Watch, recent results, Practice and Fight for 5 USDC. Live from GET /duels through dojo.ts.
import { unitsToUsd } from "@/lib/events";
import Link from "@/components/kit/link";
import { duel, watchDuel } from "@/lib/nav";
import { useDojo } from "./dojo";
import { useIsland } from "@/lib/island/store";
import type { DuelPlayer } from "./types";

const name = (p: DuelPlayer | undefined) => p?.callsign || (p?.player ? `${p.player.slice(0, 6)}…` : "?");
const Bot = ({ p }: { p: DuelPlayer | undefined }) => (p?.bot ? <span className="bot">bot</span> : null);

export function DojoBody() {
  const d = useDojo();
  const health = useIsland((s) => s.health);
  const info = d.info;
  const live = info?.live ?? [];
  const recent = (info?.recent ?? []).slice(0, 4);
  // a CHAIN=off engine settles offline: nothing it lists was paid on chain
  const offline = health?.chain === false;
  return (
    <>
      <p className="lede">One on one, best of three. Practice against the dojo bot for free, or fight another player for a 5 USDC stake. Every ranked match is replayed from its recorded inputs before the stake is paid.</p>
      <div className="stats">
        <div>
          <span>In the queue</span>
          <b>{info ? info.queue : "–"}</b>
        </div>
        <div>
          <span>Live duels</span>
          <b>{info ? live.length : "–"}</b>
        </div>
        <div>
          <span>Stake</span>
          <b>{unitsToUsd(info?.stakeUnits ?? "5000000").replace(/\.00$/, "")} USDC</b>
        </div>
        <div>
          <span>Settlement</span>
          <b>Replay-verified</b>
        </div>
      </div>
      <Link className="cta" href={duel()}>
        Fight for {unitsToUsd(info?.stakeUnits ?? "5000000").replace(/\.00$/, "")} USDC
      </Link>
      <Link className="ghost" href={duel("practice")} style={{ color: "var(--ink)", textDecoration: "none" }}>
        Practice for free
      </Link>
      {d.state === "none" && <p className="empty">No engine is configured, so ranked fights are off. Practice runs in your browser.</p>}
      {d.state === "missing" && <p className="empty">This engine does not run duels yet. Practice runs in your browser.</p>}
      {d.state === "down" && !info && <p className="empty">The engine did not answer. Practice still works offline.</p>}
      {info && (
        <>
          <h3>Live now</h3>
          {live.length ? (
            <ul className="rounds">
              {live.map((x) => (
                <li key={x.duelId}>
                  <div>
                    <b>
                      {name(x.players[0])}
                      <Bot p={x.players[0]} /> vs {name(x.players[1])}
                      <Bot p={x.players[1]} />
                    </b>
                    <span>
                      Round {x.round} · {x.hp[0]}–{x.hp[1]} hp{x.ranked === false ? " · free bot fight" : ""}
                    </span>
                  </div>
                  <div className="rt">
                    <Link href={watchDuel(x.duelId)} style={{ color: "inherit", fontWeight: 700 }} aria-label={`Watch duel #${x.duelId}`}>
                      Watch
                    </Link>
                    <span>#{x.duelId}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No duel is running. Queue up and the next one is yours.</p>
          )}
          <h3>Recent results</h3>
          {recent.length ? (
            <ul className="rounds">
              {recent.map((x) => {
                const wi = x.winner ? x.players.findIndex((p) => p.player.toLowerCase() === x.winner!.toLowerCase()) : -1;
                const w = wi >= 0 ? x.players[wi] : undefined;
                const l = wi >= 0 ? x.players[1 - wi] : undefined;
                return (
                  <li key={x.duelId}>
                    <div>
                      <b>
                        {w ? (
                          <>
                            {name(w)}
                            <Bot p={w} /> beat {name(l)}
                            <Bot p={l} />
                          </>
                        ) : (
                          <>
                            {name(x.players[0])} and {name(x.players[1])} drew
                          </>
                        )}
                      </b>
                      <span>
                        {wi >= 0 ? `${x.rounds[wi]}–${x.rounds[1 - wi]}` : `${x.rounds[0]}–${x.rounds[1]}`} · duel #{x.duelId}
                      </span>
                    </div>
                    <div className="rt">
                      <b>{x.ranked === false ? "free" : w ? (x.payoutUnits && x.payoutUnits !== "0" ? `${unitsToUsd(x.payoutUnits)} USDC` : "won") : "stakes back"}</b>
                      {x.ranked !== false && <span>{!x.settled ? "provisional" : offline ? "offline, not paid" : w ? "paid" : "refunded"}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="empty">No duels have finished yet.</p>
          )}
        </>
      )}
      <p className="fine">A fight against the bot is always free: no stake, nothing on chain.</p>
    </>
  );
}
