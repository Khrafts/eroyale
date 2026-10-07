"use client";
// /arena follows the engine's royale lobby, or the protocol prediction round with ?mode=predict (or ?mock=predict).
// With neither ?lobby= nor a mode, it falls back to prediction mode when the engine runs no royale lobby
// (GET /lobbies reports current: null twice in a row, 3 s apart, as with --predict-only). Once in prediction mode it
// stays there; a royale arena keeps checking every 10 s.
import { useEffect, useState } from "react";
import { useMatch } from "@/lib/useMatch";
import { engineHttp } from "@/lib/engineUrl";
import Storm from "@/components/arena/VariantB";

export default function ArenaPage() {
  const [predict, setPredict] = useState<boolean | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("mock") || q.get("lobby") || q.get("mode") || !process.env.NEXT_PUBLIC_ENGINE_WS) {
      setPredict(q.get("mode") === "predict" || q.get("mock") === "predict");
      return;
    }
    let stop = false;
    let nulls = 0;
    const check = async () => {
      try {
        const r = await fetch(`${engineHttp()}/lobbies`, { cache: "no-store" });
        const { current } = (await r.json()) as { current: number | null };
        nulls = current === null ? nulls + 1 : 0;
        if (stop) return;
        if (nulls >= 2) setPredict(true);
        else if (nulls === 1) setTimeout(() => void (!stop && check()), 3000);
        else setPredict((was) => was ?? false);
      } catch {
        if (!stop) setPredict((was) => was ?? false);
      }
    };
    void check();
    const id = setInterval(() => {
      if (!stop) void check();
    }, 10000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
  if (predict === null) return <main style={{ position: "fixed", inset: 0, background: "var(--sky-top)" }} />;
  return <Arena predict={predict} />;
}

function Arena({ predict }: { predict: boolean }) {
  const match = useMatch({ predict });
  return <Storm match={match} />;
}
