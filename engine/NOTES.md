## Status
- Step: RPC read-lag handling: createLobby and start wait for a read showing Open/Live; lag-shaped reverts (LobbyNotOpen on join, NotEnoughPlayers on start, LobbyNotLive/SettleBeforeEnd on settle) retried 4 x 1.5 s; failed bots retried every 3 s while joins are open; ENGINE_READ_LAG_MS test transport.
- Last gate: `bash gates/all.sh` -> GATE PASS x5. `npm run e2e:local` PASS with reads lagging 6 s (20/20 joins, all finalists + treasury match `final`).
- Next: lead reruns `npm run e2e` on Base Sepolia.
- Blockers: deployed-mode CRE trigger not wired.

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

`engine/data/lobby-<id>.jsonl` with `CHAIN=off`; with the chain on, `engine/data/<CHAIN>-<escrow address, lowercase>/lobby-<id>.jsonl`, so books, logs and `--resume` are per escrow (a new escrow restarts lobby ids at 1). `ENGINE_DATA_DIR` overrides both. Gitignored, append-only: every event line plus input lines `{"in": "create"|"join"|"countdown"|"tick"|"order"|"final", ...}` (each tick records the marks it used). `--resume` replays the inputs through a fresh lobby (bots are seeded, so they make the same orders), reattaches, and catches up missed ticks with current marks. With `CHAIN=off`, lobby ids continue after the highest id already in `data/`, so a restart never reuses a finished lobby's id. Bot joins record their seat index, so replay rebuilds the same bot even if an earlier seat failed to join.

## Bot tuning

20 bots cycle through styles `degen, trend, steady, fade` (two of each per 8). Degen: 80-100x, 85-100% of free margin, no stop. Trend/fade: 10-40x following or fading 2 s momentum, take-profit/stop on margin. Steady: 5-20x. All bank profits when above the next zone line within 6 s of a checkpoint, and press (more leverage) when behind with under 12 s left. On a quiet tape they raise leverage until a half-sigma move over the time left reaches the line (live markets move ~10x less than the sim walk). Sim walk: per-tick vol BTC 0.04%, ETH 0.05%, SOL 0.07%, with a wandering drift.
Seeds 1-30, 20 bots, stage: 27 end with 4-9 finalists, 28 have at least one liquidation. Live on a calm Coinbase tape (BTC moving ~0.02% in 2 min) the same bots ended with 3 finalists after two cuts; real price moves are the limit there, not the rules.

## Chain robustness

- Nonces are tracked locally per account (`write()` in `src/chain.ts`): read once with blockTag `pending`, then incremented. A load-balanced RPC's pending count can lag a tx we already saw mined. On a nonce error it resyncs to max(local + 1, RPC count). Sends stay serialized.
- `joinFor` resends up to 3 times on nonce or transport errors (`retryable()`); an `AlreadyJoined` revert on a resend means an earlier attempt landed and counts as joined.
- `redact()` replaces any http(s)/ws(s) URL with `<rpc>`. `failReason()` uses viem's `shortMessage` and redacts; the server's `log` redacts every line; uncaught errors exit through a redacted `fatal`. The e2e relays engine output line by line through `redact()` and has its own redacted top-level handler.
- Read lag: after `createLobby` the engine polls `getLobby` until it reads Open (30 s deadline) before any join; after `start`, until Live. The relayer's mint and approve are confirmed the same way. A simulation that reverts with a lag-shaped error (`LobbyNotOpen` on joinFor, `LobbyNotOpen`/`NotEnoughPlayers` on start, `LobbyNotLive`/`SettleBeforeEnd` on settleFallback) is retried 4 times, 1.5 s apart, before it counts. `AlreadyJoined` counts as joined. Bots whose join still failed are retried every 3 s until joins close. Receipts are polled every 1 s.
- `ENGINE_READ_LAG_MS` (test only, off unless set): eth_call and eth_estimateGas answer at the head from that many ms ago. `scripts/e2e.mts` sets 6000 when `CHAIN=anvil` (so `e2e:local` runs with lag; `ENGINE_READ_LAG_MS=0` turns it off) and clears it on any other chain.
- e2e: refuses a busy `E2E_PORT` (default 8799; `e2e:local` uses 8811). Historical `balanceOf` is retried 10 x 2 s, then the settlement receipt's Transfer logs give the deltas.

## Settlement (Phase 6)

After `final`, with the chain on, `settle()` in `src/server.ts` runs:

- `SETTLE_MODE=simulated` (default): reads `getLobby` for the on-chain pot and end time, builds the report with `workflow/src/report.ts` `buildReport` from the exact book bytes on disk, the final marks, the on-chain pot, fee 500 bps and `CHAIN_SELECTOR`; waits until the latest block's timestamp is past the on-chain `endTime`; the owner (`PRIVATE_KEY_DEPLOYER`) calls `settleFallback`; on a success receipt, `markSettled` emits `settled {txHash, mode, winners, amounts}`. Retries every 5 s (up to 10), stops as soon as one failure reason (decoded custom error name) repeats; the error is on `chainError`. If the escrow already says Settled, it picks up the `Settled` log instead of sending.
- `SETTLE_MODE=deployed`: the CRE HTTP trigger is **not wired** (contracts/NOTES.md does not document how to send a signed gateway request). The engine logs that, then polls for the escrow's `Settled(id)` log and emits `settled` with that tx hash once someone triggers `royale-settle` with `{"lobbyId": id}`.
- Pot: with the chain on, `final`'s provisional payouts and the report both use the escrow's pot (`getLobby`, read once before `final` and passed to settlement), so they agree even if the engine's own count differs.
- A failed `settleFallback` call checks `getLobby`; if the escrow already says Settled (the tx landed but the call errored), it picks up the `Settled` log and emits `settled`.
- Deployed mode stops watching for `Settled` after 15 minutes, sets `chainError`, and `--loop` carries on.
- Not resumed: a lobby restarted after `final` (`--resume` skips finished lobbies) is not settled by the engine; settle it by hand per contracts/NOTES.md.

`CHAIN=anvil` (chain id 31337) is accepted for local runs. `ENGINE_DATA_DIR` moves the log/book store (e2e uses a temp dir: a fresh anvil reuses lobby ids, and a stored book is never rewritten).

Relayer funds: `Deploy.s.sol` mints 1,000,000 mUSDC to the relayer and approves the escrow. On its first `joinFor`, the engine also mints 1,000,000 mUSDC from MockUSDC's open `mint(address,uint256)` if the relayer holds under 1,000 mUSDC (covers a redeployed escrow on an existing token).

Bot addresses are `keccak256("royale-bot:<seed>:<i>")[12:]`: valid addresses with no known key. `joinFor` needs only the address, so bots join on-chain, but **bot winnings are unrecoverable** (nobody holds the key). Fine on testnet with MockUSDC.

## e2e

    npm run e2e:local   # repo root: anvil + Deploy.s.sol with anvil dev keys + the e2e below; nothing public
    npm run e2e         # repo root: same e2e against RPC_URL / TOKEN_ADDRESS / ESCROW_ADDRESS from the env or .env

`engine/scripts/e2e.mts` starts the engine (20 bots, stage, port `E2E_PORT` default 8799, temp data dir, `SETTLE_MODE=simulated`), waits for `final` and `settled` on the WebSocket, then reads each winner's and the treasury's MockUSDC balance at the settlement block and the block before, and exits non-zero unless every change equals the `final` event's `provisionalPayoutUnits` / `feeUnits` and the winner lists agree. Final marks always come from the real Coinbase candle endpoint. Takes about 4-5 minutes (minute-aligned start, 120 s match, candle final 60 s after the end). On a public chain it must not share the deployer key with a running engine (nonce races).

## Not done / for the lead

- Chain start: joins close 7 s before `startsAt`; `start()` is sent 6 s before, retried every second until 1.5 s before `startsAt`. After the last failure the lobby is cancelled (engine first, so it never goes live; then `cancel()` on chain, which refunds every entry); the outcome, or the cancel failure, is on `chainError`. A failed `createLobby` at boot is logged and retried every 10 s.
- Boot refuses an `RPC_URL` whose chain id is not the configured `CHAIN`'s; `npm run e2e` refuses unless the RPC chain id is 84532, 11155111 or 31337. Errors exposed in logs, join responses and `chainError` go through `failReason` (never the raw message, which carries the RPC URL).
- `createLobby`, `start`, `cancel`, `settleFallback` are `onlyOwner` (`PRIVATE_KEY_DEPLOYER`); `joinFor` uses `PRIVATE_KEY_RELAYER`. The on-chain lobby id becomes the engine's lobby id.
- No `cancel` route: a lobby that never reaches 4 players just stays open.
- Human orders fill at the latest feed price; `t` is the wall-clock offset clamped inside the current tick.
