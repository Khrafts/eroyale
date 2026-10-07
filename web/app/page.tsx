import type { Metadata, Viewport } from "next";
import IslandRoot from "@/components/island/IslandRoot";
import { ISLAND } from "@/lib/theme";

// The island is the front door; /island is an alias, ?view=list opens the list view.
export const metadata: Metadata = { title: "Royale Isle", description: "Every game on one island. Trade, predict, win, dance." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: ISLAND.backdrop };

export default function Home() {
  return <IslandRoot />;
}
