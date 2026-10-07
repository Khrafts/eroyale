# Royale Isle

A cartoon island of real-time money games on Base Sepolia. Each building is a game:

- **Trading Royale**: everyone pays the same entry and starts with $10,000 in phantom dollars. Trade live BTC, ETH and SOL prices long or short with 1x to 100x leverage. At three checkpoints the bottom quarter of the lobby is cut and anyone under the rising zone line is flooded out. Survivors split the pot pro rata to their profit.
- **Price Prediction**: pay the entry, call where BTC, ETH or SOL will close. Predictions are hidden until the lock. The closest quarter of players win, closest paid most. A protocol round is always open; players can also create their own rounds with a creator fee of up to 5%.
- **Stickman Duel**: one-on-one stickman fighting with combos, blocks, throws and cross-ups, practised in the browser against a bot at three levels. Ranked duels for a stake are built (contract, engine, replay settlement) but shown as "Coming soon" while the rules are tuned.

Play: <WEB_URL>
Engine: https://eroyale-production.up.railway.app (`/health`, `/lobbies`, `/rounds`, `/stats`)

Testnet only. The token is a mock USDC with an open `mint`; nothing here has real value. Players get a burner wallet in the browser and a relayer pays their entry.

## How to play

**Trading Royale** (`/play`, big screen `/arena`). Join the open lobby with a callsign. When it goes live, pick a market, set margin and leverage (detents at 10, 25, 50, 100) and tap LONG or SHORT; close a position to bank its profit or loss. The screen always tells you how far above or below the cut you are. Equity at or below zero liquidates you. Matches run 2 minutes (stage) or 6 minutes (standard) with checkpoints at each quarter. Finalists get 95% of the pot, split by profit above the start balance; 5% goes to the treasury.

**Price Prediction** (`/play?mode=predict`). Pick a round, join, and drag or nudge your price until the lock. After the lock everyone's call is revealed and the live price moves through them; at resolve the closest predictors win. Each winner gets their entry back plus a share weighted by rank (`equal`, `linear` or `steep` split). Create a round with `/play?mode=predict&screen=create`.

**Stickman Duel** (`/duel?mode=practice`). Best of three rounds. Keyboard: arrows to move, jump and crouch, Z = A (jab, air attack), X = B (heavy; down + B sweep), Z + X throw, hold away from the opponent to block. On touch: pad at bottom left, Block in the middle, A and B at bottom right. Bot levels: Sparring, Fighter, Master, plus a Dummy.

The big screen (`/arena`, 1920x1080) follows the current royale lobby or the protocol round; `?lobby=<id>` pins one. Screens have a mock mode for offline demos, for example `/?mock=island&at=overview`.

## Contracts (Base Sepolia, chain id 84532)

| Contract | Address |
| --- | --- |
| MockUSDC (6 decimals) | [0x60702429D3679fCCE9FC85E6D24c5dACc21E68F0](https://sepolia.basescan.org/address/0x60702429D3679fCCE9FC85E6D24c5dACc21E68F0) |
| RoyaleEscrow (royale and prediction) | [0xf4D071E6713C60200C7deDD905be46c31aFa9394](https://sepolia.basescan.org/address/0xf4D071E6713C60200C7deDD905be46c31aFa9394) |
| DuelEscrow | [0x6037eA43B1fD085605a05B0d238E495E332EB2a7](https://sepolia.basescan.org/address/0x6037eA43B1fD085605a05B0d238E495E332EB2a7) |
| Chainlink forwarder | [0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5](https://sepolia.basescan.org/address/0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5) |
| Treasury | [0x5589f6A1CF95aDD24Bf59b9ef1Fcc2e20AA134B4](https://sepolia.basescan.org/address/0x5589f6A1CF95aDD24Bf59b9ef1Fcc2e20AA134B4) |

Chain selector `10344971235874465080`. The full record is `contracts/deployments/base-sepolia.json`. Both escrows extend Chainlink's `ReceiverTemplate` (vendored under `contracts/src/vendor/`) and only release funds on a report.

## Settlement

The engine runs the game off chain and publishes a final book at `GET /lobbies/:id/final`: written once, identical bytes for every reader, `bookHash = keccak256(body)`. Scoring is one pure module, `shared/scoring.ts` (`settle` for royale, `predictSettle` for prediction), imported by both the engine and the workflow so they cannot disagree.

- **CRE workflow `royale-settle`** (`workflow/`) fetches the book, reads the settlement price for each market from Coinbase Exchange one-minute candles (the close of the candle before the end time), recomputes the payouts with `shared/scoring.ts` and writes `abi.encode(chainSelector, lobbyId, bookHash, winners, amounts)`. The escrow checks chain selector, lobby state and end time, registered and sorted winners, and the budget (`pot - fee - creatorFee`), marks the lobby settled, then pays the creator fee, the winners and the remainder to the treasury.
- **Why the simulator.** Deploying a workflow to a Chainlink DON needs an MNDA we do not have for this hackathon. So the workflow runs in the CRE CLI simulator with `--broadcast`, which sends the report on chain through the Chainlink forwarder to the escrow's `onReport`, the same entry point a DON would use. `npm run cre-settler` polls the hosted engine and settles each finished lobby and round this way.
- **Fallback.** If no CRE settlement lands within the wait window, the owner calls `settleFallback` with the same report bytes `buildReport` produces.
- **Duels.** The engine steps `shared/duel.ts` at 60 Hz and records the input bits it applied each tick. The book (`GET /duels/:id/final`) holds both input strings; `replay()` re-runs the match from them and must give the same winner and tick count before the duel report (`abi.encode(chainSelector, duelId, bookHash, winner)`) is built. Duels currently settle with `settleFallback`.

## Repository

| Path | What |
| --- | --- |
| `shared/` | `scoring.ts` (royale and prediction payouts) and `duel.ts` (duel rules, replay, bot). No imports, integers only; runs in Node, the browser and the CRE WASM runtime. |
| `contracts/` | Foundry: `MockUSDC`, `RoyaleEscrow`, `DuelEscrow`, deploy scripts, tests, deployment records. |
| `engine/` | Node game server: lobbies, rounds, duels, order and join signatures (EIP-712), relayer, bots, WebSocket feed, final books, `/stats`. `engine/Dockerfile` is the Railway image. |
| `workflow/` | CRE workflow `royale-settle`: `src/main.ts` handler, pure `buildReport` in `src/report.ts`. |
| `web/` | Next.js app: the 3D island (`/`, three.js), phone screens (`/play`, `/duel`), big screen (`/arena`). `web/Dockerfile` is the Railway image. |
| `scripts/` | `e2e-local.sh`: anvil end-to-end run. |

## Run locally

Requirements: Node 24 (the images use `node:24-slim`), npm, Foundry. Copy `.env.example` to `.env` (testnet keys only). With `CHAIN=off` the engine needs no chain and settles offline.

```sh
# engine on :8787
cd engine && npm ci
CHAIN=off npm run dev -- --bots 10                # royale lobby with 10 bots
CHAIN=off npm run dev -- --predict-bots 10        # also run prediction rounds with bots

# web on :3000, pointed at the local engine
cd web && npm ci
NEXT_PUBLIC_ENGINE_WS=ws://localhost:8787/ws NEXT_PUBLIC_ENGINE_HTTP=http://localhost:8787 npm run dev

# offline seeded simulation (same seed, same bytes)
cd engine && npm run sim -- --bots 20 --preset stage --seed 7 --out /tmp/book.json --events /tmp/events.jsonl
cd engine && npm run sim -- --mode predict --bots 12 --seed 7 --market BTC --out /tmp/pbook.json --events /tmp/pevents.jsonl

# contracts
cd contracts && forge build && forge test

# workflow: score a book the way the CRE handler does
cd workflow && npm ci
npm run score-fixture -- <book.json> <prices.json> <potUnits> <feeBps> <chainSelector>

# end to end
npm run e2e:local      # anvil chain, deploy, 20-bot match settled on chain
npm run cre-settler    # settle the hosted engine's finished lobbies via the CRE simulator (needs `cre login`)
```

Engine environment: `CHAIN` (`off`, `anvil`, `base-sepolia`), `RPC_URL`, `ESCROW_ADDRESS`, `DUEL_ESCROW_ADDRESS`, `SETTLE_MODE` (`cre`, `simulated`), `PRICE_SOURCE_URL`, `ORDER_SIG=off` to skip signature checks, `PORT`. Web build: `NEXT_PUBLIC_ENGINE_WS`, `NEXT_PUBLIC_ENGINE_HTTP`.
