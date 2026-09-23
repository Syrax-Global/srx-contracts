// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockFeeOnTransferERC20
 * @notice Test-only ERC-20 that burns a fee on every transfer, modelling USDT's
 *         dormant fee switch being turned on. Used to prove a payment is credited
 *         at what arrived, not at the nominal amount (PSR-12).
 */
contract MockFeeOnTransferERC20 is ERC20 {
    uint8 private immutable _dec;
    uint256 public feeBps;

    constructor(uint8 decimals_, uint256 feeBps_) ERC20("Fee Token", "FEE") {
        _dec = decimals_;
        feeBps = feeBps_;
    }

    function decimals() public view override returns (uint8) { return _dec; }

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps != 0) {
            uint256 fee = value * feeBps / 10_000;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}
