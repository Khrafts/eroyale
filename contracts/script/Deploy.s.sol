// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console } from "forge-std/Script.sol";

import { MockUSDC } from "../src/MockUSDC.sol";
import { RoyaleEscrow } from "../src/RoyaleEscrow.sol";

/// @notice Deploys MockUSDC (unless TOKEN_ADDRESS is set) and RoyaleEscrow, funds and approves the relayer,
///         and writes the addresses to deployments/<CHAIN>.json.
/// @dev    Env (names from .env.example): CHAIN, CHAIN_SELECTOR, FORWARDER_ADDRESS, PRIVATE_KEY_DEPLOYER,
///         PRIVATE_KEY_RELAYER, TREASURY_ADDRESS, optional TOKEN_ADDRESS, optional RELAYER_MINT (token units).
contract Deploy is Script {
    uint256 internal constant _DEFAULT_RELAYER_MINT = 1_000_000 * 1e6;

    function run() external {
        string memory chain = vm.envString("CHAIN");
        uint64 chainSelector = uint64(vm.envUint("CHAIN_SELECTOR"));
        address forwarder = vm.envAddress("FORWARDER_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY_DEPLOYER");
        uint256 relayerKey = vm.envUint("PRIVATE_KEY_RELAYER");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address token = vm.envOr("TOKEN_ADDRESS", address(0));
        uint256 relayerMint = vm.envOr("RELAYER_MINT", _DEFAULT_RELAYER_MINT);
        address relayer = vm.addr(relayerKey);

        vm.startBroadcast(deployerKey);

        if (token == address(0)) {
            token = address(new MockUSDC());
        }

        RoyaleEscrow escrow = new RoyaleEscrow(forwarder, token, chainSelector, treasury, relayer);

        if (relayerMint != 0) {
            MockUSDC(token).mint(relayer, relayerMint);
        }

        vm.stopBroadcast();

        vm.startBroadcast(relayerKey);
        MockUSDC(token).approve(address(escrow), type(uint256).max);
        vm.stopBroadcast();

        console.log("TOKEN_ADDRESS=%s", token);
        console.log("ESCROW_ADDRESS=%s", address(escrow));

        string memory key = "deployment";
        vm.serializeString(key, "chain", chain);
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeString(key, "chainSelector", vm.toString(uint256(chainSelector)));
        vm.serializeAddress(key, "forwarder", forwarder);
        vm.serializeAddress(key, "treasury", treasury);
        vm.serializeAddress(key, "relayer", relayer);
        vm.serializeAddress(key, "owner", vm.addr(deployerKey));
        vm.serializeAddress(key, "token", token);
        string memory json = vm.serializeAddress(key, "escrow", address(escrow));

        vm.writeJson(json, string.concat(vm.projectRoot(), "/deployments/", chain, ".json"));
    }
}
