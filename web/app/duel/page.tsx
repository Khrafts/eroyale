import type { Metadata, Viewport } from "next";
import Duel from "@/components/duel/Duel";
import { paper } from "@/lib/theme";

export const metadata: Metadata = { title: "Stickman Duel", description: "One-on-one stickman fights in the dojo. Practice free, or fight for 5 USDC." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false, viewportFit: "cover", themeColor: paper };

export default function DuelPage() {
  return <Duel />;
}
