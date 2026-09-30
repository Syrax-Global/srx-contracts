// Approves test wallets to buy in a PreSaleRound (setBuyerApprovals). Since the
// approved-buyers rule (Genesis journey, 25 Sep 2026) no wallet can buy, on chain
// or off, without an approval, so every fixture that invests approves its wallets
// here. The cap is effectively unlimited; tests of the rule itself set real caps.
const { ethers } = require("hardhat");

const UNLIMITED_USD_8DEC = 10n ** 20n; // $1 trillion, far above any hard cap in the tests

const refFor = (addr) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [addr]));

async function approveBuyers(round, admin, wallets, capUsd8Dec = UNLIMITED_USD_8DEC) {
  const addrs = wallets.map((w) => (typeof w === "string" ? w : w.address));
  await round.connect(admin).setBuyerApprovals(addrs, addrs.map(() => capUsd8Dec), addrs.map(refFor));
}

module.exports = { approveBuyers, refFor, UNLIMITED_USD_8DEC };
