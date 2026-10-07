import type { Match } from "@/lib/useMatch";
/** `pinned`: the URL pins this lobby (?lobby=), so it does not move on by itself (CLAUDE.md "Navigation" rule 8). */
export type ArenaProps = { match: Match; pinned?: boolean };
