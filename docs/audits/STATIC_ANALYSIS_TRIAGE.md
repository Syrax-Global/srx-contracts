# Static analysis: triage

Two tools are run on the deployable contracts (everything under `contracts/` except `mocks/`, `test/`
and `echidna/`). Every finding is either fixed or explained here. Nothing is left unexplained.

| Tool | Version | How it is run | Result (22 Oct 2026) |
|---|---|---|---|
| Slither | 0.11.6 (pinned, `scripts/ci/requirements-slither.txt`) | CI job "Slither static analysis", `slither.config.json`, fails on Medium and High | **0 High, 0 Medium.** Each reviewed exception is a dated `slither-disable-next-line` comment beside the code. |
| Aderyn | 0.6.8 (Cyfrin's release `aderyn-v0.6.8`, sha256 checked against the published `.sha256`) | `aderyn . --src contracts --path-excludes contracts/mocks,contracts/test,contracts/echidna` (Linux build; there is no Windows build) | 1 High category (17 sites) and 13 Low categories, every one triaged below. |

## Aderyn: fixed on 22 Oct 2026

| Finding | What it was | Fix |
|---|---|---|
| Contract locks Ether without a withdraw function (SRXToken, SRXOFTNative) | `lzReceive` is payable, so ETH an executor sends with a bridge delivery had no exit (internal audit TB-05). | `rescueTokens(address(0), to, amount)` moves ETH, behind the same authority as before (hub: the Timelock; spoke: its Timelock). Test `test/internal-audit/TB05.EthRescue.test.js`. |
| Contract name reused in different files | `ISRXToken` declared twice with different members, `ISuccessorOf` twice, `ISRXBurnable` twice. | One declaration each: `contracts/token/ISRXBurnable.sol`, `contracts/token/ISuccessorOf.sol`. |
| State variable could be immutable (6) | Settings set once in a constructor, with no setter, left as storage from the upgradeable design REG-53 removed. | Now `immutable` (StabilisationFund `srxToken`, `rewardAllocation`, `tgeDistributor`; SRXStaking `srx`, `tgeDistributor`; SRXTreasury `srxToken`). |

## Aderyn: reviewed, no change

**H: "Reentrancy: state change after external call" (17 sites).** Aderyn counts a `view` call and a
call to our own token as an external call. At every site the call is one of three kinds:
- **`balanceOf` on SRXToken or a payment token** (BuybackBurner `burnHeld`, `buyAndBurnWithToken`;
  PreSaleRound `deployVault`, `batchDeployVaults`; StabilisationFund and SRXStaking `notifyRewardAmount`;
  TGEDistributor `distribute`; VestingVault `triggerTGE`). A `view` call runs as a static call and
  cannot change state or re-enter a state-changing function.
- **`this.syncAllocation()` inside `startWindDown`** (StabilisationFund, SRXStaking). It is a call to
  the contract itself; it reads the allocation source fixed at deployment, and `startWindDown` is
  `nonReentrant`.
- **`ISuccessorOf(successor).tgeDistributor()` in `releaseRewardAllocation`** (StabilisationFund,
  SRXStaking). The successor is chosen by a Timelock proposal, the function is `nonReentrant` and
  governance-only, and the call is a `view`.
- **The swap router call in `BuybackBurner.buyAndBurnWithToken`.** `EXECUTOR_ROLE` only, `nonReentrant`;
  the router is set by the admin. Proven by the test BuybackBurner "re-entry during a swap", and Slither's
  `reentrancy-balance` exception at the same line carries the same reason.

**Low categories.**

| Category | Count | Verdict |
|---|---|---|
| Centralization risk | 95 | By design: every privileged function is listed in `MULTISIG_SPEC.md` with its holder after the hand-over (the Timelock, 48 h, for every power except the guardian's bounded pause). Checked by `verify_roles.js`. |
| Unchecked return | 29 | All are `_grantRole(...)` in constructors, whose boolean only says whether the role was new. In a constructor it always is. |
| Unspecific Solidity pragma | 19 | `^0.8.24` by policy; every build is pinned to solc 0.8.24 in `hardhat.config.js` and `foundry.toml`. |
| PUSH0 opcode | 19 | The target chains (Ethereum, BNB Chain, ZKsync) support Shanghai. The build targets `cancun`. |
| Large numeric literal / literal instead of constant | 24 / 23 | Readability. The values are named in comments and pinned by tests (supply cap, tier thresholds, durations). |
| `nonReentrant` is not the first modifier | 22 | The modifiers before it are access and state checks that make no external call. |
| Costly operations inside loop / loop contains revert | 6 / 5 | Paginated admin batches (`batchDeployVaults`, `batchTriggerTGE`) and the guardian's six-module `pauseAll`. Bounded, admin-only. A failing module is skipped visibly in `pauseAll` (R7-02). |
| Address state variable set without checks | 3 | `BuybackBurner.setSwapRouter` (zero disables swaps, deliberately) and `PreSaleRound.setStablecoinFeeds` (zero disables the depeg check for a coin that is not offered). Admin-only, each emits an event. |
| Storage array length not cached | 2 | Admin-only views and batches; gas only. |
| Local variable shadows state variable | 2 | `SRXGovernor` constructor parameters `_token` and `_timelock` shadow inherited names; no behavioural effect. |
| Missing inheritance | 1 | `TGEDistributor` answers `ITGEAllocationSource` (`token`, `distributed`, `allocatedTo`) without declaring it: its `token` getter is typed `IERC20`, the interface's `address`; the ABI is identical. The real distributor is exercised as the source by `test/REG50.FixedRewardPools.test.js` (end to end). |

Re-run both tools after any contract change, and update this file in the same commit.
