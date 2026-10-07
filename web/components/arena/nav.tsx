"use client";
// The /arena overlay's content, loaded lazily by Overlay.tsx: the kit app bar as a floating chip cluster (brand,
// game switcher) plus a picker of what to watch (GET /lobbies, GET /rounds, GET /duels), and, when a pinned lobby,
// round or duel is over, the offer to move on (CLAUDE.md "Navigation" rules 6 and 8).
import { useEffect, useState } from "react";
import { TopBar, kit } from "@/components/kit";
import Link from "@/components/kit/link";
import { usePopover } from "@/components/kit/popover";
import { engineHttp } from "@/lib/engineUrl";
import { island, watchDuel, watchLobby, watchRound } from "@/lib/nav";
import { coral, tang, violet } from "@/lib/theme";
import { parseDuels, type DuelsLive } from "@/components/duel/types";
import n from "./nav.module.css";

export type ArenaGame = "royale" | "predict" | "duel";
export type ArenaNavProps = {
  game: ArenaGame;
  /** The pinned ?lobby= (royale lobby or prediction round), else null (following). */
  lobby: number | null;
  /** The pinned ?duel=, else null. */
  duel: number | null;
  /** A pinned lobby, round or duel is over: offer the next one. */
  ended?: boolean;
  /** Mock data: no engine to list. */
  mock?: boolean;
};

type Lobby = { lobbyId: number; status: string; players: number };
type Round = { lobbyId: number; protocol: boolean; players: number; params?: { market?: string } };
type Lists = { lobbies: Lobby[]; current: number | null; rounds: Round[]; duels: DuelsLive[]; loaded: boolean };
const EMPTY: Lists = { lobbies: [], current: null, rounds: [], duels: [], loaded: false };
const DONE = new Set(["settled", "cancelled"]);
const hasEngine = () => !!(process.env.NEXT_PUBLIC_ENGINE_WS || process.env.NEXT_PUBLIC_ENGINE_HTTP);

const get = async (path: string) => {
  try {
    const r = await fetch(engineHttp() + path, { cache: "no-store" });
    return r.ok ? ((await r.json()) as unknown) : null;
  } catch {
    return null;
  }
};

/** What there is to watch, every 5 s while the tab is visible. */
function useLists(on: boolean): Lists {
  const [lists, setLists] = useState<Lists>(EMPTY);
  useEffect(() => {
    if (!on) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stop) return;
      if (!document.hidden) {
        const [l, r, d] = await Promise.all([get("/lobbies"), get("/rounds"), get("/duels")]);
        if (stop) return;
        const lb = (l ?? {}) as { current?: number | null; lobbies?: Lobby[] };
        const rb = (r ?? {}) as { rounds?: Round[] };
        setLists({
          current: lb.current ?? null,
          // the royale lobbies (rounds are listed below with their market); open and running ones only
          lobbies: (lb.lobbies ?? []).filter((x) => !DONE.has(x.status) && !(rb.rounds ?? []).some((y) => y.lobbyId === x.lobbyId)),
          rounds: rb.rounds ?? [],
          duels: d ? parseDuels(d).live : [],
          loaded: true,
        });
      }
      t = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [on]);
  return lists;
}

const vs = (d: DuelsLive) => d.players.map((p) => p.callsign || `${p.player.slice(0, 6)}…`).join(" vs ") || "two fighters";

export default function ArenaNav({ game, lobby, duel, ended, mock }: ArenaNavProps) {
  const lists = useLists(!mock && hasEngine());
  const pop = usePopover();
  const watching =
    game === "duel" ? (duel ? `Duel #${duel}` : "Mock duel") : lobby ? `${game === "predict" ? "Round" : "Lobby"} #${lobby}` : game === "predict" ? "The protocol round" : "The current lobby";
  const close = () => pop.setOpen(false);
  type Item = { href: string; label: string; sub: string; color: string; on: boolean };
  const items: Item[] = [
    { href: "/arena?mode=royale", label: "Follow Trading Royale", sub: lists.current ? `the current lobby, #${lists.current}` : "the current lobby", color: coral, on: game === "royale" && !lobby },
    { href: watchRound(), label: "Follow Price Prediction", sub: "the protocol round", color: violet, on: game === "predict" && !lobby },
    ...lists.lobbies.map((x) => ({ href: watchLobby(x.lobbyId), label: `Lobby #${x.lobbyId}`, sub: `${x.status}, ${x.players} ${x.players === 1 ? "player" : "players"}`, color: coral, on: game === "royale" && lobby === x.lobbyId })),
    ...lists.rounds.map((x) => ({ href: watchRound(x.lobbyId), label: `Round #${x.lobbyId}${x.params?.market ? ` · ${x.params.market}` : ""}`, sub: `${x.protocol ? "protocol round" : "player round"}, ${x.players} ${x.players === 1 ? "player" : "players"}`, color: violet, on: game === "predict" && lobby === x.lobbyId })),
    ...lists.duels.map((x) => ({ href: watchDuel(x.duelId), label: `Duel #${x.duelId}`, sub: `${vs(x)}, round ${x.round}`, color: tang, on: game === "duel" && duel === x.duelId })),
  ];
  return (
    <>
      <TopBar game={game} watch={null} className={n.bar}>
        <div className={n.pick} ref={pop.box}>
          <button ref={pop.btn} type="button" className={`${kit.chip} ${n.pickBtn}`} aria-haspopup="true" aria-expanded={pop.open} aria-controls="arena-pick" aria-label={`Watching ${watching}. Pick what to watch`} style={{ ["--c" as string]: game === "duel" ? tang : game === "predict" ? violet : coral }} onClick={() => pop.setOpen((o) => !o)}>
            <span className={n.eye} aria-hidden="true" />
            {watching}
            <svg viewBox="0 0 10 6" aria-hidden="true" className={n.caret}>
              <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          {pop.open && (
            <div id="arena-pick" className={n.menu} role="group" aria-label="What to watch">
              {items.map((it) => (
                <Link key={it.href} href={it.href} className={n.item} aria-current={it.on ? "page" : undefined} onClick={close} style={{ ["--c" as string]: it.color }}>
                  <i className={n.dot} aria-hidden="true" />
                  <span>
                    <b>{it.label}</b>
                    <small>{it.sub}</small>
                  </span>
                </Link>
              ))}
              {mock ? <p className={n.note}>Mock data: the live lists need an engine.</p> : !hasEngine() ? <p className={n.note}>No engine is configured, so nothing live is listed.</p> : !lists.loaded ? <p className={n.note}>Looking for live games…</p> : null}
            </div>
          )}
        </div>
      </TopBar>
      {ended && <Next game={game} lobby={lobby} duel={duel} lists={lists} />}
    </>
  );
}

/** The move-on offer for a pinned screen whose lobby, round or duel is over (rule 8): never a surprise, one press. */
function Next({ game, lobby, duel, lists }: { game: ArenaGame; lobby: number | null; duel: number | null; lists: Lists }) {
  const nextDuel = lists.duels.find((d) => d.duelId !== duel);
  const offer =
    game === "duel"
      ? nextDuel
        ? { title: `Duel #${duel} is over`, line: `${vs(nextDuel)} are fighting now.`, href: watchDuel(nextDuel.duelId), label: "Watch the next duel", color: tang }
        : { title: `Duel #${duel} is over`, line: lists.loaded ? "No other duel is live right now. The Dojo lists the next one." : "Looking for the next duel…", href: island("dojo"), label: "Back to the Dojo", color: tang }
      : game === "predict"
        ? { title: `Round #${lobby} is over`, line: "The protocol round keeps running: follow it and the screen moves on by itself.", href: watchRound(), label: "Follow the protocol round", color: violet }
        : { title: `Lobby #${lobby} is over`, line: lists.current && lists.current !== lobby ? `Lobby #${lists.current} is the current one.` : "Follow the current lobby and the screen moves on by itself.", href: "/arena?mode=royale", label: "Go to the current lobby", color: coral };
  return (
    <section className={`${kit.panel} ${n.next}`} aria-label="What to watch next" style={{ ["--c" as string]: offer.color }}>
      <h2>{offer.title}</h2>
      <p>{offer.line}</p>
      <Link href={offer.href} className={kit.btn} style={{ ["--c" as string]: offer.color }}>
        {offer.label}
      </Link>
    </section>
  );
}
