"use client";
// Bottom-left feed: the three newest lines, each fading after nine seconds.
import { useEffect, useState } from "react";
import { onBus, type FeedItem } from "@/lib/island/store";

const COLORS: Record<FeedItem["kind"], string> = { win: "#FFC93C", live: "#FF5E7E", cut: "#FF5E7E", lock: "#8B5CFF", promo: "#14C98E", final: "#8B5CFF" };
const TAGS: Record<FeedItem["kind"], string> = { win: "Payout", live: "The Arena", cut: "Checkpoint", lock: "The Observatory", promo: "Billboard", final: "Result" };

export function Feed() {
  const [items, setItems] = useState<(FeedItem & { fade: boolean })[]>([]);
  useEffect(
    () =>
      onBus((e) => {
        if (e.kind !== "feed") return;
        const it = { ...e.item, fade: false };
        setItems((xs) => [it, ...xs].slice(0, 3));
        setTimeout(() => setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, fade: true } : x))), 9000);
        setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== it.id)), 9700);
      }),
    [],
  );
  return (
    <div className="feed" aria-live="polite">
      {items.map((it) => (
        <div key={it.id} className={`fi${it.fade ? " fade" : ""}`} style={{ ["--c" as string]: COLORS[it.kind] }}>
          <i />
          <div>
            <small>{TAGS[it.kind]}</small>
            {it.bold && <b>{it.bold}</b>}
            {it.text}
          </div>
        </div>
      ))}
    </div>
  );
}
