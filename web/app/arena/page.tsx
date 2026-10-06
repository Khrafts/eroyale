"use client";
import { useMatch } from "@/lib/useMatch";
import Storm from "@/components/arena/VariantB";

export default function ArenaPage() {
  const match = useMatch();
  return <Storm match={match} />;
}
