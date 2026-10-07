import localFont from "next/font/local";

// The three families of the one look, self-hosted (latin) so no page waits on Google; sources and licences in
// app/fonts/SOURCES.txt. Each face keeps its real family name (declarations), so canvas code and document.fonts.check
// can name it. layout.tsx puts the three variables on <html>; theme.css and lib/theme.ts read them.
//
// The faces mirror what the island loaded from Google Fonts before, so it renders exactly as it did: Unbounded and
// Instrument Sans are one variable file declared at the weights the island used (a request for another weight snaps
// to the nearest, as before), and JetBrains Mono is Google's static 500 file for every weight up to 500 (as before)
// plus the variable file for 600 to 800 (the game screens' hero figures). The island drew its few 600/700 figures as
// synthetic bold of the 500 file; `islandMono` (the 500 file alone, under its own family) keeps them that way.
// next/font needs literal arguments, hence the repeated paths.
export const display = localFont({
  src: [
    { path: "./fonts/Unbounded-latin-wght.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Unbounded-latin-wght.woff2", weight: "700", style: "normal" },
    { path: "./fonts/Unbounded-latin-wght.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-display",
  declarations: [{ prop: "font-family", value: '"Unbounded"' }],
  display: "swap",
  fallback: ["ui-rounded", "system-ui", "sans-serif"],
});
export const body = localFont({
  src: [
    { path: "./fonts/InstrumentSans-latin-wght.woff2", weight: "400", style: "normal" },
    { path: "./fonts/InstrumentSans-latin-wght.woff2", weight: "500", style: "normal" },
    { path: "./fonts/InstrumentSans-latin-wght.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-body",
  declarations: [{ prop: "font-family", value: '"Instrument Sans"' }],
  display: "swap",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
});
export const mono = localFont({
  src: [
    { path: "./fonts/JetBrainsMono-latin-500.woff2", weight: "100 500", style: "normal" },
    { path: "./fonts/JetBrainsMono-latin-wght.woff2", weight: "600 800", style: "normal" },
  ],
  variable: "--font-mono",
  declarations: [{ prop: "font-family", value: '"JetBrains Mono"' }],
  display: "swap",
  fallback: ["ui-monospace", "Menlo", "monospace"],
});
/** The island's figures: Google's static 500 file only, so 600/700 stay synthetic bold as they always were. */
export const islandMono = localFont({
  src: [{ path: "./fonts/JetBrainsMono-latin-500.woff2", weight: "500", style: "normal" }],
  variable: "--font-mono-island",
  declarations: [{ prop: "font-family", value: '"JetBrains Mono Island"' }],
  display: "swap",
  preload: false,
  fallback: ["ui-monospace", "Menlo", "monospace"],
});
