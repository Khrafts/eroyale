// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console } from "forge-std/Script.sol";

import { DuelEscrow } from "../src/DuelEscrow.sol";

/// @notice Deploys DuelEscrow beside the deployed RoyaleEscrow: same token, treasury, forwarder, relayer and chain
///         selector, read from deployments/<CHAIN>.json. Ownership ends on ENGINE_OWNER_ADDRESS if set, else on the
///         address of PRIVATE_KEY_DEPLOYER (the key the engine signs owner calls with).
/// @dev    Env:
///         CHAIN                      required.
///         PRIVATE_KEY_DUEL_DEPLOYER  optional broadcaster; defaults to PRIVATE_KEY_DEPLOYER.
///         PRIVATE_KEY_DEPLOYER       required unless both PRIVATE_KEY_DUEL_DEPLOYER and ENGINE_OWNER_ADDRESS are set.
///         ENGINE_OWNER_ADDRESS       optional final owner.
///         APPROVE_FROM_RELAYER=1     optional: also approve the escrow from the relayer (needs PRIVATE_KEY_RELAYER).
///                                    Off by default: the hosted engine owns the relayer nonce and approves lazily.
///         WRITE_DEPLOYMENT=1         optional: add "duelEscrow" to deployments/<CHAIN>.json. Off by default so a
///                                    dry run never records an undeployed address; set it only with --broadcast.
contract DeployDuel is Script {
    /// @dev Base Sepolia, Ethereum Sepolia, local anvil. Anything else is refused.
    error UnsupportedChain(uint256 chainId);

    error ChainIdMismatch(uint256 expected, uint256 actual);

    error RelayerMismatch(address expected, address actual);

    error NoOwner();

    function run() external {
        if (block.chainid != 84532 && block.chainid != 11155111 && block.chainid != 31337) {
            revert UnsupportedChain(block.chainid);
        }

        string memory chain = vm.envString("CHAIN");
        string memory path = string.concat(vm.projectRoot(), "/deployments/", chain, ".json");
        string memory existing = vm.readFile(path);

        uint256 chainId = vm.parseJsonUint(existing, ".chainId");
        if (chainId != block.chainid) revert ChainIdMismatch(chainId, block.chainid);

        address relayer = vm.parseJsonAddress(existing, ".relayer");
        address token = vm.parseJsonAddress(existing, ".token");

        uint256 deployerKey = vm.envOr("PRIVATE_KEY_DEPLOYER", uint256(0));
        uint256 broadcasterKey = vm.envOr("PRIVATE_KEY_DUEL_DEPLOYER", deployerKey);
        address owner = vm.envOr("ENGINE_OWNER_ADDRESS", deployerKey == 0 ? address(0) : vm.addr(deployerKey));

        if (broadcasterKey == 0 || owner == address(0)) revert NoOwner();

        vm.startBroadcast(broadcasterKey);

        DuelEscrow duelEscrow = new DuelEscrow(
            vm.parseJsonAddress(existing, ".forwarder"),
            token,
            uint64(vm.parseUint(vm.parseJsonString(existing, ".chainSelector"))),
            vm.parseJsonAddress(existing, ".treasury"),
            relayer
        );

        if (owner != vm.addr(broadcasterKey)) {
            duelEscrow.transferOwnership(owner);
        }

        vm.stopBroadcast();

        if (vm.envOr("APPROVE_FROM_RELAYER", false)) {
            uint256 relayerKey = vm.envUint("PRIVATE_KEY_RELAYER");

            if (vm.addr(relayerKey) != relayer) revert RelayerMismatch(relayer, vm.addr(relayerKey));

            vm.startBroadcast(relayerKey);

            (bool ok, ) = token.call(abi.encodeWithSignature("approve(address,uint256)", address(duelEscrow), type(uint256).max));
            require(ok, "relayer approve failed");

            vm.stopBroadcast();
        }

        console.log("DUEL_ESCROW_ADDRESS=%s", address(duelEscrow));
        console.log("owner=%s", duelEscrow.owner());

        if (vm.envOr("WRITE_DEPLOYMENT", false)) {
            _write(path, existing, address(duelEscrow));
        } else {
            console.log("WRITE_DEPLOYMENT not set: deployments/%s.json left unchanged", chain);
        }
    }

    /// @dev Rewrites the deployment file with every existing field plus duelEscrow.
    function _write(string memory path, string memory existing, address duelEscrow) internal {
        string memory key = "deployment";
        vm.serializeString(key, "chain", vm.parseJsonString(existing, ".chain"));
        vm.serializeUint(key, "chainId", vm.parseJsonUint(existing, ".chainId"));
        vm.serializeString(key, "chainSelector", vm.parseJsonString(existing, ".chainSelector"));
        vm.serializeAddress(key, "escrow", vm.parseJsonAddress(existing, ".escrow"));
        vm.serializeAddress(key, "forwarder", vm.parseJsonAddress(existing, ".forwarder"));
        vm.serializeUint(key, "maxCreatorFeeBps", vm.parseJsonUint(existing, ".maxCreatorFeeBps"));
        vm.serializeAddress(key, "owner", vm.parseJsonAddress(existing, ".owner"));
        vm.serializeAddress(key, "relayer", vm.parseJsonAddress(existing, ".relayer"));
        vm.serializeAddress(key, "token", vm.parseJsonAddress(existing, ".token"));
        vm.serializeAddress(key, "treasury", vm.parseJsonAddress(existing, ".treasury"));
        string memory json = vm.serializeAddress(key, "duelEscrow", duelEscrow);

        vm.writeJson(json, path);
    }
}
