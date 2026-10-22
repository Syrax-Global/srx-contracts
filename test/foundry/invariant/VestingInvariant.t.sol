// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";
import {VestingVault} from "../../../contracts/vesting/VestingVault.sol";
import {MockLZEndpoint} from "../../../contracts/mocks/MockLZEndpoint.sol";
import {VestingHandler} from "../helpers/VestingHandler.sol";

/**
 * @title VestingInvariant
 * @notice Four VestingVaults with different cliff / vesting / TGE-unlock shapes, driven by
 *         random triggerTGE, release, time and revoke (to the recipient fixed at deployment), plus donations and
 *         an optional declared allocation.
 *
 *   VEST-1  released <= initialAllocation: nothing is released above what was granted.
 *   VEST-2  vestedAmount() <= initialAllocation.
 *   VEST-3  After revoke, the beneficiary total + the revoke recipient total ==
 *           initialAllocation: nothing is created or lost.
 *   VEST-4  While live (TGE triggered, not revoked) the vault holds >=
 *           initialAllocation - released: the unreleased grant is always backed.
 *   VEST-5  Conservation: vault balance + beneficiary + recipient == funded + donated, always.
 *   VEST-6  The beneficiary has received exactly what the vault says it released.
 *   VEST-7  vestedAmount() never decreased with time on a live vault (ghost counter).
 *
 * Run: forge test --match-contract VestingInvariant -vv
 */
contract VestingInvariant is Test {
    SRXToken internal srx;
    VestingHandler internal handler;
    VestingVault[] internal vaults;
    address internal constant ADMIN = address(0xAD);

    uint256 internal constant N = 4;

    function setUp() public {
        MockLZEndpoint ep = new MockLZEndpoint(40161);
        srx = new SRXToken(address(ep), ADMIN);
        vm.prank(ADMIN);
        srx.genesis(ADMIN);

        // cliff, vesting, tge unlock (bps), funded amount (odd wei so the rounding is exercised)
        uint256[4] memory cliff   = [uint256(90 days), 0, 30 days, 180 days];
        uint256[4] memory vest    = [uint256(365 days), 180 days, 0, 720 days];
        uint256[4] memory tge     = [uint256(0), 1_000, 2_500, 0];
        uint256[4] memory funded  = [uint256(1_000_000e18 + 7), 250_000e18 + 3, 77_777e18 + 1, 5_000_000e18 + 999];

        VestingVault[] memory vs = new VestingVault[](N);
        address[] memory recips = new address[](N);
        uint256[] memory fundedArr = new uint256[](N);
        for (uint256 i; i < N; i++) {
            address beneficiary = address(uint160(0xBE00 + i));
            recips[i] = address(uint160(0x7E00 + i));
            vs[i] = new VestingVault(address(srx), beneficiary, ADMIN, cliff[i], vest[i], tge[i], recips[i]); // the recipient is fixed at deployment (internal audit M2)
            vm.prank(ADMIN);
            srx.transfer(address(vs[i]), funded[i]);
            fundedArr[i] = funded[i];
            vaults.push(vs[i]);
        }

        handler = new VestingHandler(srx, ADMIN, vs, recips, fundedArr);
        targetContract(address(handler));
    }

    // ── invariants ───────────────────────────────────────────────────────────

    function invariant_VEST1_releasedNeverExceedsGrant() public view {
        for (uint256 i; i < N; i++) {
            assertLe(vaults[i].released(), vaults[i].initialAllocation(), "released above grant");
        }
    }

    function invariant_VEST2_vestedNeverExceedsGrant() public view {
        for (uint256 i; i < N; i++) {
            assertLe(vaults[i].vestedAmount(), vaults[i].initialAllocation(), "vested above grant");
        }
    }

    function invariant_VEST3_afterRevokeNothingCreatedOrLost() public view {
        for (uint256 i; i < N; i++) {
            if (!vaults[i].revoked()) continue;
            uint256 toBeneficiary = srx.balanceOf(vaults[i].beneficiary());
            uint256 toRecipient   = srx.balanceOf(handler.recipients(i));
            assertEq(toBeneficiary + toRecipient, vaults[i].initialAllocation(), "revoke created or lost SRX");
        }
    }

    function invariant_VEST4_unreleasedGrantIsBackedWhileLive() public view {
        for (uint256 i; i < N; i++) {
            if (!vaults[i].tgeTriggered() || vaults[i].revoked()) continue;
            assertGe(
                srx.balanceOf(address(vaults[i])),
                vaults[i].initialAllocation() - vaults[i].released(),
                "grant not backed"
            );
        }
    }

    function invariant_VEST5_conservation() public view {
        for (uint256 i; i < N; i++) {
            uint256 total = srx.balanceOf(address(vaults[i]))
                + srx.balanceOf(vaults[i].beneficiary())
                + srx.balanceOf(handler.recipients(i));
            assertEq(total, handler.ghost_funded(i) + handler.ghost_donated(i), "SRX created or lost");
        }
    }

    function invariant_VEST6_beneficiaryReceivedExactlyWhatWasReleased() public view {
        for (uint256 i; i < N; i++) {
            assertEq(srx.balanceOf(vaults[i].beneficiary()), vaults[i].released());
        }
    }

    function invariant_VEST7_vestedNeverRegressesWhileLive() public view {
        assertEq(handler.ghost_vestedRegressions(), 0);
    }

    /// Positive control: the campaign really drove the handler.
    function afterInvariant() external view {
        assertGt(handler.ghost_calls(), 0, "the campaign never acted");
    }

    // ── positive control (deterministic) ─────────────────────────────────────

    /// A scripted run proves the checks run on live numbers: TGE, partial release, a
    /// revoke mid-vesting and a donation, then every invariant is evaluated.
    function test_positiveControl_scriptedRunMakesTheInvariantsNonVacuous() public {
        handler.triggerTGE(0);
        handler.triggerTGE(1);
        handler.triggerTGE(2);
        handler.triggerTGE(3);
        assertEq(handler.ghost_tges(), 4, "TGE not triggered on all vaults");

        handler.donate(1, 12345);
        handler.warp(100 days, 1);
        handler.release(1);                  // 10% at TGE + linear: vault 1 has no cliff
        handler.release(2);                  // 25% at TGE, linear part is instant after the cliff (30d)
        handler.warp(60 days, 1);
        handler.revoke(0, 0);                // vault 0 mid-vesting
        handler.revoke(3, 0);                // vault 3 still inside its cliff
        assertEq(handler.ghost_revokes(), 2, "revokes did not both succeed");
        assertGt(handler.ghost_releases(), 0, "no release succeeded");
        assertGt(vaults[1].released(), 0);
        assertTrue(vaults[0].revoked());
        assertGt(srx.balanceOf(handler.recipients(0)), 0, "unvested part not returned");
        assertGt(srx.balanceOf(vaults[0].beneficiary()), 0, "vested part not paid on revoke");

        invariant_VEST1_releasedNeverExceedsGrant();
        invariant_VEST2_vestedNeverExceedsGrant();
        invariant_VEST3_afterRevokeNothingCreatedOrLost();
        invariant_VEST4_unreleasedGrantIsBackedWhileLive();
        invariant_VEST5_conservation();
        invariant_VEST6_beneficiaryReceivedExactlyWhatWasReleased();
        invariant_VEST7_vestedNeverRegressesWhileLive();
    }
}
