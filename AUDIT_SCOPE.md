# SRX Token — External Audit Scope & Handoff Package

Prepared so that an external audit can begin quickly once an engagement is agreed.
This document gives an auditor everything needed to (a) quote accurately and (b) start fast.

⚠️ **No external audit has been commissioned and none has begun.** No auditor is
engaged and no firm named anywhere in this repository has reviewed this code.

**Package refreshed 23 September 2026** after a full pre-external-audit sweep. The
findings and fixes from that sweep are in `REMEDIATION.md` (top section); read
it first, because it also lists what is still open.

---

## 1. Project Overview

**Syrax Token (SRX)** — the utility & governance token of the Syrax ecosystem. A fixed-supply
(10,000,000,000) ERC-20 with EIP-2612 Permit, ERC20Votes governance, and LayerZero V2 OFT
cross-chain transfer. Origin chain: Ethereum; bridged to BNB Chain and zkSync as spokes of an
Ethereum hub. Includes vesting, a presale (the Genesis round), staking (fee tiers + Synthetix
rewards), an on-chain treasury, a three-tier stabilisation fund, on-chain governance (Governor +
48h Timelock), a non-upgradeable guardian/circuit-breaker module, a buy-and-burn contract, a
Merkle airdrop and a burn-to-migrate path for a future app-chain.

## 2. Repository & Commit

- **Repo:** `github.com/Syrax-Global/srx-token` (private — read access is granted to the audit
  team's GitHub handles, or an archive of the tagged commit is provided). A public mirror of the
  in-scope code is kept at `github.com/Syrax-Global/srx-contracts`.
- **Audit target:** the annotated tag named in the hand-off message. Audit the tag, not `main`.
  ⛔ The older tag `v0.9.0-audit` predates both remediation passes and is **not** the target.
- **No secrets in repo:** `.env` is gitignored; CI runs a secret scan on every push.

## 3. Scope

**In scope — 15 production contracts under `contracts/` (excluding `mocks/`, `test/`,
`echidna/`): 7,133 lines, 3,303 nSLOC** (non-blank, non-comment; measured 23 Sep 2026).

| Contract | Lines | nSLOC | Notes |
|---|---|---|---|
| `presale/PreSaleRound.sol` | 1,319 | 679 | ETH/BNB, USDC, USDT, WBTC purchases; Chainlink pricing; flat or tiered bonus; refunds; creates a VestingVault per investor |
| `staking/SRXStaking.sol` | 1,174 | 498 | UUPS. Fee-tier locks, SRX and bonus Synthetix reward streams |
| `stabilisation/StabilisationFund.sol` | 970 | 414 | UUPS. Three-tier deployment, contributor rewards |
| `guardian/GuardianModule.sol` | 667 | 412 | Non-upgradeable. Per-module pause, circuit breaker, immutable sunset |
| `staking/FeeController.sol` | 430 | 213 | UUPS. Fee calculator and fee-destination table |
| `token/SRXToken.sol` | 454 | 180 | OFT hub + Permit + Votes + launch protection + per-chain outflow accounting |
| `vesting/VestingVault.sol` | 356 | 153 | Single-beneficiary linear vesting, revoke, declared grant |
| `buyback/BuybackBurner.sol` | 326 | 145 | Capped swap-and-burn and direct burn |
| `governance/SRXGovernor.sol` | 207 | 125 | OZ Governor (timestamp clock; quorum on the fixed global cap) |
| `treasury/SRXTreasury.sol` | 259 | 121 | UUPS. Timelock-only spend, buy-and-burn |
| `migration/ZkSyncMigrator.sol` | 294 | 105 | Burn-to-migrate, chain-separated request ids |
| `bridge/SRXOFTNative.sol` | 226 | 97 | Spoke OFT: talks to the Ethereum hub only |
| `airdrop/SRXAirdrop.sol` | 213 | 80 | Chain-bound double-hash Merkle airdrop |
| `token/TGEDistributor.sol` | 187 | 69 | One-shot genesis distribution |
| `governance/SRXTimelock.sol` | 51 | 12 | OZ TimelockController, 48h on mainnet |

**Out of scope by default:** `contracts/mocks/`, `contracts/test/`, `contracts/echidna/`,
`test/`, OpenZeppelin and LayerZero library code.

**Deployment and operations scripts — please quote as an option.** `scripts/deploy/`,
`scripts/ops/migrate_roles.js` and `scripts/verify/verify_roles.js` decide who holds power
after launch and move the full 10B supply. Two defects of that kind were found in this sweep
(DEP-01, DEP-02). We would value them in scope.

**Complexity flags for quoting:** 4 UUPS-upgradeable contracts; LayerZero V2 OFT in a
hub-and-spoke topology with hub-side outflow accounting; Chainlink integration with
per-feed staleness and bounds; two Synthetix-pattern reward systems with liability tracking;
Governor + Timelock with a two-phase role hand-over.

## 4. Tech Stack & Build

- Solidity **0.8.24**, `viaIR: true`, optimizer 200 runs, EVM `cancun`.
- **Hardhat** (unit/integration) + **Foundry** (invariants and property fuzzing).
- Dependencies, pinned by `package-lock.json` and installed with `npm ci` in CI:

  | Package | Version |
  |---|---|
  | `@openzeppelin/contracts` | 5.6.1 |
  | `@openzeppelin/contracts-upgradeable` | 5.6.1 |
  | `@layerzerolabs/oft-evm` | 4.0.1 |
  | `@layerzerolabs/oapp-evm` | 0.4.1 |
  | `@layerzerolabs/lz-evm-protocol-v2` | 3.0.168 |

- Build: `npm ci` (the repo's `.npmrc` sets `legacy-peer-deps=true` for a LayerZero transitive
  peer conflict), then `npx hardhat compile`. Foundry: `forge build` with `forge-std` in `lib/`.
- `PreSaleRound` deploys `VestingVault` inline; its runtime is 23,016 bytes against the 24,576
  limit. Any change to either contract should re-check it.

## 5. Tests and static analysis

- **Hardhat:** 817 passing, 1 pending, 0 failing (`npx hardhat test`, 23 Sep 2026).
- **Line coverage** (`npx hardhat coverage`, the 15 in-scope contracts only): 95.5% of
  statements, 74.6% of branches, 93.3% of functions. Lowest statement coverage: SRXGovernor
  80.0%, PreSaleRound 92.9%, FeeController 93.3%. Lowest branch coverage: PreSaleRound 69.5%,
  GuardianModule 71.2%, BuybackBurner 71.6%.
  `test/audit-poc/` holds the proof tests for every internal finding — each one was red on the
  code as found. Start there.
- **Foundry:** 7 token invariants (supply equation, balance sum, voting power ≤ supply, burned
  ≤ max, burned monotonic, genesis once, no holder above supply) at 256 runs × depth 50, and 3
  PreSaleRound property fuzz tests at 1,000 runs. The nightly CI profile raises these to
  1,024 × 100 and 10,000.
- **Role hand-over rehearsal:** `scripts/ops/rehearse_role_migration.js` runs the real migration
  and gate against a local chain (instructions in the file).
- **Slither** runs on every push with `fail-on: high`; excluded detectors and the reason for each
  are in `slither.config.json`. **Solhint**, `npm audit`, a secret scan and a documentation
  reference check also gate every push.
- ⚠️ Echidna (`contracts/echidna/`) is a local harness, not a CI control. Its original
  properties could not fail; it was rewritten, but reinstating it in CI needs a pinned image and
  a demonstrated failure mode.

## 6. Prior internal review

Two remediation passes, both proven by tests — see `REMEDIATION.md`:

| Pass | Outcome |
|---|---|
| 10 Sep 2026 | 31 proven findings, every one dispositioned (one of them, F6, was later found not fixed — corrected 23 Sep) |
| 23 Sep 2026 | 1 Critical, 4 High (one deployment), 11 Medium, plus Low and Info — fixed with proofs, or listed as open |

Earlier review rounds (R1–R6) are summarised in `docs/audits/README.md`, with the consolidated
report at `docs/audits/SRX_TOKEN_CONSOLIDATED_AUDIT_REPORT.pdf`. Per-round reports are available
to an engaged auditor on request.

## 7. Trust model, known issues, and where we want scrutiny

**Who holds power at launch** is specified in `MULTISIG_SPEC.md` and enforced by
`scripts/verify/verify_roles.js`: every administrative power over the six core contracts sits
behind the 48h Timelock; the admin Safe keeps emergency pause (through GuardianModule) and a
veto. The operational contracts the Safe does administer are listed there with what each
administrator can reach.

**Known and open — please do not spend time re-finding these** (details in `REMEDIATION.md`):
PSR-03 (presale chain and funding decision), SPOKE-01 (spoke owner actions not delayed, bounded
by hub accounting), PSR-09 (vault/launch-limit ordering), STK-L1 (fresh proxies required),
SSF-L1 (sole-contributor stream, accepted), F2 (lazy weight decay, mitigated), and the
launch-protection scope notes B/T2/D.

**Where we most want an independent view:**
1. **Bridge conservation** — hub-and-spoke outflow accounting (`outstandingByEid`), the spoke
   `hubEid` restriction, the supply cap in `_update`, and the DVN configuration we require
   (≥ 2 DVNs; set manually, see `scripts/deploy/07_deploy_bridge.js`).
2. **Role topology and the hand-over** — the gate, the two-phase migration, and anything that
   would leave undelayed power after it.
3. **PreSaleRound money paths** — oracle math, decimals handling, the refund ring-fence, and the
   tier inversion.
4. **Reward accounting** — liability tracking and emission scheduling in Staking and the
   StabilisationFund.
5. **Deployment** — see §3.

## 8. What We Can Provide

- Read access to the private repo at the tagged commit (or a source archive).
- The internal review record, the proof tests, the trust matrix and this package.
- A responsive maintainer team for questions and re-review of fixes.

## 9. Contact

- Technical: **[FILL — name, email]**
- Security: **security@syrax.global**
