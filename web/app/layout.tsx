import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./theme.css";
import { body, display, islandMono, mono } from "./fonts";

// Base title; each route sets its own "<game>" (rendered "<game> · Royale Isle"), screens set document.title with
// lib/nav.ts docTitle() as "<screen> · <game> · Royale Isle".
export const metadata: Metadata = { title: { default: "Royale Isle", template: "%s · Royale Isle" }, description: "Trade live prices. Survive the cut." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#000000" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable} ${islandMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
