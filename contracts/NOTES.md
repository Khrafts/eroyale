<!-- status -->
Step: Phase 11 duel-contracts done: DuelEscrow + 14 tests, DeployDuel (not broadcast), workflow duel reports on shared/duel.ts
Last checks: contracts, workflow, predict-contracts, predict-workflow, duel-contracts (gates.next-duel) all PASS
Next: lead deploys DuelEscrow (11d) and fills duelEscrowAddress in workflow/config.*.json
Blockers: none
<!-- /status -->

# Contracts track notes

## Layout

- `contracts/src/RoyaleEscrow.sol`: escrow, `is IRoyaleEscrow, ReceiverTemplate`. `onReport` (via `_processReport`) and `settleFallback` both call `_settle`.
- `contracts/src/MockUSDC.sol`: 6 decimals, open `mint`.
- `contracts/src/vendor/`: Chainlink `IReceiver`, `ReceiverTemplate`, `IERC165` copied verbatim from the "Building Consumer Contracts" page, plus the OpenZeppelin v5.4.0 files they need. Sources and commits in `src/vendor/SOURCE.txt`.
- `contracts/lib/forge-std`: forge-std v1.9.7, committed (no submodule, so the repo root stays untouched).
- `contracts/test/RoyaleEscrowPredict.t.sol`: the 10 prediction-round tests for prediction rounds. Golden values copied from the predict fixtures.
- `contracts/test/RoyaleEscrow.t.sol`: the 15 royale tests. Golden values are copied from the fixtures so the suite runs on its own.
- `contracts/script/Deploy.s.sol`: deploys MockUSDC (unless `TOKEN_ADDRESS` is set) and RoyaleEscrow, mints `RELAYER_MINT` (default 1,000,000 mUSDC) to the relayer, approves the escrow from the relayer, writes `contracts/deployments/<CHAIN>.json`.
- `workflow/`: CRE project root and the `royale-settle` workflow folder at once (`project.yaml`, `workflow.yaml`, `config.*.json`, `package.json`). `src/report.ts` is the pure `buildReport`; `src/main.ts` is the handler; `src/prices.ts` builds the Coinbase candle URL and reads the close.

## Contract behaviour worth knowing

- `joinFor` is relayer-only (the constructor's `relayer`); `join` is open. Both need the payer to have approved the escrow.
- `cancel` works while Open or Live and refunds each entry to whoever paid it (relayer for `joinFor`).
- `_settle` checks, in order: chain selector; lobby Live; `block.timestamp > endTime`; equal lengths; every winner joined; winners strictly ascending; `sum(amounts) <= floor(pot * (10000 - 500) / 10000)` (same floor as `shared/scoring.ts`). Then status Settled, pot zeroed, bookHash stored, winners paid, `pot - sum` to treasury, `Settled(id, bookHash)`.
- `settleFallback` is `onlyOwner`; the contract has no mode flag, so "simulated mode only" is an operating rule, not enforced.
- `getLobby(id)` returns the struct the workflow reads: `(status, maxPlayers, duration, startTime, endTime, entry, playerCount, pot, bookHash, creator, creatorFeeBps)`; status Live = 2. `creator` and `creatorFeeBps` were appended for prediction rounds; the old 9-field ABI no longer matches the new deploy.
- `createRound(duration, entry, maxPlayers, creator, creatorFeeBps)`: `onlyOwner`, same range checks as `createLobby`, reverts `CreatorFeeTooHigh(fee, 500)` above `MAX_CREATOR_FEE_BPS`, `ZeroCreatorWithFee(fee)` for a zero creator with a fee, and `InvalidLobbyConfig` for a zero creator with `entry % 20 != 0`. Emits `LobbyCreated` then `RoundCreated(id, creator, creatorFeeBps)`. `createLobby` gives creator 0 and fee 0.
- Settling a lobby with a creator: `creatorFee = floor(pot * creatorFeeBps / 10000)`, budget `pot - floor(pot * 500 / 10000) - creatorFee` (predictSettle's maths); after status Settled it pays the creator, then winners, then `pot - creatorFee - sum` to the treasury. Without a creator the budget stays `floor(pot * 9500 / 10000)` (royale `settle()` maths), so royale lobbies are byte-for-byte unchanged. The two formulas differ only when `pot % 20 != 0`; `createRound` refuses a creator-less round whose entry is not a multiple of 20 (so its pot always is), and a round with a creator uses the predict formula, so each lobby gets exactly the budget its scorer computes. `createLobby` has no such rule; a predict round must be created with `createRound`.
- `cancel` on a round refunds every entry; the creator gets nothing.

## Deploy

Verified facts (Chainlink docs, Forwarder Directory and EVM client chain selector table):

| Thing | Base Sepolia value |
| --- | --- |
| CRE chain name | `ethereum-testnet-sepolia-base-1` |
| `CHAIN_SELECTOR` | `10344971235874465080` |
| MockKeystoneForwarder (simulation) | `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5` |
| KeystoneForwarder (deployed workflows) | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` |

```bash
# .env at the repo root needs: RPC_URL, CHAIN=base-sepolia, CHAIN_SELECTOR, FORWARDER_ADDRESS,
# PRIVATE_KEY_DEPLOYER, PRIVATE_KEY_RELAYER, TREASURY_ADDRESS (both keys funded with Base Sepolia ETH).
cd contracts
set -a; source ../.env; set +a
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast
cat deployments/$CHAIN.json            # copy token and escrow into .env as TOKEN_ADDRESS / ESCROW_ADDRESS

# First lobby (stage preset: 120 s, entry 5 mUSDC, 50 seats)
cast send "$ESCROW_ADDRESS" "createLobby(uint32,uint96,uint16)" 120 5000000 50 \
  --private-key "$PRIVATE_KEY_DEPLOYER" --rpc-url "$RPC_URL"
```

The relayer (engine) then calls `joinFor(id, player)`; the owner calls `start(id)` once 4+ players have joined.

`Deploy.s.sol` refuses any chain id other than 84532 (Base Sepolia), 11155111 (Ethereum Sepolia) or 31337 (anvil).

After every deploy, fill both `workflow/config.staging.json` and `workflow/config.production.json` (they ship with placeholders the workflow cannot run with):

- `escrowAddress`: the new escrow from `deployments/$CHAIN.json`.
- `engineUrl`: the engine's public base URL (`ENGINE_PUBLIC_URL`), no trailing slash.
- `chainName`: the CRE chain name for the deploy chain (`ethereum-testnet-sepolia-base-1` for Base Sepolia; look up Ethereum Sepolia's in the CRE docs if the cut line moves there).

## Redeploy for prediction rounds

The prediction-round escrow adds `createRound` and two `Lobby` fields, so the live escrow `0x0b533AcE73c79533cE6BBA3EbE2D5e9217B21eF1` must be replaced. Same command as above, with the existing token so balances carry over:

```bash
cd contracts
set -a; source ../.env; set +a
TOKEN_ADDRESS=0x60702429D3679fCCE9FC85E6D24c5dACc21E68F0 forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast
cat deployments/$CHAIN.json      # maxCreatorFeeBps: 500 marks the predict build; copy escrow into .env as ESCROW_ADDRESS
```

Then update `escrowAddress` in `workflow/config.staging.json` and `config.production.json`, and restart the engine with the new `ESCROW_ADDRESS` (its `getLobby` ABI must have the 11 fields). Open lobbies on the old escrow are not migrated: cancel them there first (refunds every entry). `RELAYER_MINT` mints again to the relayer; set `RELAYER_MINT=0` to skip.

Rounds: `cast send "$ESCROW_ADDRESS" "createRound(uint32,uint96,uint16,address,uint16)" <endTime - startTime> 5000000 50 <creator or 0x0> <feeBps> ...`. The engine owns this in normal operation.

## Workflow: prediction books

- `buildReport(rawBook, prices, potUnits, feeBps, chainSelector, onchain: OnchainRound | null)`, `OnchainRound = {creator: string; creatorFeeBps: number; entry: bigint; playerCount: number}` from `getLobby`. The argument is required (omitting it throws at runtime too); only the offline `scripts/score-fixture.ts` passes `null`.
- No `mode`: royale `settle()`, unchanged; refused if `onchain` carries a creator or fee. `mode: "predict"`: refuses unless `feeBps == params.feeBps` and `potUnits == players.length * params.entryUnits`, and, unless `onchain` is null, unless `params.creator` (null = zero address, lowercased compare), `params.creatorFeeBps` (0 when creator is null), `params.entryUnits == entry` and `players.length == playerCount` (`checkRoundParams`). Settlement price is `prices[params.market]`, then `predictSettle`.
- Checked by hand: wrong pot, fee, creator, creator fee, entry, player count, a royale book on a creator lobby and an omitted `onchain` each refuse; the golden predict book with matching on-chain values gives the golden amounts.
- The handler still fetches all three markets' candles for a predict book (one code path); only the round's market is used.
- Predict books go through the same `endTime` skew check: the engine must `start` a round so the on-chain `endTime` is within 60 s of the book's resolve time.

## For the engine

- `getLobby(uint256)` returns `(uint8 status, uint16 maxPlayers, uint32 duration, uint64 startTime, uint64 endTime, uint96 entry, uint32 playerCount, uint256 pot, bytes32 bookHash, address creator, uint16 creatorFeeBps)`. viem: `"function getLobby(uint256 id) view returns ((uint8 status, uint16 maxPlayers, uint32 duration, uint64 startTime, uint64 endTime, uint96 entry, uint32 playerCount, uint256 pot, bytes32 bookHash, address creator, uint16 creatorFeeBps))"`.
- Every `buildReport` call must pass the on-chain lobby: `{creator: l.creator, creatorFeeBps: Number(l.creatorFeeBps), entry: BigInt(l.entry), playerCount: Number(l.playerCount)}`. `engine/src/server.ts` on main calls it with 5 arguments; that call throws after this branch merges, so the engine change must land with or before it.
- Create creator-less rounds with an entry that is a multiple of 20 (the protocol's 5_000000 is).

## Stickman Duel: DuelEscrow

- `contracts/src/DuelEscrow.sol` (`is IDuelEscrow, ReceiverTemplate`), constructor `(forwarder, token, chainSelector, treasury, relayer)`. `RoyaleEscrow` is untouched.
- `getDuel(id)` returns `(status, stake, playerA, playerB, pot, bookHash, winner)`; status 0 None, 1 Open, 2 Live, 3 Settled, 4 Cancelled. playerA is the first `joinFor` (side 0), playerB the second.
- `createDuel(stake)` onlyOwner, ids from 1. `joinFor` relayer only, pulls the stake from the relayer, exactly two players (`DuelFull` on a third, `AlreadyJoined` on a repeat). `start` onlyOwner needs both (`NotEnoughPlayers`). `cancel` (Open or Live) refunds the whole pot to the relayer, which paid every stake. No end time: a duel settles as soon as it is Live.
- `_settle` (shared by `onReport` and `settleFallback`): chain selector; Live; winner zero or one of the two players; status Settled, bookHash and winner stored, pot zeroed; win: winner gets `pot - floor(pot * 500 / 10000)`, treasury the fee; draw (winner 0): each player (not the relayer) gets their stake; `Settled(id, bookHash, winner)`.
- Report: `abi.encode(uint64 chainSelector, uint256 duelId, bytes32 bookHash, address winner)`.
- Deploy (lead, 11d; not broadcast by this track): `cd contracts && forge script script/DeployDuel.s.sol --rpc-url $RPC_URL --broadcast` with `CHAIN`, `PRIVATE_KEY_DEPLOYER`, `PRIVATE_KEY_RELAYER` (and optional `ENGINE_OWNER_ADDRESS`, default the deployer, which is the key the engine signs owner calls with). It reads token, treasury, forwarder, relayer and chain selector from `deployments/<CHAIN>.json`, refuses if the relayer key or chain id differ, deploys, approves the new escrow from the relayer, and rewrites the JSON with `duelEscrow` added. Dry-run on a local anvil after Deploy.s.sol: deployed, owner the deployer, JSON written. Then set `DUEL_ESCROW_ADDRESS` in `.env` and `duelEscrowAddress` in `workflow/config.*.json` (zero until then; the duel handler refuses a zero address).

## Workflow: duel books

- `buildDuelReport(rawBook, chainSelector, onchain)` in `workflow/src/report.ts` (a separate export so `buildReport`'s return type, used by the engine, does not change; `buildReport` on a duel book throws). It refuses unless each `inputs[i]` has exactly `book.ticks` characters, replays both with `replay()` from `shared/duel.ts`, refuses unless `replay().ticks == book.ticks`, refuses a book `feeBps` other than 500, maps the winner index to `book.players[i]` (zero address for a draw), and encodes the duel report. With `onchain` (from `getDuel`) it also refuses unless the book's players (as a set) and `stakeUnits` equal the duel's. Returns `{duelId, winner, winnerIndex, rounds, ticks, payoutUnits, feeUnits, bookHash, report}`.
- `scripts/score-fixture.ts` keeps its five arguments; for a `mode: "duel"` book prices, potUnits and feeBps are ignored and it prints `{duelId, winner, winnerIndex, rounds, ticks, payoutUnits, feeUnits, bookHash, report}`.
- Handler: HTTP trigger `{"duelId": N}` reads `getDuel` from `duelEscrowAddress`, needs Live, each node GETs `/duels/N/final` and runs `buildDuelReport`, consensus on `{duelId, bookHash, winner, report}`, logs `report 0x…` (for `SETTLE_MODE=simulated`: owner calls `DuelEscrow.settleFallback` with those bytes), then `writeReport` to DuelEscrow. `{"lobbyId": N}` is unchanged. `cre-compile src/main.ts` builds the WASM.

## Operating rules

- Never call `setForwarderAddress(address(0))`: the vendored ReceiverTemplate then lets anyone call `onReport` with any payout.
- Never call `renounceOwnership()`: it kills `createLobby`, `start`, `cancel` and `settleFallback`, and stranded entries can no longer be refunded.
- A deployment whose forwarder is the MockKeystoneForwarder accepts reports nobody signed (the mock does not verify DON signatures). Treat such a deployment as throwaway; never put real value in it.

## Settling

`SETTLE_MODE=simulated` (the plan): deploy with `FORWARDER_ADDRESS` from `.env`, run `cre workflow simulate` (dry run, no `--broadcast`) to get the report bytes it would sign, and have the owner call `settleFallback` with those exact bytes. The handler logs the report as `report 0x...` before it writes. Without the CLI, the same bytes come from `scripts/score-fixture.ts`:

```bash
cd workflow
curl -s "$ENGINE_PUBLIC_URL/lobbies/1/final" -o /tmp/book.json      # exact bytes, do not reformat
echo '{"BTC":"...","ETH":"...","SOL":"..."}' > /tmp/prices.json     # closes per the settlement price source rule
POT=$(cast call "$ESCROW_ADDRESS" "getLobby(uint256)((uint8,uint16,uint32,uint64,uint64,uint96,uint32,uint256,bytes32,address,uint16))" 1 --rpc-url "$RPC_URL" | tr -d '()' | cut -d, -f8 | awk '{print $1}')
REPORT=$(npx tsx scripts/score-fixture.ts /tmp/book.json /tmp/prices.json "$POT" 500 "$CHAIN_SELECTOR" | node -pe 'JSON.parse(require("fs").readFileSync(0)).report')
cast send "$ESCROW_ADDRESS" "settleFallback(bytes)" "$REPORT" --private-key "$PRIVATE_KEY_DEPLOYER" --rpc-url "$RPC_URL"
```

CRE simulation of the real handler (needs the CRE CLI, `cre login`, Bun, and `CRE_ETH_PRIVATE_KEY` without `0x` in `workflow/.env`):

```bash
cd workflow
# fill config.staging.json: escrowAddress, engineUrl (= ENGINE_PUBLIC_URL)
bun install
RPC_URL=... cre workflow simulate . --target staging-settings   # dry run; do not add --broadcast
# HTTP trigger input when prompted: {"lobbyId": 1}
# then: cast send "$ESCROW_ADDRESS" "settleFallback(bytes)" <report from the simulation result> ...
```

Do not settle by broadcasting through the MockKeystoneForwarder. The handler treats a dry-run write as a failure (it requires `TX_STATUS_SUCCESS` and `RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS` and a tx hash), so a dry run may end with an error. The report bytes are logged first as a `[USER LOG] report 0x...` line; pass that hex to `settleFallback`. How the real CLI reports a dry-run write status has not been checked.

Handler guards: it reads `getLobby` at `LATEST_BLOCK_NUMBER` (Base Sepolia finality is too slow for a 120 s lobby; the escrow re-checks onchain), requires DON time > onchain `endTime`, rejects a book whose `endTime` differs from the onchain one by more than 60 s, and hashes the book response bytes as received (decoding a copy only to parse JSON).

## Switching to the KeystoneForwarder (SETTLE_MODE=deployed)

1. Deploy the workflow (`cre workflow deploy`), giving it a non-empty `authorizedKeys` list in `config.production.json` (deployed HTTP triggers reject an empty list).
2. As owner: `cast send "$ESCROW_ADDRESS" "setForwarderAddress(address)" 0xF8344CFd5c43616a4366C34E3EEE75af79a74482 ...`
3. As owner: `setExpectedWorkflowId(<workflow id>)` (or `setExpectedAuthor`). Never set these while still simulating: the MockKeystoneForwarder sends no metadata.

## What a human must do

- Fund the deployer and relayer with Base Sepolia ETH; fill `.env`.
- Install the CRE CLI, `cre login`, and run the simulation above; paste its output here.
- Choose the HTTP trigger's authorized signer for deployed mode.

## Could not verify

- `cre workflow simulate` never ran (no CLI). Verified instead: `tsc --noEmit` and the SDK's `cre-compile` (bundle, type check, runtime-compat check, Javy WASM build) both pass on `src/main.ts`.
- Using `workflow/` as both project root and workflow folder (`cre workflow simulate .`) is not shown in the docs; if the CLI rejects it, move `workflow.yaml` and `config.*.json` into a `royale-settle/` subfolder with `workflow-path: "../src/main.ts"`.
- Gas: `gasLimit` 3,000,000 in the configs. The 20-player golden settlement used about 1.44M gas in the test including setup; a full 50-player payout has not been measured.
- Coinbase from the DON: the request sends a `User-Agent` header; reachability from CRE nodes is untested. The parser was checked against a live Coinbase candle response.
- Candle timestamp uses the book's `endTime`, not the onchain one, so the report agrees with the engine's final marks. The handler refuses if they differ by more than 60 s (catches an engine writing milliseconds).

## Step 7: the tests bite

Each break was made in `RoyaleEscrow.sol`, the contracts checks run, then restored with `git checkout`. None was committed; no test needed strengthening.

| Break | Gate result |
| --- | --- |
| Delete the strictly-ascending winners check | `[FAIL: next call did not revert as expected] test_RevertWhen_WinnersNotAscending()` |
| Delete the budget check | `[FAIL: next call did not revert as expected] test_RevertWhen_AmountsOverBudget()` |
| Delete the chain selector check | `[FAIL: next call did not revert as expected] test_RevertWhen_WrongChainSelector()` |
| Skip the lobby-status check in `_settle` | `[FAIL: Error != expected error: AmountsOverBudget(15000000 [1.5e7], 0) != LobbyNotLive(1)] test_RevertWhen_DoubleSettle()` (the zeroed pot still blocks a second payout) |
| Pay the fee before winners, each winner one unit less | `[FAIL: assertion failed: 33036936 != 33036937] test_SettleGoldenReport()` and `[FAIL: assertion failed: 12000000 != 12000001] test_SettleHappyPathFeeMaths()` |

## The predict tests bite

Each break was made in `RoyaleEscrow.sol`, the prediction contracts checks run, then restored with `git checkout`. None was committed.

| Break | Gate result |
| --- | --- |
| Remove the creator-fee cap check in `createRound` | `[FAIL: next call did not revert as expected] test_RevertWhen_CreatorFeeOverCap()`; `GATE FAIL predict-contracts` |
| Pay the creator after the winners, budget unchanged | `[FAIL: assertion failed: <winner> != <creator>] test_CreatorPaidBeforeWinners()`; `GATE FAIL predict-contracts` |
| Drop the creator fee from the budget | `[FAIL: next call did not revert as expected] test_BudgetIncludesCreatorFee()`; `GATE FAIL predict-contracts` |

After restoring, the prediction contracts checks pass.
