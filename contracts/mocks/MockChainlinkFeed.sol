// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockChainlinkFeed
 * @notice Simulates a Chainlink AggregatorV3 price feed for unit tests.
 *         Returns a configurable price with 8 decimals (matching real Chainlink feeds).
 */
contract MockChainlinkFeed {
    int256  public latestPrice;
    uint256 public latestUpdatedAt;

    constructor(int256 _initialPrice) {
        latestPrice     = _initialPrice;
        latestUpdatedAt = block.timestamp;
    }

    /// @notice Set a new price (used in tests to simulate price movement).
    function setPrice(int256 _price) external {
        latestPrice     = _price;
        latestUpdatedAt = block.timestamp;
    }

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
