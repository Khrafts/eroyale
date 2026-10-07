"use client";
// The island's app bar (CLAUDE.md "Navigation" rules 1 to 3): the kit's brand mark, game switcher and you chip, in the
// island's chips, plus players and today's payouts (GET /stats) and the Island/List toggle. The switcher and the you
// chip are the kit's own components (lazy, as in components/kit/bar.tsx).
import { Suspense, lazy } from "react";
import { useIsland } from "@/lib/island/store";
import { short, usdc } from "@/lib/island/format";
import { BrandMark } from "@/components/kit";
import type { IslandApi } from "./Island";

const Switcher = lazy(() => import("@/components/kit/switcher"));
const YouChip = lazy(() => import("@/components/kit/you"));

export function TopBar({ api, list }: { api: IslandApi; list: boolean }) {
  const stats = useIsland((s) => s.stats);
  const statsState = useIsland((s) => s.statsState);
  const avatar = useIsland((s) => s.avatar);
  const me = useIsland((s) => s.me);
  // a CHAIN=off engine settles offline: nothing it reports was paid on chain
  const offline = useIsland((s) => s.health?.chain === false);
  const noStats = statsState === "missing" ? "Stats not served yet" : statsState === "down" ? "Stats unavailable" : null;
  const head = <span className="me-dot" style={{ background: avatar.shirt, ["--h" as string]: avatar.hatColor }} />;
  return (
    <header className="top" role="banner">
      {/* already on the island: the brand closes the panel and resets the view instead of reloading */}
      <a
        className="chip brand"
        href="/"
        aria-label="Royale Isle, back to the island"
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          api.home();
        }}
      >
        <BrandMark />
        <span className="word">Royale Isle</span>
      </a>
      <Suspense fallback={<span className="nav-slot" />}>
        <Switcher game="island" />
      </Suspense>
      {noStats ? (
        <div className="chip hide-sm">{noStats}</div>
      ) : (
        <>
          <div className="chip hide-md">
            <span className="live-dot" />
            <b>{stats ? stats.playing.toLocaleString("en-US") : "–"}</b> playing
          </div>
          <div className="chip hide-md">
            {offline ? "Settled offline today" : "Paid out today"} <b>{stats ? usdc(stats.paidTodayUnits) : "–"}</b>
          </div>
        </>
      )}
      <div className="right">
        <div className="seg" role="group" aria-label="View">
          <button type="button" aria-pressed={!list} onClick={() => api.setList(false)}>
            Island
          </button>
          <button type="button" aria-pressed={list} onClick={() => api.setList(true)}>
            List
          </button>
        </div>
        {me && (
          <Suspense
            fallback={
              <div className="chip hide-sm wallet" title={me}>
                {short(me)}
              </div>
            }
          >
            <span className="you-slot">
              <YouChip wallet={me} callsign={avatar.name !== "you" ? avatar.name : null} avatar={head} />
            </span>
          </Suspense>
        )}
      </div>
    </header>
  );
}
