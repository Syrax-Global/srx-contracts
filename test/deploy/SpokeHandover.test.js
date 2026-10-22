// SPOKE-01 closed (external disclosure A, 7 Oct 2026): a spoke's owner and LayerZero
// delegate move behind its own 48-hour Timelock, using exactly the steps 07_deploy_bridge.js
// runs (scripts/deploy/lib/spokeOps.js).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySpokeTimelock, handoverSpoke, finalizeSpoke, checkSpoke, delegateOf } = require("../../scripts/deploy/lib/spokeOps");

const HUB = 40161, SPOKE = 40102, DELAY = 172_800;
const b32 = (a) => ethers.zeroPadValue(a, 32);

describe("Spoke hand-over (SPOKE-01): owner and LayerZero delegate behind the spoke Timelock", function () {
  async function fixture() {
    const [deployer, safe, hub, stranger] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(SPOKE);
    const spoke = await (await ethers.getContractFactory("SRXOFTNative"))
      .deploy(await ep.getAddress(), safe.address, HUB, hub.address);
    await spoke.connect(safe).setPeer(HUB, b32(hub.address));
    const timelock = await deploySpokeTimelock({ deployer, safe: safe.address, minDelay: DELAY });
    // The Safe sends each step itself (in a deployment, through its batch).
    const send = async (c, fn, args) => (await c.connect(safe)[fn](...args)).wait();
    return { deployer, safe, hub, stranger, spoke, timelock, send };
  }

  it("hands over, waits the delay, and passes every check", async function () {
    const { deployer, safe, hub, spoke, timelock, send } = await fixture();
    await handoverSpoke({ spoke, timelock, send });
    expect(await delegateOf(spoke)).to.equal(await timelock.getAddress());
    expect(await spoke.pendingOwner()).to.equal(await timelock.getAddress());

    await expect(finalizeSpoke({ spoke, timelock, signer: deployer })).to.be.rejectedWith(/not ready/);
    await time.increase(DELAY + 1);
    expect(await finalizeSpoke({ spoke, timelock, signer: deployer })).to.equal(true);

    expect(await checkSpoke({ spoke, timelock, hubAddress: hub.address, hubEid: HUB, safe: safe.address, requiredDelay: DELAY }))
      .to.deep.equal([]);
  });

  it("afterwards the Safe alone can no longer change the peer, the delegate or the owner", async function () {
    const { deployer, safe, spoke, timelock, send } = await fixture();
    await handoverSpoke({ spoke, timelock, send });
    await time.increase(DELAY + 1);
    await finalizeSpoke({ spoke, timelock, signer: deployer });

    await expect(spoke.connect(safe).setPeer(HUB, ethers.ZeroHash)).to.be.reverted;
    await expect(spoke.connect(safe).setDelegate(safe.address)).to.be.reverted;
    await expect(spoke.connect(safe).transferOwnership(safe.address)).to.be.reverted;
    // ...but pausing stays fast: PAUSER_ROLE is untouched.
    await spoke.connect(safe).pause();
    expect(await spoke.paused()).to.equal(true);
  });

  it("is idempotent: running the hand-over twice sends nothing the second time", async function () {
    const { spoke, timelock, send } = await fixture();
    let calls = 0;
    const counting = async (...a) => { calls++; return send(...a); };
    await handoverSpoke({ spoke, timelock, send: counting });
    const first = calls;
    await handoverSpoke({ spoke, timelock, send: counting });
    expect(first).to.equal(3);
    expect(calls).to.equal(3);
  });

  it("the check catches a spoke left with the Safe as owner", async function () {
    const { safe, hub, spoke, timelock } = await fixture();
    const failures = await checkSpoke({ spoke, timelock, hubAddress: hub.address, hubEid: HUB, safe: safe.address, requiredDelay: DELAY });
    expect(failures.some((f) => /owner/.test(f))).to.equal(true);
    expect(failures.some((f) => /delegate/.test(f))).to.equal(true);
  });

  it("the check catches a Timelock shorter than required", async function () {
    const [deployer, safe, hub] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(SPOKE);
    const spoke = await (await ethers.getContractFactory("SRXOFTNative")).deploy(await ep.getAddress(), safe.address, HUB, hub.address);
    const short = await deploySpokeTimelock({ deployer, safe: safe.address, minDelay: 60 });
    const failures = await checkSpoke({ spoke, timelock: short, hubAddress: hub.address, hubEid: HUB, safe: safe.address, requiredDelay: DELAY });
    expect(failures.some((f) => /below the required/.test(f))).to.equal(true);
  });
});
