import type { Metadata } from "next";
import { Panel, PanelHead, TopBar } from "@/components/kit";
import { EndActions } from "@/components/kit/actions";
import { island } from "@/lib/nav";
import { paper } from "@/lib/theme";

export const metadata: Metadata = { title: "Page not found" };

// The 404 (N29): the app bar and the end-state action block, nothing else.
export default function NotFound() {
  return (
    <div style={{ minHeight: "100dvh", background: paper }}>
      <TopBar watch={null} />
      <main style={{ maxWidth: 460, margin: "0 auto", padding: "28px 16px 40px" }}>
        <Panel>
          <PanelHead color="var(--ink)" eyebrow="404" title="Nothing stands here" />
          <div style={{ padding: "18px 20px 22px" }}>
            <p style={{ margin: "0 0 18px", color: "var(--ink2)", font: "400 15px/1.5 var(--body)" }}>
              This address is not on the island. Pick a game, or head back to the plaza.
            </p>
            <EndActions game="island" primary={{ label: "Back to the island", href: island() }} />
          </div>
        </Panel>
      </main>
    </div>
  );
}
