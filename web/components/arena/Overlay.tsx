"use client";
// The /arena overlay (CLAUDE.md "Navigation" rule 6): hidden by default so the canvas stays full-bleed and every
// screenshot taken without input is clean. A pointer move, a tap or any key shows it; 3 s without input hides it;
// Escape toggles it; ?kiosk=1 turns it off. `ended` (a pinned lobby, round or duel that is over, after its end hold,
// rule 8) shows it and keeps it up with the move-on offer. This shell is in /arena's first load; the bar and the
// picker (nav.tsx) load lazily on the first input (prefetched once the page is idle).
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { ArenaNavProps } from "./nav";

const load = () => import("./nav");
const ArenaNav = lazy(load);
const IDLE_MS = 3000;

export default function Overlay(props: ArenaNavProps) {
  const [kiosk, setKiosk] = useState(true);
  const [shown, setShown] = useState(false);
  const [ever, setEver] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ended = !!props.ended;
  const endedRef = useRef(ended);
  endedRef.current = ended;

  useEffect(() => {
    if (new URLSearchParams(location.search).get("kiosk") === "1") return;
    setKiosk(false);
    const idle = (window as Window & { requestIdleCallback?: (f: () => void) => number }).requestIdleCallback;
    const pre = setTimeout(() => (idle ? idle(() => void load()) : void load()), 1500);
    const hideLater = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        // keep it up while a menu is open or focus is inside it, and while the move-on offer is showing
        const box = document.getElementById("arena-nav");
        if (endedRef.current || box?.querySelector('[aria-expanded="true"]') || box?.contains(document.activeElement)) return hideLater();
        setShown(false);
      }, IDLE_MS);
    };
    const show = () => {
      setEver(true);
      setShown(true);
      hideLater();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        setEver(true);
        setShown((s) => {
          if (s && !endedRef.current) {
            clearTimeout(timer.current);
            const box = document.getElementById("arena-nav");
            if (box?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
            return false;
          }
          hideLater();
          return true;
        });
        return;
      }
      show();
    };
    addEventListener("keydown", key);
    addEventListener("pointermove", show, { passive: true });
    addEventListener("pointerdown", show, { passive: true });
    return () => {
      clearTimeout(pre);
      clearTimeout(timer.current);
      removeEventListener("keydown", key);
      removeEventListener("pointermove", show);
      removeEventListener("pointerdown", show);
    };
  }, []);

  useEffect(() => {
    if (kiosk || !ended) return;
    setEver(true);
    setShown(true);
  }, [ended, kiosk]);

  if (kiosk || !ever) return null;
  const visible = shown || ended;
  return (
    <div
      id="arena-nav"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        pointerEvents: "none",
        opacity: visible ? 1 : 0,
        visibility: visible ? "visible" : "hidden",
        transition: visible ? "opacity .18s ease-out" : "opacity .35s ease-in, visibility 0s linear .35s",
      }}
    >
      <Suspense fallback={null}>
        <ArenaNav {...props} />
      </Suspense>
    </div>
  );
}
