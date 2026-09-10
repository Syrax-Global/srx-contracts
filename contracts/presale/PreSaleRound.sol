// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { VestingVault } from "../vesting/VestingVault.sol";

/**
 * @title PreSaleRound
 * @notice Manages pre-presale (seed-equivalent) token allocations with on-chain
 *         participation tier bonuses.
 *
 * Supported payment paths:
 *   Off-chain  — admin records a SAFT / wire investor via addInvestor().
 *   ETH        — investor calls invest(). Price fetched live from Chainlink ETH/USD.
 *   USDC       — investor calls investWithUSDC(). Priced at $0.0125/SRX.
 *   USDT       — investor calls investWithUSDT(). Same price as USDC.
 *   WBTC       — investor calls investWithWBTC(). Price fetched live from Chainlink BTC/USD.
 *
 * Participation Tier Structure (flat — applies to entire cumulative investment):
 *
 *   Tier              │ Cumulative USD    │ Bonus
 *   ──────────────────┼───────────────────┼──────
 *   Entry             │ $0 – $99,999      │ +10%
 *   Standard          │ $100,000–$199,999 │ +12.5%
 *   Enhanced          │ $200,000–$299,999 │ +15%
 *   Priority          │ $300,000–$399,999 │ +17.5%
 *   Institutional     │ $400,000+         │ +20%
 *
 * Bonus applies to the full cumulative investment at the tier active at the time
 * of each investment. If a top-up crosses a tier boundary, the entire allocation
 * is recalculated at the new (higher) tier rate — the investor is retroactively
 * upgraded. Bonus SRX vests under the same terms as the principal.
 *
 * Pricing model:
 *   A single value — srxPriceUsd8Dec — stores the SRX price in USD with 8 decimal
 *   places. e.g. $0.0125 = 1_250_000 (0.0125 × 10^8).
 *
 *   ETH / WBTC amounts are converted to USD in real-time via Chainlink feeds, then
 *   divided by srxPriceUsd8Dec to produce the exact SRX allocation.
 *   USDC / USDT are treated as $1 each (6-decimal stablecoins).
 *
 *   USD tracking (all in 8-decimal format, consistent with Chainlink):
 *     ETH:       usdValue = ethWei × ethUsdPrice8dec / 1e18
 *     USDC/USDT: usdValue = stableAmount × 100
 *     WBTC:      usdValue = wbtcAmount × btcUsdPrice8dec / 1e8
 *
 *   SRX with bonus: totalSRX = cumulativeUsd × 1e18 × (10000 + bonusBps) / srxPrice / 10000
 *
 * Flow:
 *   1. Admin deploys with hard cap, SRX price, and oracle feed addresses.
 *   2. Admin transfers SRX allocation into this contract.
 *   3. Investors participate on-chain, or admin records off-chain investors.
 *   4. Admin calls deployVault(investor) / batchDeployVaults() to lock SRX into
 *      individual VestingVaults — one per investor.
 *   5. At token launch, admin calls batchTriggerTGE() to start all vesting clocks.
 *   6. Admin calls withdrawETH() / withdrawUSDC() / withdrawUSDT() / withdrawWBTC()
 *      to collect raised funds.
 *
 * Vesting terms (seed-equivalent, hardcoded):
 *   TGE unlock : 0%
 *   Cliff      : 273 days
 *   Vesting    : 730 days linear
 *
 * To disable a currency at deploy time, pass address(0) for its feed / token address.
 * WBTC requires both a non-zero wbtc token address AND a non-zero btcUsdFeed address.
 */
contract PreSaleRound is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Seed vesting constants ─────────────────────────────────────────────────

    uint256 public constant CLIFF_DURATION   = 273 days;
    uint256 public constant VESTING_DURATION = 730 days;
    uint256 public constant TGE_UNLOCK_BPS   = 0;

    // ── Default oracle staleness threshold ────────────────────────────────────
    // SC-004 fix: reduced from 3600s (1 hour) to 1800s (30 minutes).
    // SC-PR-001 fix: reduced from 1800s (30 minutes) to 300s (5 minutes) to
    // close the arbitrage window during oracle update lag. Chainlink ETH/USD
    // and BTC/USD update on a heartbeat of 3600s OR a deviation threshold of
    // 0.5% — whichever fires first. In practice, both feeds update every
    // 5–15 minutes during normal volatility. A 300s threshold means investments
    // revert if the oracle is more than 5 minutes behind real time — eliminates
    // the bulk of price-drift MEV. Governance can raise this via
    // setMaxStaleness() if oracle reliability requires it during deployment.

    uint256 public constant DEFAULT_MAX_STALENESS = 300; // 5 minutes

    // ── Participation tier thresholds (cumulative USD in 8-decimal format) ────
    //
    //  $100,000 in 8-dec = 100_000 × 1e8 = 10_000_000_000_000
    //  Investors whose cumulative USD reaches or exceeds a threshold are
    //  upgraded to that tier. The full allocation is recalculated at the new rate.

    uint256 public constant TIER_STANDARD_MIN     = 10_000_000_000_000; // $100,000
    uint256 public constant TIER_ENHANCED_MIN     = 20_000_000_000_000; // $200,000
    uint256 public constant TIER_PRIORITY_MIN     = 30_000_000_000_000; // $300,000
    uint256 public constant TIER_INSTITUTIONAL_MIN = 40_000_000_000_000; // $400,000

    // ── Participation tier bonus rates (basis points, 10000 = 100%) ───────────

    uint256 public constant ENTRY_BONUS_BPS         = 1_000; // +10%
    uint256 public constant STANDARD_BONUS_BPS      = 1_250; // +12.5%
    uint256 public constant ENHANCED_BONUS_BPS      = 1_500; // +15%
    uint256 public constant PRIORITY_BONUS_BPS      = 1_750; // +17.5%
    uint256 public constant INSTITUTIONAL_BONUS_BPS = 2_000; // +20%

    // ── Immutables ─────────────────────────────────────────────────────────────

    IERC20  public immutable srxToken;
    IERC20  public immutable usdc;       // 6-decimal; address(0) = disabled
    IERC20  public immutable usdt;       // 6-decimal; address(0) = disabled
    IERC20  public immutable wbtc;       // 8-decimal; address(0) = disabled
    address public immutable admin;

    IAggregatorV3 public immutable ethUsdFeed; // address(0) = ETH disabled
    IAggregatorV3 public immutable btcUsdFeed; // address(0) = WBTC disabled

    // ── Mutable config ─────────────────────────────────────────────────────────

    uint256 public srxPriceUsd8Dec; // SRX price in 8-dec USD (e.g. 1_250_000 = $0.0125)
    uint256 public maxStaleness;    // Chainlink staleness threshold in seconds
    uint256 public hardCapSRX;      // maximum total SRX allocatable this round
    bool    public finalized;       // when true: no new investments accepted

    // ── Oracle sanity bounds (SC-OPS-001 fix) ─────────────────────────────────
    //
    // Defends against Chainlink feed malfunctions that return technically valid but
    // economically impossible prices (e.g. ETH = $1 or ETH = $1,000,000). Recent
    // DeFi exploits (Compound 2020, Inverse Finance 2022) used exactly this vector
    // when oracle feeds suffered transient malfunctions.
    //
    // Both bounds are stored in Chainlink 8-decimal format (e.g. $500 = 50_000_000_000).
    // A bound of 0 disables the check on that side. Governance sets reasonable bounds
    // at deployment and can adjust via setOraclePriceBounds().
    //
    // Recommended initial bounds:
    //   ETH:  min = $100   (10_000_000_000)      max = $20,000 (2_000_000_000_000)
    //   BTC:  min = $10,000 (1_000_000_000_000)  max = $500,000 (50_000_000_000_000)
    //
    // These are deliberately generous (~10x range each direction) — tight enough to
    // catch malfunctions but wide enough to survive legitimate market crashes / rallies.

    uint256 public minEthPriceUsd8Dec; // 0 = disabled
    uint256 public maxEthPriceUsd8Dec; // 0 = disabled
    uint256 public minBtcPriceUsd8Dec; // 0 = disabled
    uint256 public maxBtcPriceUsd8Dec; // 0 = disabled

    // ── Optional Chainlink stablecoin feeds (SC-OPS-002 fix) ───────────────────
    //
    // By default, the contract treats 1 USDC = 1 USDT = $1. During known depeg
    // events (USDC March 2023 = $0.87; USDT periodically below peg), this
    // assumption transfers value between the protocol and investors.
    //
    // If governance sets a USDC/USD or USDT/USD Chainlink feed via
    // setStablecoinFeeds(), the contract uses the live price (8-dec) instead of
    // the $1 assumption. The same staleness and bounds checks apply. A feed of
    // address(0) reverts to the $1 default.

    IAggregatorV3 public usdcUsdFeed; // address(0) = use $1 assumption (default)
    IAggregatorV3 public usdtUsdFeed; // address(0) = use $1 assumption (default)

    // ── Stablecoin oracle sanity bounds (SC-OPS-001 fix) ───────────────────────
    //
    // When a USDC/USDT Chainlink feed is configured, these bounds reject technically
    // valid but economically impossible prices (e.g. a feed glitch reporting $0.0001
    // or $5 for a dollar-pegged asset). Stored in Chainlink 8-decimal format.
    // A bound of 0 disables the check on that side. Recommended on mainnet:
    //   min = $0.50 (50_000_000)   max = $2.00 (200_000_000)
    uint256 public minStablePriceUsd8Dec; // 0 = disabled
    uint256 public maxStablePriceUsd8Dec; // 0 = disabled

    // ── Per-feed staleness overrides (SC-ECON-002 fix) ─────────────────────────
    //
    // A single global `maxStaleness` cannot match feeds with different heartbeats
    // (Chainlink ETH/USD and BTC/USD heartbeat ~3600s; stablecoin feeds vary).
    // Each override, when non-zero, replaces `maxStaleness` for that specific feed.
    // 0 = fall back to the global `maxStaleness`. Lets governance set, e.g.,
    // 3900s for ETH/BTC heartbeat feeds while keeping a tight global default.
    uint256 public ethMaxStaleness;    // 0 = use maxStaleness
    uint256 public btcMaxStaleness;    // 0 = use maxStaleness
    uint256 public stableMaxStaleness; // 0 = use maxStaleness

    // ── Investor state ─────────────────────────────────────────────────────────

    struct Investor {
        uint256 srxAllocation;     // total SRX owed (principal + bonus, 18-dec)
        uint256 cumulativeUsd8Dec; // cumulative USD invested (8-dec), used for tier lookup
        address vault;             // VestingVault address (address(0) until deployed)
        bool    offChain;          // true = added by admin, false = on-chain payment
    }

    mapping(address => Investor) public investors;
    address[] public investorList;

    uint256 public totalAllocated;

    // ── Events ─────────────────────────────────────────────────────────────────

    event InvestorAdded(address indexed investor, uint256 srxAmount, bool offChain);
    event AllocationUpdated(address indexed investor, uint256 oldAmount, uint256 newAmount);
    event BonusApplied(
        address indexed investor,
        string  tierName,
        uint256 bonusBps,
        uint256 baseSRX,
        uint256 totalSRX
    );
    event InvestorRemoved(address indexed investor);
    event VaultDeployed(address indexed investor, address indexed vault, uint256 srxAmount);
    event TGETriggeredForAll(uint256 vaultCount);
    event Finalized();
    event SRXPriceUpdated(uint256 oldPrice8Dec, uint256 newPrice8Dec);
    event HardCapUpdated(uint256 newCap);
    event MaxStalenessUpdated(uint256 newStaleness);
    event ETHWithdrawn(address indexed to, uint256 amount);
    event USDCWithdrawn(address indexed to, uint256 amount);
    event USDTWithdrawn(address indexed to, uint256 amount);
    event WBTCWithdrawn(address indexed to, uint256 amount);
    event SRXRecovered(address indexed to, uint256 amount);
    event OraclePriceBoundsUpdated(
        uint256 minEthPriceUsd8Dec, uint256 maxEthPriceUsd8Dec,
        uint256 minBtcPriceUsd8Dec, uint256 maxBtcPriceUsd8Dec
    );
    event StablecoinFeedsUpdated(address indexed usdcFeed, address indexed usdtFeed);
    event StablecoinPriceBoundsUpdated(uint256 minStablePriceUsd8Dec, uint256 maxStablePriceUsd8Dec);
    event FeedStalenessUpdated(uint256 ethMaxStaleness, uint256 btcMaxStaleness, uint256 stableMaxStaleness);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error OnlyAdmin();
    error RoundFinalized();
    error HardCapExceeded();
    error ZeroAmount();
    error ZeroAddress();
    error NoAllocation();
    error VaultAlreadyDeployed();
    error InsufficientSRX();
    error ETHTransferFailed();
    error CapBelowAllocated();
    error CurrencyDisabled();
    error InvalidOraclePrice();
    error StalePriceFeed();
    error IncompleteRound();
    error OraclePriceOutOfBounds(uint256 price, uint256 min, uint256 max);
    error InvalidPriceBounds();
    error PriceLockedAfterFirstInvestor(); // R5-02: price immutable once any investor exists

    // ── Modifiers ──────────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier notFinalized() {
        if (finalized) revert RoundFinalized();
        _;
    }

    // ── Constructor ────────────────────────────────────────────────────────────

    /**
     * @param _srxToken        SRX token address.
     * @param _usdc            USDC address (6-dec). Pass address(0) to disable.
     * @param _usdt            USDT address (6-dec). Pass address(0) to disable.
     * @param _wbtc            WBTC address (8-dec). Pass address(0) to disable.
     * @param _ethUsdFeed      Chainlink ETH/USD feed. Pass address(0) to disable ETH investment.
     * @param _btcUsdFeed      Chainlink BTC/USD feed. Pass address(0) to disable WBTC investment.
     * @param _admin           Admin address (Gnosis Safe in production).
     * @param _hardCapSRX      Maximum SRX (18-dec) allocatable in this round.
     * @param _srxPriceUsd8Dec SRX price in 8-decimal USD (e.g. 1_250_000 for $0.0125).
     */
    constructor(
        address _srxToken,
        address _usdc,
        address _usdt,
        address _wbtc,
        address _ethUsdFeed,
        address _btcUsdFeed,
        address _admin,
        uint256 _hardCapSRX,
        uint256 _srxPriceUsd8Dec
    ) {
        if (_srxToken == address(0)) revert ZeroAddress();
        if (_admin    == address(0)) revert ZeroAddress();
        if (_hardCapSRX == 0)        revert ZeroAmount();
        if (_srxPriceUsd8Dec == 0)   revert ZeroAmount();

        srxToken        = IERC20(_srxToken);
        usdc            = IERC20(_usdc);
        usdt            = IERC20(_usdt);
        wbtc            = IERC20(_wbtc);
        ethUsdFeed      = IAggregatorV3(_ethUsdFeed);
        btcUsdFeed      = IAggregatorV3(_btcUsdFeed);
        admin           = _admin;
        hardCapSRX      = _hardCapSRX;
        srxPriceUsd8Dec = _srxPriceUsd8Dec;
        maxStaleness    = DEFAULT_MAX_STALENESS;
    }

    // ── Off-chain investor management ──────────────────────────────────────────

    /**
     * @notice Record an off-chain (SAFT / wire transfer) investor.
     *
     * @dev Pass the INCREMENTAL USD amount for this payment in 8-decimal format
     *      (e.g. a $100,000 wire = 10_000_000_000_000). The contract calculates SRX
     *      allocation including the participation tier bonus automatically.
     *
     *      For top-ups: if the new cumulative USD crosses a tier boundary, the FULL
     *      allocation is recalculated at the higher tier rate. The investor is
     *      retroactively upgraded on every top-up.
     *
     *      Reverts if the investor's vault has already been deployed (allocation locked).
     *
     * @param investor      Investor wallet address.
     * @param usdAmount8Dec Incremental USD investment in 8-decimal format.
     */
    function addInvestor(address investor, uint256 usdAmount8Dec)
        external
        onlyAdmin
        notFinalized
    {
        if (investor     == address(0)) revert ZeroAddress();
        if (usdAmount8Dec == 0)          revert ZeroAmount();
        if (investors[investor].vault != address(0)) revert VaultAlreadyDeployed();

        _processInvestment(investor, usdAmount8Dec, true);
    }

    /**
     * @notice Directly set an investor's SRX allocation and synthetic USD equivalent.
     *         Use this to correct an allocation after an error. The cumulativeUsd8Dec
     *         is back-calculated from the SRX amount so tier views remain consistent.
     *         Reverts if the investor has no existing allocation or vault is deployed.
     */
    function updateAllocation(address investor, uint256 newSrxAmount) external onlyAdmin notFinalized {
        Investor storage inv = investors[investor];
        if (inv.srxAllocation == 0)  revert NoAllocation();
        if (inv.vault != address(0)) revert VaultAlreadyDeployed();
        if (newSrxAmount == 0)       revert ZeroAmount();

        uint256 oldAmount = inv.srxAllocation;
        uint256 newTotal  = totalAllocated - oldAmount + newSrxAmount;
        if (newTotal > hardCapSRX) revert HardCapExceeded();

        // Back-calculate a synthetic USD equivalent so tier views stay consistent.
        // R5-03 fix: invert the FULL forward map including the tier bonus —
        //   srx = usd × (10000 + bonusBps(usd)) × 1e18 / price / 10000
        // The old naive inversion (srx × price / 1e18) omitted the bonus factor,
        // overstating USD by 10–20% and inflating the investor's tier.
        inv.cumulativeUsd8Dec = _usdFromSrx(newSrxAmount);
        totalAllocated        = newTotal;
        inv.srxAllocation     = newSrxAmount;

        emit AllocationUpdated(investor, oldAmount, newSrxAmount);
    }

    /**
     * @notice Remove an investor before their vault is deployed (e.g. failed KYC).
     *
     * @dev Uses an O(n) swap-and-pop to maintain investorList without gaps.
     *      For presale-scale lists (typically < 500 investors) this stays well within
     *      block gas limits. If the investor set ever grows into the thousands, migrate
     *      to an off-chain index mapping to make removal O(1) (A3-L-01 note).
     */
    function removeInvestor(address investor) external onlyAdmin notFinalized {
        Investor storage inv = investors[investor];
        if (inv.srxAllocation == 0)  revert NoAllocation();
        if (inv.vault != address(0)) revert VaultAlreadyDeployed();

        totalAllocated -= inv.srxAllocation;
        delete investors[investor];

        uint256 len = investorList.length;
        for (uint256 i = 0; i < len; i++) {
            if (investorList[i] == investor) {
                investorList[i] = investorList[len - 1];
                investorList.pop();
                break;
            }
        }

        emit InvestorRemoved(investor);
    }

    // ── On-chain: ETH ─────────────────────────────────────────────────────────

    /**
     * @notice Invest with ETH. SRX allocation (including tier bonus) is calculated
     *         using the live Chainlink ETH/USD price.
     *         Investors may call this multiple times to top up their allocation.
     *         Crossing a tier boundary on top-up retroactively upgrades the full allocation.
     *         Reverts if the investor's vault has already been deployed (allocation locked).
     */
    function invest() external payable notFinalized nonReentrant {
        if (address(ethUsdFeed) == address(0)) revert CurrencyDisabled();
        if (msg.value == 0) revert ZeroAmount();
        if (investors[msg.sender].vault != address(0)) revert VaultAlreadyDeployed();

        uint256 usdValue8Dec = _ethToUsd8Dec(msg.value);
        if (usdValue8Dec == 0) revert ZeroAmount();

        _processInvestment(msg.sender, usdValue8Dec, false);
    }

    // ── On-chain: USDC ────────────────────────────────────────────────────────

    /**
     * @notice Invest with USDC (6-decimal). Caller must approve this contract first.
     *         1 USDC = $1, priced at srxPriceUsd8Dec per SRX, plus tier bonus.
     *         Investors may call this multiple times to top up their allocation.
     *         Crossing a tier boundary retroactively upgrades the full allocation.
     *         Reverts if the investor's vault has already been deployed (allocation locked).
     */
    function investWithUSDC(uint256 usdcAmount) external notFinalized nonReentrant {
        if (address(usdc) == address(0)) revert CurrencyDisabled();
        if (usdcAmount == 0) revert ZeroAmount();
        if (investors[msg.sender].vault != address(0)) revert VaultAlreadyDeployed();

        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // SC-OPS-002: use Chainlink USDC/USD feed if set, else default to $1
        uint256 usdValue8Dec = _stableToUsd8Dec(usdcAmount, usdcUsdFeed);
        _processInvestment(msg.sender, usdValue8Dec, false);
    }

    // ── On-chain: USDT ────────────────────────────────────────────────────────

    /**
     * @notice Invest with USDT (6-decimal). Caller must approve this contract first.
     *         Same pricing as USDC — 1 USDT = $1, plus tier bonus.
     *         Investors may call this multiple times to top up their allocation.
     *         Crossing a tier boundary retroactively upgrades the full allocation.
     *         Reverts if the investor's vault has already been deployed (allocation locked).
     */
    function investWithUSDT(uint256 usdtAmount) external notFinalized nonReentrant {
        if (address(usdt) == address(0)) revert CurrencyDisabled();
        if (usdtAmount == 0) revert ZeroAmount();
        if (investors[msg.sender].vault != address(0)) revert VaultAlreadyDeployed();

        usdt.safeTransferFrom(msg.sender, address(this), usdtAmount);

        // SC-OPS-002: use Chainlink USDT/USD feed if set, else default to $1
        uint256 usdValue8Dec = _stableToUsd8Dec(usdtAmount, usdtUsdFeed);
        _processInvestment(msg.sender, usdValue8Dec, false);
    }

    // ── On-chain: WBTC ────────────────────────────────────────────────────────

    /**
     * @notice Invest with WBTC (8-decimal Wrapped Bitcoin). Caller must approve first.
     *         BTC price is fetched live from Chainlink BTC/USD, plus tier bonus.
     *         Investors may call this multiple times to top up their allocation.
     *         Crossing a tier boundary retroactively upgrades the full allocation.
     *         Reverts if the investor's vault has already been deployed (allocation locked).
     */
    function investWithWBTC(uint256 wbtcAmount) external notFinalized nonReentrant {
        if (address(wbtc) == address(0) || address(btcUsdFeed) == address(0)) revert CurrencyDisabled();
        if (wbtcAmount == 0) revert ZeroAmount();
        if (investors[msg.sender].vault != address(0)) revert VaultAlreadyDeployed();

        wbtc.safeTransferFrom(msg.sender, address(this), wbtcAmount);

        uint256 usdValue8Dec = _wbtcToUsd8Dec(wbtcAmount);
        if (usdValue8Dec == 0) revert ZeroAmount();

        _processInvestment(msg.sender, usdValue8Dec, false);
    }

    // ── Vault deployment ───────────────────────────────────────────────────────

    function deployVault(address investor) external onlyAdmin returns (address vault) {
        Investor storage inv = investors[investor];
        if (inv.srxAllocation == 0)   revert NoAllocation();
        if (inv.vault != address(0))  revert VaultAlreadyDeployed();

        uint256 amount = inv.srxAllocation;
        if (srxToken.balanceOf(address(this)) < amount) revert InsufficientSRX();

        VestingVault v = new VestingVault(
            address(srxToken),
            investor,
            address(this),
            CLIFF_DURATION,
            VESTING_DURATION,
            TGE_UNLOCK_BPS
        );
        vault     = address(v);
        inv.vault = vault;
        srxToken.safeTransfer(vault, amount);

        emit VaultDeployed(investor, vault, amount);
    }

    /**
     * @notice Deploy vesting vaults for a range of investors by index.
     *         Use startIndex=0, endIndex=investorList.length for a full run.
     *         For large investor sets, call in batches of 20-50 per transaction
     *         to stay within block gas limits (M-07 fix).
     *
     * @param startIndex Inclusive start index in investorList.
     * @param endIndex   Exclusive end index in investorList.
     */
    function batchDeployVaults(uint256 startIndex, uint256 endIndex) external onlyAdmin {
        uint256 len = investorList.length;
        if (endIndex > len) endIndex = len;

        for (uint256 i = startIndex; i < endIndex; i++) {
            address investor     = investorList[i];
            Investor storage inv = investors[investor];
            if (inv.vault != address(0) || inv.srxAllocation == 0) continue;

            uint256 amount = inv.srxAllocation;
            if (srxToken.balanceOf(address(this)) < amount) revert InsufficientSRX();

            VestingVault v = new VestingVault(
                address(srxToken),
                investor,
                address(this),
                CLIFF_DURATION,
                VESTING_DURATION,
                TGE_UNLOCK_BPS
            );
            inv.vault = address(v);
            srxToken.safeTransfer(address(v), amount);
            emit VaultDeployed(investor, address(v), amount);
        }
    }

    // ── TGE ───────────────────────────────────────────────────────────────────

    /**
     * @notice Trigger TGE on all deployed investor vaults. Paginated to avoid block
     *         gas limit issues with large investor lists (A2-M-02 fix — same pattern
     *         as batchDeployVaults). Process the full list by calling in batches:
     *         batchTriggerTGE(0, 100), batchTriggerTGE(100, 200), etc.
     * @param startIndex Inclusive start index in investorList.
     * @param endIndex   Exclusive end index. Clamped to list length if out of bounds.
     */
    function batchTriggerTGE(uint256 startIndex, uint256 endIndex) external onlyAdmin {
        uint256 len = investorList.length;
        if (endIndex > len) endIndex = len;
        uint256 count = 0;
        for (uint256 i = startIndex; i < endIndex; i++) {
            address vaultAddr = investors[investorList[i]].vault;
            if (vaultAddr != address(0)) {
                VestingVault(vaultAddr).triggerTGE();
                count++;
            }
        }
        emit TGETriggeredForAll(count);
    }

    function revokeVault(address investor, address revokeRecipient) external onlyAdmin {
        address vaultAddr = investors[investor].vault;
        if (vaultAddr == address(0)) revert NoAllocation();
        VestingVault(vaultAddr).revoke(revokeRecipient);
    }

    // ── Admin config ───────────────────────────────────────────────────────────

    function finalize() external onlyAdmin notFinalized {
        finalized = true;
        emit Finalized();
    }

    /**
     * @notice Update the SRX price in USD (8 decimal places).
     *         e.g. $0.0125 = 1_250_000. Use this to correct the price BEFORE the
     *         round opens — it is locked once the first investor is recorded.
     *
     *         R5-02 fix: _processInvestment recomputes an investor's ENTIRE position
     *         at the CURRENT price on every top-up (cumulativeUsd × price). A price
     *         change mid-round therefore IS retroactive:
     *           price ↑ → newTotalSRX < oldSRX → srxDelta underflows → top-up reverts
     *           price ↓ → the whole prior position is repriced cheaper → value leak
     *         Locking the price once any investor exists removes both failure modes.
     *         To change price after that, finalize this round and deploy a new one.
     */
    function setSRXPrice(uint256 _srxPriceUsd8Dec) external onlyAdmin notFinalized {
        if (_srxPriceUsd8Dec == 0) revert ZeroAmount();
        if (investorList.length > 0) revert PriceLockedAfterFirstInvestor();
        emit SRXPriceUpdated(srxPriceUsd8Dec, _srxPriceUsd8Dec);
        srxPriceUsd8Dec = _srxPriceUsd8Dec;
    }

    /**
     * @notice Update the Chainlink staleness threshold.
     *         If the oracle has not been updated within this many seconds, investments revert.
     */
    function setMaxStaleness(uint256 _maxStaleness) external onlyAdmin {
        if (_maxStaleness == 0) revert ZeroAmount();
        maxStaleness = _maxStaleness;
        emit MaxStalenessUpdated(_maxStaleness);
    }

    /**
     * @notice Set oracle sanity bounds for ETH and BTC prices (SC-OPS-001 fix).
     *
     *         Both bounds are in Chainlink 8-decimal USD format. A min/max of 0
     *         disables the check on that side. The check is enforced on every
     *         oracle read inside _ethToUsd8Dec and _wbtcToUsd8Dec.
     *
     *         Governance MUST set reasonable bounds before mainnet. Recommended:
     *           ETH min/max: $100  / $20,000   (8-dec: 10_000_000_000 / 2_000_000_000_000)
     *           BTC min/max: $10K  / $500,000  (8-dec: 1_000_000_000_000 / 50_000_000_000_000)
     *
     *         A min > max is rejected. Pass (0, 0) on both pairs to disable bounds
     *         entirely (NOT recommended for production).
     *
     * @param _minEth Minimum acceptable ETH price (8-dec). 0 = disabled.
     * @param _maxEth Maximum acceptable ETH price (8-dec). 0 = disabled.
     * @param _minBtc Minimum acceptable BTC price (8-dec). 0 = disabled.
     * @param _maxBtc Maximum acceptable BTC price (8-dec). 0 = disabled.
     */
    function setOraclePriceBounds(
        uint256 _minEth,
        uint256 _maxEth,
        uint256 _minBtc,
        uint256 _maxBtc
    ) external onlyAdmin {
        // If both are non-zero, min must be < max
        if (_minEth != 0 && _maxEth != 0 && _minEth >= _maxEth) revert InvalidPriceBounds();
        if (_minBtc != 0 && _maxBtc != 0 && _minBtc >= _maxBtc) revert InvalidPriceBounds();
        minEthPriceUsd8Dec = _minEth;
        maxEthPriceUsd8Dec = _maxEth;
        minBtcPriceUsd8Dec = _minBtc;
        maxBtcPriceUsd8Dec = _maxBtc;
        emit OraclePriceBoundsUpdated(_minEth, _maxEth, _minBtc, _maxBtc);
    }

    /**
     * @notice Set optional Chainlink USDC/USDT price feeds (SC-OPS-002 fix).
     *         When set, the contract uses the live feed price (with staleness +
     *         completeness checks) instead of the $1 default. Pass address(0) to
     *         disable a feed and fall back to $1.
     *         Recommended on mainnet to defend against stablecoin depeg events.
     */
    function setStablecoinFeeds(address _usdcFeed, address _usdtFeed) external onlyAdmin {
        usdcUsdFeed = IAggregatorV3(_usdcFeed);
        usdtUsdFeed = IAggregatorV3(_usdtFeed);
        emit StablecoinFeedsUpdated(_usdcFeed, _usdtFeed);
    }

    /**
     * @notice Set sanity bounds for configured stablecoin feeds (SC-OPS-001 fix).
     *         Bounds are in Chainlink 8-decimal USD format; 0 disables a side.
     *         Only enforced when a USDC/USDT feed is set; the $1 default path is
     *         unaffected. Recommended on mainnet: min $0.50, max $2.00.
     * @param _min Minimum acceptable stable price (8-dec). 0 = disabled.
     * @param _max Maximum acceptable stable price (8-dec). 0 = disabled.
     */
    function setStablecoinPriceBounds(uint256 _min, uint256 _max) external onlyAdmin {
        if (_min != 0 && _max != 0 && _min >= _max) revert InvalidPriceBounds();
        minStablePriceUsd8Dec = _min;
        maxStablePriceUsd8Dec = _max;
        emit StablecoinPriceBoundsUpdated(_min, _max);
    }

    /**
     * @notice Set per-feed staleness overrides (SC-ECON-002 fix). Each value, when
     *         non-zero, replaces the global `maxStaleness` for that feed. 0 = use the
     *         global default. Lets governance match each feed's true heartbeat (e.g.
     *         ~3900s for ETH/BTC) without loosening the global default for others.
     * @param _eth    ETH/USD staleness override in seconds (0 = use maxStaleness).
     * @param _btc    BTC/USD staleness override in seconds (0 = use maxStaleness).
     * @param _stable Stablecoin feed staleness override in seconds (0 = use maxStaleness).
     */
    function setFeedStaleness(uint256 _eth, uint256 _btc, uint256 _stable) external onlyAdmin {
        ethMaxStaleness    = _eth;
        btcMaxStaleness    = _btc;
        stableMaxStaleness = _stable;
        emit FeedStalenessUpdated(_eth, _btc, _stable);
    }

    function setHardCap(uint256 _hardCapSRX) external onlyAdmin notFinalized {
        if (_hardCapSRX < totalAllocated) revert CapBelowAllocated();
        if (_hardCapSRX == 0)            revert ZeroAmount();
        hardCapSRX = _hardCapSRX;
        emit HardCapUpdated(_hardCapSRX);
    }

    // ── Fund withdrawal ────────────────────────────────────────────────────────

    function withdrawETH(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = address(this).balance;
        if (bal == 0) revert ZeroAmount();
        (bool ok,) = to.call{ value: bal }("");
        if (!ok) revert ETHTransferFailed();
        emit ETHWithdrawn(to, bal);
    }

    /**
     * @notice Withdraw a specific amount of ETH (SC-OPS-003 fix).
     *         Lets the admin test a small amount first to validate the recipient
     *         is payable, then withdraw the full balance — avoids the all-or-nothing
     *         failure mode of withdrawETH() when the destination is a multisig with
     *         restricted receive() handling.
     * @param to     Recipient address (must accept ETH).
     * @param amount Amount of ETH in wei. Must be > 0 and ≤ contract balance.
     */
    function withdrawETHAmount(address to, uint256 amount) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > address(this).balance) revert ZeroAmount();
        (bool ok,) = to.call{ value: amount }("");
        if (!ok) revert ETHTransferFailed();
        emit ETHWithdrawn(to, amount);
    }

    function withdrawUSDC(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = usdc.balanceOf(address(this));
        if (bal == 0) revert ZeroAmount();
        usdc.safeTransfer(to, bal);
        emit USDCWithdrawn(to, bal);
    }

    function withdrawUSDT(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = usdt.balanceOf(address(this));
        if (bal == 0) revert ZeroAmount();
        usdt.safeTransfer(to, bal);
        emit USDTWithdrawn(to, bal);
    }

    function withdrawWBTC(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = wbtc.balanceOf(address(this));
        if (bal == 0) revert ZeroAmount();
        wbtc.safeTransfer(to, bal);
        emit WBTCWithdrawn(to, bal);
    }

    function recoverSRX(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = srxToken.balanceOf(address(this));
        if (bal == 0) revert ZeroAmount();
        srxToken.safeTransfer(to, bal);
        emit SRXRecovered(to, bal);
    }

    // ── Quote views ────────────────────────────────────────────────────────────

    /// @notice How many SRX (including tier bonus) will `ethAmount` wei buy,
    ///         given the investor's current cumulative USD.
    function quoteETH(uint256 ethAmount, address investor) external view returns (uint256) {
        if (address(ethUsdFeed) == address(0)) revert CurrencyDisabled();
        uint256 usdValue8Dec    = _ethToUsd8Dec(ethAmount);
        uint256 newCumulative   = investors[investor].cumulativeUsd8Dec + usdValue8Dec;
        return _computeTotalSRXWithBonus(newCumulative) - investors[investor].srxAllocation;
    }

    /// @notice How many SRX (including tier bonus) will `stableAmount` of USDC/USDT buy,
    ///         given the investor's current cumulative USD.
    /// @dev R5-04 fix: quotes through the SAME feed-aware conversion the invest path
    ///      uses (_stableToUsd8Dec with the USDC/USD feed), so quoted SRX matches
    ///      received SRX even during a stablecoin depeg. With no feed configured this
    ///      is identical to the legacy $1 assumption. USDT amounts quote via the USDC
    ///      feed here; for exact USDT pricing during a divergence, compare on-chain.
    function quoteStable(uint256 stableAmount, address investor) external view returns (uint256) {
        uint256 usdValue8Dec    = _stableToUsd8Dec(stableAmount, usdcUsdFeed);
        uint256 newCumulative   = investors[investor].cumulativeUsd8Dec + usdValue8Dec;
        return _computeTotalSRXWithBonus(newCumulative) - investors[investor].srxAllocation;
    }

    /// @notice How many SRX (including tier bonus) will `wbtcAmount` (8-decimal) buy,
    ///         given the investor's current cumulative USD.
    function quoteWBTC(uint256 wbtcAmount, address investor) external view returns (uint256) {
        if (address(wbtc) == address(0) || address(btcUsdFeed) == address(0)) revert CurrencyDisabled();
        uint256 usdValue8Dec    = _wbtcToUsd8Dec(wbtcAmount);
        uint256 newCumulative   = investors[investor].cumulativeUsd8Dec + usdValue8Dec;
        return _computeTotalSRXWithBonus(newCumulative) - investors[investor].srxAllocation;
    }

    /// @notice Current ETH/USD price from Chainlink (8 decimal places).
    function currentEthPrice() external view returns (uint256) {
        if (address(ethUsdFeed) == address(0)) revert CurrencyDisabled();
        (, int256 price,,, ) = ethUsdFeed.latestRoundData();
        return uint256(price);
    }

    /// @notice Current BTC/USD price from Chainlink (8 decimal places).
    function currentBtcPrice() external view returns (uint256) {
        if (address(btcUsdFeed) == address(0)) revert CurrencyDisabled();
        (, int256 price,,, ) = btcUsdFeed.latestRoundData();
        return uint256(price);
    }

    // ── Tier views ─────────────────────────────────────────────────────────────

    /// @notice Returns the tier name for an investor based on their current cumulative USD.
    function getTierName(address investor) external view returns (string memory) {
        return _tierName(investors[investor].cumulativeUsd8Dec);
    }

    /// @notice Returns the bonus BPS currently applied to an investor's allocation.
    function getBonusBps(address investor) external view returns (uint256) {
        return _getTierBps(investors[investor].cumulativeUsd8Dec);
    }

    /// @notice Returns the tier name and bonus BPS that would apply to a given
    ///         cumulative USD amount (8-decimal). Useful for front-end display.
    function quoteTier(uint256 cumulativeUsd8Dec)
        external
        pure
        returns (string memory tierName, uint256 bonusBps)
    {
        bonusBps = _getTierBps(cumulativeUsd8Dec);
        tierName = _tierName(cumulativeUsd8Dec);
    }

    // ── General views ──────────────────────────────────────────────────────────

    function investorCount()     external view returns (uint256) { return investorList.length; }
    function remainingCap()      external view returns (uint256) { return hardCapSRX - totalAllocated; }
    function getVault(address i) external view returns (address) { return investors[i].vault; }
    function getInvestorList()   external view returns (address[] memory) { return investorList; }

    function getAllVaults() external view returns (address[] memory vaults) {
        uint256 len = investorList.length;
        vaults = new address[](len);
        for (uint256 i = 0; i < len; i++) {
            vaults[i] = investors[investorList[i]].vault;
        }
    }

    function pendingDeployment() external view returns (uint256 total) {
        uint256 len = investorList.length;
        for (uint256 i = 0; i < len; i++) {
            Investor storage inv = investors[investorList[i]];
            if (inv.vault == address(0)) total += inv.srxAllocation;
        }
    }

    // ── Internal: shared investment processor ─────────────────────────────────

    /**
     * @dev Core investment logic shared by all payment paths and addInvestor().
     *      1. Adds usdValue8Dec to the investor's cumulative USD.
     *      2. Recalculates their total SRX allocation at the new tier.
     *      3. Updates totalAllocated by the delta (new total - old total).
     *      4. Emits InvestorAdded / AllocationUpdated and BonusApplied.
     *
     * @param investor     Investor wallet address.
     * @param usdValue8Dec Incremental USD value of this investment in 8-decimal format.
     * @param offChain     True for admin-added investors, false for on-chain payments.
     */
    function _processInvestment(
        address investor,
        uint256 usdValue8Dec,
        bool    offChain
    ) internal {
        Investor storage inv      = investors[investor];
        uint256 oldSRX            = inv.srxAllocation;
        uint256 newCumulativeUsd  = inv.cumulativeUsd8Dec + usdValue8Dec;
        uint256 newTotalSRX       = _computeTotalSRXWithBonus(newCumulativeUsd);

        // Delta is positive because cumulative USD only ever increases AND the price is
        // locked once the first investor exists (R5-02) — so newTotalSRX >= oldSRX always.
        uint256 srxDelta = newTotalSRX - oldSRX;
        if (srxDelta == 0) revert ZeroAmount();
        if (totalAllocated + srxDelta > hardCapSRX) revert HardCapExceeded();

        totalAllocated        += srxDelta;
        inv.cumulativeUsd8Dec  = newCumulativeUsd;
        inv.srxAllocation      = newTotalSRX;

        if (oldSRX == 0) {
            // New investor
            inv.vault    = address(0);
            inv.offChain = offChain;
            investorList.push(investor);
            emit InvestorAdded(investor, newTotalSRX, offChain);
        } else {
            emit AllocationUpdated(investor, oldSRX, newTotalSRX);
        }

        // Emit bonus details
        uint256 bonusBps = _getTierBps(newCumulativeUsd);
        uint256 baseSRX  = newCumulativeUsd * 1e18 / srxPriceUsd8Dec;
        emit BonusApplied(investor, _tierName(newCumulativeUsd), bonusBps, baseSRX, newTotalSRX);
    }

    // ── Internal: tier calculations ────────────────────────────────────────────

    /**
     * @dev Returns the bonus BPS for a given cumulative USD (8-decimal).
     */
    function _getTierBps(uint256 cumulativeUsd8Dec) internal pure returns (uint256) {
        if (cumulativeUsd8Dec >= TIER_INSTITUTIONAL_MIN) return INSTITUTIONAL_BONUS_BPS;
        if (cumulativeUsd8Dec >= TIER_PRIORITY_MIN)      return PRIORITY_BONUS_BPS;
        if (cumulativeUsd8Dec >= TIER_ENHANCED_MIN)      return ENHANCED_BONUS_BPS;
        if (cumulativeUsd8Dec >= TIER_STANDARD_MIN)      return STANDARD_BONUS_BPS;
        return ENTRY_BONUS_BPS;
    }

    /**
     * @dev Returns the tier name string for a given cumulative USD (8-decimal).
     */
    function _tierName(uint256 cumulativeUsd8Dec) internal pure returns (string memory) {
        if (cumulativeUsd8Dec >= TIER_INSTITUTIONAL_MIN) return "Institutional";
        if (cumulativeUsd8Dec >= TIER_PRIORITY_MIN)      return "Priority";
        if (cumulativeUsd8Dec >= TIER_ENHANCED_MIN)      return "Enhanced";
        if (cumulativeUsd8Dec >= TIER_STANDARD_MIN)      return "Standard";
        return "Entry";
    }

    /**
     * @dev Computes total SRX allocation including tier bonus for a given cumulative USD.
     *
     *      totalSRX = cumulativeUsd8Dec × 1e18 × (10000 + bonusBps) / srxPriceUsd8Dec / 10000
     *
     *      Overflow analysis (worst case):
     *        cumulativeUsd8Dec max = $400,000 × 1e8 = 4e13
     *        (10000 + 2000) = 12000
     *        4e13 × 1e18 × 12000 = 4.8e35 — well within uint256 (max ~1.15e77)
     */
    function _computeTotalSRXWithBonus(uint256 cumulativeUsd8Dec) internal view returns (uint256) {
        uint256 bonusBps = _getTierBps(cumulativeUsd8Dec);
        return cumulativeUsd8Dec * 1e18 * (10_000 + bonusBps) / srxPriceUsd8Dec / 10_000;
    }

    /**
     * @dev Inverse of _computeTotalSRXWithBonus (R5-03 fix): given an SRX allocation,
     *      back-calculate the cumulative USD that would produce it, ACCOUNTING for the
     *      tier bonus. The forward map is piecewise-linear and monotone in USD, so we
     *      test each tier bracket for self-consistency, highest first: invert with that
     *      tier's bonus and accept the candidate whose implied USD actually falls in
     *      that tier's bracket.
     *
     *      Boundary rounding can rarely leave no bracket exactly consistent; we then
     *      fall back to the Entry-tier inversion (conservative — lowest implied USD,
     *      so a tier is never inflated).
     */
    function _usdFromSrx(uint256 srxAmount) internal view returns (uint256) {
        uint256[5] memory mins = [
            uint256(0),
            TIER_STANDARD_MIN,
            TIER_ENHANCED_MIN,
            TIER_PRIORITY_MIN,
            TIER_INSTITUTIONAL_MIN
        ];
        uint256[5] memory bonuses = [
            ENTRY_BONUS_BPS,
            STANDARD_BONUS_BPS,
            ENHANCED_BONUS_BPS,
            PRIORITY_BONUS_BPS,
            INSTITUTIONAL_BONUS_BPS
        ];

        for (uint256 i = 5; i > 0; ) {
            unchecked { --i; }
            uint256 usd = srxAmount * srxPriceUsd8Dec * 10_000
                / (1e18 * (10_000 + bonuses[i]));
            bool aboveMin = usd >= mins[i];
            bool belowNext = (i == 4) || (usd < mins[i + 1]);
            if (aboveMin && belowNext) return usd;
        }

        // Conservative fallback: Entry-tier inversion (never inflates the tier).
        return srxAmount * srxPriceUsd8Dec * 10_000 / (1e18 * (10_000 + ENTRY_BONUS_BPS));
    }

    // ── Internal: USD conversion helpers ──────────────────────────────────────

    /**
     * @dev Converts ETH (wei) to USD in 8-decimal format using the Chainlink oracle.
     *      usdValue8Dec = ethWei × ethUsdPrice8dec / 1e18
     *      At ETH=$2500: 1e18 × 250_000_000_000 / 1e18 = 250_000_000_000 ($2500 in 8-dec)
     */
    function _ethToUsd8Dec(uint256 ethAmount) internal view returns (uint256) {
        (uint80 roundId, int256 price,, uint256 updatedAt, uint80 answeredInRound) = ethUsdFeed.latestRoundData();
        if (price <= 0)                                  revert InvalidOraclePrice();
        // SC-ECON-002: per-feed staleness override (0 = global maxStaleness)
        uint256 ethStale = ethMaxStaleness != 0 ? ethMaxStaleness : maxStaleness;
        if (block.timestamp - updatedAt > ethStale)      revert StalePriceFeed();
        if (answeredInRound < roundId)                   revert IncompleteRound();
        // SC-OPS-001 fix: reject implausibly low/high oracle prices
        uint256 priceU = uint256(price);
        if (minEthPriceUsd8Dec != 0 && priceU < minEthPriceUsd8Dec)
            revert OraclePriceOutOfBounds(priceU, minEthPriceUsd8Dec, maxEthPriceUsd8Dec);
        if (maxEthPriceUsd8Dec != 0 && priceU > maxEthPriceUsd8Dec)
            revert OraclePriceOutOfBounds(priceU, minEthPriceUsd8Dec, maxEthPriceUsd8Dec);
        return ethAmount * priceU / 1e18;
    }

    /**
     * @dev Converts WBTC (8-decimal) to USD in 8-decimal format using the Chainlink oracle.
     *      usdValue8Dec = wbtcAmount × btcUsdPrice8dec / 1e8
     *      At BTC=$60000: 1e8 × 6_000_000_000_000 / 1e8 = 6_000_000_000_000 ($60,000 in 8-dec)
     */
    function _wbtcToUsd8Dec(uint256 wbtcAmount) internal view returns (uint256) {
        (uint80 roundId, int256 price,, uint256 updatedAt, uint80 answeredInRound) = btcUsdFeed.latestRoundData();
        if (price <= 0)                                  revert InvalidOraclePrice();
        // SC-ECON-002: per-feed staleness override (0 = global maxStaleness)
        uint256 btcStale = btcMaxStaleness != 0 ? btcMaxStaleness : maxStaleness;
        if (block.timestamp - updatedAt > btcStale)      revert StalePriceFeed();
        if (answeredInRound < roundId)                   revert IncompleteRound();
        // SC-OPS-001 fix: reject implausibly low/high oracle prices
        uint256 priceU = uint256(price);
        if (minBtcPriceUsd8Dec != 0 && priceU < minBtcPriceUsd8Dec)
            revert OraclePriceOutOfBounds(priceU, minBtcPriceUsd8Dec, maxBtcPriceUsd8Dec);
        if (maxBtcPriceUsd8Dec != 0 && priceU > maxBtcPriceUsd8Dec)
            revert OraclePriceOutOfBounds(priceU, minBtcPriceUsd8Dec, maxBtcPriceUsd8Dec);
        return wbtcAmount * priceU / 1e8;
    }

    // ── Stable → USD 8-dec helper (SC-OPS-002) ────────────────────────────────

    /**
     * @dev Converts a 6-decimal stablecoin amount to 8-decimal USD value.
     *      If `feed` is set, applies the live Chainlink price (with staleness +
     *      completeness checks). If `feed` is address(0), defaults to $1 (the
     *      legacy behavior — `amount * 100` to scale 6-dec → 8-dec).
     *
     *      Result formula when feed is set:
     *        usdValue8Dec = stableAmount * priceFromFeed / 1e6
     *      where priceFromFeed is the stable/USD price in 8-decimals.
     *      For 1.0 USDC = $1: priceFromFeed = 1e8.
     *        Then 1e6 (= 1 USDC) * 1e8 / 1e6 = 1e8 (= $1 in 8-dec). ✓
     *      For 1.0 USDC = $0.87: priceFromFeed = 87_000_000 (= 0.87 * 1e8).
     *        Then 1e6 * 87_000_000 / 1e6 = 87_000_000 (= $0.87 in 8-dec). ✓
     */
    function _stableToUsd8Dec(uint256 stableAmount, IAggregatorV3 feed)
        internal
        view
        returns (uint256)
    {
        if (address(feed) == address(0)) {
            // Legacy default: 1 stable unit = $1
            return stableAmount * 100;
        }
        (uint80 roundId, int256 price,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        if (price <= 0)                                  revert InvalidOraclePrice();
        // SC-ECON-002: per-feed staleness override (0 = global maxStaleness)
        uint256 stableStale = stableMaxStaleness != 0 ? stableMaxStaleness : maxStaleness;
        if (block.timestamp - updatedAt > stableStale)   revert StalePriceFeed();
        if (answeredInRound < roundId)                   revert IncompleteRound();
        // SC-OPS-001 fix: reject implausibly low/high stablecoin prices
        uint256 priceU = uint256(price);
        if (minStablePriceUsd8Dec != 0 && priceU < minStablePriceUsd8Dec)
            revert OraclePriceOutOfBounds(priceU, minStablePriceUsd8Dec, maxStablePriceUsd8Dec);
        if (maxStablePriceUsd8Dec != 0 && priceU > maxStablePriceUsd8Dec)
            revert OraclePriceOutOfBounds(priceU, minStablePriceUsd8Dec, maxStablePriceUsd8Dec);
        return stableAmount * priceU / 1e6;
    }

}

// ── Minimal Chainlink interface ────────────────────────────────────────────────

interface IAggregatorV3 {
    function latestRoundData() external view returns (
        uint80  roundId,
        int256  answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80  answeredInRound
    );
}
