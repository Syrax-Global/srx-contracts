// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";
import {SRXOFTNative} from "../../../contracts/bridge/SRXOFTNative.sol";
import {MockLZEndpoint} from "../../../contracts/mocks/MockLZEndpoint.sol";
import {BridgeHandler} from "../helpers/BridgeHandler.sol";

/**
 * @title BridgeConservationInvariant
 * @notice Cross-chain conservation under an adversarial spoke (external disclosure A,
 *         internal review 7 Oct 2026: the token invariants above never bridged, so
 *         INV-1 held only because nothing was ever sent).
 *
 *   BRIDGE-1  Ethereum: hub supply + outstanding to the spoke + burned == 10B, exactly.
 *   BRIDGE-2  Across both chains: spoke supply + returns in flight
 *             == outstanding + forged mints. Whatever was forged is the only thing unbacked.
 *   BRIDGE-3  However a forger times it, Ethereum credits at most
 *             Lmax x (1 + elapsed / 24 h), Lmax being the highest limit governance set.
 *   BRIDGE-4  Hub supply never exceeds MAX_SUPPLY.
 *
 * Run: forge test --match-contract BridgeConservationInvariant -vv
 *      (the nightly profile raises it to 1,024 runs x 100 calls)
 */
contract BridgeConservationInvariant is Test {
    SRXToken internal hub;
    SRXOFTNative internal spoke;
    BridgeHandler internal handler;
    address internal constant ADMIN = address(0xAD);

    function setUp() public {
        MockLZEndpoint hubEp = new MockLZEndpoint(40161);
        MockLZEndpoint spokeEp = new MockLZEndpoint(40102);
        hub = new SRXToken(address(hubEp), ADMIN);
        spoke = new SRXOFTNative(address(spokeEp), ADMIN, 40161, address(hub));
        vm.startPrank(ADMIN);
        hub.genesis(ADMIN);
        hub.setPeer(40102, bytes32(uint256(uint160(address(spoke)))));
        spoke.setPeer(40161, bytes32(uint256(uint160(address(hub)))));
        hub.setInboundLimit(40102, 10_000_000e18);
        hub.grantRole(hub.PAUSER_ROLE(), ADMIN); // the guardian's fast freeze, held by ADMIN here
        vm.stopPrank();

        handler = new BridgeHandler(hub, spoke, hubEp, spokeEp, ADMIN);
        address alice = handler.alice(); // read first: an external call would use up the prank
        vm.prank(ADMIN);
        hub.transfer(alice, 500_000_000e18);

        targetContract(address(handler));
    }

    function invariant_BRIDGE1_hubAccountingExact() public view {
        assertEq(hub.totalSupply() + hub.outstandingByEid(40102) + hub.totalBurned(), hub.MAX_SUPPLY());
    }

    function invariant_BRIDGE2_onlyForgedSrxIsUnbacked() public view {
        assertEq(spoke.totalSupply() + handler.ghost_pendingSum(), hub.outstandingByEid(40102) + handler.ghost_forgedMinted());
    }

    function invariant_BRIDGE3_forgeryBoundedByTheLimit() public view {
        uint256 lmax = handler.ghost_lmax();
        uint256 elapsed = block.timestamp - handler.ghost_t0();
        assertLe(handler.ghost_credited(), lmax + (lmax * elapsed) / 1 days);
    }

    function invariant_BRIDGE4_supplyCap() public view {
        assertLe(hub.totalSupply(), hub.MAX_SUPPLY());
    }

    /// Positive control: show the campaign actually exercised refusals and forgeries.
    function afterInvariant() external view {
        assertGt(handler.ghost_forgedMinted() + handler.ghost_credited(), 0, "the campaign never bridged");
    }
}
