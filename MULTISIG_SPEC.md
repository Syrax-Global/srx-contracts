# SRX Token — Gnosis Safe Multisig Specification

## Why a Multisig

All privileged roles in the SRX token suite are currently held by an EOA
(Externally Owned Account) deployer. This is acceptable on testnet. It is a
critical security risk on mainnet.

Before TGE, every privileged role MUST be transferred to a Gnosis Safe with
a minimum 3-of-5 threshold. A single EOA holding admin rights means one
compromised private key = total loss of protocol control.

---

## Safe Configuration

| Parameter | Value |
|---|---|
| Safe version | 1.4.1 (latest) |
| Threshold | 3 of 5 signers |
| Network | Ethereum mainnet (deploy Safe here first) |
| Cross-chain | Deploy matching Safe on BNB Chain for BNBChain roles |

### Signer Allocation (5 slots)

| Slot | Role | Custody |
|---|---|---|
| 1 | Founder | Hardware wallet (Ledger/Trezor) |
| 2 | CTO | Hardware wallet (Ledger/Trezor) |
| 3 | Legal/Compliance | Hardware wallet |
| 4 | Cold backup 1 | Hardware wallet, geographically separate |
| 5 | Cold backup 2 | Hardware wallet, geographically separate |

No signer should use a software wallet or hot wallet for Safe signing.
No two signers should share the same physical location.

---

## Roles to Transfer at TGE

The following roles must be transferred from the EOA deployer to the Gnosis
Safe before any mainnet deployment is considered complete.

### SRXToken
| Role | bytes32 | Transfer to |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `0x00` | Gnosis Safe |
| `PAUSER_ROLE` | `keccak256("PAUSER_ROLE")` | Gnosis Safe |
| `GOVERNANCE_ROLE` | `keccak256("GOVERNANCE_ROLE")` | Gnosis Safe |
| `BURN_ROLE` | `keccak256("BURN_ROLE")` | BuybackBurner contract |

### BuybackBurner
| Role | Transfer to |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Gnosis Safe |
| `OPERATOR_ROLE` | Gnosis Safe or automated operator |

### SRXTreasury
| Role | Transfer to |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Gnosis Safe |
| `SPENDER_ROLE` | Gnosis Safe |

### StabilisationFund
| Role | Transfer to |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Gnosis Safe |
| `OPERATOR_ROLE` | Gnosis Safe |

### SRXStaking, FeeController, VestingVault, PreSaleRound, SRXAirdrop
| Role | Transfer to |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Gnosis Safe |
| All operational roles | Gnosis Safe or designated operator |

**SC-TRUST-004 — PreSaleRound admin is omnipotent over investor funds.**
The PreSaleRound `admin` (a single address, no Timelock) can `withdrawETH/USDC/USDT/WBTC`,
`recoverSRX` (sweep all undeployed SRX), and `revokeVault` on any investor. For any
mainnet round, `admin` MUST be a Gnosis Safe (≥3/5). This is a disclosed custodial-presale
trust assumption — document it to investors and verify the admin address on-chain before
opening the round.

### SRXOFTNative / SRXToken (Bridge — `setPeer`)
| Role | Transfer to |
|---|---|
| `owner()` (OApp owner — controls `setPeer`) | **SRXTimelock** (preferred) or Gnosis Safe |
| `DEFAULT_ADMIN_ROLE` | Gnosis Safe |

**SC-LZ-001 — `setPeer` is `onlyOwner`, not Timelock-gated by default.**
`setPeer` registers cross-chain peers; a malicious peer enables mint-without-burn.
Preferred remediation: transfer Ownable ownership of `SRXToken` and `SRXOFTNative` to the
**SRXTimelock** so peer changes inherit the 48h delay. If operational speed requires the
owner to remain a Gnosis Safe, that is an ACCEPTED risk only if (a) the owner is a hardened
≥3/5 Safe and (b) the GuardianModule holds `PAUSER_ROLE` so a suspect peer change can be
frozen (the `setPeer` override is `whenNotPaused`). Record the chosen owner on-chain and in
the deployment runbook.

---

## Transfer Procedure

### Step 1 — Deploy the Safe

Use the Gnosis Safe web app (app.safe.global) or CLI:
```
Network: Ethereum Mainnet
Owners: [addr1, addr2, addr3, addr4, addr5]
Threshold: 3
```

Record the Safe address in `TGE_DEPLOYMENT_RUNBOOK.md`.

### Step 2 — Grant roles to Safe BEFORE revoking EOA

For each contract, grant the role to the Safe first:
```solidity
token.grantRole(DEFAULT_ADMIN_ROLE, SAFE_ADDRESS);
```

Verify the Safe holds the role on-chain before the next step.

**Tooling — generate the migration batch automatically.** Rather than hand-crafting
each grant/revoke, use the migration tool. It computes the minimal set of operations to
reach the audited end state and is idempotent (skips anything already correct):

```
# Mainnet: produce a Gnosis Safe Transaction Builder JSON for owners to review + sign
npm run migrate:roles -- --network ethereum
# → writes migrate_roles.ethereum.json; import at app.safe.global → Transaction Builder

# Testnet / mainnet-fork rehearsal: execute directly (signer must hold DEFAULT_ADMIN_ROLE)
MIGRATE_EXECUTE=1 npm run migrate:roles -- --network sepolia
```

The irreversible final handover (revoking the admin Safe's own `DEFAULT_ADMIN_ROLE` in
favour of the Timelock) is only included with `MIGRATE_FINALIZE=1`. Flags are read from
env vars (reliable with `hardhat run`) or `--execute`/`--finalize` CLI args. Always run
`npm run verify:roles` afterwards to confirm the end state.

### Step 3 — Revoke EOA roles

Only after the Safe is confirmed to hold every role:
```solidity
token.revokeRole(DEFAULT_ADMIN_ROLE, EOA_DEPLOYER);
```

### Step 4 — Verify

Confirm on Etherscan:
- EOA has NO roles on any contract
- Safe holds DEFAULT_ADMIN_ROLE on every contract
- `token.owner()` returns the Safe address

**Automated gate (SC-TRUST-001 / SC-TRUST-002):** run the role-topology verifier.
It fails (exit 1) unless the deployer EOA holds zero roles, `UPGRADER_ROLE` is held
only by the Timelock, and governance/pause/spender roles are correctly homed:
```
npm run verify:roles -- --network ethereum
```
This MUST print `✅ ALL CHECKS PASSED` before mainnet is considered ready.

### Step 4a — UPGRADER_ROLE migration (SC-TRUST-001)

The four UUPS contracts (SRXTreasury, SRXStaking, FeeController, StabilisationFund)
gate `_authorizeUpgrade` on a dedicated `UPGRADER_ROLE` — separate from
`GOVERNANCE_ROLE` — so upgrade authority can be homed exclusively on the Timelock.
At deployment `UPGRADER_ROLE` is granted to the admin (and the Timelock, for Treasury)
for bootstrap. Before mainnet:
```solidity
contract.grantRole(UPGRADER_ROLE, TIMELOCK_ADDRESS);   // ensure Timelock holds it
contract.revokeRole(UPGRADER_ROLE, ADMIN_SAFE);        // remove from admin
contract.revokeRole(UPGRADER_ROLE, EOA_DEPLOYER);      // remove from deployer
```
After migration, an upgrade can ONLY be executed via a governance proposal that the
Timelock queues and executes after the 48-hour delay — closing the instant-drain path.

### Step 5 — Test a Safe transaction

Execute a low-risk Safe transaction (e.g. read a view function via Safe UI)
to confirm the 3/5 threshold signing flow works before relying on it in
production.

---

## Operational Signing Policy

| Action | Required signers |
|---|---|
| Grant/revoke any role | 3 of 5 |
| Pause token transfers | 3 of 5 |
| Execute genesis | 3 of 5 |
| Upgrade any UUPS contract | 3 of 5 |
| Change oracle price bounds | 3 of 5 |
| Trigger StabilisationFund stress event | 3 of 5 |
| Rescue tokens from any contract | 3 of 5 |

---

## Mainnet Blocker

The following must be true before `v1.0.0` is deployed:

- [ ] Gnosis Safe deployed and signer keys verified
- [ ] 3/5 test transaction executed successfully
- [ ] All roles granted to Safe
- [ ] `UPGRADER_ROLE` migrated to Timelock; revoked from admin + deployer (SC-TRUST-001)
- [ ] All EOA roles revoked
- [ ] `npm run verify:roles` prints `✅ ALL CHECKS PASSED` (SC-TRUST-002)
- [ ] On-chain verification complete (Etherscan role checks)
- [ ] PreSaleRound payment-token decimals verified: `USDC.decimals()==6`, `USDT.decimals()==6`, `WBTC.decimals()==8` (R5-07 — a misconfigured token silently mis-values investments)
- [ ] PreSaleRound `srxPriceUsd8Dec` set to the final value BEFORE the first investor is recorded (R5-02 — price locks on first investor)
- [ ] Safe address recorded in `TGE_DEPLOYMENT_RUNBOOK.md`
