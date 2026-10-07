## Status
- Step: Phase 14 duel-feel done: ranked "Coming soon" (menu, Dojo, no duel in /arena picker or Big screen, jet fixed low), practice Sparring/Fighter/Master/Dummy in ?level= (?guard=block), Block button, BLOCK spark and tips hint, crossing drawn with a smoothed facing turn.
- Last check: on the merge with feat/duel2 (rules v2): ui, look-ui, nav-ui, gates.next-duel2 duel-ui GATE PASS; typecheck clean; a forward jump over the dummy crosses and turns with no snap.
- Next: feel check (11.3). Blockers: none.

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

Files: `lib/events.ts` (wire types), `lib/useMatch.ts` (mock or WS feed, clock, positions), `lib/engine.ts` (burner key, signed join and orders), `mocks/match.ts`, `components/arena/VariantB.tsx` + `components/arena/b/` (the arena, one canvas in the island's world), `components/play/` (phone).

## Prediction mode

Same app, same world: `/arena` draws a prediction lobby as a price chart on the same canvas (`components/arena/b/predict.ts`, picked in `VariantB.tsx` when `state.mode === "predict"`); `/play?mode=predict` is the phone (`components/play/Predict.tsx`). The sea is still only the zone: after the lock it closes in from above and below, leaving a sun band that is the winners' span (`ptick.band`). Sun is winners and payouts, ink the live price.

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

## Island

The front door (`/`, alias `/island`): docs/island-prototype.html ported to three 0.186.1 (pinned exactly) with its
own examples/jsm OrbitControls and BufferGeometryUtils. No React Three Fiber. `ColorManagement.enabled = false` and
linear sRGB output keep the prototype's r147 colours; light intensities are the prototype's times PI (lights are
physical since r155).

Run it:
- Mocks: `/?mock=island&at=overview|live|checkpoint|settled|studio|victory` (clock frozen at the moment; built from
  mocks/match.ts folded through useMatch's reducer and mocks/predict.ts round lists). `?view=list` opens the list.
  `&motion=reduce` forces reduced motion.
- Live: `NEXT_PUBLIC_ENGINE_WS=ws://localhost:8802/ws npx next dev -p 3101`, engine
  `CHAIN=off npm run dev -- --port 8802 --bots 12 --preset stage --predict-bots 10 --loop`. Polls /lobbies, /rounds,
  /marks, /health, /stats every 3 s (backs off to 15 s while the engine is down, paused while the tab is hidden).
  WebSockets through useMatch: the current royale lobby, the open protocol round, and up to three locked protocol
  rounds still waiting for their result.
- Shots: `npm run shots` adds island-overview, island-panel, island-studio, island-victory, island-list (1440x900)
  and island-phone (390x844). Headless Chrome gets WebGL from SwiftShader (`--use-angle=swiftshader`); each island
  shot waits for `window.__islandReady` (set once every building has popped in). SwiftShader runs the scene at about
  2 fps, so CSS transitions lag in shots.

Modules:
- `components/island/world/` (plain TS, its own chunk, loaded only with WebGL2): scene.ts (renderer, camera,
  controls, smooth zoom, flights, view offset, frame loop, studio preview renderer), materials.ts (toon, outline,
  instancing, canvas textures), common.ts (layout, shoreline, obstacle book), terrain, water, sky, plaza (fountain
  jets, coins), buildings/{arena,observatory,park,wheel,plots,dojo,lighthouse,billboards}, props (instanced), life
  (clouds, blimp, balloons, boats, fireflies, confetti), avatar/{rig,dances}, picking, labels.
- `components/island/ui/` (React): Island.tsx (mount, world API, bus), TopBar, Feed, Panel (every building),
  AvatarStudio, ListView, island.css (the prototype's CSS, every rule under `.isle`). IslandRoot.tsx loads it with
  `next/dynamic` and `ssr: false`.
- `lib/island/`: store.ts (one external store; React via useSyncExternalStore, the world via getSnapshot each
  frame; a small bus for feed lines, cut flares, confetti, victory), live.tsx (polling + useMatch watches),
  mock.ts, avatar.ts (AV, DANCES, cfgFor by address, storage `royale.avatar.<address>` and `royale.callsign`),
  format.ts (label and panel lines), places.ts (games, billboards; no three).

Known differences from the prototype:
- Shadows use PCFShadowMap: r186 removed PCFSoftShadowMap, so shadow edges are slightly harder.
- The prototype's mock simulation is gone. Labels, panels and list show engine data; anything without data says so
  (park, podium, top bar and lighthouse while /stats 404s; empty promo boards read "NO ROUNDS YET"; the blimp invites
  you to create a round).
- Player rounds have no titles on the wire: boards and lists say "Call the ETH close. Steep split." and
  "ETH call · round #42", with the creator's short address (no creator callsign on /rounds).
- Promo boards and the blimp are labelled as player rounds with the biggest pots, never "PROMOTED" or a price.
- Buttons with no backend are gone: Dojo "Notify me", Sky Wheel "Suggest a use", plot "Propose a building", sponsor
  "Visit sponsor", blimp "Book the blimp", the open slot's bid form. The Observatory's nudge box became the live price
  and the prediction count, with "Make your call" handing off to /play?mode=predict&lobby=.
- The lighthouse drops "Your region · Allowed" (no data); it shows engine, chain (from /health), escrow (from
  contracts/deployments at build time), prices fresh/stale and the last payout.
- The ticker's change is against the oldest mark seen in the last ten minutes (the engine has no daily open), and the
  candle bars are the latest BTC moves in basis points.
- The wallet chip shows the burner address only (no balance call).
- On phones the feed sits above the hint (the prototype stacked them on top of each other).

## One look

Phase 10: the island's look becomes the product's look. Track look-theme laid the shared base; look-play and
look-arena restyle /play and /arena on it.

- Tokens: `lib/theme.ts` (constants for canvas and script code: every token of CLAUDE.md "One look", `GAME`,
  `MEANING`, `STROKE`, `RADIUS`, `SHADOW`, `FONT`, `ISLAND` for the island's own grass/sand/podium colours, and
  `canvasFont(role, weight, px)`) and `app/theme.css` (the same values as custom properties on `:root`, kebab-case:
  `--ink`, `--sky-top`, `--sea-deep`, `--coral-text`, `--island-grass`, `--shadow-chip`, `--radius-card`, `--display`,
  `--body`, `--mono` ...). Change both together. `body` gets `font-family: var(--body)`.
- Loss text on paper is `coralText` / `--coral-text` `#D12B52`: 4.87:1 on paper (coral itself is 2.85:1).
- Fonts: `app/fonts.ts` loads Unbounded, Instrument Sans and JetBrains Mono with next/font/local from `app/fonts/`
  (variable latin woff2, OFL texts, URLs in `app/fonts/SOURCES.txt`). Each face keeps its real family name
  (`declarations`), so canvas code and `document.fonts.check('16px "Unbounded"')` work; layout.tsx puts
  `--font-display`, `--font-body`, `--font-mono` on `<html>`. The island no longer loads fonts.googleapis.com.
  Sofia Sans is gone, and so is `components/arena/b/fonts.ts`: the arena draws with `canvasFont` from lib/theme.ts.
- The island reads the shared tokens: `.isle` keeps only its extras, places.ts `COLORS` and world `C` are built from
  theme.ts, water/sky/terrain/common import it, canvas text uses `canvasFont`. No visible change (checked by pixel diff
  against feat/island with `motion=reduce` shots).
- Kit: `components/kit/` (`index.tsx` + `kit.module.css`, the island.css rules on theme.css values): `Chip` (glass, or
  `fill` for a meaning colour with ink text), `Button` (game colour via `color="royale"|"predict"|...` or a theme
  constant; `big` = display face, ink text, for LONG/SHORT; `href` makes a link), `GhostButton`, `Card` (soft, or
  `raised`), `Panel`, `PanelHead` (game colour with the two soft circles), `Segmented`, `BotTag`, `BrandMark`,
  `TopBar` (brand chip linking to `/`, optional middle content, wallet chip from a passed address).
  The island's `.isle` sets `--mono` to `--font-mono-island` (JetBrains Mono's 500 file alone) so its 600/700 figures
  stay synthetic bold as before; everywhere else `--mono` has true weights up to 800. Class names are
  exported as `kit` for layouts the components do not cover. Buttons and chips use the spec's `0 3px 0` shadow (the
  island's own .cta keeps its 4px).
- Arena (look-arena): one 1920x1080 canvas as before. `components/arena/b/toon.ts` is the island's world in 2D: the sky
  gradient with pre-rendered toon clouds, `box` (chip/panel: fill, 3 px ink outline, hard ink shadow, optional tag tip),
  `panel` (game-colour head with the two soft circles), the wordmark/pot/count chips, the bot tag, avatar heads drawn
  from `cfgFor` (or your saved look when this browser has a burner key; the arena never creates one) into an offscreen
  sprite once per look, size and crown, the podium step and confetti. `scene.ts`: toon land (meadow, grass, a sand
  beach above the waterline, ink outline), the sea (seaMid to seaDeep, seaShallow band, seaFoam line and flecks), heads
  on summits under label chips (equity on a sun or coral pill), mint/violet pennants, a coral ring for at-risk, the
  cut line in coral and ink, the checkpoint surge with toon shards and a paper flash, the final podium (top three by
  equity; their summits keep a numbered sun flag) with confetti. `predict.ts`: ink price line over a paper underlay,
  dashed ink calls ending in head chips, the sun band between two sea fronts, confetti on the reveal. The HUD sits
  `HUD_Y` (16 px) below the top edge so the sky reads above it. Every colour from theme.ts; no hex in arena files.

## Stickman Duel

`/duel` (phone), `/arena?duel=:id` (big screen) and the island's Dojo, on `shared/duel.ts` through `components/duel/sim.ts`.

- `/duel`: the menu (an attract loop of a bot match, Practice, callsign, Fight for 5 USDC). `/duel?mode=practice` starts at once: the rules at 60 Hz against `botInput` (Normal by default, Easy/Normal/Hard toggle), you are fighter 0, `window.__duelState()` returns the live DuelState. Keyboard on window (arrows, Z = A, X = B, Z+X throw); touch pad bottom left, A and B bottom right, A+B pill for a one-thumb throw.
- Ranked: signed `DuelQueue` (EIP-712, same domain and burner as /play; `components/duel/net.ts`, nonce on the same `royale.nonce.<player>` key as lib/engine.ts), ticket polled every 1 s, after 10 s alone "Fight the bot for free" (`POST /duels/queue/:ticket/bot`). The fight (`link.ts`): input bits sent on change over `WS /ws?duel=`; your fighter is the rules stepped from the newest `dstate` up to now plus 3 ticks with your recorded bits; the opponent is interpolated about 4 ticks behind. The result fetches `GET /duels/:id/final`, replays it in the browser (`verify.ts`) and shows the replay hash, whether the winner matches and whether keccak256 of the body equals `bookHash`; payouts say provisional until `settled`, offline settlements say nothing was paid on chain.
- `/arena?duel=:id`: one canvas at 1920x1080, island chips for the duel, stake and status, the end card with payout, replay hash and book hash. Loaded with React.lazy from `app/arena/page.tsx`, so /arena's first load did not grow (+1.1% vs main, as before the branch).
- Leaving the queue sends `DELETE /duels/queue/:ticket` and returns to the menu only on 200 or 404; a 409 with a matched ticket goes to the fight. A `dfinal` is placed by its `winnerSide` (else the winner's address among the players); until it can be placed the result waits and no draw is shown. `GET /duels/:id` 404 stops following the duel; an archived or finished snapshot is shown from its `dfinal`/`settled` without reconnecting. Offline amounts always carry "not paid, offline"; draws say "Refunded, tx …". Stake amounts come from the engine's `stakeUnits`. Your name in a fight is the engine's `players[side].callsign`.
- Island: `components/duel/dojo.ts` polls `GET /duels` every 3 s (paused while hidden); the Dojo panel (`DojoPanel.tsx`, mounted by Panel.tsx), the list card, the Dojo label line and the Duel jet (queue + players in live duels, out of 20) read it.
- Mocks: `/duel?mock=duel&at=practice|fight|result`, `/arena?mock=duel&at=fight`, `/?mock=island&at=dojo` (Dojo panel open, mock GET /duels). The mock match is botInput level 3 against level 2 through the rules (`mock.ts`); in the ranked moments you are kestrel on side 1, who wins 2-0.
- Framing: the camera fits the pair across and the highest fighter plus a body (phone: fighters about 45% of the stage), never shows past the posts, and at the end of a match on the big screen pulls back to the whole deck under the result card. Each side has an accent ring under its feet (tang, violet) and side 1 changes shirt when it is too close to side 0's. A clean hit holds the picture about 50 ms and flashes the defender paper for two frames. The combo count clears at a new round and hides during the round intro.
- Renderer (`render.ts`): sky gradient and clouds, meadow, sand deck with an ink edge, dojo posts at the walls; stickmen in ink with avatar colours (yours from storage, others `cfgFor`), joints eased toward pose targets each frame, hit sparks and bursts on hp drops and fresh blockstun, the combo count (kept on the attacker by the rules), health with a coral trail, round dots, timer, round and winner banners. `prefers-reduced-motion`: no sparks, shake or banner pop.
- Verified 2026-10-07 against a local CHAIN=off engine from the duel-engine branch: two browser contexts queued and fought (duel 2, alpha 2-0, both phones show the same replay hash 77c85e54 and a matching book hash, settled offline), a draw by time-out (duel 1, stakes refunded), a free bot fight, the big screen end card, and the live Dojo panel.

## Navigation

Phase 12 kit (CLAUDE.md "Navigation"). Tracks use these; do not hand-roll another.

- `lib/nav.ts` (imports only `theme.ts`): `NAV_GAMES` (id `island|royale|predict|duel`, name, short, color, href), `navGame(id)`, `CREATE`, `PANEL` (each game's island place), route helpers `island(place?)`, `playRoyale(lobby?)`, `predictRounds()`, `playRound(id)`, `createRound()`, `duel("practice"?)`, `watchLobby(id)`, `watchRound(id?)`, `watchDuel(id)`, `watchGame(id)`, and `docTitle(game, screen?)` -> `"<screen> · <game> · Royale Isle"` for `document.title`. `lib/island/places.ts` reads its names and colours from it.
- App bar: `<TopBar back? game? live? watch? wallet? callsign? avatar? className?>{screen chips}</TopBar>` from `@/components/kit`. `back = {to, href?, onClick?}` renders "Back to <to>" (link with href, button with only onClick). `game` marks the current entry (`aria-current="page"`); `live: GameId[]` adds the "you're in" pip; `watch` is the Big screen href (default `watchGame(game)`, `null` hides it); `avatar` is a small head node (e.g. `<Avatar>` from components/play) shown in the you chip and its menu. The shell (bar.tsx) is in first-load; the switcher (switcher.tsx) and you chip (you.tsx) load with React.lazy (the you chip shows a static address chip until then). Responsive by the bar's own width (`container: appbar`): segmented from 640 px (short labels under 1080), a "Games" menu button below. The switcher is links only and never takes focus or arrow keys; the menus close on outside press and Escape (captured, so a page's Escape-to-parent does not also fire).
- Links: `AppLink` (components/kit/link.tsx), also what `Button`/`GhostButton` render for `href`: a real `<a href>` whose plain left click goes through Next's router (`useRouter().push`, or `.replace` with `replace`), so no reload. Used instead of `next/link` because next/link's module is 3.4 KB gzip of /play's first-load room; to switch, change link.tsx alone.
- End-state block: `<EndActions game primary watch? more? />` from `@/components/kit/actions` (not the index, so screens without it do not carry it). `primary`/`more` items are `{label, href?, onClick?, replace?}`. Renders the primary in the game colour, "Watch on the big screen" (when `watch`), `more` as ghost buttons, the other games, and "Back to the island" (omitted for `game="island"`). Server-compatible.
- URL state: `const { params, push, replace, back } = useUrlState()` from `@/lib/useUrlState`. `push(set, path?)` drill-down, `replace(set, path?)` lateral, `back(parentSet, path?)` = `history.back()` when the previous entry was pushed from that parent URL, else replaceState to it. `set` only changes the keys it names (`null` deletes), so `mock`, `at`, `speed`, `seed`, `me`, `motion` survive. `params` re-read on popstate and every move; empty during SSR/hydration. `withParams(set, path?, search?)` builds the same URL for an href.
- Titles: layout template `"%s · Royale Isle"`; route titles `Trading Royale` (/play), `Stickman Duel` (/duel), `Big screen` (/arena, via app/arena/layout.tsx), `Page not found`; `/` is absolute "Royale Isle". Screens set finer titles with `docTitle`.
- 404: `app/not-found.tsx`: `AutoTopBar` (components/kit/auto-bar.tsx: the app bar with the you chip from `burner()`, lib/engine imported after mount) and `EndActions game="island"`.
- Island (nav-island): `?place=<id>` is the open panel (any building, billboard, `studio`): a click pushes it from the bare island and replaces it panel-to-panel; the close button, Escape and Back close it (`useUrlState().back`); a deep link or a link such as the you chip's "My avatar" (`/?place=studio`) opens it (Island.tsx follows `useSearchParams`). Mock moments (`at=studio|dojo`) open their panel without writing the URL. The toggle replaces `?view=list`. The world skips the intro swoop and pop-in (`createWorld(..., skipIntro)`) when the island was already shown in this document, the document started on another route, or `?place=` is set. The brand chip on the island closes the panel, leaves the list and resets the camera. Panels move focus to their heading and back on close, and set `document.title` to `<place> · Royale Isle`. The switcher's container query needs `.isle .top` as the `appbar` container (island.css); the wordmark hides under 1500 px of bar and the stats chips under 1240.
- Follow policy (lib/useMatch.ts, rule 8): `useMatch({hold: true})` keeps a finished match on screen; the returned `next` is the engine's current lobby (protocol round in predict) once this one has ended and differs, `pinned` is true for `opts.lobby`/`?lobby=`, `followNext()` moves a held match on. Pinned and held matches only offer `next`; without `hold` an unpinned match still follows by itself (the big screen). /play royale uses `hold`.
- /play shell: `Shell` in components/play/Bar.tsx (app bar full width, the 520 px phone column under it, document.title kept over Next's streamed metadata title). Modes and screens read the URL with `useSearchParams` (so router pushes from AppLink and useUrlState writes both re-render); the predict screens move with useUrlState (`?lock=` keeps a created round's lock time over a refresh).
- /arena (nav-arena): `components/arena/Overlay.tsx` (first-load shell: input listeners, 3 s idle hide, Escape toggles, `?kiosk=1` off; renders nothing until the first input, so screenshots without input are clean) lazily loads `components/arena/nav.tsx` (the kit TopBar as a floating paper bar, a "Watching ..." picker from GET /lobbies, /rounds, /duels, and the move-on card). A pinned `?lobby=`/`?duel=` that is over (30 s after `final`, 12 s after `settled`, 4 s after cancelled; duels 12 s after the end card, 3 s if cancelled or missing) shows the overlay with "Go to the current lobby" / "Follow the protocol round" / "Watch the next duel". `?mode=royale` is explicit. The page re-keys on the query, so a picker move needs no reload. `components/arena/title.ts` `useDocTitle` holds document.title against Next's metadata write.
- /duel (nav-arena): screens from the URL (`?mode=practice`, `?ticket=`, `?duel=`, mock); sessionStorage `royale.duel.session` holds `{ticket, since, callsign, duelId, side, token, ranked, after}`. A queued page leaves the queue on unmount and on pagehide (`leaveQueue(ticket, true)`, keepalive); a reload then finds the ticket gone (404) and queues again with the same callsign. `?duel=` takes side and token from the session (token refreshed from GET /duels/queue/:ticket); another browser gets "Not your fight" with Watch. A live ranked fight asks on beforeunload and before any link click. "Fight again" re-queues (waits out the last duel's settling: the engine answers POST /duels/queue with the old ticket until then).

