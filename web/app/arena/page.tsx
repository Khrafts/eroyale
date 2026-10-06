"use client";
import { useEffect, useState } from "react";
import { useMatch } from "@/lib/useMatch";
import VariantA from "@/components/arena/VariantA";
import VariantB from "@/components/arena/VariantB";
import VariantC from "@/components/arena/VariantC";

const VARIANTS = { a: VariantA, b: VariantB, c: VariantC } as const;

export default function ArenaPage() {
  const match = useMatch();
  const [v, setV] = useState<keyof typeof VARIANTS>("a");
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("v");
    if (p === "a" || p === "b" || p === "c") setV(p);
  }, []);
  const Variant = VARIANTS[v];
  return <Variant match={match} />;
}
