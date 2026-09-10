# SRX Token

Smart contracts for the SRX token — an omnichain ERC-20 built on LayerZero OFT,
with staking, vesting, treasury, buyback, a stabilisation fund, governance and a
cross-chain migration path.

**Solidity 0.8.24 · Hardhat + Foundry · MIT**

---

## Status

⚠️ **Testnet only. Not deployed to any mainnet.**

Deployed on Sepolia and BSC testnet. `.openzeppelin/` contains a `sepolia.json`
manifest and no mainnet manifest. Mainnet deployment is gated on an external
audit that has not yet been performed.

⛔ **Nothing here should be read as a statement that Syrax Global FZCO holds any
licence.** It does not. Regulatory applications are in progress and no licensed
activity is offered.

## The contracts

| Contract | Purpose |
|---|---|
| `token/SRXToken.sol` | The token. ERC-20 + Permit + Votes + LayerZero OFT, 10,000,000,000 fixed supply |
| `token/TGEDistributor.sol` | One-shot genesis distribution |
| `bridge/SRXOFTNative.sol` | The token on non-origin chains — minted only against a verified bridge message |
| `staking/SRXStaking.sol` | Lock-duration staking with fee tiers |
| `staking/FeeController.sol` | Platform fee calculation and tier discounts |
| `vesting/VestingVault.sol` | One vault per vested allocation, cliff + linear |
| `treasury/SRXTreasury.sol` | Treasury custody and spending |
| `stabilisation/StabilisationFund.sol` | Reserve layer and stress-event response |
| `buyback/BuybackBurner.sol` | Buy-and-burn execution |
| `guardian/GuardianModule.sol` | Circuit breaker and coordinated pause |
| `governance/SRXGovernor.sol` | Governor + Timelock |
| `migration/ZkSyncMigrator.sol` | Burn-and-migrate to Syrax Chain |
| `airdrop/SRXAirdrop.sol` | Merkle-proof airdrop |
| `presale/PreSaleRound.sol` | Presale with oracle-priced contributions |

## Running the tests

```bash
npm ci
npx hardhat test          # 726 tests
forge test                # 7 invariants + 3 property-fuzz tests
```

⭐ `test/audit-poc/` holds **executable proofs of vulnerabilities found during the
pre-audit sweep**. A fixed item's test now asserts the *correct* behaviour, so
reintroducing any of those defects turns the suite red. Read
`test/audit-poc/README.md` before changing anything in there.

## Security

- **Reporting:** `SECURITY.md`
- **Threat model:** `THREAT_MODEL.md` — ⚠️ read the note about which companion
  documents are planned rather than written
- **Audit scope and history:** `AUDIT_SCOPE.md`, `docs/audits/`
- **Remediation record:** `REMEDIATION.md` — what was found, what was fixed, what
  was deliberately not fixed and why
- **Incident response:** `INCIDENT_RESPONSE.md`
- **Deployment gates:** `DEPLOYMENT_SECURITY.md`, `TGE_DEPLOYMENT_RUNBOOK.md`

⭐ **`REMEDIATION.md` is the honest starting point for a reviewer.** It records 31
vulnerabilities proven by executable test, their dispositions, and the mistakes
made while fixing them — including two cases where a control could not fail and
one where documentation described a guarantee the code did not provide.

## Things a reviewer should know up front

- **Launch protection is not an accumulation cap.** `maxTransferAmount` and
  `maxWalletBalance` deliberately exempt DEX pool addresses and the bridge
  (`SRXToken.sol:82-88`), so they are friction on direct wallet-to-wallet
  transfers during the launch window, nothing more.
- **The timelock delay is derived from the network.** 48 hours on anything not
  explicitly a testnet, and a shorter value is refused rather than accepted.
- **Governance quorum is a fixed fraction of the global supply cap**, not of live
  Ethereum-side supply, so bridging tokens away cannot lower it.
- **Voting power is Ethereum-native.** Cross-chain vote aggregation is not built.

## Repository layout

```
contracts/        the contracts under audit
test/             Hardhat suite; test/foundry/ invariants; test/audit-poc/ proofs
scripts/deploy/   ordered deployment scripts
scripts/verify/   pre-mainnet gates (role topology, TGE destinations)
scripts/ops/      operational and verification tooling
docs/audits/      audit history and the consolidated report
```

## Licence

MIT — see `LICENSE`. All 21 contracts carry a matching `SPDX-License-Identifier`.
