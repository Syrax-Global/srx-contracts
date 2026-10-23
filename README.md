# SRX Token

Smart contracts for the SRX token — an omnichain ERC-20 built on LayerZero OFT,
with staking, vesting, treasury, buyback, a stabilisation fund, governance and a
cross-chain migration path.

**Solidity 0.8.24 · Hardhat + Foundry · Proprietary**

> **Maintained by Syrax Global FZCO** (Dubai, United Arab Emirates) and published from the
> company's official GitHub organisation, [`Syrax-Global`](https://github.com/Syrax-Global).
> No other GitHub account or organisation using the "Syrax" name is affiliated with us, except
> [`@SyraxGlobal`](https://github.com/SyraxGlobal), a company-held account that is a member of
> this organisation. All Syrax repositories live here.
> ⚠️ Contract addresses should only ever be taken from [`docs/ADDRESSES.md`](docs/ADDRESSES.md)
> or from [syrax.global](https://www.syrax.global) — never from a third party claiming to be Syrax.

---

## Status

⚠️ **Testnet only. Not deployed to any mainnet.**

Deployed on Sepolia and BSC testnet only ([`docs/ADDRESSES.md`](docs/ADDRESSES.md)); there is no mainnet deployment and no
mainnet upgrade manifest (no SRX contract is upgradeable). Those testnet contracts predate REG-50,
REG-53 and REG-54 and the 16 and 22 October 2026 internal-audit fixes, and will be redeployed. Mainnet
deployment is gated on an external audit that has not yet been performed. It is upcoming and has
not been engaged.

⛔ **Nothing here should be read as a statement that Syrax Global FZCO holds any
licence.** It does not, it has not applied for one, and no licensed activity is
offered. Any regulated activity would require a separate licensed entity, and none
has been established.

## The contracts

| Contract | Purpose |
|---|---|
| `token/SRXToken.sol` | The token. ERC-20 + Permit + Votes + LayerZero OFT, 10,000,000,000 fixed supply |
| `token/TGEDistributor.sol` | One-shot genesis distribution |
| `bridge/SRXOFTNative.sol` | The token on non-origin chains — accepts messages from the Ethereum hub only (its address fixed at deployment), supply capped per chain |
| `staking/SRXStaking.sol` | Lock-duration staking with fee tiers |
| `staking/FeeController.sol` | Platform fee calculation and tier discounts |
| `vesting/VestingVault.sol` | One vault per vested allocation, cliff + linear |
| `treasury/SRXTreasury.sol` | Treasury custody and spending |
| `stabilisation/StabilisationFund.sol` | Reserve layer and stress-event response |
| `buyback/BuybackBurner.sol` | Buy-and-burn execution |
| `guardian/GuardianModule.sol` | Circuit breaker and coordinated pause |
| `governance/SRXGovernor.sol` | Governor + Timelock |
| `migration/ZkSyncMigrator.sol` | Retired, not deployed (CH-13, 22 Oct 2026); kept as history. SRX moves onto Syrax Chain through the chain's own bridge (a signed deposit locks it 1:1 in the Ethereum vault) |
| `airdrop/SRXAirdrop.sol` | Merkle-proof airdrop |
| `presale/PreSaleRound.sol` | Presale with oracle-priced contributions |

## Running the tests

```bash
npm ci
npx hardhat test          # 1,624 passing (23 Oct 2026)
# Foundry needs forge-std, which is not stored in the repository (CI pins the same tag):
git clone --depth 1 --branch v1.16.1 https://github.com/foundry-rs/forge-std lib/forge-std
forge test                # 33 invariants + 5 property-fuzz tests
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
one where documentation described a guarantee the code did not provide. Its top section is the
22 October 2026 internal review round (the fixes with their tests, and two Medium items still
open for a design decision); the 16 October 2026 internal audit (12 Medium, 17 Low) follows.

## Things a reviewer should know up front

- **Launch protection is not an accumulation cap.** `maxTransferAmount` and
  `maxWalletBalance` deliberately exempt DEX pool addresses and the bridge
  (`isExemptFromLimits` in `SRXToken.sol`), so they are friction on direct wallet-to-wallet
  transfers during the launch window, nothing more. The wallet cap also never applies to SRX
  leaving a listed wind-down exit (staking, the fund): a holder's own principal always comes back.
- **The timelock delay is derived from the network.** 48 hours on anything not
  explicitly a testnet, and a shorter value is refused rather than accepted. The
  Timelock also cannot be set below its deployment delay later (`minDelayFloor`).
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
docs/audits/      internal audit history
```

## Licence

Proprietary — see [`NOTICE`](NOTICE). No licence is granted.
