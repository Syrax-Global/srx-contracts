// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice The part of SRXToken that BuybackBurner and SRXTreasury call.
/// @dev buyAndBurn burns from the CALLER's own balance only (A2-H-01 removed the `from`
///      parameter). One shared declaration: the same name was declared twice with different
///      members (Aderyn H-3, 22 Oct 2026).
interface ISRXBurnable {
    function buyAndBurn(uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}
