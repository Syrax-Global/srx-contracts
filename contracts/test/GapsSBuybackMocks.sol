// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { MockERC20 } from "../mocks/MockERC20.sol";

/// @notice Test-only token whose allowances a test can set directly (to pre-seed a leftover allowance).
contract GapsSAllowanceToken is MockERC20 {
    constructor() MockERC20("Gaps Allowance Token", "GAT", 6) {}

    function forceAllowance(address owner, address spender, uint256 value) external {
        _approve(owner, spender, value, false);
    }
}

/// @notice Test-only token that debits the payer an extra 10% on every transferFrom (burned), i.e. a
///         swap pulling `value` can take 1.1 x value out of the payer. Models a token that lets a
///         router take more than the approved amount.
contract GapsSOverdebitToken is MockERC20 {
    constructor() MockERC20("Gaps Overdebit Token", "GOT", 6) {}

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _spendAllowance(from, msg.sender, value);
        _transfer(from, to, value);
        _burn(from, value / 10);
        return true;
    }
}

/// @notice Test-only router, same swap() signature as MockSwapRouter, that records the allowance the
///         caller (the burner) had granted it at the moment of the call.
contract GapsSProbeRouter {
    uint256 public allowanceSeen;
    bool    public called;

    function swap(address tokenIn, uint256 pull, address srx, uint256 srxOut, address srxTo) external {
        called = true;
        allowanceSeen = IERC20(tokenIn).allowance(msg.sender, address(this));
        if (pull > 0) IERC20(tokenIn).transferFrom(msg.sender, address(this), pull);
        IERC20(srx).transfer(srxTo, srxOut);
    }
}
