import localFont from "next/font/local";

// Survey-map lettering: condensed for names and notes, extra condensed for every figure.
// Self-hosted variable fonts (latin, weight axis 1..1000) so the build never waits on Google; see app/fonts/SOURCES.txt.
export const condensed = localFont({
  src: [{ path: "../../../app/fonts/SofiaSansCondensed-latin-wght.woff2", weight: "1 1000", style: "normal" }],
  display: "swap",
  fallback: ["Arial Narrow", "Helvetica Neue", "Arial", "sans-serif"],
});
export const extra = localFont({
  src: [{ path: "../../../app/fonts/SofiaSansExtraCondensed-latin-wght.woff2", weight: "1 1000", style: "normal" }],
  display: "swap",
  fallback: ["Arial Narrow", "Helvetica Neue", "Arial", "sans-serif"],
});
