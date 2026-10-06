// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { ERC20 } from "./vendor/openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  MockUSDC
/// @notice Testnet stand-in for USDC: 6 decimals, anyone can mint.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    /// @notice Mints `amount` to `to`. Open to anyone; testnet only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
