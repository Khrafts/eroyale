"use client";
// The app bar for a page that has no burner of its own (the 404): the you chip's address comes from burner() in
// lib/engine.ts, imported after mount so viem stays out of the page's first-load JS. Same props as TopBar otherwise.
import { useEffect, useState, type ComponentProps } from "react";
import { CALLSIGN_KEY } from "@/lib/island/avatar";
import { TopBar } from "./bar";

export default function AutoTopBar(props: Omit<ComponentProps<typeof TopBar>, "wallet" | "callsign">) {
  const [me, setMe] = useState<{ wallet: string; callsign: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void import("@/lib/engine").then(({ burner }) => {
      let callsign: string | null = null;
      try {
        callsign = localStorage.getItem(CALLSIGN_KEY);
      } catch {
        /* storage blocked */
      }
      if (live) setMe({ wallet: burner().address, callsign });
    });
    return () => {
      live = false;
    };
  }, []);
  return <TopBar {...props} wallet={me?.wallet} callsign={me?.callsign} />;
}
