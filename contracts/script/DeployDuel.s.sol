// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console } from "forge-std/Script.sol";

import { DuelEscrow } from "../src/DuelEscrow.sol";

/// @notice Deploys DuelEscrow beside the deployed RoyaleEscrow: same token, treasury, forwarder, relayer and chain
///         selector, read from deployments/<CHAIN>.json. Approves the new escrow from the relayer (joinFor pulls the
///         stake from it), hands ownership to ENGINE_OWNER_ADDRESS if set (default: the deployer, which is the key
///         the engine signs owner calls with), and adds "duelEscrow" to deployments/<CHAIN>.json.
/// @dev    Env: CHAIN, PRIVATE_KEY_DEPLOYER, PRIVATE_KEY_RELAYER, optional ENGINE_OWNER_ADDRESS.
///         The relayer key must match the deployment's relayer; the script refuses otherwise.
contract DeployDuel is Script {
    /// @dev Base Sepolia, Ethereum Sepolia, local anvil. Anything else is refused.
    error UnsupportedChain(uint256 chainId);

    error ChainIdMismatch(uint256 expected, uint256 actual);

    error RelayerMismatch(address expected, address actual);

    function run() external {
        if (block.chainid != 84532 && block.chainid != 11155111 && block.chainid != 31337) {
            revert UnsupportedChain(block.chainid);
        }

        string memory chain = vm.envString("CHAIN");
        string memory path = string.concat(vm.projectRoot(), "/deployments/", chain, ".json");
        string memory existing = vm.readFile(path);

        uint256 chainId = vm.parseJsonUint(existing, ".chainId");
        if (chainId != block.chainid) revert ChainIdMismatch(chainId, block.chainid);

        uint64 chainSelector = uint64(vm.parseUint(vm.parseJsonString(existing, ".chainSelector")));
        address forwarder = vm.parseJsonAddress(existing, ".forwarder");
        address token = vm.parseJsonAddress(existing, ".token");
        address treasury = vm.parseJsonAddress(existing, ".treasury");
        address relayer = vm.parseJsonAddress(existing, ".relayer");

        uint256 deployerKey = vm.envUint("PRIVATE_KEY_DEPLOYER");
        uint256 relayerKey = vm.envUint("PRIVATE_KEY_RELAYER");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envOr("ENGINE_OWNER_ADDRESS", deployer);

        if (vm.addr(relayerKey) != relayer) revert RelayerMismatch(relayer, vm.addr(relayerKey));

        vm.startBroadcast(deployerKey);

        DuelEscrow duelEscrow = new DuelEscrow(forwarder, token, chainSelector, treasury, relayer);

        if (owner != deployer) {
            duelEscrow.transferOwnership(owner);
        }

        vm.stopBroadcast();

        vm.startBroadcast(relayerKey);

        (bool ok, ) = token.call(abi.encodeWithSignature("approve(address,uint256)", address(duelEscrow), type(uint256).max));
        require(ok, "relayer approve failed");

        vm.stopBroadcast();

        console.log("DUEL_ESCROW_ADDRESS=%s", address(duelEscrow));
        console.log("owner=%s", duelEscrow.owner());

        _write(path, existing, address(duelEscrow));
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
