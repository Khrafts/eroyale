import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Trading Royale", description: "Trade live prices. Survive the cut." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#000000" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
