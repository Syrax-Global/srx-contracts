// Internal audit 16 Oct 2026, L5 (MONEY-06, TB-02 and the breaker sibling): a draining-bucket
// limit near type(uint256).max overflowed (elapsed * limit) the next block, which bricked the
// limited action AND the setter that would correct it. Each setter now refuses such a value.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (n) => ethers.parseUnits(String(n), 18);
const U128 = (1n << 128n) - 1n;
const YEAR = 365 * 86_400;

async function hub() {
  const [admin] = await ethers.getSigners();
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const srx = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
  await srx.connect(admin).genesis(admin.address);
  return { admin, srx };
}

describe("Internal audit L5: no draining-bucket limit can overflow", function () {
  it("SRXToken.setInboundLimit refuses more than MAX_SUPPLY; MAX_SUPPLY itself survives ten idle years", async function () {
    const { admin, srx } = await hub();
    const cap = await srx.MAX_SUPPLY();
    await expect(srx.connect(admin).setInboundLimit(40102, ethers.MaxUint256))
      .to.be.revertedWithCustomError(srx, "LimitTooHigh").withArgs(ethers.MaxUint256, cap);
    await expect(srx.connect(admin).setInboundLimit(40102, cap + 1n))
      .to.be.revertedWithCustomError(srx, "LimitTooHigh");
    await srx.connect(admin).setInboundLimit(40102, cap);
    await time.increase(10 * YEAR);
    expect(await srx.inboundAvailable(40102)).to.equal(cap);
    await srx.connect(admin).setInboundLimit(40102, E(1_000_000));   // the setter still works
    expect(await srx.inboundAvailable(40102)).to.equal(E(1_000_000));
  });

  it("BuybackBurner.setSwapLimits refuses perDay above 2^128; 2^128 - 1 survives ten idle years", async function () {
    const { admin, srx } = await hub();
    const burner = await (await ethers.getContractFactory("BuybackBurner")).deploy(await srx.getAddress(), admin.address);
    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    const t = await usdc.getAddress();
    await expect(burner.connect(admin).setSwapLimits(t, 1n, ethers.MaxUint256))
      .to.be.revertedWithCustomError(burner, "LimitTooHigh").withArgs(ethers.MaxUint256, U128);
    await burner.connect(admin).setSwapLimits(t, 1_000_000n, U128);
    await time.increase(10 * YEAR);
    await burner.connect(admin).setSwapLimits(t, 1_000_000n, 1_000_000n);   // the setter still works
    expect(await burner.dailySwapLimit(t)).to.equal(1_000_000n);
  });

  it("GuardianModule.configureCircuitBreaker refuses a threshold above 2^128; reporting keeps working at 2^128 - 1", async function () {
    const [admin, guardian, governance, monitor] = await ethers.getSigners();
    const g = await (await ethers.getContractFactory("GuardianModule"))
      .deploy(admin.address, guardian.address, governance.address, 180 * 86_400);
    const BRIDGE = await g.MODULE_BRIDGE();
    const stub = await (await ethers.getContractFactory("PausableStub")).deploy();
    await g.connect(governance).registerModule(BRIDGE, await stub.getAddress());
    await expect(g.connect(governance).configureCircuitBreaker(BRIDGE, U128 + 1n, 3600))
      .to.be.revertedWithCustomError(g, "InvalidThreshold");
    await g.connect(governance).configureCircuitBreaker(BRIDGE, U128, 3600);
    await g.connect(admin).grantRole(await g.CIRCUIT_BREAKER_ROLE(), monitor.address);
    await time.increase(90 * 86_400);                                     // inside the 180-day sunset
    await g.connect(monitor).recordBridgeActivity(BRIDGE, E(1));            // no overflow
    expect((await g.circuitBreakers(BRIDGE)).tripped).to.equal(false);
  });
});
