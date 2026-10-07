import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./theme.css";
import { body, display, islandMono, mono } from "./fonts";

export const metadata: Metadata = { title: "Trading Royale", description: "Trade live prices. Survive the cut." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#000000" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable} ${islandMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
