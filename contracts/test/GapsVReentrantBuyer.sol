// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title GapsVReentrantBuyer
 * @notice TEST ONLY. A contract that buys in a PreSaleRound and, while the round is
 *         paying it an ETH refund, tries to re-enter claimRefund() for another asset.
 *         Records what the round answered so a test can assert the exact refusal.
 */
contract GapsVReentrantBuyer {
    address public immutable round;

    /// @dev asset to try to claim from inside receive(); address(1) = disarmed
    address public reenterAsset = address(1);
    /// @dev true: revert the ETH receive when the re-entry is refused (the outer claim fails)
    bool public bubble;

    uint256 public reenterAttempts;
    bool public lastReenterOk;
    bytes public lastReenterRevert;

    constructor(address _round) {
        round = _round;
    }

    function arm(address asset, bool bubble_) external {
        reenterAsset = asset;
        bubble = bubble_;
    }

    function disarm() external {
        reenterAsset = address(1);
        bubble = false;
    }

    function buyETH() external payable {
        (bool ok, bytes memory ret) = round.call{ value: msg.value }(abi.encodeWithSignature("invest()"));
        if (!ok) _bubble(ret);
    }

    function buyUSDC(address usdc, uint256 amount) external {
        IERC20(usdc).approve(round, amount);
        (bool ok, bytes memory ret) = round.call(abi.encodeWithSignature("investWithUSDC(uint256)", amount));
        if (!ok) _bubble(ret);
    }

    function claim(address asset) external {
        (bool ok, bytes memory ret) = round.call(abi.encodeWithSignature("claimRefund(address,address)", asset, address(this)));
        if (!ok) _bubble(ret);
    }

    receive() external payable {
        if (reenterAsset != address(1)) {
            reenterAttempts++;
            (bool ok, bytes memory ret) =
                round.call(abi.encodeWithSignature("claimRefund(address,address)", reenterAsset, address(this)));
            lastReenterOk = ok;
            lastReenterRevert = ret;
            if (!ok && bubble) revert("GapsVReentrantBuyer: re-entry refused");
        }
    }

    function _bubble(bytes memory ret) private pure {
        assembly { revert(add(ret, 32), mload(ret)) }
    }
}
