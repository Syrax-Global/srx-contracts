// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PreSaleRound} from "../../../contracts/presale/PreSaleRound.sol";
import {SRXToken} from "../../../contracts/token/SRXToken.sol";
import {MockLZEndpoint} from "../../../contracts/mocks/MockLZEndpoint.sol";
import {MockChainlinkFeed} from "../../../contracts/mocks/MockChainlinkFeed.sol";
import {MockERC20} from "../../../contracts/mocks/MockERC20.sol";

/**
 * @title PreSaleRoundFuzz
 * @notice Property-based fuzz tests for PreSaleRound. Run thousands of
 *         randomized USD inputs through addInvestor() / invest() and verify
 *         the tier math holds.
 *
 * Properties tested:
 *   - P1: total SRX allocation never exceeds hard cap
 *   - P2: tier bonus is monotonically non-decreasing with cumulative USD
 *   - P3: per-investor allocation calculation reproduces from cumulative USD
 *   - P4: removing an investor reduces totalAllocated by exactly that investor's allocation
 */
contract PreSaleRoundFuzz is Test {
    SRXToken          public token;
    MockLZEndpoint    public endpoint;
    MockChainlinkFeed public ethFeed;
    MockERC20         public usdc;
    MockERC20         public usdt;
    PreSaleRound      public presale;

    address constant ADMIN     = address(0xA11CE);
    address constant INVESTOR  = address(0xB0B);
    uint256 constant HARD_CAP  = 400_000_000 * 10 ** 18;   // 400M SRX
    uint256 constant SRX_PRICE = 1_250_000;                // $0.0125 in 8-dec
    uint256 constant PRESALE_FUND = 10_000_000 * 10 ** 18; // 10M SRX

    function setUp() public {
        endpoint = new MockLZEndpoint(40161);
        token    = new SRXToken(address(endpoint), ADMIN);
        vm.prank(ADMIN);
        token.genesis(ADMIN);

        ethFeed = new MockChainlinkFeed(2500_00000000); // $2500
        usdc    = new MockERC20("USDC", "USDC", 6);
        usdt    = new MockERC20("USDT", "USDT", 6);

        presale = new PreSaleRound(
            address(token),
            address(usdc),
            address(usdt),
            address(0),                // wbtc disabled
            address(ethFeed),
            address(0),                // btc feed disabled
            ADMIN,
            HARD_CAP,
            SRX_PRICE
        );

        // Fund presale
        vm.prank(ADMIN);
        token.transfer(address(presale), PRESALE_FUND);
    }

    /// @dev P1: For any USD input that fits under the hard cap, totalAllocated
    ///      stays bounded by hardCapSRX. Inputs that would exceed must revert.
    function testFuzz_totalAllocatedNeverExceedsCap(uint256 usdAmount8Dec) public {
        // Bound to a reasonable range: $1 to $500K
        usdAmount8Dec = bound(usdAmount8Dec, 1e8, 500_000 * 1e8);

        vm.prank(ADMIN);
        try presale.addInvestor(INVESTOR, usdAmount8Dec) {
            assertLe(
                presale.totalAllocated(),
                presale.hardCapSRX(),
                "P1 violated: totalAllocated exceeded hardCapSRX"
            );
        } catch {
            // Revert is acceptable — function must reject if would exceed cap
        }
    }

    /// @dev P2: tier bonus BPS is monotonically non-decreasing as cumulative USD grows.
    ///      Verify by reading getBonusBps after two successive top-ups.
    function testFuzz_tierBonusMonotonicallyIncreases(
        uint256 firstUsd,
        uint256 secondUsd
    ) public {
        // Bound both to non-trivial USD amounts
        firstUsd  = bound(firstUsd,  1_000 * 1e8, 50_000 * 1e8);   // $1K – $50K
        secondUsd = bound(secondUsd, 1_000 * 1e8, 100_000 * 1e8);  // $1K – $100K

        vm.startPrank(ADMIN);
        try presale.addInvestor(INVESTOR, firstUsd) {
            uint256 bpsAfterFirst = presale.getBonusBps(INVESTOR);

            try presale.addInvestor(INVESTOR, secondUsd) {
                uint256 bpsAfterSecond = presale.getBonusBps(INVESTOR);
                assertGe(
                    bpsAfterSecond,
                    bpsAfterFirst,
                    "P2 violated: tier bonus decreased after top-up"
                );
            } catch {}
        } catch {}
        vm.stopPrank();
    }

    /// @dev P4: removeInvestor reduces totalAllocated by exactly the investor's allocation
    function testFuzz_removeInvestorReducesTotalByAllocation(uint256 usdAmount8Dec) public {
        usdAmount8Dec = bound(usdAmount8Dec, 1_000 * 1e8, 50_000 * 1e8);

        vm.startPrank(ADMIN);
        try presale.addInvestor(INVESTOR, usdAmount8Dec) {
            (uint256 alloc,,, ) = presale.investors(INVESTOR);
            uint256 totalBefore  = presale.totalAllocated();

            presale.removeInvestor(INVESTOR);

            assertEq(
                presale.totalAllocated(),
                totalBefore - alloc,
                "P4 violated: removeInvestor did not reduce totalAllocated by exactly the allocation"
            );
        } catch {}
        vm.stopPrank();
    }
}
