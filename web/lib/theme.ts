// The product's one look: every colour, font, radius, stroke and shadow used on the island, /play and /arena.
// web/app/theme.css declares the same values as CSS custom properties on :root. Change one, change the other to match.
// Imports nothing, so canvas code, the island world and server components can all read it.

// Base tokens (CLAUDE.md "One look", "Tokens").
export const ink = "#2B1D52"; // text, every outline and border, hard shadows
export const ink2 = "#4A3D73"; // secondary text
export const muted = "#7A6F9B"; // captions
export const paper = "#FFFBF5"; // panels, cards, the phone background
export const glass = "rgba(255,251,245,.86)"; // chips over the scene
export const line = "rgba(43,29,82,.12)"; // hairlines inside a panel
export const coral = "#FF5E7E"; // Trading Royale
export const violet = "#8B5CFF"; // Price Prediction
export const tang = "#FF8A3D"; // Stickman Duel
export const mint = "#14C98E"; // Create a round
export const sun = "#FFC93C"; // highlights, the podium, confetti
export const skyTop = "#5B7CFA"; // the island's sky gradient, top
export const skyBottom = "#B3BEFF"; // the island's sky gradient, near the horizon
export const seaFoam = "#FFFFFF"; // the zone, and only the zone
export const seaShallow = "#86F7E6";
export const seaMid = "#2CC3E0";
export const seaDeep = "#3A6FE0";
/** Loss, danger, liquidated as text on paper: coral darkened to 4.87:1 on `paper` (coral itself is 2.85:1). */
export const coralText = "#D12B52";
/** A soft ink shade on the ground under a figure (the duel's floor shadow). */
export const shade = "rgba(43,29,82,.18)";
/** The white gloss strip along a filled bar. */
export const gloss = "rgba(255,255,255,.45)";

export const TOKENS = { ink, ink2, muted, paper, glass, line, coral, violet, tang, mint, sun, skyTop, skyBottom, seaFoam, seaShallow, seaMid, seaDeep, coralText, shade, gloss } as const;

/** Each game's colour: its panel heads and its primary button. */
export const GAME = { royale: coral, predict: violet, duel: tang, create: mint } as const;

/** Game meaning, fixed on every game screen. `fill` is the shape colour, `text` the colour of that meaning as text on paper. */
export const MEANING = {
  /** Royale flood, prediction band edges: the four sea tokens, used for nothing else on a game screen. */
  zone: { fill: [seaFoam, seaShallow, seaMid, seaDeep] as const, text: seaDeep },
  /** Ink on a mint chip. */
  long: { fill: mint, text: ink },
  /** Ink on a violet chip. */
  short: { fill: violet, text: ink },
  /** Ink on a sun chip; never yellow text on paper. */
  profit: { fill: sun, text: ink },
  /** Loss, danger, liquidated. */
  loss: { fill: coral, text: coralText },
} as const;

/** Colours the island already draws that are not base tokens (its world and podium). Shared so the arena's toon land
 *  and podium match it. */
export const ISLAND = {
  sky: "#4CC9F0", // the island's aqua accent (swatches, flowers)
  backdrop: "#A9B8FF", // behind the canvas before the scene draws
  grass: "#5FD36F",
  meadow: "#7BE28A",
  meadowDark: "#4CC765",
  sand: "#FFCF86",
  path: "#FFEBDA",
  pathEdge: "#F7BFA6",
  horizon: "#FFD1C1",
  white: "#FFFFFF", // cards and fields inside a panel
  silver: "#D8D2F5", // 2nd on a podium or leaderboard
  bronze: "#FFB38A", // 3rd
  lilac: "#EFE9FF", // nudge buttons
  wave: "#7FF5E4", // the brand mark's palm
} as const;

/** Shape. Borders and outlines are ink; shadows are hard offsets in ink, never soft grey. */
export const STROKE = { phone: 2, arena: 3 } as const;
export const RADIUS = { card: 16, panel: 24, round: 999 } as const;
export const SHADOW = { chip: `0 3px 0 ${ink}`, panel: `0 6px 0 ${ink}` } as const;

/** Font roles. The families are self-hosted (app/fonts.ts) and exposed on <html> as --font-display, --font-body and
 *  --font-mono; these stacks add the fallbacks. Use them in inline styles; canvas code calls `canvasFont`. */
export const FONT = {
  display: "var(--font-display), ui-rounded, system-ui, sans-serif",
  body: "var(--font-body), system-ui, -apple-system, \"Segoe UI\", sans-serif",
  mono: "var(--font-mono), ui-monospace, Menlo, monospace",
} as const;
const FALLBACK = { display: "Unbounded, ui-rounded, system-ui, sans-serif", body: "\"Instrument Sans\", system-ui, sans-serif", mono: "\"JetBrains Mono\", ui-monospace, Menlo, monospace" } as const;

/** A canvas `font` string for one role, e.g. canvasFont("display", 800, 54). Canvas cannot resolve CSS variables, so this
 *  reads the self-hosted family from <html> (falls back to the plain names outside a browser). */
export function canvasFont(role: keyof typeof FONT, weight: number, px: number): string {
  return `${weight} ${px}px ${fontFamily(role)}`;
}
const cache: Partial<Record<keyof typeof FONT, string>> = {};
export function fontFamily(role: keyof typeof FONT): string {
  if (cache[role]) return cache[role]!;
  if (typeof document === "undefined") return FALLBACK[role];
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--font-${role}`).trim();
  if (!v) return FALLBACK[role];
  return (cache[role] = `${v}, ${FALLBACK[role]}`);
}
