"use client";
// The /arena overlay's content, loaded lazily by Overlay.tsx: the kit app bar as a floating chip cluster (brand,
// game switcher) plus a picker of what to watch (GET /lobbies, GET /rounds), and, when a pinned lobby, round or duel
// is over, the offer to move on (CLAUDE.md "Navigation" rules 6 and 8). Duels are not listed while ranked is "Coming
// soon" (CLAUDE.md "Duel tuning"); a pinned ?duel= still renders.
import { useEffect, useState, type CSSProperties } from "react";
import { TopBar, kit } from "@/components/kit";
// the switcher: load its chunk with this one (prefetched while idle) so the Games menu
// is there on the first keypress instead of one more round trip later
import "@/components/kit/switcher";
import Link from "@/components/kit/link";
import { usePopover } from "@/components/kit/popover";
import { engineHttp } from "@/lib/engineUrl";
import { island, playRoyale, watchLobby, watchRound } from "@/lib/nav";
import { coral, tang, violet } from "@/lib/theme";
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
type Lists = { lobbies: Lobby[]; current: number | null; rounds: Round[]; loaded: boolean };
const EMPTY: Lists = { lobbies: [], current: null, rounds: [], loaded: false };
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
        const [l, r] = await Promise.all([get("/lobbies"), get("/rounds")]);
        if (stop) return;
        const lb = (l ?? {}) as { current?: number | null; lobbies?: Lobby[] };
        const rb = (r ?? {}) as { rounds?: Round[] };
        setLists({
          current: lb.current ?? null,
          // the royale lobbies (rounds are listed below with their market); open and running ones only
          lobbies: (lb.lobbies ?? []).filter((x) => !DONE.has(x.status) && !(rb.rounds ?? []).some((y) => y.lobbyId === x.lobbyId)),
          rounds: rb.rounds ?? [],
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

/** Where the bar goes. The canvas is the 1920 by 1080 design scaled to fit the window (VariantB), so the bar is placed
 *  and scaled in canvas coordinates: a solid panel over the HUD's top-left strip (x 16 to 496, y 12 to 106 or 120 in a
 *  duel: the title chip, or the left fighter's name) and nothing else at any window size, so it never reaches the
 *  centre panel ("Final", the countdown, the settled price). On a big screen (90% of 1920 or more) it shows the segmented switcher scaled
 *  into that strip; smaller, the compact switcher (a "Games" menu), no smaller than 0.66 and at least 300 px wide before scaling so its chips fit. A portrait phone has empty space above the canvas: the bar sits
 *  there at natural size instead. */
const DW = 1920;
const DH = 1080;
const STRIP_W = 480;
function useFit(strip: number): { wide: boolean; style: CSSProperties } {
  const [size, setSize] = useState<[number, number]>([DW, DH]);
  useEffect(() => {
    const r = () => setSize([innerWidth, innerHeight]);
    r();
    addEventListener("resize", r);
    return () => removeEventListener("resize", r);
  }, []);
  const [w, h] = size;
  const s = Math.min(w / DW, h / DH);
  const ox = (w - DW * s) / 2;
  const oy = (h - DH * s) / 2;
  if (oy >= 84) return { wide: w >= 700, style: { left: 8, top: 8, width: Math.min(w - 16, 656), ["--mh" as string]: "0px" } };
  // a big screen: the segmented switcher (the kit shows it from 640 px of bar content; 660 leaves room for the padding and border), scaled down to fit the same strip
  if (s >= 0.9) {
    const kb = (STRIP_W * s) / 660;
    return { wide: true, style: { left: ox + 16 * s, top: oy + 12 * s, width: 660, transform: `scale(${kb})`, ["--mh" as string]: `${(strip * s) / kb}px` } };
  }
  const k = Math.max(s, 0.66);
  return { wide: false, style: { left: ox + 16 * s, top: oy + 12 * s, width: Math.max(300, (STRIP_W * s) / k), transform: `scale(${k})`, ["--mh" as string]: `${(strip * s) / k}px` } };
}

export default function ArenaNav({ game, lobby, duel, ended, mock }: ArenaNavProps) {
  const lists = useLists(!mock && hasEngine());
  const fit = useFit(game === "duel" ? 108 : 94);
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
  ];
  return (
    <>
      <div className={fit.wide ? n.fit : `${n.fit} ${n.compact}`} style={fit.style}>
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
      </div>
      {ended && <Next game={game} lobby={lobby} duel={duel} lists={lists} />}
    </>
  );
}

/** The move-on offer for a pinned screen whose lobby, round or duel is over (rule 8): never a surprise, one press. */
function Next({ game, lobby, duel, lists }: { game: ArenaGame; lobby: number | null; duel: number | null; lists: Lists }) {
  const cur = lists.current && lists.current !== lobby ? lists.current : null;
  const offer: { title: string; line: string; href: string; label: string; color: string; watch?: { href: string; label: string } } =
    game === "duel"
      ? { title: `Duel #${duel} is over`, line: "Practice against the dojo bot while ranked duels are coming soon.", href: island("dojo"), label: "Back to the Dojo", color: tang }
      : game === "predict"
        ? { title: `Round #${lobby} is over`, line: "The protocol round keeps running: follow it and the screen moves on by itself.", href: watchRound(), label: "Follow the protocol round", color: violet }
        : {
            title: `Lobby #${lobby} is over`,
            line: cur ? `Lobby #${cur} is the current one.` : "Join the current lobby on your phone, or follow it here.",
            href: playRoyale(cur ?? undefined),
            label: "Join the current lobby",
            color: coral,
            watch: { href: cur ? watchLobby(cur) : "/arena?mode=royale", label: "Watch the current lobby" },
          };
  return (
    <section className={`${kit.panel} ${n.next}`} aria-label="What to watch next" style={{ ["--c" as string]: offer.color }}>
      <h2>{offer.title}</h2>
      <p>{offer.line}</p>
      <Link href={offer.href} className={kit.btn} style={{ ["--c" as string]: offer.color }}>
        {offer.label}
      </Link>
      {offer.watch && (
        <Link href={offer.watch.href} className={kit.ghost}>
          {offer.watch.label}
        </Link>
      )}
    </section>
  );
}
