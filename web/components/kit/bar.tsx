"use client";
// The app bar (CLAUDE.md "Navigation" rules 1 to 4): back control, brand chip, game switcher, screen chips, you chip.
// The switcher and the you chip's menu load lazily (React.lazy), so /play and /arena first-load JS only carries this
// shell; the server render includes them where the page is server-rendered. Documented in web/NOTES.md "Navigation".
import { Suspense, lazy, type ReactNode } from "react";
import type { GameId } from "@/lib/nav";
import { ISLAND, ink, paper, sun } from "@/lib/theme";
import Link from "./link";
import k from "./kit.module.css";

const Switcher = lazy(() => import("./switcher"));
const YouChip = lazy(() => import("./you"));
const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** The back control: "Back to <to>". A link with `href` (an onClick may intercept it, e.g. useUrlState().back), a
 *  button with only `onClick`. */
export type Back = { to: string; href?: string; onClick?: () => void };

/** The app bar. Every prop is optional, so a bare <TopBar /> is the brand and the switcher.
 *  - `back`: the back control.
 *  - `game`: the game this screen belongs to; the switcher marks it (aria-current="page").
 *  - `live`: games you are live in; the switcher marks them "you're in".
 *  - `watch`: the "Big screen" href (default `watchGame(game)` from lib/nav.ts; null hides it).
 *  - `wallet`, `callsign`, `avatar`: the you chip (hidden without a wallet); `avatar` is a small head node.
 *  - `children`: screen chips after the switcher. */
export function TopBar({ back, game, live, watch, wallet, callsign, avatar, children, className }: { back?: Back; game?: GameId; live?: readonly GameId[]; watch?: string | null; wallet?: string | null; callsign?: string | null; avatar?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={className ? `${k.top} ${className}` : k.top} role="banner">
      {back &&
        (back.href ? (
          <Link className={`${k.chip} ${k.back}`} href={back.href} onClick={back.onClick} aria-label={`Back to ${back.to}`}>
            <BackIcon />
          </Link>
        ) : (
          <button type="button" className={`${k.chip} ${k.back}`} onClick={back.onClick} aria-label={`Back to ${back.to}`}>
            <BackIcon />
          </button>
        ))}
      <Link className={`${k.chip} ${k.brand}`} href="/" aria-label="Royale Isle, back to the island">
        <BrandMark />
        <span className={k.word}>Royale Isle</span>
      </Link>
      <Suspense fallback={<span className={k.nav} />}>
        <Switcher game={game} live={live} watch={watch} />
      </Suspense>
      {children}
      {wallet && (
        <span className={k.right}>
          <Suspense
            fallback={
              <span className={`${k.chip} ${k.wallet}`} title={wallet}>
                {shortAddr(wallet)}
              </span>
            }
          >
            <YouChip wallet={wallet} callsign={callsign} avatar={avatar} />
          </Suspense>
        </span>
      )}
    </header>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={k.icon}>
      <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The island's brand mark. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className ? `${k.mark} ${className}` : k.mark}>
      <circle cx="16" cy="16" r="15" fill={ink} />
      <path d="M7 23h18" stroke={paper} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M16 22V13M16 13c-3-4-6.5-3-7.5 1.5M16 13c3-4 6.5-3 7.5 1.5" stroke={ISLAND.wave} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <circle cx="16" cy="8" r="2.6" fill={sun} stroke={paper} strokeWidth="1" />
    </svg>
  );
}
