#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

rpc=https://rpc-test.qday.info
explorer=https://explorer-test.qday.info
token=0x456569838f1d43009A91ebA4263147Afd7233483
chain_id=44005

action=${1:-}
if [[ "$action" != deploy && "$action" != verify ]]; then
  echo "Usage: $0 deploy | verify <aevum-pay-address>" >&2
  exit 1
fi
if [[ "$(cast chain-id --rpc-url "$rpc")" != "$chain_id" ]]; then
  echo "RPC did not report QDay Aevum testnet (44005)." >&2
  exit 1
fi

if [[ "$action" == deploy ]]; then
  : "${AEVUM_DEPLOYER_KEY:?Supply your own testnet-only deployer key in AEVUM_DEPLOYER_KEY}"
  forge script script/DeployAevumPay.s.sol:DeployAevumPay --rpc-url "$rpc" --broadcast
else
  address=${2:?Supply the deployed Aevum Pay address}
  [[ "$address" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "Invalid contract address." >&2; exit 1; }
  actual_token=$(cast call "$address" 'token()(address)' --rpc-url "$rpc")
  [[ "${actual_token,,}" == "${token,,}" ]] || { echo "Unexpected payment token." >&2; exit 1; }
  forge verify-contract --watch --chain-id "$chain_id" --verifier blockscout \
    --verifier-url "$explorer/api" \
    --constructor-args "$(cast abi-encode 'constructor(address)' "$token")" \
    "$address" src/AevumPay.sol:AevumPay
  printf '%s/address/%s?tab=contract\n' "$explorer" "$address"
fi
