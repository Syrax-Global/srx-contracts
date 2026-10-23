# SRX Token — External Audit Scope & Handoff Package

Prepared so that an external audit can begin quickly once an engagement is agreed.
This document gives an auditor everything needed to (a) quote accurately and (b) start fast.

⚠️ **The internal audits are done, and a few items from the latest one are still open for design
decisions (§6 and §7). An independent external audit is next, ahead of any mainnet deployment.
It is upcoming and has not been engaged. No external audit report exists**, and no outside firm
has reviewed this code.

**Package refreshed 22 October 2026** after a second internal review round (§6, "Review round,
22 October 2026"). The one before it, on 16 October, was our own internal audit of every
contract (§6), which followed twelve outside reports since 30 September. The refresh before that was 7 October,
after three external reports and a claims-against-tests review of every security statement in
the code and documents. The findings and fixes are in `REMEDIATION.md` (top section, then
12 Oct, 7 Oct, 1 Oct and 23 Sep); read it first, because it also lists what is still open.

---

## 1. Project Overview

**Syrax Token (SRX)** — the utility & governance token of the Syrax ecosystem. A fixed-supply
(10,000,000,000) ERC-20 with EIP-2612 Permit, ERC20Votes governance, and LayerZero V2 OFT
cross-chain transfer. Origin chain: Ethereum; bridged to BNB Chain and zkSync as spokes of an
Ethereum hub. Includes vesting, a presale (the Genesis round), staking (fee tiers + Synthetix
rewards), an on-chain treasury, a three-tier stabilisation fund, on-chain governance (Governor +
48h Timelock), a non-upgradeable guardian/circuit-breaker module, a buy-and-burn contract, a
Merkle airdrop. SRX reaches the Syrax Chain (the zkSync-based chain) through that chain's own
bridge (CH-13, 22 Oct 2026), not through a contract of this repository.

## 2. Repository & Commit

- **Repo:** `github.com/Syrax-Global/srx-token` (private — read access is granted to the audit
  team's GitHub handles, or an archive of the tagged commit is provided). A public mirror of the
  in-scope code is kept at `github.com/Syrax-Global/srx-contracts`.
- **Audit target:** the annotated tag named in the hand-off message. Audit the tag, not `main`.
  ⛔ The older tag `v0.9.0-audit` predates both remediation passes and is **not** the target.
- **No secrets in repo:** `.env` is gitignored; CI runs a secret scan on every push.

## 3. Scope

**In scope — 14 production contracts under `contracts/` (excluding `mocks/`, `test/`,
`echidna/`): 8,003 lines, 3,632 nSLOC** (non-blank, non-comment lines; measured 22 Oct 2026
after the review-round fixes (§6), with the retired `ZkSyncMigrator` out of scope (CH-13).
Earlier on 22 Oct, before those fixes, the figure was 7,907 lines and 3,592 nSLOC. On 16 Oct
it was 8,034 lines and 3,616 nSLOC for 15 contracts; this count's counter reads a line or two
lower per file than that one did. The earlier figures, 7,194 lines and 3,338 nSLOC on 25 Sep,
used a different counter and predate REG-50, REG-53, REG-54 and the 16 Oct fixes).

| Contract | Lines | nSLOC | Notes |
|---|---|---|---|
| `presale/PreSaleRound.sol` | 1,444 | 734 | ETH/BNB, USDC, USDT, WBTC purchases; approved buyers only, each capped at an agreed USD amount; Chainlink pricing; flat or tiered bonus; refunds; creates a VestingVault per investor |
| `staking/SRXStaking.sol` | 1,219 | 475 | Plain contract (REG-53). Fee-tier locks, one SRX reward stream from a fixed allocation (REG-50), irreversible wind-down |
| `stabilisation/StabilisationFund.sol` | 1,307 | 536 | Plain contract (REG-53). Three-tier deployment, depositor rewards from a fixed allocation (REG-50), irreversible wind-down |
| `guardian/GuardianModule.sol` | 1,057 | 619 | Non-upgradeable. Per-module pause, bridge-only circuit breaker, bounded guardian token pause, sunset at most 180 days |
| `staking/FeeController.sol` | 414 | 182 | Plain contract (REG-53). Fee calculator with a fixed 0.15% floor and 5% ceiling (REG-54), fee-destination table |
| `token/SRXToken.sol` | 643 | 256 | OFT hub + Permit + Votes + launch protection + per-chain outflow accounting + bridge-only stop + wind-down exits |
| `vesting/VestingVault.sol` | 371 | 157 | Single-beneficiary linear vesting, revoke, declared grant |
| `buyback/BuybackBurner.sol` | 322 | 137 | Capped swap-and-burn and direct burn |
| `governance/SRXGovernor.sol` | 209 | 124 | OZ Governor (timestamp clock; quorum on the fixed global cap) |
| `treasury/SRXTreasury.sol` | 227 | 103 | Plain contract (REG-53). Timelock-only spend, buy-and-burn |
| `bridge/SRXOFTNative.sol` | 301 | 129 | Spoke OFT: talks to the Ethereum hub only; refuses plain transfers to its own address; owner-only `rescueTokens` |
| `airdrop/SRXAirdrop.sol` | 221 | 82 | Chain-bound double-hash Merkle airdrop |
| `token/TGEDistributor.sol` | 197 | 78 | One-shot genesis distribution |
| `governance/SRXTimelock.sol` | 71 | 20 | OZ TimelockController, 48h on mainnet |

Also in scope but not counted above: `token/ITGEAllocationSource.sol` (10 lines), the interface a
reward pool reads its launch allocation through (a `TGEDistributor`, or a wound-down predecessor).

**Out of scope by default:** `contracts/mocks/`, `contracts/test/`, `contracts/echidna/`,
`test/`, OpenZeppelin and LayerZero library code.

**Out of scope: retired, not deployed (CH-13, 22 Oct 2026):**
`contracts/migration/ZkSyncMigrator.sol` (about 300 lines) and its tests stay in the
repository as history. SRX moves onto the Syrax Chain through the chain's own bridge: a holder
signs one deposit, the SRX is locked 1:1 in the Ethereum vault and appears on the Syrax Chain,
withdrawable back at any time. Holders on BNB Chain or ZKsync Era first return to the Ethereum
hub over the existing OFT bridge. Any future helper must be stateless and hold no funds and no
roles. `scripts/deploy/09_deploy_migrator.js` refuses to run, and `scripts/verify/verify_roles.js`
fails a network that declares a migrator.

**Out of scope, available on request:** `contracts/genesis/GenesisAgreementRegistry.sol` (50 lines).
It records, on the Syrax Chain, that a wallet accepted a Genesis purchase agreement: one
function, no admin, no funds, no upgrade path. Its commitment is the `agreementRef` that
`PreSaleRound.setBuyerApprovals` stores, so it is quoted separately rather than left out silently.

**Deployment and operations scripts — please quote as an option.** `scripts/deploy/`,
`scripts/ops/migrate_roles.js` and `scripts/verify/verify_roles.js` decide who holds power
after launch and move the full 10B supply. Two defects of that kind were found in this sweep
(DEP-01, DEP-02). We would value them in scope.

**Complexity flags for quoting:** no upgradeable contracts (REG-53); LayerZero V2 OFT in a
hub-and-spoke topology with hub-side outflow accounting; Chainlink integration with
per-feed staleness and bounds; two Synthetix-pattern reward systems with liability tracking;
Governor + Timelock with a two-phase role hand-over.

## 4. Tech Stack & Build

- Solidity **0.8.24**, `viaIR: true`, optimizer 200 runs, EVM `cancun`. Two files are the
  exception: `PreSaleRound.sol` and `SRXToken.sol` are built with optimizer `runs: 1` through a
  per-file override in `hardhat.config.js`, to stay under the size limit below. Behaviour is
  identical; gas per call is slightly higher. The Foundry suites still build at 200 runs, so
  their bytecode differs from the Hardhat build of those two files; their behaviour does not.
- **Hardhat** (unit/integration) + **Foundry** (invariants and property fuzzing).
- Dependencies, pinned by `package-lock.json` and installed with `npm ci` in CI:

  | Package | Version |
  |---|---|
  | `@openzeppelin/contracts` | 5.6.1 |
  | `@openzeppelin/contracts-upgradeable` | 5.6.1 (still installed, but no contract imports it since REG-53; only the verify gate's `hardhat-upgrades` check needs it) |
  | `@layerzerolabs/oft-evm` | 4.0.1 |
  | `@layerzerolabs/oapp-evm` | 0.4.1 |
  | `@layerzerolabs/lz-evm-protocol-v2` | 3.0.168 |

- **Known advisories in the JavaScript tooling (22 Oct 2026).** None reaches a deployed
  contract: the contracts compile from the Solidity sources of the packages above, and no
  JavaScript runs on chain.
  - `npm audit --omit=dev`: 15 Low, all `elliptic` through LayerZero's `ethers` v5 (used by
    its JavaScript helpers, which this repository's scripts and tests load). There is no fix
    upstream yet.
  - Development tools: no Critical. `handlebars` (via `solidity-coverage`) and
    `follow-redirects` are held at their fixed versions by `overrides` in `package.json`,
    and `certifi` in `scripts/ci/requirements-slither.txt` is at 2026.10.19. Nine High
    remain, every one development-only (coverage, test runner, gas report; none is loaded by
    a deploy script or reaches a contract):

    | Package | Path | Advisory |
    |---|---|---|
    | `braces` 3.0.3 | `solidity-coverage` › `globby` › `fast-glob` › `micromatch` › `braces` | GHSA-vfj7-8cjw-p6xm (deeply nested pattern, stack exhaustion; no patched release) |
    | `micromatch` 4.0.8 | `solidity-coverage` › `globby` › `fast-glob` › `micromatch` | via `braces` |
    | `fast-glob` 3.3.3 | `solidity-coverage` › `globby` › `fast-glob` | via `micromatch` |
    | `globby` 10.0.2 | `solidity-coverage` › `globby` | via `fast-glob` |
    | `chokidar` 3.6.0 | `solidity-coverage` › `mocha` 10 › `chokidar` | via `braces` |
    | `mocha` 10.8.2, 11.8.0 | `solidity-coverage` › `mocha`; `hardhat` › `mocha` | via `chokidar` and `diff` |
    | `solidity-coverage` 0.8.17 | direct (dev) | via `globby`, `mocha`, `web3-utils` |
    | `eth-gas-reporter` 0.2.27 | `hardhat-gas-reporter` 1 › `eth-gas-reporter` | via its `ethers` v5 and `mocha` |
    | `hardhat-gas-reporter` 1.0.10 | direct (dev), and through `@nomicfoundation/hardhat-toolbox` 5 | via `eth-gas-reporter` |

    The inputs these tools parse are this repository's own files, not outside data. They clear
    with the move to Hardhat 3 and its toolbox (gas reporter 2, current coverage tooling), a
    breaking upgrade scheduled after this audit's tag.
- Build: `npm ci` (the repo's `.npmrc` sets `legacy-peer-deps=true` for a LayerZero transitive
  peer conflict), then `npx hardhat compile`. Foundry: `forge build` with `forge-std` in `lib/`.
- `PreSaleRound` deploys `VestingVault` inline. Deployed code sizes, measured 22 Oct 2026 after
  the review-round fixes, against the EIP-170 limit of 24,576 bytes: `PreSaleRound` 24,421 bytes
  and `SRXToken` 23,645 bytes, both built with the `runs: 1` override above. `PreSaleRound` has
  155 bytes of headroom, so any change to either contract must re-check it
  (`npx hardhat size-contracts`).

## 5. Tests and static analysis

- **Hardhat:** 1,624 passing, 0 failing (`npx hardhat test`, 23 Oct 2026). The regression tests for the 16 Oct internal audit and the 22 Oct review round are in `test/internal-audit/` (`Review22Oct.Fixes`: each was red on the old code), with the mutation-gap and boundary tests (`MutationGaps22Oct`, `BoundaryGaps23Oct`, below) and launch delegation (`test/governance/Delegation.test.js`). The bridge integration suite (`test/Bridge.test.js`) was skipped until 8 Oct while REMEDIATION.md cited it; it now runs on real relayed messages.
- **Coverage** (`npx hardhat coverage`, 23 Oct 2026, the 14 in-scope contracts only, read from the
  JSON report the run writes): **99.08% of statements, 98.41% of branches.** Lowest: SRXGovernor 80% of
  statements (two OpenZeppelin pass-through overrides), FeeController 92.8% / 94.9%, SRXToken
  98.7% / 97.9%; eight contracts are at 100% of statements. The test groups that run deploy
  scripts in a child `hardhat run` are skipped under coverage only: a child process loses the
  instrumented hit counts (measured 87% with them, 96% without); they test the scripts, not the
  contracts. (7 Oct, 15 contracts: 98.1% / 83.9%.)
- **Mutation testing (22–23 Oct 2026).** Each mutant removes one access modifier or one guard
  (`if (...) revert`, `require`), or flips one comparison in a guard (`<` ↔ `<=`, `>` ↔ `>=`), in
  the 14 in-scope contracts; the whole Hardhat suite runs against each.
  - Modifier and guard removal: 548 mutants, 521 killed by the suite. Of the 27 survivors, 15
    are now killed by `test/internal-audit/MutationGaps22Oct.test.js` (each proved against its
    mutant) and 12 are equivalent: a parent function repeats the check (`transferOwnership` ×2;
    `Ownable(_admin)` rejects address 0 before the token's own check), an earlier check makes
    the guard unreachable (the spoke's `_srcEid`, the distributor's final supply re-check, the
    guardian's two overlapping repause checks), or `nonReentrant` on a path with no callback to
    the caller (the four purchase paths use only feed reads and the fixed payment tokens, and
    `refundInvestor` makes no external transfer).
  - Comparison flips: 108 mutants, 77 killed by the suite; 30 are now killed by
    `test/internal-audit/BoundaryGaps23Oct.test.js` (each test sits exactly on the boundary and
    one step before it) and 1 is equivalent (`FeeController.setFeeDestination`: the equality is
    handled by the branch above). No boundary was found to contradict its documentation.
  - Not run: deleting `emit` statements (146 mutants); events are asserted by the suite where
    monitoring depends on them.
- **Claims against tests (7 Oct 2026):** every "never / cannot / only / at most" statement in
  the natspec and the security documents was mapped to a test. 143 tests were added where none
  existed (`test/Gaps.*.test.js`); where the code was wrong it was fixed (REMEDIATION.md R7-01
  to R7-12), and where a comment promised more than the code does, the comment was corrected
  (R7-13).
- **Cross-chain conservation** (`test/BridgeConservation.property.test.js`): seeded random
  sequences of honest bridging, forged spoke mints, retried returns, limit changes and freezes.
  After every step: exact accounting on Ethereum and across both chains, the inbound limit
  equals a model draining bucket exactly, and what Ethereum credits stays within the limit
  times (1 + elapsed days). Replay one seed with `SRX_PROP_SEED`.
  `test/audit-poc/` holds the proof tests for every internal finding — each one was red on the
  code as found. Start there.
- **Foundry, cross-chain (8 Oct 2026):** 4 bridge invariants over a hub and a spoke driven by random
  honest bridging, forged spoke mints, refused and retried returns, limit changes and freezes
  (`test/foundry/invariant/BridgeConservationInvariant.t.sol`): Ethereum's accounting is exact,
  only forged SRX is unbacked, a forger gets at most the limit times (1 + elapsed days), and the
  supply cap holds. Green at 1,024 runs x 100 calls; removing the hub's limit fails it.
- **Foundry:** 33 invariants across 6 files: 7 token invariants (supply equation, balance sum,
  voting power ≤ supply, burned ≤ max, burned monotonic, genesis once, no holder above supply),
  5 for staking accounting, 7 for vesting, the 4 bridge invariants above, 4 for the
  Stabilisation Fund's accounting and 6 reward-pool invariants (REG-50,
  `test/foundry/invariant/RewardPoolsInvariant.t.sol`: rewards backed only by the launch
  allocation, the fund never releases reserved SRX, fees never become rewards, rewards never
  released to a wallet, releases never above the delivered allocation). They run at 256 runs × depth 50
  locally. 4 PreSaleRound property fuzz tests and 1 GenesisAgreementRegistry fuzz test (5 in
  all) run at 1,000 runs. The nightly CI profile raises these to 1,024 × 100 and 10,000. Pull-request CI
  runs a lighter setting, `FOUNDRY_FUZZ_RUNS=256` and `FOUNDRY_INVARIANT_RUNS=64`, because
  the runner has little memory (CI-04, 22 Oct 2026); the full depth runs nightly. The last
  full nightly pass on record was 7 Oct 2026 (Foundry 1.8.5), before REG-50 and the 16 Oct
  and 22 Oct fixes.
- **Testnet proof, Sepolia ↔ BNB Chain testnet (7–8 Oct 2026, test tokens only)**, with the
  suite redeployed from `0deaa30` (addresses: `docs/ADDRESSES.md`; that deployment predates
  REG-50, REG-53, REG-54 and the 16 Oct fixes, and will be redeployed):
  - transfers both ways, each verified by two DVNs (LayerZero Labs and Nethermind);
  - a return above the hub's daily limit refused (`InboundLimitExceeded`), then delivered in full
    once the limit was raised;
  - the guardian froze BNB testnet's returns through `GuardianModule.freezeBridgeInbound`; a return
    was refused (`InboundChainFrozen`) and delivered after governance lifted the freeze;
  - the spoke handed to its own Timelock; `verify_spoke.js` passed (owner and delegate, hub-only peer,
    two DVNs each way, delivery gas);
  - accounting exact at the end: spoke supply 74,000 SRX = the hub's `outstandingByEid`, and hub
    supply + outstanding = 10B.
  The proof is repeatable with `scripts/ops/bridge_proof.js`.
- **Role hand-over rehearsal:** `scripts/ops/rehearse_role_migration.js` runs the real migration
  and gate against a local chain (instructions in the file).
- **Slither 0.11.6** (latest at 7 Oct 2026) runs on every push with `fail-on: medium`: 0 High,
  0 Medium, including on the 23 Oct review-round code (85 Low, 24 Informational). **Aderyn 0.6.8**
  is run alongside it; every finding of both tools is fixed or explained in
  `docs/audits/STATIC_ANALYSIS_TRIAGE.md`. Each reviewed exception is a dated `slither-disable-next-line` comment with its
  reason, next to the code. Since 8 Oct no detector that can report High is excluded
  repo-wide (`arbitrary-send-erc20`, `arbitrary-send-eth` and `reentrancy-no-eth` were); the
  remaining exclusions and their reasons are in `slither.config.json`. Foundry is pinned (forge
  v1.8.5, forge-std v1.16.1). **Solhint**, `npm audit`, a secret scan and a documentation
  reference check also gate every push.
- ⚠️ Echidna (`contracts/echidna/`) is a local harness, not a CI control. Its original
  properties could not fail; it was rewritten, but reinstating it in CI needs a pinned image and
  a demonstrated failure mode.

## 6. Prior internal review

Three remediation passes, all proven by tests — see `REMEDIATION.md`:

| Pass | Outcome |
|---|---|
| 10 Sep 2026 | 31 proven findings, every one dispositioned (one of them, F6, was later found not fixed — corrected 23 Sep) |
| 23 Sep 2026 | 1 Critical, 4 High (one deployment), 11 Medium, plus Low and Info — fixed with proofs, or listed as open |
| 16 Oct 2026 | Internal audit (board 3af6f2d5): 0 Critical, 0 High, 12 Medium, 17 Low, about 30 Info. Fixed: 6 Medium, 15 Low and the gate half of M11; M2 was fixed later, on 22 Oct. Waiting for a design decision: M3, M4, M8, M9, L7, L8, L9 and the design half of M11 (below) |
| 22 Oct 2026 | Review round: five independent internal reviews, each finding proven by a test. No Critical; one High in the deploy process (E-01), fixed; Mediums, Lows and Info listed by ID below. Fixed except A1 and A4, which wait for a design decision. See "Review round, 22 October 2026" below |

Earlier review rounds (R1–R6) are summarised in `docs/audits/README.md`. The consolidated report
and the per-round reports are available to an external auditor on request.

### Internal audit, 16 October 2026

**Why it was done.** Twelve outside reports reached us between 30 September and 16 October.
Most had one shape: a fix or limit present in one function was missing from its twin. So every
contract was reviewed again, on commit `7bc32fa` (`main` plus PR 20 and PR 21), by six
independent groups: staking, money paths, token and bridge, distribution, control, and a claims
group. This is an internal audit and **not** the external audit.

**Method.** Each group applied all of these to its own contracts, following cross-contract calls:
1. a twin and sibling sweep (a parity table for every pair of functions that do the same job);
2. every state-changing function: caller, worst case for a compromised key or a typo, and what
   stops it;
3. accounting invariants on the rare paths (pause, wind-down, rescue, early exit, bridge,
   shortfall, rounding);
4. entry-point hooks: which update hooks each entry point runs (a skipped hook is a finding);
5. funds with no exit, and rescues or sweeps that could take what users are owed;
6. docs against code: every "never / cannot / only / at most" statement, checked against the
   code and a test;
7. Slither 0.11.6 (0 High, 0 Medium) and mutation / fail-first tests: every fix's test was shown
   to fail on the old code. Every finding at Low or above had a passing proof test.

**Counts.** 0 Critical, 0 High, **12 Medium**, **17 Low**, about 30 Info, and about 30 stale
facts in the documents (corrected). The claims group found 15 documented guarantees that did
not hold at the review commit, and 7 that were only weakly tested. Where a fix makes a claim
true, the wording now matches the new behaviour exactly; where the claim is tied to an open
item below it is kept as the build target and marked "Open: internal audit ..." in the
document.

**Fixed in the code** (full table with tests in `REMEDIATION.md`): M1, M5, M6, M7, M10, M12;
L1 to L6, L10 to L13 and L15; the spoke rescue (board 585533e0); L17 (wording). Regression tests
are in `test/internal-audit/`.

**Also fixed:** L14 (the circuit-breaker monitor also counts returns), L16 (the launch gate
checks the guardian's module registry and breaker settings), and the gate half of M11 (the gate
fails on Timelock operations still pending from before the hand-over).

**Open, for the external auditor's attention.** These are awaiting a design decision by
Security and Jared. Please review them as open, not as accepted:
- **M3** A paying Genesis buyer can be removed after their vault exists, with no refund; and
  **L7**, only the Safe can start a Genesis vault's clock.
- **M4** and **L9** The Safe keeps `DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE` and `BURN_ROLE` on every
  spoke. The spoke pause has none of the hub's limits, and a spoke's burns are invisible to the
  hub, so "10B − `totalBurned`" is false after a spoke burn.
- **M8** The Safe's Timelock veto can cancel the operation that would remove it.
- **M9** The fixed 400M quorum is about 89% of the votable launch float.
- **M11** (design half) The temporary Timelock proposer window before the hand-over.
- **L8** WBTC is priced at BTC/USD with no depeg feed.

### Review round, 22 October 2026

**What it was.** Five independent internal reviews of the code as it stood at `9395487`, after
the 16 Oct fixes and the class sweep. Each finding was proven by a test against `9395487` before
it was fixed. The fixes are in `688b0e9` unless noted; the regression tests are in
`test/internal-audit/Review22Oct.Fixes.test.js` (20 tests; all but the D-1 pin fail on
`9395487`) and, for the deploy scripts, `test/deploy/`. Full table: `REMEDIATION.md`, top
section. This is an internal review and **not** the external audit.

**Fixed in the contracts:**
- **A2 (Low)** `SRXToken`: a send into a chain whose returns are frozen was accepted, burning SRX
  that could not come back. It is refused now (`InboundChainFrozen`).
- **A3 (Low)** `SRXToken`: a plain transfer to the hub's own address is refused
  (`TransferToTokenContract`), as on the spoke. Bridge credits to it still land and
  `rescueTokens` recovers them. **A5 (Info)** natspec on the wallet-cap exemption for listed exits.
- **B1 (Low)** `SRXStaking` and `StabilisationFund` `releaseRewardAllocation`: the successor's
  reward backing, after it syncs (`syncAllocation`), must cover everything ever released to it,
  since that backing comes only from this contract; all state is written before the calls.
  A wound-down successor, or one whose reward cap is too small, is refused, so released SRX can
  only become the successor's rewards (REG-50). **B2 (Low)** the fund's stress snapshot reads the
  allocation first. **B3 (Info)** the fund's constructor enforces the 90-day withdraw-lock
  ceiling. **B4 (Info)** the lock is per position: a top-up can extend the unlock, never bring it
  forward.
- **C1 (Medium)** `PreSaleRound.returnFunds()` (admin, payable) puts ETH back so a late refund
  can be paid after the raised ETH was withdrawn. **C2 (Low)** `setBuyerApprovals` raises a cap
  below what a buyer bought instead of reverting the whole batch. **C3 (Low)**
  `claimRefund(asset, to)`: the payer chooses where its refund goes. **C4 (Info)**
  `quoteStable(coin, amount, investor)`. **C6 (Low)** `removeInvestor` works after finalize for a
  wire buyer.
- **D-2 (Low)** `GuardianModule.updateModuleTarget` is refused while the guardian holds that
  module paused. **D-3 (Info)** `releaseAfterSunset` emits `ReleasedAfterSunset`. **Lead:** only
  the six module ids can be registered, and one `pause()` module per target, so the token's run
  limits cannot be sidestepped through another id.
- **Info:** `addWindDownExit` refuses address 0; a failed ETH rescue reverts `ETHRescueFailed`.

**Fixed in the deploy scripts and gate** (tests in `test/deploy/`): **E-01 (High, deploy
process)** the launch gate (06) requires staking and the fund to name the distributor that
launches, and a re-run of 03 needs 04 and 05b re-run. **C7/E-02 (Medium)** revoked SRX went to a
wallet; `SRXTreasury` is now deployed before 10 and 03, and the gate checks every
`revokeRecipient`. **E-03 to E-06 (Low)** the role gate lists the Timelock's proposers,
cancellers and admins from events, checks the Governor, requires the Safe's guardian and veto
roles and the breaker monitor, lists the hub's peers from `PeerSet` events, and splits
`GUARDIAN_MULTISIG` into `PAUSE_GUARDIAN` and `SSF_GUARDIAN_MULTISIG`. **C5 (Low)** the Genesis
vault batch defaults to 12 and is refused above 15,000,000 gas.

**Documentation, not a defect (D-1).** A per-chain inbound freeze is lifted only by governance,
even after the guardian's sunset. This is deliberate: after the sunset nobody else could
re-freeze a compromised chain. The sunset bounds the guardian's other pauses (anyone may lift a
guardian pause after it, L15) but not a per-chain freeze.

**Open, for the external auditor's attention (design decision pending: Jared and Security).**
- **A1 and A4 (Medium)** The hub's per-chain inbound bucket counts gross returns, so one holder
  sending the same SRX out and back, paying the fees, can keep the bucket full and hold honest
  returns from that chain back. The same round trips can trip the bridge circuit breaker
  (configured on testnet only; mainnet has none). Counting net returns would end the
  blocking, but would let honest sends into a compromised chain free room for forged returns.
  No funds are lost; returns are delayed. The bucket stays gross for now. Please review this as
  open, not as accepted.

## 7. Trust model, known issues, and where we want scrutiny

**Who holds power at launch** is specified in `MULTISIG_SPEC.md` and enforced by
`scripts/verify/verify_roles.js`: every administrative power over the six core contracts sits
behind the 48h Timelock; the admin Safe keeps emergency pause (through GuardianModule) and a
veto. The operational contracts the Safe does administer are listed there with what each
administrator can reach.

**Known and open — please do not spend time re-finding these** (details in `REMEDIATION.md`):
PSR-09
(vault/launch-limit ordering), F2 (lazy weight decay,
mitigated), the launch-protection scope notes B/T2/D, and the internal-audit items listed under
"Open, for the external auditor's attention" in §6 (M3, M4, M8, M9, M11, L7, L8, L9; M2 was fixed on 22 Oct), and the two Medium items from the
22 Oct review round: **A1 and A4**, open pending a design decision (§6: the hub's per-chain
inbound bucket counts gross returns, so a holder's repeated round trips can hold honest
returns from that chain back and can trip the bridge circuit breaker; no funds are lost,
returns are delayed). STK-L1
(fresh proxies required) is moot since REG-53: there are no proxies.

**Settled since the last revision** (in scope; please review the fixes): the 16 Oct internal
audit fixes (§6, `REMEDIATION.md`), notably: a successor's reward backing is re-read until
wind-down (M1); a top-up always serves a full term (M5, M6); the guardian's token-pause run is
at most 14 days across breaks under 7 days (M7); quorum is read at the proposal's snapshot
(M10); a pause governance holds or adopts can be lifted only by governance (M12); there is no
stranded-pool rescue, so the only exit for an unused reward pool is the release to a successor
(L1); pauses under 7 days apart are one run and only time actually paused counts towards the 30-day wind-down clock (L2); the fund's
withdrawal lock is per position and at most 90 days: a top-up can extend the unlock, never
bring it forward (L3, B4); `recoverSRX` takes only the surplus
above what Genesis buyers are owed (L6); and anyone may lift a guardian pause after the sunset
(L15). Also REG-53 (12 Oct): no SRX
contract is upgradeable (SRXStaking, FeeController, StabilisationFund and SRXTreasury are plain
contracts); SRXStaking and StabilisationFund have an irreversible wind-down (exit-only, exact
principal, works while paused) and a Timelock-only release of unused reward allocation to an
opt-in successor (see `docs/MIGRATION.md` and the REG-53 section of `REMEDIATION.md`). REG-54 and
the token-pause ruling (12 Oct): FeeController's floor and ceiling are constants; the circuit
breaker stops the bridge only; a token pause never blocks an exit-only withdrawal; guardian token
pauses lapse after 14 days and total at most 30; the guardian's sunset is capped at 180 days in its
constructor (see the first section of `REMEDIATION.md`). REG-50 (12 Oct):
staking and fund rewards come only from fixed SRX allocations, backed only by what the launch
`TGEDistributor` delivered; the staking bonus ("real yield") stream, `receiveFees` and
`recoverLiquidity` (R7-16) are removed; no caller can deploy the fund's depositor principal or
reward SRX (see the REG-50 section of `REMEDIATION.md`). Also SPOKE-01
(spoke owner actions had no delay), closed on 7 October 2026: each spoke's owner and
LayerZero delegate is that chain's own 48-hour Timelock (see the 7 October section of
`REMEDIATION.md`). Also PSR-03, where
the Genesis round runs on Ethereum only and is funded from the seed allocation
(`scripts/deploy/lib/genesis_seed.js`, `06b_genesis_vaults.js`). Also SSF-L1, the
StabilisationFund minimum position, and SC-TRUST-001, where upgrade and spending rights
now administer themselves. See the 1 October section of `REMEDIATION.md`.

**Where we most want an independent view:**
1. **Bridge conservation** — hub-and-spoke outflow accounting (`outstandingByEid`), the hub's
   per-chain inbound limit (a draining bucket; a chain with no limit returns nothing) and the
   guardian's per-chain freeze, the spoke `hubEid` restriction and its locked hub peer (`HubPeer`:
   `setPeer` accepts only the hub or zero), the supply cap in `_update`, and the DVN configuration
   we require (≥ 2 DVNs; set manually, see `scripts/deploy/07_deploy_bridge.js`). The exact
   containment bound for a compromised spoke is **the chain's inbound limit, plus one more
   limit for each day of reaction time before the guardian freezes it** (not "the limit"); the
   property test uses limit × (1 + elapsed days). Open here: the Safe's powers on a spoke and
   the spoke's unbounded pause (M4), spoke burns that the hub cannot see (L9), and the gross
   counting of returns in the inbound bucket (A1, A4).
2. **Role topology and the hand-over** — the gate, the two-phase migration, and anything that
   would leave undelayed power after it.
3. **PreSaleRound money paths** — oracle math, decimals handling, the refund ring-fence, the
   tier inversion, and the approved-buyer cap (`setBuyerApprovals`, `_requireApproved`): no
   wallet may be credited, on chain or by the admin, beyond its agreed amount.
4. **Reward accounting** — liability tracking and emission scheduling in Staking and the
   StabilisationFund, and the REG-50 property that no SRX other than the delivered launch
   allocation can ever back or extend a reward pool (`syncAllocation`, `rewardBacking`,
   `_reservedSRX`).
5. **Deployment** — see §3.
6. **Wind-down and migration (REG-53)** — that `exitAfterWindDown` can never return more or less
   than a holder's principal, cannot be blocked by the contract's own pause, the token's, or the
   launch wallet cap (which no longer applies to SRX leaving a listed wind-down exit; L10, 16 Oct),
   and that `releaseRewardAllocation` can never reach principal or owed rewards. Since
   16 Oct there is no stranded-pool rescue (L1): `releaseRewardAllocation` to a named successor,
   after wind-down, is the only way an unused reward pool can leave. Please also test that
   anyone may wind a paused contract down only once it has been paused for a total of 30 days
   within one run of pauses (pauses less than 7 days apart, `PAUSE_BREAK`, are one run; time
   between them never counts; L2, SWEEP-03), and that a successor's reward backing, re-read until
   wind-down, only ever rises (M1).
7. **The pause and its limits (12 Oct 2026, tightened 16 Oct)** — that the token's wind-down
   exemption in `_update` (a listed contract reporting `windDown()`) cannot be used to move
   anything but a wound-down pool's own payments (these include governance's `deployLiquidity`
   of the fund's free SRX, which is bound by the free-balance check); that no sequence of guardian
   calls (`pauseModule`, `pauseAll`, `unpauseModule`, `lapseTokenPause`) keeps the token paused
   beyond 14 days at a time (pauses less than 7 days apart count as one run of at most 14 days
   of paused time, M7) or 30 in total; that a token pause governance holds, or an outside pause
   a `pauseAll` adopted, can be lifted only by governance (M12); that after the sunset anyone may
   lift a guardian pause but not a governance-only one (`releaseAfterSunset`, L15); and that the
   circuit breaker can no longer reach `SRXToken.pause()`. Not bounded in time except by the
   sunset: a pause on any module other than the token and a bridge stop through `MODULE_BRIDGE`.
   A per-chain inbound freeze is not bounded by the sunset either: it is lifted only by
   governance (`unfreezeInbound`), even after the sunset, because after the sunset nobody else
   could re-freeze a compromised chain (D-1, deliberate). `pauseAll` ignores the per-module cooldown on
   purpose (30 minutes between uses of `pauseAll` itself).

## 8. What We Can Provide

- Read access to the private repo at the tagged commit (or a source archive).
- The internal review record, the proof tests, the trust matrix and this package.
- A responsive maintainer team for questions and re-review of fixes.

## 9. Contact

- Technical and security: **security@syrax.global**
