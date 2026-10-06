## Status
- Step: 6 of 6 done. Storm arena (judge fixes in), phone states, sequences, screenshots, notes.
- Last gate: `bash gates/ui.sh` -> GATE PASS ui; all eight shots reviewed.
- Next: run /arena and /play against the live engine (NEXT_PUBLIC_ENGINE_WS) once it serves lobby 1.
- Blockers: none. Shots use installed Chrome because Playwright 1.63's Chromium is not downloaded.
- Known: positions on the phone are rebuilt from `fill` events, so a reload mid-match loses them until GET /lobbies/:id is wired in.
- Known: `final`/`settled` carry no `t`; the arena times those sequences from arrival.

## Running

Install once: `cd web && npm install`.

Against the mock (no engine needed):
- `npm run dev`, then open `http://localhost:3000/arena?mock=1` (big screen, 1920x1080) and `/play?mock=1` (phone).
- `&at=` jumps to a moment: `lobby`, `countdown`, `warning`, `checkpoint`, `live`, `liquidation`, `danger`, `eliminated`, `final`, `settled`, or a number of match seconds.
- `&speed=` sets playback speed (`0` freezes, which is how screenshots are taken). `&loop=1` repeats the match.
- `&me=` picks the phone's player: an address, or `me` (KESTREL, default), `winner`, `liquidated`.
- `&motion=reduce` forces reduced motion.
- The mock is a deterministic 20-player Stage match (seed 7, `&seed=` to change) scored through `shared/scoring.ts`.

Against a live engine:
- Set `NEXT_PUBLIC_ENGINE_WS=ws://<engine-host>:8787/ws` (and optionally `NEXT_PUBLIC_ENGINE_HTTP=http://<engine-host>:8787`; otherwise it is derived from the WS URL). Build-time variables: rebuild after changing them.
- `npm run build && npm start`, then open `/arena?lobby=1` and `/play?lobby=1` (no `mock=1`).
- The phone creates a burner key in localStorage, signs the join (EIP-712 `Join`) and every order (`Order`, nonce = max(last+1, now ms)) with viem, and posts to `POST /lobbies/:id/join` and `POST /orders`.

Screenshots: `npm run build && SHOTS_DIR=<dir> npm run shots` writes the eight gate PNGs. `SHOTS_ONLY=a,b` limits the set; `NEXT_DIST_DIR` and `PORT` let a second build run beside the first.

Files: `lib/events.ts` (wire types), `lib/useMatch.ts` (mock or WS feed, clock, positions), `lib/engine.ts` (burner key, signed join and orders), `mocks/match.ts`, `components/arena/VariantB.tsx` + `components/arena/b/` (the storm arena, one canvas), `components/play/` (phone).
