"use client";
// document.title per screen (CLAUDE.md "Navigation" rule 11). Next writes the route's metadata title into <head> after
// hydration, which can land after a screen's effect; so the title is set, then held against later rewrites of <title>
// while the screen is up.
import { useEffect } from "react";

export function useDocTitle(title: string | null) {
  useEffect(() => {
    if (!title) return;
    const set = () => {
      if (document.title !== title) document.title = title;
    };
    set();
    const mo = new MutationObserver(set);
    mo.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => mo.disconnect();
  }, [title]);
}
