/**
 * launch_checks.js — launch protection vs vesting (V6).
 *
 * maxWalletBalance caps the RECIPIENT of every transfer, including a vesting vault
 * paying out. A beneficiary who is not exempt can therefore be locked out of release()
 * for good once its unreleased entitlement plus what it already holds exceeds the cap.
 *
 * ⛔ The first version of this check (verify_tge) compared the cap with releasable()
 *    NOW. Right after launch every vault's releasable is 0 (all cliffs >= 30 days), so it
 *    could never fail: the deadlock arrives when a cliff ends (internal review, 7 Oct
 *    2026). It also skipped the Genesis buyers' vaults. This compares the cap with each
 *    beneficiary's FULL remaining entitlement, the worst case it can ever have to receive.
 *
 * Pure: takes plain values, returns failure strings (empty = no conflict possible).
 */
function walletCapConflicts({ cap, vaults }) {
  const failures = [];
  if (cap === 0n) return failures; // launch protection off: no conflict possible
  for (const v of vaults) {
    if (v.exempt) continue;
    const remaining = v.initialAllocation > v.released ? v.initialAllocation - v.released : 0n;
    const peak = v.beneficiaryBalance + remaining;
    if (peak > cap) {
      failures.push(
        `${v.label}: beneficiary ${v.beneficiary} is not exempt and could have to receive ${remaining} wei more ` +
        `(holding ${v.beneficiaryBalance}); above the ${cap} wallet cap its release() would revert. ` +
        `Exempt the beneficiary, or keep the cap above its whole entitlement.`);
    }
  }
  return failures;
}

/**
 * Addresses that must be exempt from launch protection before it is switched on.
 *
 * ⛔ Internal review, 7 Oct 2026, proven in test/LaunchProtectionStaking.test.js: with
 *    launch protection on, a staking unlock above maxTransferAmount reverts (the staking
 *    contract was not exempt), and once 0xdEaD has received early-exit penalties up to
 *    maxWalletBalance every further early exit reverts. Every protocol contract that
 *    moves SRX for users, and 0xdEaD, must be exempt first.
 *
 * Pure: `required` is [{ label, address }], `isExempt(address)` answers from the token.
 */
async function missingExemptions({ required, isExempt }) {
  const failures = [];
  for (const r of required) {
    if (!(await isExempt(r.address))) {
      failures.push(`${r.label} (${r.address}) is not exempt from launch protection; users' transfers through it can revert`);
    }
  }
  return failures;
}

module.exports = { walletCapConflicts, missingExemptions };
