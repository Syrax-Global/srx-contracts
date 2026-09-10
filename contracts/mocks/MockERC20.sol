// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice Minimal ERC-20 with configurable decimals, used in unit tests
 *         to simulate USDC (6 dec), USDT (6 dec), and WBTC (8 dec).
 */
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name, string memory symbol, uint8 decimals_)
        ERC20(name, symbol)
    {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
