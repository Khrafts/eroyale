import type { Metadata } from "next";

// /arena's page is a client component; its title lives here.
export const metadata: Metadata = { title: "Big screen" };

export default function ArenaLayout({ children }: { children: React.ReactNode }) {
  return children;
}
