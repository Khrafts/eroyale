"use client";
// The side panel (a bottom sheet on phones) for each building. Buttons that act hand off to the existing screens:
// /play?lobby= to join a royale lobby, /arena?lobby= to watch, /play?mode=predict&lobby= to predict, and
// /play?mode=predict&screen=create to create a round.
import { useEffect, useState, type ReactNode, type Ref } from "react";
import { useIsland, type IslandSnap, type UserRound } from "@/lib/island/store";
import {
  lastPayoutAgo,
  lighthouseLine,
  lineOf,
  lockIn,
  price,
  roundSub,
  roundTitle,
  royalePlayers,
  royaleProgress,
  royaleStatus,
  seats,
  short,
  usdc,
  usdcShort,
} from "@/lib/island/format";
import { commas } from "@/lib/predict";
import { unitsToUsd } from "@/lib/events";
import { ADS, GAMES, SPONSOR, promoFoot, promoHead, promoted } from "@/lib/island/places";
import { AvatarStudio } from "./AvatarStudio";
import type { IslandApi } from "./Island";
import { coral, mint, tang, violet } from "@/lib/theme";
import { DojoBody } from "@/components/duel/DojoPanel";

/** Re-render once a second for countdowns. */
export function useNow() {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
}

type Def = { eyebrow: string; c: string; title: string; body: ReactNode };

const playRound = (id: number) => `/play?mode=predict&lobby=${id}`;
const CHAIN_NAMES: Record<string, string> = { "base-sepolia": "Base Sepolia", "ethereum-sepolia": "Ethereum Sepolia", "eth-sepolia": "Ethereum Sepolia", sepolia: "Ethereum Sepolia" };

export function Panel({ id, api, ref, me }: { id: string; api: IslandApi; ref: Ref<HTMLElement>; me: string | null }) {
  useNow();
  const s = useIsland((x) => x);
  const d = defOf(id, s, api, me);
  if (!d) return null;
  return (
    <aside className="panel" ref={ref} style={{ ["--c" as string]: d.c }} aria-label={d.title}>
      <div className="phead">
        <div className="ph">
          <span className="eyebrow">{d.eyebrow}</span>
          <button className="x" aria-label="Close" onClick={api.close}>
            ×
          </button>
        </div>
        <h2>{d.title}</h2>
      </div>
      <div className="pbody">{d.body}</div>
    </aside>
  );
}

function Stats({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div className="stats">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span>{k}</span>
          <b>{v}</b>
        </div>
      ))}
    </div>
  );
}

export function RoundList({ rounds, s }: { rounds: UserRound[]; s: IslandSnap }) {
  if (!rounds.length) return <p className="empty">No player-created rounds are open right now.</p>;
  return (
    <ul className="rounds">
      {rounds.map((u) => (
        <li key={u.lobbyId}>
          <div>
            <b>
              <a href={playRound(u.lobbyId)} style={{ color: "inherit", textDecoration: "none" }}>
                {roundTitle(u)}
              </a>
            </b>
            <span>{roundSub(u)}</span>
          </div>
          <div className="rt">
            <b>{seats(u)}</b>
            <span>locks {lockIn(s, u)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Leaderboard({ s }: { s: IslandSnap }) {
  const b = s.stats?.leaderboard ?? [];
  if (s.statsState === "missing") return <p className="empty">The engine does not serve /stats yet, so there is no leaderboard to show.</p>;
  if (s.statsState === "down") return <p className="empty">The leaderboard is unavailable: the engine did not answer.</p>;
  const offline = s.health?.chain === false;
  if (!b.length) return <p className="empty">{s.statsState === "loading" ? "Loading the leaderboard." : "No payouts yet. The first winners show up here."}</p>;
  return (
    <table className="lb">
      <tbody>
        {b.map((e, i) => (
          <tr key={e.player}>
            <td>
              <span className="rk">{i + 1}</span>
            </td>
            <td>
              {e.callsign}
              {e.bot && <span className="bot">bot</span>}
            </td>
            <td className="n">{e.wins} wins</td>
            <td className="n" title={offline ? "Settled offline, not paid on chain" : undefined}>
              {commas(unitsToUsd(e.earnedUnits))}
              {offline && <span className="bot">offline</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StatusRows({ s, full }: { s: IslandSnap; full?: boolean }) {
  const h = s.health;
  const fresh = !!h && h.priceAgeMs !== null && h.priceAgeMs < 15000;
  const chainName = s.escrow.chain ? (CHAIN_NAMES[s.escrow.chain] ?? s.escrow.chain) : "Testnet";
  const ok = (on: boolean, text: string) => <b className={on ? "ok" : undefined}>{text}</b>;
  return (
    <div className="status">
      <div>Engine{ok(s.engine === "ok", s.engine === "ok" ? "Live" : s.engine === "none" ? "Not configured" : s.engine === "loading" ? "Checking" : "Offline")}</div>
      <div>Chain{ok(!!h?.chain, h ? (h.chain ? chainName : "Off (local run)") : "Unknown")}</div>
      {full && <div>Escrow{ok(!!s.escrow.address, s.escrow.address ? `RoyaleEscrow ${short(s.escrow.address)}` : "Not deployed")}</div>}
      <div>Settlement{ok(true, "CRE · royale-settle")}</div>
      {full && <div>Prices{ok(fresh, h ? (fresh ? "Fresh" : "Stale") : "Unknown")}</div>}
      <div>
        Last payout<b>{lastPayoutAgo(s)}</b>
      </div>
    </div>
  );
}

function defOf(id: string, s: IslandSnap, api: IslandApi, me: string | null): Def | null {
  const r = s.royale;
  const p = s.predict;
  switch (id) {
    case "fountain":
      return {
        eyebrow: "Plaza · The Fountain",
        c: "#1EB3B0",
        title: "Pick a game",
        body: (
          <>
            <p className="lede">Every game on the island starts here. Each jet is a game, and the busier it is, the higher it sprays.</p>
            <div className="launch">
              {GAMES.map((g) => (
                <button key={g.id} className="lt" style={{ ["--c" as string]: g.color }} onClick={() => api.select(g.route)}>
                  <i />
                  <b>{g.name}</b>
                  <span>{lineOf("game." + g.id, s)}</span>
                </button>
              ))}
            </div>
          </>
        ),
      };
    case "arena": {
      const live = r?.status === "live" || r?.status === "settling";
      const joinable = r && (r.status === "open" || r.status === "countdown");
      return {
        eyebrow: "Hall · The Arena",
        c: coral,
        title: "Trading Royale",
        body: (
          <>
            <p className="lede">Everyone starts with $10,000 in phantom balance and trades BTC, ETH and SOL at up to 100× leverage. The bottom quarter is cut at three checkpoints, and the survivors split the pot.</p>
            <Stats rows={[["Status", royaleStatus(s)], ["Lobby", r ? `#${r.lobbyId}` : "–"], ["Traders", royalePlayers(s)], ["Pot", r ? usdc(r.potUnits) : "–"]]} />
            <div className="track">
              <div className="fill" style={{ width: `${royaleProgress(s)}%` }} />
              <i style={{ left: "25%" }} />
              <i style={{ left: "50%" }} />
              <i style={{ left: "75%" }} />
            </div>
            <div className="track-l">
              <span>Start</span>
              <span>Cut 1</span>
              <span>Cut 2</span>
              <span>Cut 3</span>
              <span>Final</span>
            </div>
            {!r ? (
              <p className="empty">{lineOf("royale.line", s)}. The next lobby shows up here when the engine opens it.</p>
            ) : joinable ? (
              <>
                <a className="cta" href={`/play?lobby=${r.lobbyId}`}>
                  Join lobby #{r.lobbyId} · {usdcShort(r.entryUnits)} USDC
                </a>
                <a className="ghost" href={`/arena?lobby=${r.lobbyId}`}>
                  Watch on the big screen
                </a>
              </>
            ) : (
              <>
                <a className="cta" href={`/arena?lobby=${r.lobbyId}`}>
                  {live ? "Watch live" : `Watch lobby #${r.lobbyId}`}
                </a>
                <a className="ghost" href="/play">
                  Play the next lobby
                </a>
              </>
            )}
            <p className="fine">Payouts are released by a Chainlink CRE report.</p>
          </>
        ),
      };
    }
    case "observatory":
      return {
        eyebrow: "Hall · The Observatory",
        c: violet,
        title: "Price Prediction",
        body: (
          <>
            <p className="lede">Call the closing price. Predictions stay hidden until the lock, and the closest quarter of players split the pot.</p>
            <Stats rows={[["Round", p ? `${p.market} · round #${p.lobbyId}` : "–"], ["Locks in", p ? lockIn(s, p) : "–"], ["Players", p ? (p.maxPlayers ? `${p.players} / ${p.maxPlayers}` : String(p.players)) : "–"], ["Pot", p ? usdc(p.potUnits) : "–"]]} />
            {p ? (
              <>
                <div className="call">
                  <div className="row">
                    <span>Live {p.market}</span>
                    <b style={{ fontSize: 14 }}>{price(p.mark ?? s.marks?.[p.market])}</b>
                  </div>
                  <div className="row">
                    <span>Predictions in</span>
                    <b>{p.predicted}</b>
                  </div>
                </div>
                <a className="cta" href={playRound(p.lobbyId)}>
                  Make your call · {usdcShort(p.entryUnits)} USDC
                </a>
              </>
            ) : (
              <p className="empty">{lineOf("predict.line", s)}. A new protocol round opens as soon as the last one locks.</p>
            )}
            <h3>Player-created rounds</h3>
            <RoundList rounds={s.userRounds} s={s} />
            <button className="ghost" onClick={() => api.select("create")}>
              Create your own round
            </button>
          </>
        ),
      };
    case "dojo":
      return { eyebrow: "Islet · The Dojo", c: tang, title: "Stickman Duel", body: <DojoBody /> };
    case "park":
      return {
        eyebrow: "Leaderboard Park",
        c: mint,
        title: "Top earners",
        body: (
          <>
            <p className="lede">The top three dance on the podium, and every payout sets off confetti. Trophy heights follow total winnings.</p>
            <Leaderboard s={s} />
            <p className="fine">Winnings in USDC, from every settled lobby and round.{s.source === "mock" ? " Mock data." : ""}{s.health?.chain === false ? " This engine runs without a chain: these were settled offline and nothing was paid on chain." : ""}</p>
          </>
        ),
      };
    case "create":
      return {
        eyebrow: "Fountain · Create",
        c: mint,
        title: "Create a prediction round",
        body: (
          <>
            <p className="lede">Pick a market and set the rules. Any player can create a round and take up to 5% of the pot as its creator.</p>
            <table className="params">
              <tbody>
                {[["Entry", "1–50 USDC"], ["Seats", "4–50"], ["Lock after", "30 s – 10 min"], ["Resolve after", "1–60 min"], ["Winners", "10–50% of players"], ["Split", "equal · linear · steep"], ["Creator fee", "0–5%"]].map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <a className="cta" href="/play?mode=predict&screen=create">
              Start a round
            </a>
            <button className="ghost" onClick={() => api.select("bb4")}>
              Promote it on a billboard
            </button>
          </>
        ),
      };
    case "wheel":
      return {
        eyebrow: "Landmark · Sky Wheel",
        c: "#2BA9D6",
        title: "The Sky Wheel",
        body: (
          <>
            <p className="lede">The tallest thing on the island and the first thing new players see. It&apos;s a landmark for now. Later it could host a daily spin for active players, or be rented whole as a sponsor takeover.</p>
            <Stats rows={[["Status", "Coming later"], ["Gondolas", "12"], ["Idea", "Daily spin"], ["Sponsor", "Available"]]} />
          </>
        ),
      };
    case "lighthouse":
      return {
        eyebrow: "The Lighthouse",
        c: "#FF4F5E",
        title: "Island status",
        body: (
          <>
            <p className="lede">The lighthouse keeps watch over the money. It shows the chain, the escrow and the settlement workflow behind every payout.</p>
            <StatusRows s={s} full />
            <p className="fine">{lighthouseLine(s)}.{s.escrow.address ? ` Escrow ${s.escrow.address}.` : ""}</p>
          </>
        ),
      };
    case "blimp": {
      const u = promoted(s)[0];
      return {
        eyebrow: "Sky banner",
        c: "#9A7BFF",
        title: "The blimp",
        body: (
          <>
            <p className="lede">One banner circles the whole island. It carries the open player-created round with the biggest pot. Nobody pays for the spot.</p>
            {u ? (
              <>
                <Stats rows={[["Now showing", `Round #${u.lobbyId}`], ["Created by", short(u.creator) || "a player"], ["Pot", usdc(u.potUnits)], ["Locks in", lockIn(s, u)]]} />
                <a className="cta" href={playRound(u.lobbyId)}>
                  Join round #{u.lobbyId}
                </a>
              </>
            ) : (
              <>
                <p className="empty">No player-created round is open, so the blimp invites you to make one.</p>
                <button className="cta" onClick={() => api.select("create")}>
                  Create a round
                </button>
              </>
            )}
          </>
        ),
      };
    }
    case "studio":
      return { eyebrow: "Avatar studio", c: "#FF7BCB", title: "Make your avatar", body: <AvatarStudio api={api} me={me} /> };
    case "plotA":
    case "plotB":
      return {
        eyebrow: "Open plot",
        c: "#3AAFD9",
        title: `Plot ${id === "plotB" ? 11 : "07"} is open`,
        body: (
          <>
            <p className="lede">Every plot has the same 14 × 14 footprint and faces the plaza, so a new hall or a sponsor pavilion can go in without reshaping the island.</p>
            <Stats rows={[["Status", "Coming later"], ["Footprint", "14 × 14"], ["Faces", "The plaza"], ["Use", "Game or sponsor"]]} />
          </>
        ),
      };
  }
  const ad = ADS.find((a) => a.id === id);
  if (!ad) return null;
  if (ad.kind === "promo") {
    const u = promoted(s)[ad.rank!];
    return {
      eyebrow: "Billboard · Player round",
      c: ad.bg,
      title: u ? promoHead(u) : "No round on this board yet",
      body: u ? (
        <>
          <p className="lede">The beach boards show the open player-created rounds with the biggest pots. Nobody pays for the spot. {promoFoot(u)}.</p>
          <RoundList rounds={[u]} s={s} />
          <div style={{ height: 14 }} />
          <a className="cta" href={playRound(u.lobbyId)}>
            Join round #{u.lobbyId}
          </a>
        </>
      ) : (
        <>
          <p className="lede">The beach boards show the open player-created rounds with the biggest pots. None is open right now.</p>
          <button className="cta" onClick={() => api.select("create")}>
            Create a round
          </button>
        </>
      ),
    };
  }
  if (ad.kind === "sponsor")
    return {
      eyebrow: "Billboard · Sponsored",
      c: "#1B2A6B",
      title: "Tidepool",
      body: (
        <>
          <p className="lede">The brand slots are for crypto sponsors. {SPONSOR.name} is a made-up brand that holds the spot until a real one takes it.</p>
          <Stats rows={[["Slot", "East beach"], ["Status", "Placeholder"]]} />
        </>
      ),
    };
  return {
    eyebrow: "Billboard · Open slot",
    c: coral,
    title: "Promote your round here",
    body: (
      <>
        <p className="lede">Players who create a round will be able to bid for this spot, and the highest bid takes the next slot. Bidding is coming later; there is nothing to submit yet.</p>
        <Stats rows={[["Slot", "West beach"], ["Status", "Bidding opens later"]]} />
        <p className="fine">Ads will use a fixed template (round, market, pot, link) and are reviewed before they go up.</p>
      </>
    ),
  };
}
