"use client";
// The game switcher (CLAUDE.md "Navigation" rule 2), loaded lazily by bar.tsx. Links only, so it never takes focus or
// arrow keys on load. Segmented from 640 px (short labels below 1080 px), a menu button under 640 px (container width
// of the bar); CSS shows one. Accessible names are the game names exactly; "you're in" is a description.
import type { CSSProperties } from "react";
import { NAV_GAMES, navGame, watchGame, type GameId, type NavGame } from "@/lib/nav";
import Link from "./link";
import { usePopover } from "./popover";
import k from "./kit.module.css";
import n from "./nav.module.css";

const tint = (c: string) => ({ ["--c" as string]: c }) as CSSProperties;

export default function Switcher({ game, live, watch }: { game?: GameId; live?: readonly GameId[]; watch?: string | null }) {
  const big = watch === undefined ? (game ? watchGame(game) : null) : watch;
  const cur = game ? navGame(game) : null;
  const pop = usePopover();
  const entry = (g: NavGame, menu: boolean) => {
    const isLive = !!live?.includes(g.id) && g.id !== "island";
    return (
      <Link key={g.id} href={g.href} className={menu ? n.item : undefined} onClick={menu ? () => pop.setOpen(false) : undefined} aria-label={g.name} aria-current={g.id === game ? "page" : undefined} aria-describedby={isLive ? "nav-live" : undefined} style={tint(g.color)}>
        <i className={n.dot} aria-hidden="true" />
        {menu ? (
          g.name
        ) : (
          <>
            <span className={n.full}>{g.name}</span>
            <span className={n.short}>{g.short}</span>
          </>
        )}
        {isLive && (
          <span className={n.live} aria-hidden="true">
            {menu ? "you're in" : ""}
          </span>
        )}
      </Link>
    );
  };
  return (
    <nav className={k.nav} aria-label="Games">
      <div className={`${k.seg} ${n.switch}`}>{NAV_GAMES.map((g) => entry(g, false))}</div>
      {big && (
        <Link className={`${k.chip} ${n.bigLink}`} href={big} aria-label="Big screen">
          <ScreenIcon />
          <span className={n.full}>Big screen</span>
        </Link>
      )}
      <div className={n.compact} ref={pop.box}>
        <button ref={pop.btn} type="button" className={`${k.chip} ${n.compactBtn}`} aria-label={cur ? `Games: ${cur.name}` : "Games"} aria-expanded={pop.open} aria-haspopup="true" aria-controls="games-menu" onClick={() => pop.setOpen((o) => !o)}>
          {cur && <i className={n.dot} style={tint(cur.color)} aria-hidden="true" />}
          {cur ? cur.short : "Games"}
          <svg viewBox="0 0 10 6" aria-hidden="true" className={n.caret}>
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        {pop.open && (
          <div id="games-menu" className={n.menu} role="group" aria-label="Games">
            {NAV_GAMES.map((g) => entry(g, true))}
            {big && (
              <Link className={n.item} href={big} aria-label="Big screen" onClick={() => pop.setOpen(false)}>
                <ScreenIcon />
                Big screen
              </Link>
            )}
          </div>
        )}
      </div>
      {live?.length ? (
        <span id="nav-live" hidden>
          You are in a live game here
        </span>
      ) : null}
    </nav>
  );
}

function ScreenIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={k.icon}>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5.5 14h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
