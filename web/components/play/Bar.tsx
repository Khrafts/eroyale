"use client";
// The phone's page shell (CLAUDE.md "Navigation" rules 1 to 4, N23): the kit app bar full width along the top, the
// phone column centred under it, and the screen's document.title. Both modes of /play use it.
import { useEffect, useState, type ReactNode } from "react";
import { TopBar, type Back } from "@/components/kit";
import { burner } from "@/lib/engine";
import type { GameId } from "@/lib/nav";
import { AvatarHead, useMyAvatar } from "./Avatar";
import s from "./play.module.css";

const CALLSIGN = "royale.callsign";

/** The app bar with the you chip from this browser's burner key, its callsign and its avatar. */
function PlayBar({ game, back, live, watch }: { game: GameId; back?: Back; live?: readonly GameId[]; watch?: string | null }) {
  const [wallet, setWallet] = useState<string | null>(null);
  const [callsign, setCallsign] = useState<string | null>(null);
  useEffect(() => {
    setWallet(burner().address);
    try {
      setCallsign(localStorage.getItem(CALLSIGN));
    } catch {
      /* storage blocked */
    }
  }, []);
  const cfg = useMyAvatar(wallet?.toLowerCase() ?? null, callsign ?? "");
  return (
    <TopBar
      game={game}
      back={back}
      live={live}
      watch={watch}
      wallet={wallet}
      callsign={callsign}
      avatar={cfg ? <AvatarHead cfg={cfg} size={28} /> : undefined}
      className={s.bar}
    />
  );
}

/** The page: app bar over the phone column. `title` is the whole document.title (from docTitle). */
export function Shell({ game, back, live, watch, title, children }: { game: GameId; back?: Back; live?: readonly GameId[]; watch?: string | null; title?: string; children?: ReactNode }) {
  // Next streams the route's metadata <title> in after hydration and on every soft navigation, replacing the element:
  // keep the screen's title over it.
  useEffect(() => {
    if (!title) return;
    const path = location.pathname;
    const keep = () => {
      // Leaving /play: the next route's title is its own.
      if (location.pathname !== path) return mo.disconnect();
      if (document.title !== title) document.title = title;
    };
    const mo = new MutationObserver(keep);
    keep();
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [title]);
  return (
    <div className={s.shell}>
      <PlayBar game={game} back={back} live={live} watch={watch} />
      <main className={s.root}>{children}</main>
    </div>
  );
}

/** Before the URL is read (server render): the same shell, empty. */
export function EmptyShell() {
  return (
    <div className={s.shell}>
      <main className={s.root} />
    </div>
  );
}
