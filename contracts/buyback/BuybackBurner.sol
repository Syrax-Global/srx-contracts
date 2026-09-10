// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AccessControl }   from "@openzeppelin/contracts/access/AccessControl.sol";
import { Pausable }         from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard }  from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 }           from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 }        from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ISRXToken {
    function buyAndBurn(uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @title BuybackBurner
 * @notice Receives stablecoin and/or ETH revenue from the FeeController routing table,
 *         acquires SRX tokens, and permanently burns them via SRXToken.buyAndBurn().
 *
 * Architecture — two modes:
 *
 *   Mode 1 — Direct burn (always available):
 *     SRX tokens are transferred into this contract (e.g. from an off-chain open-market
 *     purchase, or from a manual treasury transfer). An EXECUTOR_ROLE caller then calls
 *     burnHeld() to burn whatever SRX balance is sitting in the contract.
 *     This is the testnet mode and works without a live DEX.
 *
 *   Mode 2 — Swap-and-burn (post-TGE, when DEX liquidity exists):
 *     An EXECUTOR_ROLE caller calls buyAndBurnWithToken() with pre-built swap calldata.
 *     The contract approves the swap router and executes the swap to receive SRX, then
 *     immediately burns all received SRX. The calldata approach is DEX-agnostic — works
 *     with Uniswap V3, PancakeSwap, 1inch, or any router that accepts ERC-20 approval.
 *
 * Role model:
 *   DEFAULT_ADMIN_ROLE — grants/revokes roles, updates router + slippage, rescues tokens.
 *   EXECUTOR_ROLE      — calls burnHeld() and buyAndBurnWithToken(). Intended for the
 *                        Treasury multisig or a Chainlink Automation upkeep.
 *
 * FeeController integration:
 *   Set this contract as the AutoBurn destination in the FeeController routing table.
 *   The gateway fee splitter will forward the configured share of fee revenue here
 *   automatically. When the balance reaches a threshold, an executor triggers the burn.
 *
 * ⚠ Slippage protection:
 *   buyAndBurnWithToken() requires a minSrxOut parameter. The executor must compute
 *   this off-chain using a DEX quote minus maxSlippageBps tolerance. Never pass 0.
 *
 * ⚠ BURN_ROLE prerequisite:
 *   This contract must be granted BURN_ROLE on SRXToken before burnHeld() can succeed.
 *   Grant via: srxToken.grantRole(BURN_ROLE, address(buybackBurner))
 */
contract BuybackBurner is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    // ── Constants ──────────────────────────────────────────────────────────────

    uint256 public constant MAX_SLIPPAGE_CAP = 5_000; // 50% absolute max — safety guard

    // ── Immutables ─────────────────────────────────────────────────────────────

    /// @notice The SRXToken contract. All burns go through buyAndBurn() on this address.
    ISRXToken public immutable srxToken;

    // ── State ──────────────────────────────────────────────────────────────────

    /// @notice DEX router address used for swap-and-burn. Zero = swap mode disabled.
    address public swapRouter;

    /// @notice Maximum acceptable slippage for swaps in basis points. Default 200 (2%).
    uint256 public maxSlippageBps;

    /// @notice Running total of SRX burned by this contract across all time.
    uint256 public totalBurned;

    // ── Events ─────────────────────────────────────────────────────────────────

    event BurnExecuted(uint256 srxAmount, uint256 newTotalBurned);
    event SwapAndBurnExecuted(address indexed tokenIn, uint256 amountIn, uint256 srxBurned);
    event SwapRouterUpdated(address indexed newRouter);
    event MaxSlippageUpdated(uint256 newBps);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event ETHRescued(address indexed to, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error NothingToBurn();
    error SwapRouterNotSet();
    error SlippageExceedsCap(uint256 requested, uint256 cap);
    error ZeroAddress();
    error ZeroAmount();
    error CannotRescueSRX();
    error SwapProducedInsufficientSRX(uint256 received, uint256 minimum);
    error ETHTransferFailed();
    error InsufficientETH();

    // ── Constructor ────────────────────────────────────────────────────────────

    /**
     * @param _srxToken  Address of the deployed SRXToken contract.
     * @param _admin     Initial admin (should be Treasury multisig on mainnet).
     */
    constructor(address _srxToken, address _admin) {
        if (_srxToken == address(0)) revert ZeroAddress();
        if (_admin   == address(0)) revert ZeroAddress();

        srxToken      = ISRXToken(_srxToken);
        maxSlippageBps = 200; // 2% default

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(EXECUTOR_ROLE,      _admin);
    }

    // ── Mode 1: Direct Burn ────────────────────────────────────────────────────

    /**
     * @notice Burns all SRX tokens currently held in this contract.
     *         Use after manually transferring open-market SRX purchases here,
     *         or after a swap-and-burn that left a residual balance.
     *
     *         Requires BURN_ROLE on SRXToken to be granted to this contract.
     *
     * @dev Emits BurnExecuted.
     */
    function burnHeld() external onlyRole(EXECUTOR_ROLE) whenNotPaused nonReentrant {
        uint256 balance = srxToken.balanceOf(address(this));
        if (balance == 0) revert NothingToBurn();

        totalBurned += balance;
        srxToken.buyAndBurn(balance);

        emit BurnExecuted(balance, totalBurned);
    }

    // ── Mode 2: Swap-and-Burn ─────────────────────────────────────────────────

    /**
     * @notice Swaps an ERC-20 token (e.g. USDC) for SRX via the configured router,
     *         then immediately burns all received SRX.
     *
     *         The caller must pre-compute `swapCalldata` off-chain using a DEX quote.
     *         The contract approves `tokenIn` for `amountIn` to the swap router, then
     *         performs a low-level call with the provided calldata.
     *
     *         After the swap, the contract verifies at least `minSrxOut` SRX was received
     *         before calling burnHeld().
     *
     * @param tokenIn       ERC-20 to sell (e.g. USDC address).
     * @param amountIn      Amount of tokenIn to sell (in tokenIn decimals).
     * @param minSrxOut     Minimum SRX to receive. Revert if swap underperforms.
     *                      Compute as: DEX quote × (1 - maxSlippageBps / 10000).
     *                      NEVER pass 0 — this disables slippage protection.
     * @param swapCalldata  ABI-encoded call to the swap router.
     */
    function buyAndBurnWithToken(
        address tokenIn,
        uint256 amountIn,
        uint256 minSrxOut,
        bytes calldata swapCalldata
    )
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (swapRouter == address(0)) revert SwapRouterNotSet();
        if (tokenIn    == address(0)) revert ZeroAddress();
        if (amountIn   == 0)          revert ZeroAmount();
        if (minSrxOut  == 0)          revert ZeroAmount();

        uint256 srxBefore = srxToken.balanceOf(address(this));

        // Approve router to spend tokenIn, execute swap
        IERC20(tokenIn).safeIncreaseAllowance(swapRouter, amountIn);
        (bool success, ) = swapRouter.call(swapCalldata);
        require(success, "BuybackBurner: swap call failed");

        // Verify slippage
        uint256 srxReceived = srxToken.balanceOf(address(this)) - srxBefore;
        if (srxReceived < minSrxOut)
            revert SwapProducedInsufficientSRX(srxReceived, minSrxOut);

        // Burn everything acquired
        totalBurned += srxReceived;
        srxToken.buyAndBurn(srxReceived);

        emit SwapAndBurnExecuted(tokenIn, amountIn, srxReceived);
    }

    // ── Configuration ─────────────────────────────────────────────────────────

    /**
     * @notice Set the DEX router address. Set to address(0) to disable swap mode.
     *         On Ethereum mainnet: Uniswap V3 SwapRouter02.
     *         On BNB Chain mainnet: PancakeSwap SmartRouter.
     * @param router New router address.
     */
    function setSwapRouter(address router) external onlyRole(DEFAULT_ADMIN_ROLE) {
        swapRouter = router;
        emit SwapRouterUpdated(router);
    }

    /**
     * @notice Update maximum acceptable slippage for swap-and-burn operations.
     *         Cannot exceed MAX_SLIPPAGE_CAP (50%).
     * @param bps New slippage tolerance in basis points (e.g. 200 = 2%).
     */
    function setMaxSlippageBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_SLIPPAGE_CAP) revert SlippageExceedsCap(bps, MAX_SLIPPAGE_CAP);
        maxSlippageBps = bps;
        emit MaxSlippageUpdated(bps);
    }

    // ── Emergency Controls ─────────────────────────────────────────────────────

    function pause()   external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    /**
     * @notice Rescue any ERC-20 accidentally sent to this contract.
     *         SRXToken cannot be rescued — use burnHeld() instead.
     * @param token  ERC-20 to rescue.
     * @param to     Recipient address.
     * @param amount Amount to transfer.
     */
    function rescueTokens(
        address token,
        address to,
        uint256 amount
    )
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (token == address(srxToken)) revert CannotRescueSRX();
        if (to    == address(0))        revert ZeroAddress();
        if (amount == 0)                revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /**
     * @notice Recover ETH held by this contract — accidentally sent ETH, or
     *         ETH accumulated from fee routing prior to a wrap+swap path being
     *         wired up. Until a native ETH-to-SRX swap mechanism exists, all
     *         ETH receipts must be processed through this rescue function.
     * @param to     Recipient address.
     * @param amount Amount of ETH (wei) to transfer.
     */
    function rescueETH(address payable to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (to == address(0))       revert ZeroAddress();
        if (amount == 0)            revert ZeroAmount();
        if (address(this).balance < amount) revert InsufficientETH();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert ETHTransferFailed();
        emit ETHRescued(to, amount);
    }

    /// @notice Accepts ETH (e.g. routed fee revenue). ETH has no on-chain swap path
    ///         in this contract — admin must use rescueETH() to forward to a wrapper
    ///         or treasury contract that can execute the wrap+swap+burn flow.
    receive() external payable {}
}
