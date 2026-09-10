// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title VestingVault
 * @notice Time-locked linear vesting vault for a single beneficiary.
 *
 * Vesting model:
 *  - All schedules reference a shared TGE timestamp set by the admin.
 *  - Optional TGE unlock: a percentage of total allocation is immediately
 *    claimable at TGE (used for presale: 25% at TGE).
 *  - Cliff: no tokens vest during the cliff period after TGE.
 *  - Linear vesting: the remaining tokens vest linearly over the vesting duration
 *    starting from (TGE + cliff). The contract allows claiming at any time;
 *    "monthly" tranches are a UI convention, not an on-chain restriction.
 *
 * Allocation categories and their parameters:
 *  ┌───────────────────┬──────────┬──────────────┬──────────────┬──────────────┐
 *  │ Category          │ TGE BPS  │ Cliff        │ Vesting      │ SRX          │
 *  ├───────────────────┼──────────┼──────────────┼──────────────┼──────────────┤
 *  │ Founders          │   0      │ 365 days     │ 1095 days    │ 1,000,000,000│
 *  │ Core Team         │   0      │ 182 days     │  730 days    │   600,000,000│
 *  │ Seed Investors    │   0      │ 273 days     │  730 days    │   400,000,000│
 *  │ Presale           │ 2500     │   0 days     │  180 days    │ 1,400,000,000│
 *  │ Ecosystem DAO     │   0      │   0 days     │ 1460 days    │ 1,300,000,000│
 *  └───────────────────┴──────────┴──────────────┴──────────────┴──────────────┘
 *
 * Revocation: admin may revoke unvested tokens (e.g. if an investor breaches
 * agreement). Vested-but-unclaimed tokens are paid to the beneficiary; unvested
 * tokens are returned to the `revokeRecipient` (typically the treasury).
 */
contract VestingVault {
    using SafeERC20 for IERC20;

    // ── Immutable config ───────────────────────────────────────────────────────

    IERC20  public immutable token;
    address public immutable beneficiary;
    address public immutable admin;
    uint256 public immutable cliffDuration;   // seconds from TGE before any cliff-gated vesting
    uint256 public immutable vestingDuration; // seconds of linear vesting after cliff
    uint256 public immutable tgeUnlockBps;    // basis points (0-10000) released instantly at TGE

    // ── Mutable state ──────────────────────────────────────────────────────────

    uint256 public tgeTimestamp;
    bool    public tgeTriggered;
    uint256 public released;
    bool    public revoked;
    /// @notice Snapshot of the vault balance at TGE. Used by totalAllocation()
    ///         so the reported allocation is stable regardless of accidental
    ///         external transfers into this contract (L-01 fix).
    uint256 public initialAllocation;

    /// @notice The intended allocation, if declared before TGE. Zero means "not
    ///         declared", in which case triggerTGE() falls back to the balance.
    uint256 public expectedAllocation;

    // ── Events ─────────────────────────────────────────────────────────────────

    event ExpectedAllocationDeclared(uint256 amount);
    event TGETriggered(uint256 timestamp);
    event Released(address indexed beneficiary, uint256 amount);
    event Revoked(address indexed revokeRecipient, uint256 unvestedAmount);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error OnlyAdmin();
    error OnlyBeneficiary();
    error TGEAlreadyTriggered();
    error TGENotTriggered();
    error NothingToRelease();
    error VaultRevoked();
    error ZeroAddress();
    error InvalidBps();
    error AlreadyRevoked();
    error EmptyVault();
    error NoDonatedTokens(); // A6-VV-02: no surplus above original allocation to rescue
    error VaultNotRevoked(); // A6-VV-02: rescue only available after revocation
    /// @notice The declared allocation has already been set.
    error AllocationAlreadyDeclared();
    /// @notice The vault holds less than the declared allocation.
    error VaultUnderfunded(uint256 held, uint256 declared);

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(
        address _token,
        address _beneficiary,
        address _admin,
        uint256 _cliffDuration,
        uint256 _vestingDuration,
        uint256 _tgeUnlockBps
    ) {
        if (_token == address(0))       revert ZeroAddress();
        if (_beneficiary == address(0)) revert ZeroAddress();
        if (_admin == address(0))       revert ZeroAddress();
        if (_tgeUnlockBps > 10_000)    revert InvalidBps();

        token           = IERC20(_token);
        beneficiary     = _beneficiary;
        admin           = _admin;
        cliffDuration   = _cliffDuration;
        vestingDuration = _vestingDuration;
        tgeUnlockBps    = _tgeUnlockBps;
    }

    // ── Admin: TGE trigger ─────────────────────────────────────────────────────

    /**
     * @notice Start all vesting clocks. Called once by admin when TGE occurs.
     *         All VestingVaults for the same TGE should be triggered in the same tx
     *         via the TGEDistributor to ensure clock alignment.
     */
    /**
     * @notice Declare, once and before TGE, how much this vault is meant to hold.
     *
     * @dev ⛔ WITHOUT THIS, A DONATION BECOMES PART OF THE GRANT. triggerTGE()
     *      snapshots `token.balanceOf(address(this))`, so the vault has no idea
     *      what it was *supposed* to receive -- the allocation is simply whatever
     *      happens to be sitting there. Anything sent beforehand, including a
     *      transfer to the wrong address, silently vests to the beneficiary and
     *      cannot be recovered: rescueDonatedTokens() requires the vault to be
     *      REVOKED first, which is destructive and not something you do to fix a
     *      misdirected transfer. Proven in
     *      test/audit-poc/vesting-and-distribution.test.js V5.
     *
     * ⭐ Optional and additive. If it is never called the vault behaves exactly as
     *      before, so existing deployments and scripts are unaffected. When it IS
     *      called, the grant is what was declared, the surplus is recoverable
     *      before TGE, and triggerTGE() refuses to run on an underfunded vault --
     *      which also turns a silently-short grant into a failure at setup.
     * @param amount The intended allocation, in wei.
     */
    function declareExpectedAllocation(uint256 amount) external {
        if (msg.sender != admin)     revert OnlyAdmin();
        if (tgeTriggered)            revert TGEAlreadyTriggered();
        if (expectedAllocation != 0) revert AllocationAlreadyDeclared();
        if (amount == 0)             revert EmptyVault();
        expectedAllocation = amount;
        emit ExpectedAllocationDeclared(amount);
    }

    function triggerTGE() external {
        if (msg.sender != admin)  revert OnlyAdmin();
        if (tgeTriggered)         revert TGEAlreadyTriggered();
        // Guard against triggering on an empty vault. If tokens have not been sent
        // before triggerTGE() is called, initialAllocation would be snapshotted as 0
        // and the beneficiary could never claim — with no admin recovery function
        // this would permanently lock any tokens sent afterward (A2-L-03 fix).
        uint256 held = token.balanceOf(address(this));
        if (held == 0) revert EmptyVault();

        tgeTriggered      = true;
        tgeTimestamp      = block.timestamp;

        // If an allocation was declared, THAT is the grant and any surplus stays
        // outside it. Otherwise fall back to the balance, as before.
        if (expectedAllocation != 0) {
            if (held < expectedAllocation) revert VaultUnderfunded(held, expectedAllocation);
            initialAllocation = expectedAllocation;
        } else {
            initialAllocation = held;
        }
        emit TGETriggered(block.timestamp);
    }

    // ── View: vesting maths ────────────────────────────────────────────────────

    /**
     * @notice Total tokens originally deposited into this vault (vested + unvested + already released).
     *         Returns the balance snapshotted at TGE so accidental external transfers
     *         do not inflate the reported allocation (L-01 fix).
     *         Returns live balance + released before TGE is triggered (pre-TGE state).
     */
    function totalAllocation() public view returns (uint256) {
        // Pre-TGE: the live balance has already been REDUCED by anything released,
        // so `+ released` reconstructs the original. That is correct.
        if (!tgeTriggered) return token.balanceOf(address(this)) + released;

        // ⛔ POST-TGE THIS READ `initialAllocation + released`, AND DOUBLE-COUNTED.
        //    initialAllocation is a SNAPSHOT taken at triggerTGE (see :119,
        //    token.balanceOf(address(this))), so it already IS the whole
        //    allocation and does not shrink when tokens are released. Adding
        //    `released` to a snapshot applies a correction only the live-balance
        //    branch above needs.
        //
        //    The contract already contradicted itself: revoke() at :220 computes
        //    `initialAllocation - released` to get what REMAINS, which is only
        //    valid if initialAllocation alone is the total.
        //
        //    vestedAmount() consumes this, so the inflated total drove the release
        //    schedule and every release inflated it further. Measured on a
        //    founders-shaped vault: repeated release() extracted 999,855 of
        //    1,000,000 at the vesting MIDPOINT, where the schedule permits
        //    500,456 (test/audit-poc/vesting-and-distribution.test.js V1, V3).
        return initialAllocation;
    }

    /**
     * @notice Cumulative tokens vested up to now (including TGE unlock).
     *         Returns 0 if TGE has not been triggered or vault is revoked.
     */
    function vestedAmount() public view returns (uint256) {
        if (!tgeTriggered || revoked) return 0;

        uint256 total     = totalAllocation();
        uint256 tgeAmount = (total * tgeUnlockBps) / 10_000;
        uint256 remaining = total - tgeAmount;

        uint256 vested = tgeAmount;

        uint256 cliffEnd = tgeTimestamp + cliffDuration;
        if (block.timestamp >= cliffEnd) {
            if (vestingDuration == 0 || block.timestamp >= cliffEnd + vestingDuration) {
                vested += remaining;
            } else {
                uint256 elapsed = block.timestamp - cliffEnd;
                vested += (remaining * elapsed) / vestingDuration;
            }
        }

        return vested;
    }

    /**
     * @notice Tokens vested but not yet claimed.
     */
    function releasable() public view returns (uint256) {
        if (vestedAmount() <= released) return 0;
        return vestedAmount() - released;
    }

    // ── Beneficiary: claim ─────────────────────────────────────────────────────

    /**
     * @notice Claim all currently releasable tokens. Callable only by beneficiary.
     */
    function release() external {
        if (msg.sender != beneficiary) revert OnlyBeneficiary();
        if (!tgeTriggered)             revert TGENotTriggered();
        if (revoked)                   revert VaultRevoked();

        uint256 amount = releasable();
        if (amount == 0) revert NothingToRelease();

        released += amount;
        token.safeTransfer(beneficiary, amount);
        emit Released(beneficiary, amount);
    }

    // ── Admin: revoke ──────────────────────────────────────────────────────────

    /**
     * @notice Revoke unvested tokens. Pays out any vested-but-unclaimed balance
     *         to the beneficiary first, then returns the unvested remainder to
     *         `revokeRecipient` (normally the Treasury contract).
     *
     *         TGE must have been triggered before revocation. Revoking a pre-TGE
     *         vault would result in initialAllocation=0, so unvested=0 — nothing
     *         would be transferred to revokeRecipient — but `revoked=true` would
     *         block all future claims, permanently trapping any tokens in the vault
     *         with no admin recovery path (A3-M-02 fix).
     *
     * ⚠️  IRREVERSIBLE: Once revoked, there is no un-revoke mechanism. The admin
     *     should verify the `revokeRecipient` address carefully before calling.
     *     Sending unvested tokens to an incorrect or non-recoverable address results
     *     in permanent loss with no on-chain recourse (A5-L-01 documentation).
     *
     * After revocation, vestedAmount() returns 0 to freeze further claims.
     */
    function revoke(address revokeRecipient) external {
        if (msg.sender != admin)          revert OnlyAdmin();
        if (!tgeTriggered)                revert TGENotTriggered();
        if (revoked)                      revert AlreadyRevoked();
        if (revokeRecipient == address(0)) revert ZeroAddress();

        uint256 vestedSoFar    = vestedAmount();
        uint256 releasableNow  = vestedSoFar > released ? vestedSoFar - released : 0;
        // Use initialAllocation snapshot (not live balance) to compute unvested tokens.
        // The live balance could include accidentally donated tokens, which would
        // cause extra tokens to be swept to revokeRecipient rather than remaining
        // accessible or being returned to the donor (A2-M-03 fix).
        uint256 expected  = initialAllocation > released ? initialAllocation - released : 0;
        uint256 unvested  = expected > releasableNow ? expected - releasableNow : 0;

        revoked = true;

        if (releasableNow > 0) {
            released += releasableNow;
            token.safeTransfer(beneficiary, releasableNow);
            emit Released(beneficiary, releasableNow);
        }

        if (unvested > 0) {
            token.safeTransfer(revokeRecipient, unvested);
            emit Revoked(revokeRecipient, unvested);
        }
    }

    // ── Admin: post-revoke donation rescue ────────────────────────────────────

    /**
     * @notice Rescue tokens accidentally sent to this vault AFTER revocation.
     *
     * After `revoke()` fires, `revoked = true` and all release paths are blocked.
     * Any tokens subsequently transferred to this address are permanently stranded
     * because `release()` reverts with VaultRevoked and `revoke()` reverts with
     * AlreadyRevoked. This function provides the only recovery path (A6-VV-02 fix).
     *
     * Only transfers the SURPLUS above the original snapshotted allocation —
     * i.e. tokens that were donated AFTER revocation, not any portion of the
     * original beneficiary allocation. The original allocation was already fully
     * settled by `revoke()` (vested tokens paid out, unvested returned).
     *
     * @param recipient Address to receive the rescued tokens (admin-controlled).
     */
    function rescueDonatedTokens(address recipient) external {
        if (msg.sender != admin)     revert OnlyAdmin();
        if (recipient == address(0)) revert ZeroAddress();

        // ⭐ SURPLUS PATH. When the allocation was declared up front, the vault
        //    knows exactly what it owes, so anything above that is provably not
        //    part of the grant and can be returned WITHOUT revoking. Previously
        //    the only route to a misdirected transfer was revoke(), which
        //    destroys the vesting schedule to recover someone's typo.
        if (expectedAllocation != 0 && tgeTriggered && !revoked) {
            uint256 owed = initialAllocation > released ? initialAllocation - released : 0;
            uint256 held = token.balanceOf(address(this));
            if (held <= owed) revert NoDonatedTokens();
            uint256 surplus;
            unchecked { surplus = held - owed; }
            token.safeTransfer(recipient, surplus);
            return;
        }

        if (!revoked) revert VaultNotRevoked(); // otherwise, only after revoke

        // After revocation: initialAllocation = (released + unvested already swept).
        // Any live balance above `released` is pure donation — the original allocation
        // has been fully settled. We use `released` as the "already accounted for" anchor
        // because revoke() paid released tokens out and swept unvested to revokeRecipient.
        uint256 liveBalance = token.balanceOf(address(this));
        if (liveBalance == 0) revert NoDonatedTokens();

        token.safeTransfer(recipient, liveBalance);
    }
}
