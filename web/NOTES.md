## Status
- Step: done. Storm arena + phone verified live against the engine (CHAIN=anvil, 19 bots, stage): signed join and order accepted, reload kept the position, final podium and settled stamp shown.
- Last gate: `bash gates/ui.sh` -> GATE PASS ui; all eight shots reviewed.
- Next: point NEXT_PUBLIC_ENGINE_WS at the deployed engine and rebuild.
- Blockers: none. Shots use installed Chrome because Playwright 1.63's Chromium is not downloaded.
- Known: in the final view the flood holds at the last zone line, so finalists below it are drawn under water (still labelled and paid).

## Running

Install once: `cd web && npm install`.

Against the mock (no engine needed):
- `npm run dev`, then open `http://localhost:3000/arena?mock=1` (big screen, 1920x1080) and `/play?mock=1` (phone).
- `&at=` jumps to a moment: `lobby`, `countdown`, `warning`, `checkpoint`, `live`, `liquidation`, `danger`, `eliminated`, `final`, `settled`, or a number of match seconds.
- `&speed=` sets playback speed (`0` freezes, which is how screenshots are taken). `&loop=1` repeats the match.
- `&me=` picks the phone's player: an address, or `me` (KESTREL, default), `winner`, `liquidated`.
- `&motion=reduce` forces reduced motion.
- The mock is a deterministic 20-player Stage match (seed 7, `&seed=` to change) scored through `shared/scoring.ts`.

Against a live engine (no `mock=1`; without NEXT_PUBLIC_ENGINE_WS the pages show a "not connected" message instead of a match):
- Set `NEXT_PUBLIC_ENGINE_WS=ws://<engine-host>:8787/ws` (and optionally `NEXT_PUBLIC_ENGINE_HTTP=http://<engine-host>:8787`; otherwise it is derived from the WS URL). Build-time variables: rebuild after changing them.
- `next.config.mjs` copies `NEXT_PUBLIC_*` (only those) from the repo-root `.env` when not already set.
- `npm run build && npm start`, then open `/arena` and `/play`. With no `?lobby=` they follow the engine's current lobby and switch to the next one after `settled` (or 20 s after `final`, or on `cancelled`); `?lobby=N` pins one.
- On every connect the hook reads `GET /lobbies/:id` (or `current`): positions, who is already out, `final`/`settled`, and the server clock offset (`now`), which drives the countdown, the match clock and order `ts`.
- The phone creates a burner key in localStorage, signs the join (EIP-712 `Join`) and every order (`Order`, nonce = max(last+1, now ms)) with viem, and posts to `POST /lobbies/:id/join` and `POST /orders`.

Screenshots: `npm run build && SHOTS_DIR=<dir> npm run shots` writes the eight gate PNGs. `SHOTS_ONLY=a,b` limits the set; `NEXT_DIST_DIR` and `PORT` let a second build run beside the first.

Files: `lib/events.ts` (wire types), `lib/useMatch.ts` (mock or WS feed, clock, positions), `lib/engine.ts` (burner key, signed join and orders), `mocks/match.ts`, `components/arena/VariantB.tsx` + `components/arena/b/` (the storm arena, one canvas), `components/play/` (phone).
