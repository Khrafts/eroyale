## Status
- Step: spec-checker fixes done (minute-aligned start, persisted book at end tick, signed joins, nonce/end-time guards).
- Last gate: `bash gates/engine.sh` -> GATE PASS engine.
- Live check: CHAIN=off stage match started 07:12:00Z, book served at the end tick (endTime % 60 == 0) before `final`, identical bytes after a restart; log + book pass gates/check-engine.ts; `--resume` mid-match OK.
- Next: Phase 6 integration (`settled` emission / settleFallback) by the lead.
- Blockers: none. Chain calls still untested against a deployment.

# Engine notes

## Run

    cd engine && npm install
    npm run sim -- --bots 20 --preset stage --seed 42 --out book.json --events events.jsonl
    CHAIN=off npm run dev -- --bots 20 --preset stage      # http + ws on :8787 (PORT or --port)

`dev` flags: `--bots N` (fill the lobby), `--preset stage|standard`, `--open S` (seconds the lobby stays open before the countdown, default 15; it waits for 4+ players and live prices), `--countdown S` (minimum countdown, default 10; `startsAt` is then rounded up to the next whole minute so `endTime % 60 == 0`), `--seed S` (bot seed), `--max N` (max players, default 50), `--loop` (open the next lobby 5 s after `final`), `--resume` (rebuild the latest unfinished lobby from its log and carry on).

The server reads `../.env` but never overrides a variable already set, so `CHAIN=off` on the command line wins. With `CHAIN` on, the server refuses to boot without `PRICE_SOURCE_URL`, and `final` waits (retrying every 5 s) for the settlement candle; with `CHAIN=off` it falls back to the last live mark after 6 failed tries. Env it uses: `CHAIN` (`off`, `base-sepolia`, `ethereum-sepolia`), `RPC_URL`, `PRIVATE_KEY_DEPLOYER`, `PRIVATE_KEY_RELAYER`, `ESCROW_ADDRESS`, `TOKEN_ADDRESS`, `PRICE_SOURCE_URL`, `ORDER_SIG=off` (accept unsigned orders: the hour-7 cut line), `PORT`.

## Layout

- `src/lobby.ts`: the state machine. No clock or I/O; takes tick indexes and marks. Equity, `cut()`, `settle()` all come from `shared/scoring.ts` (position PnL on close is `equityCents` of a one-position finalist with zero cash).
- `src/driver.ts`: drives a lobby from a `Clock` and a `PriceSource`. The sim uses `VirtualClock` + `RandomWalkPrices`; the server uses the real clock + exchange feeds. Same code path.
- `src/prices.ts`: Coinbase Exchange WS ticker (primary) and Kraken v2 WS ticker (fallback, used per market when Coinbase is >2 s old). Heartbeat channels keep quiet markets fresh. Settlement marks from `PRICE_SOURCE_URL` (Coinbase 1-minute candle close at `S = floor(end/60)*60 - 60`, fetched after `S + 120`, close read as received text then truncated to 2 decimals). Without `PRICE_SOURCE_URL` the final marks are the last live marks. Both endpoints verified with real requests.
- `src/bots.ts`: seeded bots, `src/sim.ts`: offline sim, `src/server.ts`: HTTP/WS/log/replay, `src/chain.ts`: relayer, `src/orders.ts`: order signatures.

## Event order per tick

liquidation fills + `eliminated` (checkpoint null), `tick`, `warning` (at checkpoint - 10 s), `leaderboard` (pre-cut at a checkpoint), checkpoint `eliminated`, then bot fills at the same `t`. At the end tick: `lobby` (settling); the book is frozen, written to `data/lobby-<id>.final.json` (temp file + rename, once) and served right away. `final` follows once the settlement candle is final (about 60 s after the end). `cutEquity` is the lowest surviving equity if `cut()` ran now against the displayed zone; `null` after the last checkpoint. Leaderboard rows hold every player: alive by equity, then the eliminated (latest first) with equity frozen at elimination. `lobby` events also carry `lobbyId`, `preset`, `endTime`; `final` also carries `feeUnits`.

## HTTP / WS

- `GET /health`, `GET /lobbies` (list + `current`), `GET /lobbies/:id` (full snapshot incl. positions, `pricesStale`, `now`; `:id` may be `current`), `GET /lobbies/:id/final` (exact book bytes from the on-disk store, loaded at boot, so a restart never loses a book; 404 until the end tick). The snapshot also carries `chainError` and `startTx`.
- `POST /lobbies/:id/join {player, callsign, signature}` -> `{txHash}`; `txHash` is `null` with `CHAIN=off`. Callsign 1 to 24 characters. Joins stay open during the countdown until 7 s before `startsAt`. Bots join inside the process, not over HTTP.
- `POST /orders {lobbyId, player, nonce, ts, order, signature}`. `ts` is unix **milliseconds** (within 30 s). `nonce` must strictly increase per player. Orders pause (503) when any market price is more than 3 s stale, and are refused once `now >= endTime`. The nonce is re-checked after signature verification, so two concurrent orders cannot share one.
- `WS /ws?lobby=:id` (no param = current lobby): on connect you get the latest `lobby`, `tick`, `leaderboard`, `final`, `settled`, then the live stream.

## Signatures (UI must match)

Join (new, for CLAUDE.md): EIP-712, same domain, primary type `Join`: `lobbyId uint256, player address, callsign string` (the callsign exactly as sent in the body). `joinMessage()` in `src/orders.ts`. `ORDER_SIG=off` skips join and order checks.

Orders:

EIP-712, domain `{name: "TradingRoyale", version: "1"}` (no chainId), primary type `Order`:
`lobbyId uint256, player address, nonce uint256, ts uint256, action string, market string, side int8, margin string, leverage uint8`.
`order` is `{action: "open", market, side: 1|-1, margin: "123.45", leverage: 1..100}` or `{action: "close", market}`; a close signs `side 0, margin "0", leverage 0`. `orderMessage()` in `src/orders.ts` builds the message; `scripts/human.mts` is a working client (join, signed open, close).

## Log and replay

`engine/data/lobby-<id>.jsonl` (gitignored), append-only: every event line plus input lines `{"in": "create"|"join"|"countdown"|"tick"|"order"|"final", ...}` (each tick records the marks it used). `--resume` replays the inputs through a fresh lobby (bots are seeded, so they make the same orders), reattaches, and catches up missed ticks with current marks. With `CHAIN=off`, lobby ids continue after the highest id already in `data/`, so a restart never reuses a finished lobby's id. Bot joins record their seat index, so replay rebuilds the same bot even if an earlier seat failed to join.

## Bot tuning

20 bots cycle through styles `degen, trend, steady, fade` (two of each per 8). Degen: 80-100x, 85-100% of free margin, no stop. Trend/fade: 10-40x following or fading 2 s momentum, take-profit/stop on margin. Steady: 5-20x. All bank profits when above the next zone line within 6 s of a checkpoint, and press (more leverage) when behind with under 12 s left. On a quiet tape they raise leverage until a half-sigma move over the time left reaches the line (live markets move ~10x less than the sim walk). Sim walk: per-tick vol BTC 0.04%, ETH 0.05%, SOL 0.07%, with a wandering drift.
Seeds 1-30, 20 bots, stage: 27 end with 4-9 finalists, 28 have at least one liquidation. Live on a calm Coinbase tape (BTC moving ~0.02% in 2 min) the same bots ended with 3 finalists after two cuts; real price moves are the limit there, not the rules.

## Not done / for the lead

- `settled` event: nothing emits it yet. Needs either a watcher for the escrow `Settled(id, bookHash)` event (its exact ABI comes from the contracts track) or, in `SETTLE_MODE=simulated`, the owner calling `settleFallback(report)` with `buildReport` from `workflow/src`. `Lobby.markSettled()` is ready for it.
- Chain start: `start()` is sent 2 s before `startsAt` (escrow sets its end to block time + duration, so the chain end lands within a few seconds of the book's), retried every 3 s up to 10 times; failures go to the log and to `chainError` on `GET /lobbies/:id`. A failed `createLobby` at boot is logged and retried every 10 s.
- Relayer: `joinFor` uses `PRIVATE_KEY_RELAYER` and approves the escrow for max on first use (receipt status checked); it does **not** mint MockUSDC (the mint signature is not in CLAUDE.md), so the relayer must be funded first. `createLobby`, `start`, `cancel` are `onlyOwner`, so they use `PRIVATE_KEY_DEPLOYER`. The on-chain lobby id (from `createLobby`'s return value) becomes the engine's lobby id. Chain calls are untested (no RPC or deployment yet).
- No `cancel` route: a lobby that never reaches 4 players just stays open.
- Human orders fill at the latest feed price; `t` is the wall-clock offset clamped inside the current tick.
