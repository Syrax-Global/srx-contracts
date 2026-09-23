// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test-only swap router. Pulls `pull` of `tokenIn` from the caller and
///         sends `srxOut` of pre-funded SRX to `srxTo` — so a test can model an
///         honest swap, a swap that pays the burner 1 wei and the attacker the rest,
///         or a swap that pulls less than it was approved for.
contract MockSwapRouter {
    function swap(address tokenIn, uint256 pull, address srx, uint256 srxOut, address srxTo) external {
        if (pull > 0) IERC20(tokenIn).transferFrom(msg.sender, address(this), pull);
        IERC20(srx).transfer(srxTo, srxOut);
    }
}
