"use client";
// The island as a page: the same places and live lines, for small screens, no WebGL, or a preference.
import { useIsland } from "@/lib/island/store";
import { lineOf, usdcShort, short } from "@/lib/island/format";
import { ADS, COLORS, SPONSOR, promoHead, promoted } from "@/lib/island/places";
import { Leaderboard, RoundList, StatusRows, useNow } from "./Panel";
import type { IslandApi } from "./Island";

/** The 3D view's other places, so the list has every entry the island has. */
const AROUND: [string, string, string, string][] = [
  ["fountain", "The Fountain", "#1EB3B0", "Pick a game"],
  ["park", "Leaderboard Park", COLORS.mint, "Top earners and the podium"],
  ["lighthouse", "The Lighthouse", "#FF4F5E", "Chain, escrow and settlement status"],
  ["wheel", "The Sky Wheel", "#2BA9D6", "A landmark, coming later"],
  ["plotA", "Plot 07", "#3AAFD9", "Open plot, coming later"],
  ["plotB", "Plot 11", "#3AAFD9", "Open plot, coming later"],
];

export function ListView({ api }: { api: IslandApi }) {
  useNow();
  const s = useIsland((x) => x);
  const card = (go: string, name: string, c: string, sub: string, line: string) => (
    <button className="card" style={{ ["--c" as string]: c }} onClick={() => api.select(go)}>
      <span className="band" />
      <span className="eyebrow">{sub}</span>
      <b>{name}</b>
      <span className="live">{line}</span>
    </button>
  );
  const promos = promoted(s);
  return (
    <section className="list">
      <div className="lv">
        <h1>Royale Isle</h1>
        <p>The same island as a page. Switch back to the 3D view at any time.</p>
        <button className="ghost" style={{ width: "auto", display: "inline-block", marginTop: 12 }} onClick={() => api.select("studio")}>
          Customize your avatar and victory dance
        </button>
        <h2>Games</h2>
        <div className="cards">
          {card("arena", "Trading Royale", COLORS.coral, "The Arena", lineOf("royale.line", s))}
          {card("observatory", "Price Prediction", COLORS.violet, "The Observatory · Early access", lineOf("predict.line", s))}
          {card("dojo", "Stickman Duel", COLORS.tang, "The Dojo · Early access", lineOf("duel.line", s))}
          {card("create", "Create a round", COLORS.mint, "The Fountain", "Your market, your rules")}
        </div>
        <div className="two">
          <div>
            <h2>Player-created rounds</h2>
            <RoundList rounds={s.userRounds} s={s} />
            <h2>On the billboards</h2>
            <div className="ads">
              {ADS.map((a) => {
                const u = a.kind === "promo" ? promos[a.rank!] : undefined;
                const title = a.kind === "promo" ? (u ? promoHead(u) : "No round on this board yet") : a.kind === "sponsor" ? SPONSOR.name : "Open slot";
                const sub = a.kind === "promo" ? (u ? `Round #${u.lobbyId} · pot ${usdcShort(u.potUnits)} USDC` : "Biggest open player rounds") : a.kind === "sponsor" ? "Sponsored · fictional brand" : "Bidding opens later";
                return (
                  <button key={a.id} className="ad" style={{ ["--c" as string]: a.bg }} onClick={() => api.select(a.id)}>
                    <i />
                    <div>
                      <b>{title}</b>
                      {sub}
                    </div>
                  </button>
                );
              })}
              <button className="ad" style={{ ["--c" as string]: "#B69CFF" }} onClick={() => api.select("blimp")}>
                <i />
                <div>
                  <b>Sky banner on the blimp</b>
                  {promos[0] ? `Round #${promos[0].lobbyId} by ${short(promos[0].creator) || "a player"}` : "Biggest open player round"}
                </div>
              </button>
            </div>
            <h2>Around the island</h2>
            <div className="ads">
              {AROUND.map(([go, name, c, sub]) => (
                <button key={go} className="ad" style={{ ["--c" as string]: c }} onClick={() => api.select(go)}>
                  <i />
                  <div>
                    <b>{name}</b>
                    {sub}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <h2>Leaderboard</h2>
            <Leaderboard s={s} />
            <h2>Island status</h2>
            <StatusRows s={s} />
          </div>
        </div>
      </div>
    </section>
  );
}
