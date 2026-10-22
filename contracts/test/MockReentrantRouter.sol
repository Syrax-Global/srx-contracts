// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test-only hostile swap router (Slither reentrancy-balance, 7 Oct 2026). During
///         the swap it tries to call back into `target` with `reenterData`, records whether
///         that call succeeded and what it returned, then completes an honest swap so the
///         outer call can finish. A test then checks the call-back was refused.
contract MockReentrantRouter {
    address public target;
    bytes public reenterData;
    bool public reentered;
    bytes public reenterResult;

    function arm(address _target, bytes calldata _data) external {
        target = _target;
        reenterData = _data;
    }

    function swap(address tokenIn, uint256 pull, address srx, uint256 srxOut, address srxTo) external {
        (reentered, reenterResult) = target.call(reenterData);
        if (pull > 0) IERC20(tokenIn).transferFrom(msg.sender, address(this), pull);
        IERC20(srx).transfer(srxTo, srxOut);
    }
}
