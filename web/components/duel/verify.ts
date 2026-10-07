"use client";
// After `dfinal`: fetch the duel book, replay its inputs in this browser with the same rules, and compare with the
// engine's winner and book hash. Shown on the phone result and the big screen.
import { useEffect, useState } from "react";
import { keccak256, stringToBytes } from "viem";
import { replay } from "./sim";
import { getDuelFinal } from "./net";
import type { DuelPlayer } from "./types";

export type Verify = { hash: string; ticks: number; matches: boolean; bookHashOk: boolean } | null;
/** After `dfinal`: fetch the book, replay its inputs here and compare with the engine's winner and book hash. */
export function useVerify(duelId: number, final: { winner: string | null; bookHash: string } | null, players: DuelPlayer[]): Verify {
  const [v, setV] = useState<Verify>(null);
  useEffect(() => {
    if (!final) return;
    let stop = false;
    void getDuelFinal(duelId).then((body) => {
      if (stop || !body) return;
      try {
        const book = JSON.parse(body) as { inputs: [string, string]; ticks: number; players: (string | DuelPlayer)[] };
        const r = replay(book.inputs[0], book.inputs[1]);
        const addr = (p: string | DuelPlayer | undefined) => (typeof p === "string" ? p : p?.player ?? "").toLowerCase();
        const w = r.winner === null ? null : addr(book.players[r.winner]) || addr(players[r.winner]);
        setV({ hash: r.hash, ticks: r.ticks, matches: r.ticks === book.ticks && (w ?? null) === (final.winner?.toLowerCase() ?? null), bookHashOk: keccak256(stringToBytes(body)) === final.bookHash.toLowerCase() });
      } catch {
        /* not a duel book */
      }
    });
    return () => {
      stop = true;
    };
  }, [duelId, final, players]);
  return v;
}

