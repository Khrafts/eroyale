// The one door to the duel rules for web/: everything under components/duel/ imports from here.
// Points at a temporary stub until shared/duel.ts lands in feat/duel, then re-exports ../../../shared/duel.
export * from "./stub";
export type { Bits, DuelState, Fighter } from "./stub";
