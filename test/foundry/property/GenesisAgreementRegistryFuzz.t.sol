// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GenesisAgreementRegistry} from "../../../contracts/genesis/GenesisAgreementRegistry.sol";

/**
 * @title GenesisAgreementRegistryFuzz
 * @notice For any wallet, commitment and time: an acceptance is recorded for that
 *         wallet alone, at that time, once, and can never be overwritten.
 */
contract GenesisAgreementRegistryFuzz is Test {
    GenesisAgreementRegistry public registry;

    function setUp() public {
        registry = new GenesisAgreementRegistry();
    }

    function testFuzz_acceptIsRecordedOnceForThatWalletOnly(
        address wallet,
        address other,
        bytes32 commitment,
        uint32 warpBy
    ) public {
        vm.assume(commitment != bytes32(0));
        vm.assume(wallet != other);
        vm.warp(block.timestamp + warpBy);

        // A Vault transaction reaches the chain through Syrax's relayer: the relayer is
        // tx.origin and the Vault account is msg.sender. Only the Vault may be credited.
        vm.prank(wallet, other);
        registry.accept(commitment);
        uint256 at = registry.acceptedAt(wallet, commitment);
        assertEq(at, block.timestamp, "recorded time is the block time");
        assertEq(registry.acceptedAt(other, commitment), 0, "the relayer (or any other wallet) is not credited");

        vm.warp(block.timestamp + 1 days);
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(GenesisAgreementRegistry.AlreadyAccepted.selector, wallet, commitment));
        registry.accept(commitment);
        assertEq(registry.acceptedAt(wallet, commitment), at, "the first acceptance stands");
    }
}
