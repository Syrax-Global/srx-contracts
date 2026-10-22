// The Timelock delay matches the documented 48-hour no-bypass (board a810a5af).
//
// ⛔ It used to be a 60-second constant guarded only by a comment saying to change it
//    for mainnet. Since 10 Sep (bd3d05e) it is derived from the network, and a short
//    delay on a non-testnet network is a hard error. Nothing tested that until now.
const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { GOVERNANCE, TESTNET_CHAINS } = require("../../scripts/deploy/00_config");

describe("Timelock delay (48 hours on every real network)", function () {
  const saved = process.env.TIMELOCK_DELAY_SECONDS;
  afterEach(() => {
    if (saved === undefined) delete process.env.TIMELOCK_DELAY_SECONDS;
    else process.env.TIMELOCK_DELAY_SECONDS = saved;
  });

  it("is 48 hours on Ethereum and any network not listed as a testnet", function () {
    delete process.env.TIMELOCK_DELAY_SECONDS;
    expect(GOVERNANCE.MAINNET_TIMELOCK_DELAY).to.equal(172_800);
    for (const net of ["ethereum", "bsc", "zkSync", "anything-new"]) {
      expect(GOVERNANCE.timelockDelayFor(net), net).to.equal(172_800);
    }
  });

  it("is short only on the listed test networks", function () {
    for (const net of TESTNET_CHAINS) expect(GOVERNANCE.timelockDelayFor(net), net).to.equal(60);
    expect(TESTNET_CHAINS.has("ethereum")).to.equal(false);
  });

  it("refuses a delay below 48 hours on a real network, and anything that is not a number", function () {
    process.env.TIMELOCK_DELAY_SECONDS = "3600";
    expect(() => GOVERNANCE.timelockDelayFor("ethereum")).to.throw(/Refusing to deploy/);
    process.env.TIMELOCK_DELAY_SECONDS = "not-a-number";
    expect(() => GOVERNANCE.timelockDelayFor("ethereum")).to.throw(/Refusing to deploy/);
    process.env.TIMELOCK_DELAY_SECONDS = "259200"; // 72 hours: longer is allowed
    expect(GOVERNANCE.timelockDelayFor("ethereum")).to.equal(259_200);
  });

  it("the governance deploy takes the delay from the network, not from a constant", function () {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "deploy", "02_deploy_governance.js"), "utf8");
    expect(src).to.include("GOVERNANCE.timelockDelayFor(network.name)");
    expect(src).to.not.match(/GOVERNANCE\.timelockDelay\b(?!For)/);
  });
});
