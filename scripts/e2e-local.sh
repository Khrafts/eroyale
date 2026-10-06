#!/usr/bin/env bash
# npm run e2e:local: start anvil, deploy MockUSDC + RoyaleEscrow with anvil's well-known dev keys, run the e2e
# against it. Nothing here touches a public network. Settlement marks still come from the real Coinbase candles.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ANVIL_PORT:-8645}"
command -v anvil >/dev/null || { echo "anvil not found (install Foundry)"; exit 2; }

# Anvil default accounts 0-3 (public test mnemonic; worthless keys).
export CHAIN=anvil
export RPC_URL="http://127.0.0.1:$PORT"
export PRIVATE_KEY_DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export PRIVATE_KEY_RELAYER=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
export FORWARDER_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC   # account 2 stands in for the forwarder
export TREASURY_ADDRESS=0x90F79bf6EB2c4f870365E785982E1f101E93b906    # account 3
export CHAIN_SELECTOR=10344971235874465080                            # Base Sepolia's; any value works locally
export PRICE_SOURCE_URL='https://api.exchange.coinbase.com/products/{MARKET}-USD/candles?granularity=60&start={START}&end={END}'
export SETTLE_MODE=simulated
export E2E_PORT="${E2E_PORT:-8811}"   # not the testnet e2e's 8799, so both can run at once
unset TOKEN_ADDRESS ESCROW_ADDRESS RELAYER_MINT

if ! curl -sf -m 10 -o /dev/null "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60"; then
  echo "Coinbase candles unreachable; the e2e needs PRICE_SOURCE_URL for the final marks"; exit 2
fi

# Never reuse a node someone else is running on this port (it may be a fork of a real chain).
if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then echo "port $PORT is in use; set ANVIL_PORT to a free port"; exit 2; fi
LOG="$(mktemp -t royale-anvil)"
# --block-time 1: blocks keep coming, so block time passes the escrow's end time without other traffic.
anvil --port "$PORT" --block-time 1 --silent > "$LOG" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 50); do cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 && break; sleep 0.2; done
kill -0 "$ANVIL" 2>/dev/null || { echo "anvil did not start:"; cat "$LOG"; exit 1; }
[ "$(cast chain-id --rpc-url "$RPC_URL")" = 31337 ] || { echo "$RPC_URL is not a fresh anvil (chain id is not 31337)"; exit 1; }

cd "$ROOT/contracts"
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast --slow > "$LOG.deploy" 2>&1 || { tail -30 "$LOG.deploy"; exit 1; }
TOKEN_ADDRESS=$(sed -n 's/.*TOKEN_ADDRESS=\(0x[0-9a-fA-F]*\).*/\1/p' "$LOG.deploy" | head -1)
ESCROW_ADDRESS=$(sed -n 's/.*ESCROW_ADDRESS=\(0x[0-9a-fA-F]*\).*/\1/p' "$LOG.deploy" | head -1)
export TOKEN_ADDRESS ESCROW_ADDRESS
echo "[e2e:local] anvil on $RPC_URL, MockUSDC $TOKEN_ADDRESS, RoyaleEscrow $ESCROW_ADDRESS"

cd "$ROOT/engine"
npx tsx scripts/e2e.mts "$@"
