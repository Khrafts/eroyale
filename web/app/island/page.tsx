import type { Metadata, Viewport } from "next";
import IslandRoot from "@/components/island/IslandRoot";

export const metadata: Metadata = { title: "Royale Isle", description: "Every game on one island. Trade, predict, win, dance." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#A9B8FF" };

export default function IslandPage() {
  return <IslandRoot />;
}
