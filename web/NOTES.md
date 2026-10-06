## Status
- Step: island port (Phase 9) step 1 done: /island on mocks (?mock=island&at=overview|live|checkpoint|settled|studio|victory), matched to docs/island-prototype.html at 1440x900 and 390x844.
- Last check: GATE PASS ui, GATE PASS predict-ui; typecheck clean. island-ui gate not written yet.
- Next: step 2, live data against a local engine (port 8802).
- Blockers: none. /stats is not on this branch yet; the park, top bar and lighthouse show their empty states.

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

## Prediction mode

Same app, same world: `/arena` draws a prediction lobby as a price survey on the storm canvas (`components/arena/b/predict.ts`, picked in `VariantB.tsx` when `state.mode === "predict"`); `/play?mode=predict` is the phone (`components/play/Predict.tsx`). Flood blue is still only the storm: after the lock it closes in from above and below, leaving a dry corridor that is the winners' band (`ptick.band`). Gold is winners and payouts, chalk the live price.

Against the mock: `?mock=predict` on either page (implies predict mode).
- `&at=` moments of the protocol round (lobby 41, BTC, 20 players, 18 calls, top 5, linear): `open` (18 s to the lock), `locked`, `close` (30 s to the resolve), `final` (settlement price landed, payouts provisional), `settled`, or seconds after the round opened.
- `&speed=`, `&seed=`, `&motion=reduce` as in royale. `&me=` is `me` (KESTREL, finishes 3rd), `winner`, `loser` or an address.
- Phone screens: `&screen=rounds`, `&screen=create`, else the round (`&lobby=41` default; 42 is mara.eth's ETH round with a 3% creator fee, 43 a SOL round still filling, 44 the next protocol round). In a round the phone shows join, predict, locked or result by state.
- `mocks/predict.ts` builds every round through `predictSettle`; the mock clock is unix seconds.

Against a live engine: `/arena?mode=predict` follows the protocol round from `GET /rounds` (the locked one whose reveal comes next, else the open one) and moves on 20 s after its `final`, on `settled` or on `cancelled`; `?lobby=N` pins one. `/play?mode=predict` lists `GET /rounds`, joins with the signed `Join`, sends signed `Prediction`s (`POST /predictions`) and creates rounds with a signed `CreateRound` (`POST /rounds`), all in `lib/engine.ts`. Before the lock no event carries a price, so the hook subscribes to `WS /ws?feed=marks` (4 Hz, client-side `mark` events); `GET /lobbies/:id` is still read every 2 s for `players[].predicted` (the truth for whether your call is in) and supplies the price only when the feed has been quiet for 3 s. The phone eases the displayed price. Events in the first 400 ms after a WebSocket connects are the engine's catch-up: they do not set the time origin (the snapshot's `openTime` does) and a caught-up `final` does not replay the reveal. In predict mode `clock()` is unix server time.
- Bare `/arena` (no `?lobby=`, no `?mode=`) switches to prediction mode when `GET /lobbies` reports `current: null` twice, 3 s apart (an engine run with `--predict-only`).
- Joins close 7 s before the lock (engine JOIN_CLOSE_MS); the button says so. Joined rounds are remembered in localStorage and listed as "Your rounds" from `GET /rounds` `active` and `recent`; round views use pushState so Back works.
- A `cancelled` event's `reason` (or the snapshot's `cancelReason`) is shown on the phone and the arena.

Rules the screens keep:
- The predict control works in integer cents (`lib/predict.ts`): the tape (drag, arrow keys) and the nudge buttons can only produce prices of at least 0.01 with exactly two decimals; `signPrediction` refuses anything else.
- The create screen's controls are range inputs bounded by `RANGES` (the spec's user-created ranges, in steps: $1 entry, 1 player, 30 s lock, 60 s resolve, 5% winners, 0.5% fee); `inRange` clamps again before signing. The pinned payout preview runs `predictSettle` on a full lobby. The fine print says calls close on a whole minute (the lock can move up to 59 s). After `POST /rounds` the phone opens the round and shows the `lockTime` the engine returned as a local clock time on the join screen.
- Payouts say provisional until `settled`; bots carry BOT.

Files: `lib/events.ts` (predict wire types), `lib/useMatch.ts` (predict state, snapshot, follow), `lib/predict.ts` (ranges, preview, rounds, cents), `lib/engine.ts` (CreateRound, Prediction), `mocks/predict.ts`, `components/arena/b/predict.ts`, `components/play/Predict.tsx` + `predict.module.css`.
