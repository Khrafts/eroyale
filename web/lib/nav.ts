// The app's map: the games the switcher lists and one helper per route, so every link emits exactly the query
// parameters CLAUDE.md "Island" > "Routes" and "Navigation" rule 7 name. Imports nothing but theme.ts: /play and
// /arena read it without pulling the island store, places.ts or the dojo.
import { ISLAND, coral, mint, tang, violet } from "./theme";

export type GameId = "island" | "royale" | "predict" | "duel";
export type NavGame = { id: GameId; name: string; short: string; color: string; href: string; early?: boolean };
/** Games that are playable but still being polished show this label (and EARLY_NOTE on their main screens). */
export const EARLY = "Early access";
export const EARLY_NOTE = "Early access: playable, still being polished.";

/** The switcher's entries, in order. `href` is the game's own entry screen; `short` its label on mid-width bars. */
export const NAV_GAMES: readonly NavGame[] = [
  { id: "island", name: "Island", short: "Island", color: ISLAND.sky, href: "/" },
  { id: "royale", name: "Trading Royale", short: "Royale", color: coral, href: "/play" },
  { id: "predict", name: "Price Prediction", short: "Prediction", color: violet, href: "/play?mode=predict", early: true },
  { id: "duel", name: "Stickman Duel", short: "Duel", color: tang, href: "/duel", early: true },
];
/** "Create a round" is a place on the island (the fountain's fourth jet), not a game in the switcher. */
export const CREATE = { id: "create", name: "Create a round", short: "+", color: mint } as const;

export const navGame = (id: GameId): NavGame => NAV_GAMES.find((g) => g.id === id)!;

/** Island place ids the routes below can open (`/?place=`). */
export type Place = "arena" | "observatory" | "dojo" | "create" | "studio" | (string & {});

// ---- route helpers ----
/** `/` or `/?place=<id>` (an open panel, or the avatar studio). */
export const island = (place?: Place) => (place ? `/?place=${encodeURIComponent(place)}` : "/");
/** Royale on the phone: follows the current lobby, or pins `lobby`. */
export const playRoyale = (lobby?: number) => (lobby ? `/play?lobby=${lobby}` : "/play");
/** The prediction rounds list (the parent of every predict screen). */
export const predictRounds = () => "/play?mode=predict";
/** Predict in one round. */
export const playRound = (id: number) => `/play?mode=predict&lobby=${id}`;
export const createRound = () => "/play?mode=predict&screen=create";
/** The duel menu, or practice against the bot. */
export const duel = (mode?: "practice") => (mode ? `/duel?mode=${mode}` : "/duel");
/** Your lobbies and rounds, live and past. */
export const me = () => "/me";
/** The big screen on one royale lobby. */
export const watchLobby = (id: number) => `/arena?lobby=${id}`;
/** The big screen on one prediction round, or following the protocol round. */
export const watchRound = (id?: number) => (id ? `/arena?lobby=${id}` : "/arena?mode=predict");
export const watchDuel = (id: number) => `/arena?duel=${id}`;
/** The big screen for a game when no lobby, round or duel is pinned (null: nothing to watch without an id). */
export const watchGame = (id: GameId): string | null =>
  id === "royale" ? "/arena?mode=royale" : id === "predict" ? watchRound() : id === "duel" ? null : "/arena";

/** Each game's island panel: the parent of its screens (CLAUDE.md "Navigation" > "Hierarchy"). */
export const PANEL: Record<Exclude<GameId, "island">, Place> = { royale: "arena", predict: "observatory", duel: "dojo" };

/** `<screen> · <game> · Royale Isle` (rule 11). Omit `screen` for a game's main screen. */
export const docTitle = (game: GameId | null, screen?: string) =>
  [screen, game && game !== "island" ? navGame(game).name : null, "Royale Isle"].filter(Boolean).join(" · ");
