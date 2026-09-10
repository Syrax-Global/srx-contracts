// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";
import {MockLZEndpoint} from "../../../contracts/mocks/MockLZEndpoint.sol";
import {SRXTokenHandler} from "../helpers/SRXTokenHandler.sol";

/**
 * @title SRXTokenInvariant
 * @notice Foundry invariant tests for SRXToken. Encodes the SC-INV-001
 *         and SC-INV-002 invariants from the Round 3 audit as continuously-checked
 *         properties under randomized sequences of token operations.
 *
 * Invariants tested:
 *   - INV-1: totalSupply() == MAX_SUPPLY - totalBurned() at all times after genesis
 *            (single-chain invariant; cross-chain bridge supply is checked separately)
 *   - INV-2: Sum of all actor balances equals totalSupply() at all times
 *   - INV-3: Total voting power across all actors equals totalSupply() (when fully delegated)
 *
 * Run:
 *   forge test --match-contract SRXTokenInvariant -vv
 *   FOUNDRY_PROFILE=ci forge test --match-contract SRXTokenInvariant
 */
contract SRXTokenInvariant is Test {
    SRXToken         public token;
    MockLZEndpoint   public endpoint;
    SRXTokenHandler  public handler;

    address constant ADMIN = address(0xA11CE);

    /// Ghost state for the properties added below. Set in setUp() after genesis.
    uint256 internal supplyAtGenesis;
    uint256 internal lastBurned;
    address[]        public actors;

    function setUp() public {
        // Set up 5 randomized actors
        actors.push(address(0xA11CE));
        actors.push(address(0xB0B));
        actors.push(address(0xCAFE));
        actors.push(address(0xDEADBEEF));
        actors.push(address(0xFEED));

        // Deploy mock LZ endpoint and the SRX token
        endpoint = new MockLZEndpoint(40161);
        token    = new SRXToken(address(endpoint), ADMIN);

        // Run genesis — mints 10B SRX to ADMIN
        vm.prank(ADMIN);
        token.genesis(ADMIN);

        supplyAtGenesis = token.totalSupply();
        lastBurned      = token.totalBurned();

        // Grant BURN_ROLE to ADMIN so the handler can call buyAndBurn
        // Cache role bytes first — calling token.BURN_ROLE() is an external call
        // that would consume the prank before grantRole executes.
        bytes32 burnRole = token.BURN_ROLE();
        vm.prank(ADMIN);
        token.grantRole(burnRole, ADMIN);

        // Distribute some tokens so the handler has multiple non-zero actors
        // ADMIN keeps the bulk; small amounts spread to others for fuzz variety
        uint256 perActor = 1_000_000 * 10 ** 18; // 1M SRX each
        for (uint256 i = 1; i < actors.length; i++) {
            vm.prank(ADMIN);
            token.transfer(actors[i], perActor);
        }

        // Deploy the handler and tell Foundry to fuzz its functions
        handler = new SRXTokenHandler(token, actors);
        targetContract(address(handler));
    }

    // ── INV-1: Supply equation ─────────────────────────────────────────────
    /// @dev SC-INV-001 — totalSupply equals MAX_SUPPLY minus totalBurned at all times.
    function invariant_totalSupplyEqualsMaxMinusBurned() public view {
        assertEq(
            token.totalSupply(),
            token.MAX_SUPPLY() - token.totalBurned(),
            "SC-INV-001 violated: totalSupply drifted from MAX_SUPPLY - totalBurned"
        );
    }

    // ── INV-2: Sum-of-balances ─────────────────────────────────────────────
    /// @dev Stronger form of INV-1 — explicitly sum every tracked actor balance.
    function invariant_sumOfBalancesEqualsTotalSupply() public view {
        uint256 sum;
        for (uint256 i = 0; i < actors.length; i++) {
            sum += token.balanceOf(actors[i]);
        }
        assertEq(
            sum,
            token.totalSupply(),
            "INV-2 violated: tracked actor balances do not sum to totalSupply"
        );
    }

    // ── INV-3: Voting power monotonicity ───────────────────────────────────
    /// @dev SC-INV-002 — voting power tracking via ERC20Votes preserves total
    ///      supply across delegation changes. After self-delegation by every
    ///      actor, sum(getVotes) == totalSupply.
    ///
    ///      Note: voting power is checkpointed; this invariant uses the LIVE
    ///      `getVotes` reading, not historical snapshots.
    function invariant_votingPowerNotExceedingSupply() public view {
        uint256 sumVotes;
        for (uint256 i = 0; i < actors.length; i++) {
            sumVotes += token.getVotes(actors[i]);
        }
        // Voting power must never exceed total supply
        assertLe(
            sumVotes,
            token.totalSupply(),
            "INV-3 violated: sum of votes exceeds totalSupply"
        );
    }

    // ── INV-4: Burn monotonicity ───────────────────────────────────────────
    /// @dev totalBurned can only increase. We don't have a snapshot of the
    ///      previous value here, but we can assert it never exceeds MAX_SUPPLY.
    function invariant_burnedNeverExceedsMaxSupply() public view {
        assertLe(
            token.totalBurned(),
            token.MAX_SUPPLY(),
            "INV-4 violated: totalBurned exceeded MAX_SUPPLY (impossible)"
        );
    }

    // ── INV-5: burn monotonicity, actually tested ──────────────────────────
    /// ⛔ INV-4 above is named "Burn monotonicity" and does not test it — its
    /// own comment says so: "We don't have a snapshot of the previous value
    /// here, but we can assert it never exceeds MAX_SUPPLY." A bound is not a
    /// direction. This keeps the snapshot and checks the direction.
    ///
    /// Deliberately NOT `view`: it has to remember the previous observation.
    function invariant_burnedIsMonotonic() public {
        uint256 current = token.totalBurned();
        assertGe(current, lastBurned, "INV-5 violated: totalBurned decreased");
        lastBurned = current;
    }

    // ── INV-6: genesis is once-only ────────────────────────────────────────
    /// A second successful genesis would mint MAX_SUPPLY again. Comparing
    /// against the value captured immediately after genesis makes that
    /// detectable; comparing against MAX_SUPPLY alone would not, because the
    /// second mint would still satisfy the cap check.
    function invariant_genesisIsOnceOnly() public view {
        assertTrue(token.genesisComplete(), "INV-6 violated: genesis flag cleared");
        assertEq(
            token.totalSupply() + token.totalBurned(),
            supplyAtGenesis,
            "INV-6 violated: supply moved away from its post-genesis value"
        );
    }

    // ── INV-7: no holder exceeds total supply ──────────────────────────────
    /// A cheap canary for accounting corruption in transfer: any single
    /// balance above totalSupply means the ledger has stopped adding up,
    /// which the sum check can miss if two errors cancel.
    function invariant_noHolderExceedsSupply() public view {
        uint256 supply = token.totalSupply();
        for (uint256 i = 0; i < actors.length; i++) {
            assertLe(token.balanceOf(actors[i]), supply, "INV-7 violated: holder exceeds supply");
        }
    }
}
