"use client";
// The island's Dojo panel body (inside components/island/ui/Panel.tsx, in the island's panel classes): Practice, the
// Ranked card as "Coming soon" (CLAUDE.md "Duel tuning"), and recent ranked results from GET /duels through dojo.ts.
import { unitsToUsd } from "@/lib/events";
import Link from "@/components/kit/link";
import { duel } from "@/lib/nav";
import { useDojo } from "./dojo";
import { useIsland } from "@/lib/island/store";
import type { DuelPlayer } from "./types";

const name = (p: DuelPlayer | undefined) => p?.callsign || (p?.player ? `${p.player.slice(0, 6)}…` : "?");
const Bot = ({ p }: { p: DuelPlayer | undefined }) => (p?.bot ? <span className="bot">bot</span> : null);

export function DojoBody() {
  const d = useDojo();
  const health = useIsland((s) => s.health);
  const info = d.info;
  // only real, finished ranked duels: a result list stays while ranked is "Coming soon"
  const recent = (info?.recent ?? []).filter((x) => x.ranked !== false).slice(0, 4);
  // a CHAIN=off engine settles offline: nothing it lists was paid on chain
  const offline = health?.chain === false;
  return (
    <>
      <p className="lede">One on one, best of three. Spar against the dojo bot for free, right in your browser: pick Sparring, Fighter or Master, or a dummy to practise on.</p>
      <Link className="cta" href={duel("practice")}>
        Practice for free
      </Link>
      <div className="ghost" aria-disabled="true" style={{ cursor: "default", opacity: 0.6, boxShadow: "none", display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span>Ranked, 5 USDC stake</span>
        <span style={{ fontFamily: "var(--mono)", fontWeight: 500 }}>Coming soon</span>
      </div>
      {recent.length > 0 && (
        <>
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
          ) : null}
        </>
      )}
      <p className="fine">Fights against the bot are always free: no stake, nothing on chain. Ranked duels open once the rules settle.</p>
    </>
  );
}
