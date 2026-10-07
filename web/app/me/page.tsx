import type { Metadata } from "next";
import { paper } from "@/lib/theme";
import AutoTopBar from "@/components/kit/auto-bar";
import Activity from "@/components/me/Activity";

export const metadata: Metadata = { title: "My activity" };

// Your lobbies and rounds, live and past, with links back into each (lib/activity.ts).
export default function MePage() {
  return (
    <div style={{ minHeight: "100dvh", background: paper }}>
      <AutoTopBar back={{ to: "Island", href: "/" }} watch={null} />
      <Activity />
    </div>
  );
}
