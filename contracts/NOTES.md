<!-- status -->
Step: 8 of 8 done + spec-checker fixes (write status checks, endTime guards, raw-byte bookHash, floored budget)
Last gate: contracts -> GATE PASS contracts; workflow -> GATE PASS workflow
Next: lead deploys to Base Sepolia (commands below), then runs cre workflow simulate
Blockers: no CRE CLI, RPC_URL or deployer key in this session; nothing deployed or simulated
<!-- /status -->

# Contracts track notes

## Layout

- `contracts/src/RoyaleEscrow.sol`: escrow, `is IRoyaleEscrow, ReceiverTemplate`. `onReport` (via `_processReport`) and `settleFallback` both call `_settle`.
- `contracts/src/MockUSDC.sol`: 6 decimals, open `mint`.
- `contracts/src/vendor/`: Chainlink `IReceiver`, `ReceiverTemplate`, `IERC165` copied verbatim from the "Building Consumer Contracts" page, plus the OpenZeppelin v5.4.0 files they need. Sources and commits in `src/vendor/SOURCE.txt`.
- `contracts/lib/forge-std`: forge-std v1.9.7, committed (no submodule, so the repo root stays untouched).
- `contracts/test/RoyaleEscrow.t.sol`: the 15 required tests. Golden values are copied from `gates/fixtures/*.json` so the suite runs without `gates/`.
- `contracts/script/Deploy.s.sol`: deploys MockUSDC (unless `TOKEN_ADDRESS` is set) and RoyaleEscrow, mints `RELAYER_MINT` (default 1,000,000 mUSDC) to the relayer, approves the escrow from the relayer, writes `contracts/deployments/<CHAIN>.json`.
- `workflow/`: CRE project root and the `royale-settle` workflow folder at once (`project.yaml`, `workflow.yaml`, `config.*.json`, `package.json`). `src/report.ts` is the pure `buildReport`; `src/main.ts` is the handler; `src/prices.ts` builds the Coinbase candle URL and reads the close.

## Contract behaviour worth knowing

- `joinFor` is relayer-only (the constructor's `relayer`); `join` is open. Both need the payer to have approved the escrow.
- `cancel` works while Open or Live and refunds each entry to whoever paid it (relayer for `joinFor`).
- `_settle` checks, in order: chain selector; lobby Live; `block.timestamp > endTime`; equal lengths; every winner joined; winners strictly ascending; `sum(amounts) <= floor(pot * (10000 - 500) / 10000)` (same floor as `shared/scoring.ts`). Then status Settled, pot zeroed, bookHash stored, winners paid, `pot - sum` to treasury, `Settled(id, bookHash)`.
- `settleFallback` is `onlyOwner`; the contract has no mode flag, so "simulated mode only" is an operating rule, not enforced.
- `getLobby(id)` returns the struct the workflow reads: `(status, maxPlayers, duration, startTime, endTime, entry, playerCount, pot, bookHash)`; status Live = 2.

## Deploy (lead runs this; not run here)

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

## Operating rules

- Never call `setForwarderAddress(address(0))`: the vendored ReceiverTemplate then lets anyone call `onReport` with any payout.
- Never call `renounceOwnership()`: it kills `createLobby`, `start`, `cancel` and `settleFallback`, and stranded entries can no longer be refunded.
- A deployment whose forwarder is the MockKeystoneForwarder accepts reports nobody signed (the mock does not verify DON signatures). Treat such a deployment as throwaway; never put real value in it.

## Settling

`SETTLE_MODE=simulated` (the plan): deploy with `FORWARDER_ADDRESS` from `.env`, run `cre workflow simulate` (dry run, no `--broadcast`) to get the report bytes it would sign, and have the owner call `settleFallback` with those exact bytes. The handler logs the report as `report 0x...` before it writes. Without the CLI, the same bytes come from `scripts/score-fixture.ts`:

```bash
cd workflow
curl -s "$ENGINE_PUBLIC_URL/lobbies/1/final" -o /tmp/book.json      # exact bytes, do not reformat
echo '{"BTC":"...","ETH":"...","SOL":"..."}' > /tmp/prices.json     # closes per CLAUDE.md price source
POT=$(cast call "$ESCROW_ADDRESS" "getLobby(uint256)((uint8,uint16,uint32,uint64,uint64,uint96,uint32,uint256,bytes32))" 1 --rpc-url "$RPC_URL" | tr -d '()' | cut -d, -f8 | awk '{print $1}')
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

Each break was made in `RoyaleEscrow.sol`, `bash gates/contracts.sh` run, then restored with `git checkout`. None was committed; no test needed strengthening.

| Break | Gate result |
| --- | --- |
| Delete the strictly-ascending winners check | `[FAIL: next call did not revert as expected] test_RevertWhen_WinnersNotAscending()` |
| Delete the budget check | `[FAIL: next call did not revert as expected] test_RevertWhen_AmountsOverBudget()` |
| Delete the chain selector check | `[FAIL: next call did not revert as expected] test_RevertWhen_WrongChainSelector()` |
| Skip the lobby-status check in `_settle` | `[FAIL: Error != expected error: AmountsOverBudget(15000000 [1.5e7], 0) != LobbyNotLive(1)] test_RevertWhen_DoubleSettle()` (the zeroed pot still blocks a second payout) |
| Pay the fee before winners, each winner one unit less | `[FAIL: assertion failed: 33036936 != 33036937] test_SettleGoldenReport()` and `[FAIL: assertion failed: 12000000 != 12000001] test_SettleHappyPathFeeMaths()` |
