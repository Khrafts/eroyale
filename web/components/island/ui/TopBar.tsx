"use client";
// Top bar: brand, your avatar, players and today's payouts (GET /stats), the island/list switch, your burner address.
import { useIsland } from "@/lib/island/store";
import { short, usdc } from "@/lib/island/format";
import type { IslandApi } from "./Island";
import { ISLAND, ink, paper, sun } from "@/lib/theme";

export function TopBar({ api, list }: { api: IslandApi; list: boolean }) {
  const stats = useIsland((s) => s.stats);
  const statsState = useIsland((s) => s.statsState);
  const avatar = useIsland((s) => s.avatar);
  const me = useIsland((s) => s.me);
  // a CHAIN=off engine settles offline: nothing it reports was paid on chain
  const offline = useIsland((s) => s.health?.chain === false);
  const noStats = statsState === "missing" ? "Stats not served yet" : statsState === "down" ? "Stats unavailable" : null;
  return (
    <header className="top">
      <div className="chip brand">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="15" fill={ink} />
          <path d="M7 23h18" stroke={paper} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M16 22V13M16 13c-3-4-6.5-3-7.5 1.5M16 13c3-4 6.5-3 7.5 1.5" stroke={ISLAND.wave} strokeWidth="2.2" fill="none" strokeLinecap="round" />
          <circle cx="16" cy="8" r="2.6" fill={sun} stroke={paper} strokeWidth="1" />
        </svg>
        <span className="word">Royale Isle</span>
      </div>
      <button className="chip me-btn" aria-label="My avatar" onClick={() => api.select("me")}>
        <span className="me-dot" style={{ background: avatar.shirt, ["--h" as string]: avatar.hatColor }} />
        <span className="hide-xs">My avatar</span>
      </button>
      {noStats ? (
        <div className="chip hide-sm">{noStats}</div>
      ) : (
        <>
          <div className="chip hide-sm">
            <span className="live-dot" />
            <b>{stats ? stats.playing.toLocaleString("en-US") : "–"}</b> playing
          </div>
          <div className="chip hide-sm">
            {offline ? "Settled offline today" : "Paid out today"} <b>{stats ? usdc(stats.paidTodayUnits) : "–"}</b>
          </div>
        </>
      )}
      <div className="right">
        <div className="seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected={!list} onClick={() => api.setList(false)}>
            Island
          </button>
          <button role="tab" aria-selected={list} onClick={() => api.setList(true)}>
            List
          </button>
        </div>
        {me && (
          <div className="chip hide-sm wallet" title={me}>
            {short(me)}
          </div>
        )}
      </div>
    </header>
  );
}
