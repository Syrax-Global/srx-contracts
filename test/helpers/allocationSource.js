// REG-50: SRXStaking and StabilisationFund are fixed at initialize to the launch
// TGEDistributor, and only what it records delivering can back their rewards. Unit
// tests that are not about the launch flow arm the pools with this stand-in instead
// (contracts/mocks/MockTGEAllocationSource.sol). The real distributor is exercised in
// test/REG50.FixedRewardPools.test.js.
const { ethers } = require("hardhat");

const STAKING_ALLOCATION = ethers.parseUnits("1700000000", 18);

/** Deploy a distributed stand-in reporting `amount` delivered to any destination. */
async function allocationSource(token, amount = STAKING_ALLOCATION, distributed = true) {
  const tokenAddr = typeof token === "string" ? token : await token.getAddress();
  const src = await (await ethers.getContractFactory("MockTGEAllocationSource")).deploy(tokenAddr, amount, distributed);
  return src.getAddress();
}

module.exports = { allocationSource, STAKING_ALLOCATION };
