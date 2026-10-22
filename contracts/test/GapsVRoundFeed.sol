// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title GapsVRoundFeed
 * @notice TEST ONLY. A Chainlink-shaped feed whose roundId and answeredInRound can be set
 *         independently, which MockChainlinkFeed cannot do (it hard-codes both to 1).
 *         Used to prove the presale refuses an incomplete round.
 */
contract GapsVRoundFeed {
    uint8   public constant decimals = 8;
    int256  public answer;
    uint256 public updatedAt;
    uint80  public roundId = 1;
    uint80  public answeredInRound = 1;

    constructor(int256 _answer) {
        answer = _answer;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 _answer) external {
        answer = _answer;
        updatedAt = block.timestamp;
    }

    function setRound(uint80 _roundId, uint80 _answeredInRound) external {
        roundId = _roundId;
        answeredInRound = _answeredInRound;
        updatedAt = block.timestamp;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}
