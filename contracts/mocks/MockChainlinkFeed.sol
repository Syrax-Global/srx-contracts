// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title MockChainlinkFeed
 * @notice Simulates a Chainlink AggregatorV3 price feed for unit tests.
 *         Returns a configurable price with 8 decimals (matching real Chainlink feeds).
 */
contract MockChainlinkFeed {
    int256  public latestPrice;
    uint256 public latestUpdatedAt;
    uint8   public decimals = 8;

    /// @notice Empty by default — matches a real feed's description() only once set.
    ///         Added for scripts/deploy/10_deploy_presale.js's requireFeed() check
    ///         (finding DEP-01 rehearsal), which reads description() the same way a
    ///         real Chainlink feed exposes it. A setter rather than a constructor arg
    ///         so every existing `MockChainlinkFeed.deploy(price)` call site keeps
    ///         working unchanged.
    string  public description;

    constructor(int256 _initialPrice) {
        latestPrice     = _initialPrice;
        latestUpdatedAt = block.timestamp;
    }

    /// @notice Set the feed's description (used only by requireFeed() callers).
    function setDescription(string calldata _description) external {
        description = _description;
    }

    /// @notice Set a new price (used in tests to simulate price movement).
    function setPrice(int256 _price) external {
        latestPrice     = _price;
        latestUpdatedAt = block.timestamp;
    }

    /// @notice Simulate a feed that is not 8-decimal USD.
    function setDecimals(uint8 _d) external { decimals = _d; }

    /// @notice Manually set updatedAt — used to simulate a stale feed.
    function setUpdatedAt(uint256 _updatedAt) external {
        latestUpdatedAt = _updatedAt;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80  roundId,
            int256  answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80  answeredInRound
        )
    {
        return (1, latestPrice, latestUpdatedAt, latestUpdatedAt, 1);
    }
}
