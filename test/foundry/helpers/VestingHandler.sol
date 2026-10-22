// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";
import {VestingVault} from "../../../contracts/vesting/VestingVault.sol";

/**
 * @title VestingHandler
 * @notice Drives several VestingVaults (different cliff / duration / TGE unlock) through
 *         the admin's triggerTGE, an optional pre-TGE declared allocation, donations into
 *         a vault, the beneficiary's release, the passage of time and the admin's revoke
 *         at random times. Ghost variables record the funded and donated amounts so the
 *         invariant suite can check that nothing is created or lost, and that vested
 *         amounts never move backwards while a vault is live.
 */
contract VestingHandler is Test {
    SRXToken public srx;
    address public admin;
    VestingVault[] internal _vaults;
    address[] internal _recipients; // one revoke recipient per vault, so balances stay attributable

    uint256 internal constant UNIT = 1e18;

    // ghost state
    uint256 public ghost_calls;                   // handler entry points called (positive control)
    uint256 public ghost_tges;                    // successful triggerTGE()
    uint256 public ghost_releases;                // successful release()
    uint256 public ghost_revokes;                 // successful revoke()
    uint256 public ghost_declares;                // successful declareExpectedAllocation()
    uint256 public ghost_donations;               // donations made
    uint256 public ghost_vestedRegressions;       // times vestedAmount() fell on a live vault with time
    uint256[] public ghost_funded;                // per vault: SRX the admin funded it with
    uint256[] public ghost_donated;               // per vault: SRX donated on top

    modifier counted() { ghost_calls++; _; }

    constructor(SRXToken _srx, address _admin, VestingVault[] memory vaults_, address[] memory recipients_, uint256[] memory funded_) {
        srx = _srx; admin = _admin;
        for (uint256 i; i < vaults_.length; i++) {
            _vaults.push(vaults_[i]);
            _recipients.push(recipients_[i]);
            ghost_funded.push(funded_[i]);
            ghost_donated.push(0);
        }
    }

    function vaultCount() external view returns (uint256) { return _vaults.length; }
    function vaults(uint256 i) external view returns (VestingVault) { return _vaults[i]; }
    function recipients(uint256 i) external view returns (address) { return _recipients[i]; }

    function _idx(uint256 seed) internal view returns (uint256) { return seed % _vaults.length; }

    // ── admin ────────────────────────────────────────────────────────────────

    function triggerTGE(uint256 vaultSeed) external counted {
        VestingVault v = _vaults[_idx(vaultSeed)];
        vm.prank(admin);
        try v.triggerTGE() { ghost_tges++; } catch {}
    }

    /// @dev Declares an allocation at or below what the vault holds (pre-TGE only; the vault refuses later).
    function declareExpectedAllocation(uint256 vaultSeed, uint256 amountSeed) external counted {
        uint256 i = _idx(vaultSeed);
        uint256 amt = bound(amountSeed, 1, ghost_funded[i]);
        vm.prank(admin);
        try _vaults[i].declareExpectedAllocation(amt) { ghost_declares++; } catch {}
    }

    /// @dev Revoke at a random moment. Rare (1 in 5 calls) so the campaign also lives in unrevoked states.
    function revoke(uint256 vaultSeed, uint256 gate) external counted {
        if (gate % 5 != 0) return;
        uint256 i = _idx(vaultSeed);
        vm.prank(admin);
        try _vaults[i].revoke() { ghost_revokes++; } catch {} // goes to the fixed recipient, _recipients[i]
    }

    /// @dev Anyone can send SRX to a vault by mistake; it must never become part of the grant after TGE
    ///      (before TGE with no declared allocation it legitimately does).
    function donate(uint256 vaultSeed, uint256 amountSeed) external counted {
        uint256 i = _idx(vaultSeed);
        uint256 amt = bound(amountSeed, 1, 1_000 * UNIT);
        if (srx.balanceOf(admin) < amt) return;
        vm.prank(admin);
        try srx.transfer(address(_vaults[i]), amt) { ghost_donated[i] += amt; ghost_donations++; } catch {}
    }

    // ── beneficiary ──────────────────────────────────────────────────────────

    function release(uint256 vaultSeed) external counted {
        VestingVault v = _vaults[_idx(vaultSeed)];
        vm.prank(v.beneficiary());
        try v.release() { ghost_releases++; } catch {}
    }

    // ── time ─────────────────────────────────────────────────────────────────

    function warp(uint256 secs, uint256 mode) external counted {
        uint256[] memory before = new uint256[](_vaults.length);
        for (uint256 i; i < _vaults.length; i++) before[i] = _vaults[i].vestedAmount();

        uint256 d = mode % 3 == 0 ? bound(secs, 0, 1 days) : bound(secs, 0, 200 days);
        vm.warp(block.timestamp + d);

        // Vesting is monotone in time on a live vault (revoking zeroes it, so a vault revoked
        // in between is excluded by the unchanged revoked flag: nothing revokes during a warp).
        for (uint256 i; i < _vaults.length; i++) {
            if (!_vaults[i].revoked() && _vaults[i].vestedAmount() < before[i]) ghost_vestedRegressions++;
        }
    }
}
