// Branch-coverage tests, group G3: SRXTreasury, FeeController, BuybackBurner, SRXStaking, StabilisationFund.
//
// Every test here drives a branch that no other test reaches AND asserts what the branch means (the exact
// custom error, the state change, the amount, the event). The groups, in order:
//   1. SRXTreasury        2. FeeController      3. BuybackBurner
//   4. SRXStaking         5. StabilisationFund
//
// Tests named "SUSPECT: ..." demonstrate behaviour that looks wrong. They assert what the contract does TODAY
// so that they pass; a fix to the contract is expected to turn them red on purpose.
//
// Reentrancy: the guard's refusal can only be seen when a contract calls back in mid-call. G3Hook (compiled
// here from source with the solc package already in node_modules, nothing is added to contracts/) is a stand-in
// for the staked token / ETH recipient: it answers every call with a truthy word and, once armed, tries a list of
// calls on the target from inside that callback and records whether each was refused.
const { expect } = require("chai");
const { execFileSync } = require("child_process");
const { ethers, network, artifacts } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { allocationSource } = require("../helpers/allocationSource");

const e18 = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86_400;
const ZERO = ethers.ZeroAddress;
const GUARD_MSG = "ReentrancyGuard: reentrant call";
const OZ_REENTRANT_SELECTOR = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);
const abi = ethers.AbiCoder.defaultAbiCoder();

// ── Shared helpers ───────────────────────────────────────────────────────────

async function deployToken(admin) {
  const lz = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
  const token = await (await ethers.getContractFactory("SRXToken")).deploy(await lz.getAddress(), admin.address);
  await token.connect(admin).genesis(admin.address);
  return token;
}

const HOOK_SRC = `
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
contract G3Hook {
    address public target;
    bytes[] private _attempts;
    bool public armed;
    bool[] private _oks;
    bytes[] private _results;

    function arm(address t, bytes[] calldata a) external {
        target = t;
        delete _attempts; delete _oks; delete _results;
        for (uint256 i = 0; i < a.length; i++) _attempts.push(a[i]);
        armed = true;
    }
    function count() external view returns (uint256) { return _oks.length; }
    function outcome(uint256 i) external view returns (bool, bytes memory) { return (_oks[i], _results[i]); }

    // Answers every call (transfer, transferFrom, plain ETH) with a truthy word. When armed it first tries
    // each queued call on the target, once, and records the outcome.
    fallback(bytes calldata) external payable returns (bytes memory) {
        if (armed) {
            armed = false;
            for (uint256 i = 0; i < _attempts.length; i++) {
                (bool ok, bytes memory res) = target.call(_attempts[i]);
                _oks.push(ok);
                _results.push(res);
            }
        }
        return abi.encode(uint256(1));
    }
}`;

let hookBuild;
function compileHook() {
  if (hookBuild) return hookBuild;
  // Compiled in a child process: solc-js is an emscripten module and installs process-wide
  // unhandledRejection/uncaughtException handlers that would leak into the other test files.
  const input = {
    language: "Solidity",
    sources: { "G3Hook.sol": { content: HOOK_SRC } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const runner = 'let s="";process.stdin.on("data",(d)=>{s+=d;}).on("end",()=>{process.stdout.write(require(process.argv[1]).compile(s));});';
  const out = JSON.parse(execFileSync(process.execPath, ["-e", runner, require.resolve("solc")], {
    input: JSON.stringify(input), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  }));
  const errs = (out.errors || []).filter((x) => x.severity === "error");
  if (errs.length) throw new Error("G3Hook failed to compile: " + errs.map((x) => x.formattedMessage).join("\n"));
  const c = out.contracts["G3Hook.sol"].G3Hook;
  hookBuild = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
  return hookBuild;
}

async function deployHook(signer) {
  const b = compileHook();
  const hook = await new ethers.ContractFactory(b.abi, b.bytecode, signer).deploy();
  await hook.waitForDeployment();
  return hook;
}

/** Decode Error(string) revert data. */
function revertString(data) {
  if (!data || !data.startsWith("0x08c379a0")) return null;
  return abi.decode(["string"], "0x" + data.slice(10))[0];
}

/** Assert every call the hook tried from inside the callback was refused by the inline nonReentrant guard. */
async function expectAllRefused(hook, expectedCount, check = (data) => expect(revertString(data)).to.equal(GUARD_MSG)) {
  expect(await hook.count()).to.equal(BigInt(expectedCount));
  for (let i = 0; i < expectedCount; i++) {
    const [ok, data] = await hook.outcome(i);
    expect(ok, "call " + i + " must have been refused").to.equal(false);
    check(data, i);
  }
}

/** Send several transactions so they are mined into ONE block (same timestamp). */
async function inOneBlock(...sends) {
  await network.provider.send("evm_setAutomine", [false]);
  let txs = [];
  try {
    for (const s of sends) txs.push(await s());
    await network.provider.send("evm_mine");
  } finally {
    await network.provider.send("evm_setAutomine", [true]);
  }
  const receipts = await Promise.all(txs.map((t) => t.wait()));
  expect(new Set(receipts.map((r) => r.blockNumber)).size, "all in one block").to.equal(1);
  return receipts;
}

async function storageSlot(contractName, file, label) {
  const info = await artifacts.getBuildInfo(file + ":" + contractName);
  const layout = info.output.contracts[file][contractName].storageLayout.storage;
  const v = layout.find((x) => x.label === label);
  if (!v) throw new Error("no storage slot for " + label);
  return BigInt(v.slot);
}

async function setStorageUint(addr, slot, value) {
  await network.provider.send("hardhat_setStorageAt", [addr, ethers.toBeHex(slot), ethers.zeroPadValue(ethers.toBeHex(value), 32)]);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. SRXTreasury
// ═════════════════════════════════════════════════════════════════════════════
describe("G3 branches: SRXTreasury", function () {
  async function fixture() {
    const [admin, timelock, recipient, stranger] = await ethers.getSigners();
    const token = await deployToken(admin);
    const treasury = await (await ethers.getContractFactory("SRXTreasury")).deploy(await token.getAddress(), admin.address, timelock.address);
    const treasuryAddr = await treasury.getAddress();
    await token.connect(admin).grantRole(await token.BURN_ROLE(), treasuryAddr);
    await token.connect(admin).transfer(treasuryAddr, e18(1_000_000));
    await admin.sendTransaction({ to: treasuryAddr, value: ethers.parseEther("5") });
    return { admin, timelock, recipient, stranger, token, treasury, treasuryAddr };
  }

  it("the constructor refuses a zero SRX token, a zero admin and a zero timelock, each on its own (ZeroAddress)", async function () {
    const { admin, timelock, token, treasury } = await loadFixture(fixture);
    const F = await ethers.getContractFactory("SRXTreasury");
    const t = await token.getAddress();
    await expect(F.deploy(ZERO, admin.address, timelock.address)).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    await expect(F.deploy(t, ZERO, timelock.address)).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    await expect(F.deploy(t, admin.address, ZERO)).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    // control: all three set deploys, the Timelock is the only spender and the admin only pauses
    const ok = await F.deploy(t, admin.address, timelock.address);
    expect(await ok.hasRole(await ok.SPENDER_ROLE(), timelock.address)).to.equal(true);
    expect(await ok.hasRole(await ok.SPENDER_ROLE(), admin.address)).to.equal(false);
  });

  it("only a PAUSER_ROLE holder can unpause: a stranger and the Timelock are refused and the treasury stays paused", async function () {
    const { admin, timelock, stranger, treasury, recipient, token } = await loadFixture(fixture);
    const PAUSER = await treasury.PAUSER_ROLE();
    await treasury.connect(admin).pause();
    await expect(treasury.connect(stranger).unpause())
      .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount").withArgs(stranger.address, PAUSER);
    await expect(treasury.connect(timelock).unpause())
      .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount").withArgs(timelock.address, PAUSER);
    expect(await treasury.paused()).to.equal(true);
    // while it is paused no spend goes out, even from the Timelock
    await expect(treasury.connect(timelock).withdraw(await token.getAddress(), recipient.address, 1n, "x"))
      .to.be.revertedWithCustomError(treasury, "EnforcedPause");
    await treasury.connect(admin).unpause();
    expect(await treasury.paused()).to.equal(false);
    // and spending is the Timelock's alone: a stranger is refused on the same call
    await expect(treasury.connect(stranger).withdraw(await token.getAddress(), recipient.address, 1n, "x"))
      .to.be.revertedWithCustomError(treasury, "AccessControlUnauthorizedAccount").withArgs(stranger.address, await treasury.SPENDER_ROLE());
    await expect(treasury.connect(timelock).withdraw(await token.getAddress(), recipient.address, 7n, "grant"))
      .to.emit(treasury, "Withdrawal").withArgs(await token.getAddress(), recipient.address, 7n, "grant");
    expect(await treasury.totalSpentSRX()).to.equal(7n);
  });

  it("withdraw and executeBuyAndBurn refuse a call-back made while withdrawETH is paying out; the outer payment still completes", async function () {
    const { admin, timelock, token, treasury, treasuryAddr } = await loadFixture(fixture);
    const hook = await deployHook(admin);
    const hookAddr = await hook.getAddress();
    // worst case: the call-back address is itself a spender
    await treasury.connect(timelock).grantRole(await treasury.SPENDER_ROLE(), hookAddr);
    await hook.arm(treasuryAddr, [
      treasury.interface.encodeFunctionData("withdraw", [await token.getAddress(), hookAddr, 1n, "reenter"]),
      treasury.interface.encodeFunctionData("executeBuyAndBurn", [1n]),
    ]);
    await expect(treasury.connect(timelock).withdrawETH(hookAddr, ethers.parseEther("1"), "outer"))
      .to.emit(treasury, "ETHWithdrawal").withArgs(hookAddr, ethers.parseEther("1"), "outer");
    await expectAllRefused(hook, 2);
    expect(await treasury.totalSpentSRX()).to.equal(0n);
    expect(await treasury.totalBurned()).to.equal(0n);
    expect(await ethers.provider.getBalance(hookAddr)).to.equal(ethers.parseEther("1"));
    expect(await token.balanceOf(hookAddr)).to.equal(0n);
    // control: the same two calls from the same spender outside a payout go through
    await treasury.connect(timelock).grantRole(await treasury.SPENDER_ROLE(), admin.address);
    await expect(treasury.connect(admin).executeBuyAndBurn(1n)).to.emit(treasury, "BuyAndBurnExecuted");
  });

  it("withdrawETH to a recipient that rejects ETH reverts 'ETH transfer failed' and sends nothing", async function () {
    const { timelock, treasury, treasuryAddr } = await loadFixture(fixture);
    const rejecting = await (await ethers.getContractFactory("MockERC20")).deploy("No ETH", "NOETH", 6); // no receive()/fallback
    const before = await ethers.provider.getBalance(treasuryAddr);
    await expect(treasury.connect(timelock).withdrawETH(await rejecting.getAddress(), ethers.parseEther("1"), "to a contract"))
      .to.be.revertedWith("ETH transfer failed");
    expect(await ethers.provider.getBalance(treasuryAddr)).to.equal(before);
    expect(await ethers.provider.getBalance(await rejecting.getAddress())).to.equal(0n);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. FeeController
// ═════════════════════════════════════════════════════════════════════════════
describe("G3 branches: FeeController", function () {
  const Fiat = 0, Crypto = 1;
  async function fixture() {
    const [admin, governance, user, stranger] = await ethers.getSigners();
    const token = await deployToken(admin);
    const staking = await (await ethers.getContractFactory("SRXStaking")).deploy(await token.getAddress(), admin.address, await allocationSource(token));
    const fee = await (await ethers.getContractFactory("FeeController")).deploy(await staking.getAddress(), admin.address);
    await fee.connect(admin).grantRole(await fee.GOVERNANCE_ROLE(), governance.address);
    return { admin, governance, user, stranger, token, staking, fee };
  }

  it("the constructor refuses a zero staking contract and a zero admin, each on its own (ZeroAddress)", async function () {
    const { admin, staking, fee } = await loadFixture(fixture);
    const F = await ethers.getContractFactory("FeeController");
    await expect(F.deploy(ZERO, admin.address)).to.be.revertedWithCustomError(fee, "ZeroAddress");
    await expect(F.deploy(await staking.getAddress(), ZERO)).to.be.revertedWithCustomError(fee, "ZeroAddress");
    const ok = await F.deploy(await staking.getAddress(), admin.address);
    expect(await ok.baseFeeRateBps()).to.equal(150n);
  });

  it("only a PAUSER_ROLE holder can unpause: governance alone and a stranger are refused, the pause stays", async function () {
    const { admin, governance, stranger, fee } = await loadFixture(fixture);
    const PAUSER = await fee.PAUSER_ROLE();
    await fee.connect(admin).pause();
    await expect(fee.connect(stranger).unpause())
      .to.be.revertedWithCustomError(fee, "AccessControlUnauthorizedAccount").withArgs(stranger.address, PAUSER);
    await expect(fee.connect(governance).unpause())
      .to.be.revertedWithCustomError(fee, "AccessControlUnauthorizedAccount").withArgs(governance.address, PAUSER);
    expect(await fee.paused()).to.equal(true);
    await fee.connect(admin).unpause();
    expect(await fee.paused()).to.equal(false);
  });

  it("with the staking address pointed at a plain wallet there is no discount and the tier name is 'None' (both fiat and crypto)", async function () {
    const { governance, user, stranger, fee } = await loadFixture(fixture);
    await fee.connect(governance).setStakingContract(stranger.address); // an EOA: no code to ask
    expect(await fee.calculateFee(user.address, Fiat)).to.equal(150n);
    expect(await fee.calculateFee(user.address, Crypto)).to.equal(112n); // 150 x 75%, rounded once
    const f = await fee.feeBreakdown(user.address, Fiat);
    expect([f.baseBps, f.discountBps, f.effectiveBps, f.tierName]).to.deep.equal([150n, 0n, 150n, "None"]);
    const c = await fee.feeBreakdown(user.address, Crypto);
    expect([c.baseBps, c.discountBps, c.effectiveBps, c.tierName]).to.deep.equal([112n, 0n, 112n, "None"]);
  });

  it("a fee can never exceed the 5% ceiling: even the highest base rate with a 100% multiplier charges exactly 500 bps (the clamp above MAX is defensive)", async function () {
    const { governance, user, fee } = await loadFixture(fixture);
    await fee.connect(governance).setBaseFeeRate(500);
    await fee.connect(governance).setCryptoFeeMultiplier(10_000);
    expect(await fee.calculateFee(user.address, Fiat)).to.equal(500n);
    expect(await fee.calculateFee(user.address, Crypto)).to.equal(500n);
    const b = await fee.feeBreakdown(user.address, Crypto);
    expect(b.effectiveBps).to.equal(500n);
    await expect(fee.connect(governance).setBaseFeeRate(501)).to.be.revertedWithCustomError(fee, "InvalidBps");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. BuybackBurner
// ═════════════════════════════════════════════════════════════════════════════
describe("G3 branches: BuybackBurner", function () {
  const SRX_OUT = e18(500);

  async function fixture() {
    const [admin, executor, stranger] = await ethers.getSigners();
    const token = await deployToken(admin);
    const burner = await (await ethers.getContractFactory("BuybackBurner")).deploy(await token.getAddress(), admin.address);
    const burnerAddr = await burner.getAddress();
    await token.connect(admin).grantRole(await token.BURN_ROLE(), burnerAddr);
    await burner.connect(admin).grantRole(await burner.EXECUTOR_ROLE(), executor.address);
    const router = await (await ethers.getContractFactory("MockSwapRouter")).deploy();
    await token.connect(admin).transfer(await router.getAddress(), e18(10_000));
    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    await usdc.mint(burnerAddr, 10_000_000_000n);
    const swapData = (pull, out = SRX_OUT) => router.interface.encodeFunctionData("swap", [
      usdc.target, pull, token.target, out, burnerAddr,
    ]);
    return { admin, executor, stranger, token, burner, burnerAddr, router, usdc, swapData };
  }

  it("the constructor refuses a zero admin as well as a zero token (ZeroAddress)", async function () {
    const { token, burner } = await loadFixture(fixture);
    const F = await ethers.getContractFactory("BuybackBurner");
    await expect(F.deploy(await token.getAddress(), ZERO)).to.be.revertedWithCustomError(burner, "ZeroAddress");
  });

  it("buyAndBurnWithToken refuses a zero tokenIn and a zero amountIn once the router is set", async function () {
    const { admin, executor, burner, router, usdc } = await loadFixture(fixture);
    await burner.connect(admin).setSwapRouter(await router.getAddress());
    await expect(burner.connect(executor).buyAndBurnWithToken(ZERO, 1n, 1n, "0x"))
      .to.be.revertedWithCustomError(burner, "ZeroAddress");
    await expect(burner.connect(executor).buyAndBurnWithToken(await usdc.getAddress(), 0n, 1n, "0x"))
      .to.be.revertedWithCustomError(burner, "ZeroAmount");
    expect(await burner.totalBurned()).to.equal(0n);
  });

  it("setSwapLimits refuses the zero address as the token", async function () {
    const { admin, burner } = await loadFixture(fixture);
    await expect(burner.connect(admin).setSwapLimits(ZERO, 1n, 1n)).to.be.revertedWithCustomError(burner, "ZeroAddress");
  });

  it("a full daily bucket leaves nothing available: the next swap reverts SwapLimitExceeded(token, amount, 0) until the bucket drains", async function () {
    const { admin, executor, burner, router, usdc, swapData } = await loadFixture(fixture);
    const usdcAddr = await usdc.getAddress();
    await burner.connect(admin).setSwapRouter(await router.getAddress());
    // 1000 base units per swap and per day: at that size the bucket drains less than one unit per second.
    await burner.connect(admin).setSwapLimits(usdcAddr, 1000n, 1000n);
    await expect(burner.connect(executor).buyAndBurnWithToken(usdcAddr, 1000n, SRX_OUT, swapData(1000n)))
      .to.emit(burner, "SwapAndBurnExecuted").withArgs(usdcAddr, 1000n, SRX_OUT);
    expect(await burner.swapInFlight(usdcAddr)).to.equal(1000n);
    await expect(burner.connect(executor).buyAndBurnWithToken(usdcAddr, 1n, SRX_OUT, swapData(1n)))
      .to.be.revertedWithCustomError(burner, "SwapLimitExceeded").withArgs(usdcAddr, 1n, 0n);
    expect(await burner.totalBurned()).to.equal(SRX_OUT);
    // a day later the whole bucket has drained and the full cap is available again
    await time.increase(DAY);
    await expect(burner.connect(executor).buyAndBurnWithToken(usdcAddr, 1000n, SRX_OUT, swapData(1000n)))
      .to.emit(burner, "SwapAndBurnExecuted");
    expect(await burner.totalBurned()).to.equal(SRX_OUT * 2n);
  });

  it("only the admin can pause or unpause: the executor and a stranger are refused both ways", async function () {
    const { admin, executor, stranger, burner } = await loadFixture(fixture);
    const ADMIN = await burner.DEFAULT_ADMIN_ROLE();
    for (const who of [executor, stranger]) {
      await expect(burner.connect(who).pause())
        .to.be.revertedWithCustomError(burner, "AccessControlUnauthorizedAccount").withArgs(who.address, ADMIN);
    }
    await burner.connect(admin).pause();
    for (const who of [executor, stranger]) {
      await expect(burner.connect(who).unpause())
        .to.be.revertedWithCustomError(burner, "AccessControlUnauthorizedAccount").withArgs(who.address, ADMIN);
    }
    expect(await burner.paused()).to.equal(true);
    await burner.connect(admin).unpause();
    expect(await burner.paused()).to.equal(false);
  });

  it("rescueTokens refuses a zero amount and moves nothing", async function () {
    const { admin, stranger, burner, usdc } = await loadFixture(fixture);
    const before = await usdc.balanceOf(await burner.getAddress());
    await expect(burner.connect(admin).rescueTokens(await usdc.getAddress(), stranger.address, 0n))
      .to.be.revertedWithCustomError(burner, "ZeroAmount");
    expect(await usdc.balanceOf(await burner.getAddress())).to.equal(before);
  });

  describe("rescueETH", function () {
    it("a stranger is refused, then the admin is paid out", async function () {
      const { admin, stranger, burner, burnerAddr } = await loadFixture(fixture);
      await admin.sendTransaction({ to: burnerAddr, value: ethers.parseEther("2") });
      await expect(burner.connect(stranger).rescueETH(stranger.address, 1n))
        .to.be.revertedWithCustomError(burner, "AccessControlUnauthorizedAccount").withArgs(stranger.address, await burner.DEFAULT_ADMIN_ROLE());
      await expect(burner.connect(admin).rescueETH(stranger.address, ethers.parseEther("1")))
        .to.emit(burner, "ETHRescued").withArgs(stranger.address, ethers.parseEther("1"));
      expect(await ethers.provider.getBalance(burnerAddr)).to.equal(ethers.parseEther("1"));
    });

    it("a recipient that rejects ETH reverts ETHTransferFailed and the ETH stays in the burner", async function () {
      const { admin, burner, burnerAddr, usdc } = await loadFixture(fixture);
      await admin.sendTransaction({ to: burnerAddr, value: ethers.parseEther("2") });
      await expect(burner.connect(admin).rescueETH(await usdc.getAddress(), ethers.parseEther("1")))
        .to.be.revertedWithCustomError(burner, "ETHTransferFailed");
      expect(await ethers.provider.getBalance(burnerAddr)).to.equal(ethers.parseEther("2"));
    });

    it("a call-back into rescueETH while it pays out is refused by the guard, even from an admin; the outer payment completes", async function () {
      const { admin, burner, burnerAddr } = await loadFixture(fixture);
      await admin.sendTransaction({ to: burnerAddr, value: ethers.parseEther("2") });
      const hook = await deployHook(admin);
      const hookAddr = await hook.getAddress();
      await burner.connect(admin).grantRole(await burner.DEFAULT_ADMIN_ROLE(), hookAddr); // worst case
      await hook.arm(burnerAddr, [burner.interface.encodeFunctionData("rescueETH", [hookAddr, 1n])]);
      await expect(burner.connect(admin).rescueETH(hookAddr, ethers.parseEther("1")))
        .to.emit(burner, "ETHRescued").withArgs(hookAddr, ethers.parseEther("1"));
      await expectAllRefused(hook, 1, (data) => expect(data.slice(0, 10)).to.equal(OZ_REENTRANT_SELECTOR));
      expect(await ethers.provider.getBalance(hookAddr)).to.equal(ethers.parseEther("1"));
      expect(await ethers.provider.getBalance(burnerAddr)).to.equal(ethers.parseEther("1"));
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. SRXStaking
// ═════════════════════════════════════════════════════════════════════════════
describe("G3 branches: SRXStaking", function () {
  const LOCK_7D = 7 * DAY, LOCK_30D = 30 * DAY, LOCK_180D = 180 * DAY;
  const DEAD = "0x000000000000000000000000000000000000dEaD";

  async function fixture() {
    const [admin, user1, user2, stranger] = await ethers.getSigners();
    const token = await deployToken(admin);
    const staking = await (await ethers.getContractFactory("SRXStaking")).deploy(await token.getAddress(), admin.address, await allocationSource(token));
    const sAddr = await staking.getAddress();
    for (const u of [user1, user2]) {
      await token.connect(admin).transfer(u.address, e18(5_000_000));
      await token.connect(u).approve(sAddr, ethers.MaxUint256);
    }
    return { admin, user1, user2, stranger, token, staking, sAddr };
  }

  // The pool is armed (1,000,000 SRX registered) and emitting 1 SRX per second.
  async function emittingFixture() {
    const ctx = await fixture();
    const { admin, token, staking, sAddr } = ctx;
    await token.connect(admin).transfer(sAddr, e18(1_000_000));
    await staking.connect(admin).notifyRewardAmount(e18(1_000_000));
    await staking.connect(admin).setRewardRate(e18(1));
    return ctx;
  }

  // A successor: deployed with THIS pool as its allocation source (docs/MIGRATION.md).
  const successorOf = async (staking, token, admin) =>
    (await ethers.getContractFactory("SRXStaking")).deploy(await token.getAddress(), admin.address, await staking.getAddress());

  // ── constructor ────────────────────────────────────────────────────────────
  it("the constructor refuses a zero token, a zero admin and a zero allocation source, each on its own (ZeroAddress)", async function () {
    const { admin, token, staking } = await loadFixture(fixture);
    const F = await ethers.getContractFactory("SRXStaking");
    const t = await token.getAddress();
    const src = await allocationSource(token);
    await expect(F.deploy(ZERO, admin.address, src)).to.be.revertedWithCustomError(staking, "ZeroAddress");
    await expect(F.deploy(t, ZERO, src)).to.be.revertedWithCustomError(staking, "ZeroAddress");
    await expect(F.deploy(t, admin.address, ZERO)).to.be.revertedWithCustomError(staking, "ZeroAddress");
    const ok = await F.deploy(t, admin.address, src);
    expect(await ok.tgeDistributor()).to.equal(src);
  });

  // ── pause rules ────────────────────────────────────────────────────────────
  it("while paused lock, addToPosition and unlock all refuse (EnforcedPause) and change nothing; after unpause they work", async function () {
    const { admin, user1, user2, staking } = await loadFixture(fixture);
    await staking.connect(user1).lock(e18(1_000), LOCK_7D);
    await time.increase(LOCK_7D + 1);
    await staking.connect(admin).pause();
    await expect(staking.connect(user2).lock(e18(1_000), LOCK_7D)).to.be.revertedWithCustomError(staking, "EnforcedPause");
    await expect(staking.connect(user1).addToPosition(e18(1), 0)).to.be.revertedWithCustomError(staking, "EnforcedPause");
    await expect(staking.connect(user1).unlock()).to.be.revertedWithCustomError(staking, "EnforcedPause");
    expect(await staking.totalLocked()).to.equal(e18(1_000));
    await staking.connect(admin).unpause();
    await expect(staking.connect(user1).unlock()).to.emit(staking, "Unlocked").withArgs(user1.address, e18(1_000));
    await expect(staking.connect(user2).lock(e18(1_000), LOCK_7D)).to.emit(staking, "Locked");
  });

  it("only a PAUSER_ROLE holder can unpause: governance alone and a stranger are refused and the pool stays paused", async function () {
    const { admin, stranger, staking } = await loadFixture(fixture);
    const PAUSER = await staking.PAUSER_ROLE();
    await staking.connect(admin).pause();
    await expect(staking.connect(stranger).unpause())
      .to.be.revertedWithCustomError(staking, "AccessControlUnauthorizedAccount").withArgs(stranger.address, PAUSER);
    expect(await staking.paused()).to.equal(true);
    expect(await staking.pausedSince()).to.not.equal(0n);
  });

  // ── addToPosition ──────────────────────────────────────────────────────────
  it("addToPosition refuses an address with no position (NoPosition) and a zero amount (ZeroAmount)", async function () {
    const { user1, user2, staking } = await loadFixture(fixture);
    await expect(staking.connect(user2).addToPosition(e18(1), 0)).to.be.revertedWithCustomError(staking, "NoPosition");
    await staking.connect(user1).lock(e18(1_000), LOCK_30D);
    await expect(staking.connect(user1).addToPosition(0, 0)).to.be.revertedWithCustomError(staking, "ZeroAmount");
    expect((await staking.positions(user1.address)).amount).to.equal(e18(1_000));
  });

  it("a top-up in the SAME block as the lock, same duration, cannot move the lock end or duration (it is not later than the end already set); the weight still covers the whole principal", async function () {
    const { user1, staking } = await loadFixture(fixture);
    const [r] = await inOneBlock(
      () => staking.connect(user1).lock(e18(1_000), LOCK_30D, { gasLimit: 1_500_000 }),
      () => staking.connect(user1).addToPosition(e18(100), LOCK_30D, { gasLimit: 1_500_000 }),
    );
    const blk = await ethers.provider.getBlock(r.blockNumber);
    const pos = await staking.positions(user1.address);
    expect(pos.lockedAt).to.equal(BigInt(blk.timestamp));
    expect(pos.lockEnd).to.equal(BigInt(blk.timestamp + LOCK_30D)); // unchanged: now + 30d == the end already set
    expect(pos.lockDuration).to.equal(BigInt(LOCK_30D));
    expect(pos.amount).to.equal(e18(1_100));
    expect(pos.weightedAmount).to.equal((e18(1_100) * 125n) / 100n);
    expect(await staking.totalWeightedStake()).to.equal(pos.weightedAmount);
  });

  it("control: the same top-up in a LATER block does move the lock end out to a fresh full term", async function () {
    const { user1, staking } = await loadFixture(fixture);
    await staking.connect(user1).lock(e18(1_000), LOCK_30D);
    const first = (await staking.positions(user1.address)).lockEnd;
    await time.increase(DAY);
    await staking.connect(user1).addToPosition(e18(100), LOCK_30D);
    const pos = await staking.positions(user1.address);
    expect(pos.lockEnd).to.be.gt(first);
    expect(pos.lockEnd - first).to.be.closeTo(BigInt(DAY), 3n);
  });

  it("a top-up with duration 0 in the SAME block as the lock leaves the end at lock + term: renewing the term from the same instant adds nothing", async function () {
    const { user1, staking } = await loadFixture(fixture);
    const [r] = await inOneBlock(
      () => staking.connect(user1).lock(e18(1_000), LOCK_180D, { gasLimit: 1_500_000 }),
      () => staking.connect(user1).addToPosition(e18(50), 0, { gasLimit: 1_500_000 }),
    );
    const blk = await ethers.provider.getBlock(r.blockNumber);
    const pos = await staking.positions(user1.address);
    expect(pos.lockEnd).to.equal(BigInt(blk.timestamp + LOCK_180D));
    expect(pos.lockDuration).to.equal(BigInt(LOCK_180D));
    expect(pos.weightedAmount).to.equal(e18(1_050) * 2n);
  });

  it("control: duration 0 in a later block renews the end to now + the position's own term", async function () {
    const { user1, staking } = await loadFixture(fixture);
    await staking.connect(user1).lock(e18(1_000), LOCK_180D);
    const first = (await staking.positions(user1.address)).lockEnd;
    await time.increase(10 * DAY);
    await staking.connect(user1).addToPosition(e18(50), 0);
    const pos = await staking.positions(user1.address);
    expect(pos.lockEnd - first).to.be.closeTo(BigInt(10 * DAY), 3n);
  });

  it("a top-up on an expired lock restarts a full term: the lock end is in the future, so the multiplier applies again", async function () {
    const { user1, staking } = await loadFixture(fixture);
    await staking.connect(user1).lock(e18(1_000), LOCK_180D);
    await time.increase(LOCK_180D + DAY);
    await staking.connect(user1).addToPosition(e18(500), 0);
    const pos = await staking.positions(user1.address);
    const now = BigInt(await time.latest());
    expect(pos.lockEnd).to.be.closeTo(now + BigInt(LOCK_180D), 3n);
    expect(pos.weightedAmount).to.equal(e18(1_500) * 2n);
    expect(await staking.totalWeightedStake()).to.equal(pos.weightedAmount);
  });

  // ── earlyWithdraw ──────────────────────────────────────────────────────────
  it("earlyWithdraw refuses an address with no position (NoPosition)", async function () {
    const { stranger, staking } = await loadFixture(fixture);
    await expect(staking.connect(stranger).earlyWithdraw()).to.be.revertedWithCustomError(staking, "NoPosition");
  });

  it("earlyWithdraw while PAUSED pays back the principal less the 10% penalty but leaves the earned rewards pending; they are claimable after unpause", async function () {
    const { admin, user1, token, staking } = await loadFixture(emittingFixture);
    await staking.connect(user1).lock(e18(1_000), LOCK_30D);
    await time.increase(DAY);
    await staking.connect(admin).pause();
    const before = await token.balanceOf(user1.address);
    const deadBefore = await token.balanceOf(DEAD);
    await expect(staking.connect(user1).earlyWithdraw())
      .to.emit(staking, "EarlyWithdrawal").withArgs(user1.address, e18(900), e18(100))
      .and.to.not.emit(staking, "RewardsClaimed");
    expect((await token.balanceOf(user1.address)) - before).to.equal(e18(900)); // principal only, no rewards
    expect((await token.balanceOf(DEAD)) - deadBefore).to.equal(e18(100));
    expect(await staking.totalPenaltyBurned()).to.equal(e18(100));
    expect((await staking.positions(user1.address)).amount).to.equal(0n);
    const pending = await staking.pendingRewards(user1.address);
    expect(pending).to.be.closeTo(e18(86_400), e18(5)); // a day at 1 SRX/s, sole staker
    // rewards stay locked behind the pause...
    await expect(staking.connect(user1).claimRewards()).to.be.revertedWithCustomError(staking, "EnforcedPause");
    // ...and are paid in full once it ends
    await staking.connect(admin).unpause();
    await expect(staking.connect(user1).claimRewards()).to.emit(staking, "RewardsClaimed").withArgs(user1.address, pending);
    expect(await staking.pendingRewards(user1.address)).to.equal(0n);
  });

  it("earlyWithdraw while paused AFTER wind-down pays the earned rewards out as well and charges no penalty", async function () {
    const { admin, user1, token, staking } = await loadFixture(emittingFixture);
    await staking.connect(user1).lock(e18(1_000), LOCK_30D);
    await time.increase(DAY);
    await staking.connect(admin).pause();
    await staking.connect(admin).startWindDown();
    const before = await token.balanceOf(user1.address);
    const tx = await staking.connect(user1).earlyWithdraw();
    await expect(tx).to.emit(staking, "EarlyWithdrawal").withArgs(user1.address, e18(1_000), 0n);
    await expect(tx).to.emit(staking, "RewardsClaimed");
    const paid = (await token.balanceOf(user1.address)) - before - e18(1_000);
    expect(paid).to.be.closeTo(e18(86_400), e18(5));
    expect(await staking.pendingRewards(user1.address)).to.equal(0n);
    expect(await staking.totalPenaltyBurned()).to.equal(0n);
  });

  // ── reward registration ────────────────────────────────────────────────────
  it("notifyRewardAmount(0) reverts ZeroAmount and registers nothing", async function () {
    const { admin, staking } = await loadFixture(fixture);
    await expect(staking.connect(admin).notifyRewardAmount(0)).to.be.revertedWithCustomError(staking, "ZeroAmount");
    expect(await staking.rewardPool()).to.equal(0n);
    expect(await staking.totalRewardsRegistered()).to.equal(0n);
  });

  // ── tier parameters ────────────────────────────────────────────────────────
  describe("updateTierParams", function () {
    const Slate = 1, Onyx = 2, Obsidian = 3;

    it("Onyx: a valid change applies at once, retroactively, to a live position (documented A6-SK-04) and emits TierParamsUpdated", async function () {
      const { admin, user1, staking } = await loadFixture(fixture);
      await staking.connect(user1).lock(e18(260_000), LOCK_7D); // weight 260k, Onyx at the 250k default
      expect(await staking.getTier(user1.address)).to.equal(2n);
      await expect(staking.connect(admin).updateTierParams(Onyx, e18(300_000), 6_500))
        .to.emit(staking, "TierParamsUpdated").withArgs(Onyx, e18(300_000), 6_500);
      const p = await staking.tierParams(Onyx);
      expect([p.minSRX, p.discountBps]).to.deep.equal([e18(300_000), 6_500n]);
      expect(await staking.getTier(user1.address)).to.equal(1n); // slipped to Slate
      expect(await staking.getDiscountBps(user1.address)).to.equal(2_500n);
    });

    it("Onyx: the discount may not fall below Slate's or rise above Obsidian's, and the minimum must sit strictly between Slate's and Obsidian's", async function () {
      const { admin, staking } = await loadFixture(fixture);
      const bad = (min, bps) => expect(staking.connect(admin).updateTierParams(Onyx, min, bps)).to.be.revertedWithCustomError(staking, "InvalidBps");
      await bad(e18(250_000), 2_400);            // below Slate's 2500
      await bad(e18(50_000), 6_000);             // not above Slate's minimum
      await bad(e18(1_000_000), 6_000);          // not below Obsidian's minimum
      // Obsidian's discount is lowered to 80%; Onyx may then equal it but not pass it
      await staking.connect(admin).updateTierParams(Obsidian, e18(1_000_000), 8_000);
      await bad(e18(250_000), 8_001);
      await staking.connect(admin).updateTierParams(Onyx, e18(250_000), 8_000);
      expect((await staking.tierParams(Onyx)).discountBps).to.equal(8_000n);
    });

    it("None is immutable and no discount can exceed 100%", async function () {
      const { admin, staking } = await loadFixture(fixture);
      await expect(staking.connect(admin).updateTierParams(0, 1, 100)).to.be.revertedWithCustomError(staking, "InvalidBps");
      await expect(staking.connect(admin).updateTierParams(Obsidian, e18(2_000_000), 10_001)).to.be.revertedWithCustomError(staking, "InvalidBps");
    });

    it("Slate needs a non-zero minimum below Onyx's and a discount no higher than Onyx's; Obsidian a minimum above Onyx's and a discount no lower", async function () {
      const { admin, staking } = await loadFixture(fixture);
      const bad = (t, min, bps) => expect(staking.connect(admin).updateTierParams(t, min, bps)).to.be.revertedWithCustomError(staking, "InvalidBps");
      await bad(Slate, 0, 100);
      await bad(Slate, e18(250_000), 100);
      await bad(Slate, e18(40_000), 6_001);
      await bad(Obsidian, e18(250_000), 10_000);
      await bad(Obsidian, e18(2_000_000), 5_999);
      await expect(staking.connect(admin).updateTierParams(Slate, e18(40_000), 2_000)).to.emit(staking, "TierParamsUpdated").withArgs(Slate, e18(40_000), 2_000);
      await expect(staking.connect(admin).updateTierParams(Obsidian, e18(2_000_000), 9_000)).to.emit(staking, "TierParamsUpdated").withArgs(Obsidian, e18(2_000_000), 9_000);
    });
  });

  // ── pause run / wind-down ──────────────────────────────────────────────────
  it("once a run of short-gapped pauses has served 30 days, wind-down opens to anyone the moment the next pause begins", async function () {
    const { admin, stranger, staking } = await loadFixture(fixture);
    expect(await staking.windDownOpenToAllAt()).to.equal(0n); // not paused
    await staking.connect(admin).pause();
    await time.increase(20 * DAY);
    await staking.connect(admin).unpause();
    await time.increase(DAY);                  // a gap under 7 days: the same run
    await staking.connect(admin).pause();
    await time.increase(15 * DAY);
    await staking.connect(admin).unpause();
    expect(await staking.pausedInRun()).to.be.closeTo(BigInt(35 * DAY), 10n);
    expect(await staking.windDownOpenToAllAt()).to.equal(0n);
    await expect(staking.connect(stranger).startWindDown()).to.be.revertedWithCustomError(staking, "NotAuthorisedToWindDown"); // not paused
    await time.increase(DAY);
    await staking.connect(admin).pause();
    expect(await staking.windDownOpenToAllAt()).to.equal(await staking.pausedSince()); // already served: open now
    await expect(staking.connect(stranger).startWindDown()).to.emit(staking, "WindDownStarted").withArgs(stranger.address, true);
    expect(await staking.windDown()).to.equal(true);
  });

  // ── release to a successor ─────────────────────────────────────────────────
  it("releaseRewardAllocation refuses a zero successor, a zero amount, a wallet, and a contract that names a different source", async function () {
    const { admin, stranger, token, staking } = await loadFixture(fixture);
    await expect(staking.connect(admin).releaseRewardAllocation(ZERO, 1n)).to.be.revertedWithCustomError(staking, "ZeroAddress");
    const good = await successorOf(staking, token, admin);
    await expect(staking.connect(admin).releaseRewardAllocation(await good.getAddress(), 0n)).to.be.revertedWithCustomError(staking, "ZeroAmount");
    await expect(staking.connect(admin).releaseRewardAllocation(stranger.address, 1n))
      .to.be.revertedWithCustomError(staking, "NotASuccessor").withArgs(stranger.address);
    const other = await (await ethers.getContractFactory("SRXStaking")).deploy(await token.getAddress(), admin.address, await allocationSource(token));
    await expect(staking.connect(admin).releaseRewardAllocation(await other.getAddress(), 1n))
      .to.be.revertedWithCustomError(staking, "NotASuccessor").withArgs(await other.getAddress());
    expect(await staking.releasedTo(await other.getAddress())).to.equal(0n);
    // and only GOVERNANCE_ROLE may call it at all, whoever the successor is
    await expect(staking.connect(stranger).releaseRewardAllocation(await good.getAddress(), 1n))
      .to.be.revertedWithCustomError(staking, "AccessControlUnauthorizedAccount").withArgs(stranger.address, await staking.GOVERNANCE_ROLE());
  });

  it("exitAfterWindDown before wind-down reverts NotWoundDown and keeps the position", async function () {
    const { user1, staking } = await loadFixture(fixture);
    await staking.connect(user1).lock(e18(1_000), LOCK_30D);
    await expect(staking.connect(user1).exitAfterWindDown()).to.be.revertedWithCustomError(staking, "NotWoundDown");
    expect((await staking.positions(user1.address)).amount).to.equal(e18(1_000));
  });

  it("FIXED (was SUSPECT, MONEY-11): startWindDown logs the rate it stopped, RewardRateSet(1 SRX/s, 0)", async function () {
    const { admin, staking } = await loadFixture(emittingFixture);
    expect(await staking.rewardRate()).to.equal(e18(1));
    const r = await (await staking.connect(admin).startWindDown()).wait();
    const ev = r.logs.map((l) => { try { return staking.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "RewardRateSet");
    expect(ev, "RewardRateSet emitted").to.not.equal(undefined);
    // the stopped rate is in the event, so a monitor following RewardRateSet sees what ended
    expect(ev.args.oldRate).to.equal(e18(1));
    expect(ev.args.newRate).to.equal(0n);
    expect(await staking.rewardRate()).to.equal(0n);
  });

  // ── reentrancy: every nonReentrant function refuses a call-back ─────────────
  describe("reentrancy", function () {
    async function hooked() {
      const [admin, user, user2] = await ethers.getSigners();
      const hook = await deployHook(admin);
      const hookAddr = await hook.getAddress();
      const src = await (await ethers.getContractFactory("MockTGEAllocationSource")).deploy(hookAddr, e18(1_700_000_000), true);
      const staking = await (await ethers.getContractFactory("SRXStaking")).deploy(hookAddr, admin.address, await src.getAddress());
      await staking.connect(admin).grantRole(await staking.GOVERNANCE_ROLE(), hookAddr); // worst case for releaseRewardAllocation
      return { admin, user, user2, hook, hookAddr, staking, sAddr: await staking.getAddress() };
    }

    it("a call-back from the token during lock() into any other guarded function is refused, and lock() itself completes", async function () {
      const { user, user2, hook, hookAddr, staking, sAddr } = await loadFixture(hooked);
      const i = staking.interface;
      await hook.arm(sAddr, [
        i.encodeFunctionData("lock", [e18(100), LOCK_7D]),
        i.encodeFunctionData("addToPosition", [1n, 0]),
        i.encodeFunctionData("unlock"),
        i.encodeFunctionData("pokeExpiredPosition", [hookAddr]),
        i.encodeFunctionData("earlyWithdraw"),
        i.encodeFunctionData("claimRewards"),
        i.encodeFunctionData("startWindDown"),
        i.encodeFunctionData("releaseRewardAllocation", [hookAddr, 1n]),
        i.encodeFunctionData("exitAfterWindDown"),
      ]);
      await expect(staking.connect(user).lock(e18(100), LOCK_7D)).to.emit(staking, "Locked");
      await expectAllRefused(hook, 9);
      expect(await staking.totalLocked()).to.equal(e18(100));
      expect(await staking.windDown()).to.equal(false);
      expect(await staking.releasedTo(hookAddr)).to.equal(0n);
      // the guard is released afterwards: a different staker can lock normally
      await expect(staking.connect(user2).lock(e18(100), LOCK_7D)).to.emit(staking, "Locked");
    });

    it("control: the same calls made outside any callback are not refused by the guard", async function () {
      const { user, hook, hookAddr, staking, sAddr } = await loadFixture(hooked);
      await hook.arm(sAddr, [staking.interface.encodeFunctionData("pokeExpiredPosition", [user.address])]);
      // hook.poke-like: trigger the callback with a plain call to the hook itself (not from inside the staking contract)
      await user.sendTransaction({ to: hookAddr, data: "0x" });
      const [ok] = await hook.outcome(0);
      expect(ok).to.equal(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. StabilisationFund
// ═════════════════════════════════════════════════════════════════════════════
describe("G3 branches: StabilisationFund", function () {
  const SEED = e18(1_500_000_000);          // free SRX the fund is seeded with
  const BACKING = e18(10_000_000);          // rewardAllocation in these fixtures
  const LOCK = 30 * DAY;

  async function deployFund(token, admin, { allocation = BACKING, source, maxDep = 3_000, maxGuard = 7_000 } = {}) {
    const src = source ?? (await allocationSource(token, e18(1_500_000_000)));
    return (await ethers.getContractFactory("StabilisationFund")).deploy(
      await token.getAddress(), admin.address, maxDep, maxGuard, LOCK, allocation, src);
  }

  async function baseFixture(seed = true) {
    const [admin, timelock, guardian, deployer, oracle, pauser, treasurer, c1, c2, stranger, recipient] = await ethers.getSigners();
    const token = await deployToken(admin);
    const fund = await deployFund(token, admin);
    const fundAddr = await fund.getAddress();
    await fund.connect(admin).grantRole(await fund.GOVERNANCE_ROLE(), timelock.address);
    await fund.connect(admin).grantRole(await fund.GUARDIAN_ROLE(), guardian.address);
    await fund.connect(admin).grantRole(await fund.DEPLOYER_ROLE(), deployer.address);
    await fund.connect(admin).grantRole(await fund.ORACLE_REPORTER_ROLE(), oracle.address);
    await fund.connect(admin).grantRole(await fund.PAUSER_ROLE(), pauser.address);
    await fund.connect(admin).grantRole(await fund.TREASURY_ROLE(), treasurer.address);
    await fund.connect(admin).setDeployTarget(recipient.address, true);
    if (seed) await token.connect(admin).transfer(fundAddr, SEED + BACKING); // free SRX + the reserved reward backing
    for (const u of [c1, c2]) {
      await token.connect(admin).transfer(u.address, e18(2_000_000));
      await token.connect(u).approve(fundAddr, ethers.MaxUint256);
    }
    return { admin, timelock, guardian, deployer, oracle, pauser, treasurer, c1, c2, stranger, recipient, token, fund, fundAddr };
  }
  const fixture = () => baseFixture(true);
  const unseededFixture = () => baseFixture(false);

  // A successor fund: deployed with THIS fund as its allocation source (docs/MIGRATION.md).
  const successorOf = async (fund, token, admin) => deployFund(token, admin, { source: await fund.getAddress() });

  // ── constructor ────────────────────────────────────────────────────────────
  it("the constructor refuses a zero token, a zero admin and a zero allocation source, each on its own (ZeroAddress)", async function () {
    const { admin, token, fund } = await loadFixture(fixture);
    const F = await ethers.getContractFactory("StabilisationFund");
    const t = await token.getAddress();
    const src = await allocationSource(token);
    const args = (o) => [o.t ?? t, o.a ?? admin.address, 3_000, 7_000, LOCK, BACKING, o.s ?? src];
    await expect(F.deploy(...args({ t: ZERO }))).to.be.revertedWithCustomError(fund, "ZeroAddress");
    await expect(F.deploy(...args({ a: ZERO }))).to.be.revertedWithCustomError(fund, "ZeroAddress");
    await expect(F.deploy(...args({ s: ZERO }))).to.be.revertedWithCustomError(fund, "ZeroAddress");
    expect(await (await F.deploy(...args({}))).maxGuardianBps()).to.equal(7_000n);
  });

  it("the constructor refuses a guardian cap above 100% (InvalidBps) even when the deployer cap is not above it", async function () {
    const { admin, token, fund } = await loadFixture(fixture);
    const F = await ethers.getContractFactory("StabilisationFund");
    const src = await allocationSource(token);
    await expect(F.deploy(await token.getAddress(), admin.address, 3_000, 10_001, LOCK, BACKING, src)).to.be.revertedWithCustomError(fund, "InvalidBps");
    await expect(F.deploy(await token.getAddress(), admin.address, 10_001, 10_001, LOCK, BACKING, src)).to.be.revertedWithCustomError(fund, "InvalidBps");
    // the boundary itself is allowed
    expect(await (await F.deploy(await token.getAddress(), admin.address, 10_000, 10_000, LOCK, BACKING, src)).maxGuardianBps()).to.equal(10_000n);
  });

  // ── pause rules ────────────────────────────────────────────────────────────
  it("while paused contribute, withdrawContribution, depositStableReserve and deployLiquidity all refuse (EnforcedPause); claimRewards refuses too until wind-down", async function () {
    const { admin, pauser, treasurer, timelock, c1, recipient, token, fund } = await loadFixture(fixture);
    await fund.connect(c1).contribute(e18(1_000));
    await fund.connect(pauser).pause();
    await expect(fund.connect(c1).contribute(e18(1_000))).to.be.revertedWithCustomError(fund, "EnforcedPause");
    await expect(fund.connect(c1).withdrawContribution(e18(1_000))).to.be.revertedWithCustomError(fund, "EnforcedPause");
    await expect(fund.connect(c1).claimRewards()).to.be.revertedWithCustomError(fund, "EnforcedPause");
    await expect(fund.connect(treasurer).depositStableReserve(await token.getAddress(), 1n)).to.be.revertedWithCustomError(fund, "EnforcedPause");
    await expect(fund.connect(timelock).deployLiquidity(recipient.address, await token.getAddress(), 1n, "x")).to.be.revertedWithCustomError(fund, "EnforcedPause");
    expect(await fund.totalContributions()).to.equal(e18(1_000));
    // wind-down releases the claim lock (and works while paused)
    await fund.connect(admin).startWindDown();
    await expect(fund.connect(c1).claimRewards()).to.be.revertedWithCustomError(fund, "NothingToClaim"); // reached the claim itself
  });

  it("only a PAUSER_ROLE holder can unpause: governance alone and a stranger are refused and the fund stays paused", async function () {
    const { pauser, timelock, stranger, fund } = await loadFixture(fixture);
    const PAUSER = await fund.PAUSER_ROLE();
    await fund.connect(pauser).pause();
    await expect(fund.connect(stranger).unpause())
      .to.be.revertedWithCustomError(fund, "AccessControlUnauthorizedAccount").withArgs(stranger.address, PAUSER);
    await expect(fund.connect(timelock).unpause())
      .to.be.revertedWithCustomError(fund, "AccessControlUnauthorizedAccount").withArgs(timelock.address, PAUSER);
    expect(await fund.paused()).to.equal(true);
  });

  // ── stable reserve ─────────────────────────────────────────────────────────
  it("depositStableReserve: only the treasury role may deposit, never zero, and the deposit lands in the fund with its event", async function () {
    const { treasurer, stranger, fund, fundAddr } = await loadFixture(fixture);
    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    const usdcAddr = await usdc.getAddress();
    await usdc.mint(treasurer.address, 5_000_000n);
    await usdc.connect(treasurer).approve(fundAddr, ethers.MaxUint256);
    await expect(fund.connect(stranger).depositStableReserve(usdcAddr, 1n))
      .to.be.revertedWithCustomError(fund, "AccessControlUnauthorizedAccount").withArgs(stranger.address, await fund.TREASURY_ROLE());
    await expect(fund.connect(treasurer).depositStableReserve(usdcAddr, 0n)).to.be.revertedWithCustomError(fund, "ZeroAmount");
    await expect(fund.connect(treasurer).depositStableReserve(usdcAddr, 5_000_000n))
      .to.emit(fund, "StableReserveDeposited").withArgs(treasurer.address, usdcAddr, 5_000_000n);
    expect(await usdc.balanceOf(fundAddr)).to.equal(5_000_000n);
    expect(await fund.totalContributions()).to.equal(0n); // a reserve deposit is nobody's contribution
  });

  // ── deployLiquidity input guards ───────────────────────────────────────────
  it("deployLiquidity refuses a zero target and a zero amount before it looks at who is calling", async function () {
    const { timelock, recipient, token, fund } = await loadFixture(fixture);
    const t = await token.getAddress();
    await expect(fund.connect(timelock).deployLiquidity(ZERO, t, 1n, "x")).to.be.revertedWithCustomError(fund, "ZeroAddress");
    await expect(fund.connect(timelock).deployLiquidity(recipient.address, t, 0n, "x")).to.be.revertedWithCustomError(fund, "ZeroAmount");
    expect(await fund.totalDeployed()).to.equal(0n);
  });

  // ── cap read-outs while a stress event is live ─────────────────────────────
  it("the cap read-outs report the remaining fast-path room during a stress event and 0 outside one", async function () {
    const { oracle, timelock, deployer, recipient, token, fund } = await loadFixture(fixture);
    expect(await fund.getDeployerCapRemaining()).to.equal(0n);
    expect(await fund.getGuardianCapRemaining()).to.equal(0n);
    await fund.connect(oracle).triggerStressEvent();
    expect(await fund.stressStartSRXBalance()).to.equal(SEED);
    expect(await fund.getDeployerCapRemaining()).to.equal((SEED * 3_000n) / 10_000n);
    expect(await fund.getGuardianCapRemaining()).to.equal((SEED * 7_000n) / 10_000n);
    await fund.connect(deployer).deployLiquidity(recipient.address, await token.getAddress(), e18(100_000_000), "market support");
    expect(await fund.getDeployerCapRemaining()).to.equal((SEED * 3_000n) / 10_000n - e18(100_000_000));
    expect(await fund.getGuardianCapRemaining()).to.equal((SEED * 7_000n) / 10_000n - e18(100_000_000));
    await fund.connect(timelock).resolveStressEvent();
    expect(await fund.getDeployerCapRemaining()).to.equal(0n);
  });

  it("a stress event started with no free SRX has a zero snapshot, so both cap read-outs stay 0 and a fast-path deploy is refused", async function () {
    const { oracle, deployer, recipient, token, fund } = await loadFixture(unseededFixture);
    await fund.connect(oracle).triggerStressEvent();
    expect(await fund.stressActive()).to.equal(true);
    expect(await fund.stressStartSRXBalance()).to.equal(0n);
    expect(await fund.getDeployerCapRemaining()).to.equal(0n);
    expect(await fund.getGuardianCapRemaining()).to.equal(0n);
    await expect(fund.connect(deployer).deployLiquidity(recipient.address, await token.getAddress(), 1n, "x"))
      .to.be.revertedWithCustomError(fund, "DeployerCapExceeded").withArgs(0n, 1n);
  });

  // ── reward registration ────────────────────────────────────────────────────
  describe("notifyRewardAmount", function () {
    it("is refused for a zero amount (ZeroAmount) and registers nothing", async function () {
      const { timelock, c1, fund } = await loadFixture(fixture);
      await fund.connect(c1).contribute(e18(1_000));
      await expect(fund.connect(timelock).notifyRewardAmount(0n)).to.be.revertedWithCustomError(fund, "ZeroAmount");
      expect(await fund.rewardPool()).to.equal(0n);
      expect(await fund.totalRewardsRegistered()).to.equal(0n);
    });

    it("is refused after wind-down (WoundDown)", async function () {
      const { admin, timelock, fund } = await loadFixture(fixture);
      await fund.connect(admin).startWindDown();
      await expect(fund.connect(timelock).notifyRewardAmount(1n)).to.be.revertedWithCustomError(fund, "WoundDown");
    });

    it("is refused while nobody has contributed (NoContribution): a pool with no depositors would accrue to the first dust deposit", async function () {
      const { timelock, fund } = await loadFixture(fixture);
      expect(await fund.totalContributions()).to.equal(0n);
      await expect(fund.connect(timelock).notifyRewardAmount(e18(1_000))).to.be.revertedWithCustomError(fund, "NoContribution");
      expect(await fund.rewardPool()).to.equal(0n);
    });

    it("cannot register SRX the fund does not hold beyond principal and the existing pool: PoolAmountExceedsAvailable with the true figure", async function () {
      // The source says 10M SRX were delivered but the fund was only sent 4M of it.
      const { timelock, admin, c1, token, fund, fundAddr } = await loadFixture(unseededFixture);
      await token.connect(admin).transfer(fundAddr, e18(4_000_000));
      await fund.connect(c1).contribute(e18(1_000_000));
      // balance 5M, principal 1M: 4M available
      await expect(fund.connect(timelock).notifyRewardAmount(e18(5_000_000)))
        .to.be.revertedWithCustomError(fund, "PoolAmountExceedsAvailable").withArgs(e18(4_000_000), e18(5_000_000));
      await expect(fund.connect(timelock).notifyRewardAmount(e18(4_000_000))).to.emit(fund, "RewardPoolFunded").withArgs(e18(4_000_000), e18(4_000_000));
      expect(await fund.rewardPool()).to.equal(e18(4_000_000));
    });

    it("when the fund holds nothing beyond principal, the available amount is 0 (the balance never goes negative)", async function () {
      const { timelock, c1, fund } = await loadFixture(unseededFixture);
      await fund.connect(c1).contribute(e18(1_000_000)); // balance == principal, no seed at all
      await expect(fund.connect(timelock).notifyRewardAmount(1n))
        .to.be.revertedWithCustomError(fund, "PoolAmountExceedsAvailable").withArgs(0n, 1n);
    });
  });

  // ── allocation source errors ───────────────────────────────────────────────
  it("syncAllocation fails closed: a source for another token is WrongDistributorToken(token), one not yet distributed is DistributionNotComplete", async function () {
    const { admin, token } = await loadFixture(fixture);
    const other = await (await ethers.getContractFactory("MockERC20")).deploy("Other", "OTH", 18);
    const wrongSrc = await allocationSource(await other.getAddress(), BACKING);
    const wrong = await deployFund(token, admin, { source: wrongSrc });
    await expect(wrong.syncAllocation()).to.be.revertedWithCustomError(wrong, "WrongDistributorToken").withArgs(await other.getAddress());

    const notYet = await deployFund(token, admin, { source: await allocationSource(token, BACKING, false) });
    await expect(notYet.syncAllocation()).to.be.revertedWithCustomError(notYet, "DistributionNotComplete");
    expect(await notYet.allocationSynced()).to.equal(false);
    expect(await notYet.rewardBacking()).to.equal(0n);
  });

  // ── governance setters ─────────────────────────────────────────────────────
  describe("governance setters", function () {
    it("setMaxGuardianBps refuses more than 100% (InvalidBps) and anyone without GOVERNANCE_ROLE", async function () {
      const { timelock, stranger, fund } = await loadFixture(fixture);
      const GOV = await fund.GOVERNANCE_ROLE();
      await expect(fund.connect(stranger).setMaxGuardianBps(8_000))
        .to.be.revertedWithCustomError(fund, "AccessControlUnauthorizedAccount").withArgs(stranger.address, GOV);
      await expect(fund.connect(timelock).setMaxGuardianBps(10_001)).to.be.revertedWithCustomError(fund, "InvalidBps");
      await expect(fund.connect(timelock).setMaxGuardianBps(8_000)).to.emit(fund, "MaxGuardianBpsSet").withArgs(7_000n, 8_000n);
    });

    it("setStressCooldownDuration, setWithdrawLockDuration, setMinTotalForEmission and setLayerTargetBps are governance-only and take effect when governance calls them", async function () {
      const { timelock, stranger, fund } = await loadFixture(fixture);
      const GOV = await fund.GOVERNANCE_ROLE();
      const denied = (p) => expect(p).to.be.revertedWithCustomError(fund, "AccessControlUnauthorizedAccount").withArgs(stranger.address, GOV);
      await denied(fund.connect(stranger).setStressCooldownDuration(1));
      await denied(fund.connect(stranger).setWithdrawLockDuration(1));
      await denied(fund.connect(stranger).setMinTotalForEmission(1));
      await denied(fund.connect(stranger).setLayerTargetBps(5_000, 3_000, 2_000));

      await expect(fund.connect(timelock).setStressCooldownDuration(DAY)).to.emit(fund, "StressCooldownDurationSet").withArgs(7n * BigInt(DAY), BigInt(DAY));
      await expect(fund.connect(timelock).setWithdrawLockDuration(10 * DAY)).to.emit(fund, "WithdrawLockDurationSet").withArgs(BigInt(LOCK), BigInt(10 * DAY));
      await expect(fund.connect(timelock).setWithdrawLockDuration(90 * DAY + 1)).to.be.revertedWithCustomError(fund, "InvalidDuration");
      await expect(fund.connect(timelock).setMinTotalForEmission(e18(5))).to.emit(fund, "MinTotalForEmissionSet").withArgs(0n, e18(5));
      await expect(fund.connect(timelock).setLayerTargetBps(4_000, 4_000, 2_000)).to.emit(fund, "LayerTargetsSet").withArgs(4_000n, 4_000n, 2_000n);
      await expect(fund.connect(timelock).setLayerTargetBps(4_000, 4_000, 2_001)).to.be.revertedWithCustomError(fund, "InvalidBps");
      expect([await fund.stableTargetBps(), await fund.coreTargetBps(), await fund.yieldTargetBps()]).to.deep.equal([4_000n, 4_000n, 2_000n]);
    });
  });

  // ── wind-down timing ───────────────────────────────────────────────────────
  it("windDownOpenToAllAt is 0 while not paused, and once a run of short-gapped pauses has served 30 days it opens at the very moment the next pause begins", async function () {
    const { pauser, stranger, fund } = await loadFixture(fixture);
    expect(await fund.windDownOpenToAllAt()).to.equal(0n);
    await fund.connect(pauser).pause();
    await time.increase(20 * DAY);
    await fund.connect(pauser).unpause();
    await time.increase(DAY);
    await fund.connect(pauser).pause();
    await time.increase(15 * DAY);
    await fund.connect(pauser).unpause();
    expect(await fund.pausedInRun()).to.be.closeTo(BigInt(35 * DAY), 10n);
    expect(await fund.windDownOpenToAllAt()).to.equal(0n);
    await expect(fund.connect(stranger).startWindDown()).to.be.revertedWithCustomError(fund, "NotAuthorisedToWindDown");
    await time.increase(DAY);
    await fund.connect(pauser).pause();
    expect(await fund.windDownOpenToAllAt()).to.equal(await fund.pausedSince());
    await expect(fund.connect(stranger).startWindDown()).to.emit(fund, "WindDownStarted").withArgs(stranger.address, true);
  });

  it("exitAfterWindDown before wind-down reverts NotWoundDown and keeps the principal", async function () {
    const { c1, fund } = await loadFixture(fixture);
    await fund.connect(c1).contribute(e18(1_000));
    await expect(fund.connect(c1).exitAfterWindDown()).to.be.revertedWithCustomError(fund, "NotWoundDown");
    expect((await fund.contributions(c1.address)).srxAmount).to.equal(e18(1_000));
  });

  // ── release to a successor ─────────────────────────────────────────────────
  describe("releaseRewardAllocation", function () {
    it("refuses a zero successor, a zero amount, a wallet, a contract naming another source, and a caller without GOVERNANCE_ROLE", async function () {
      const { timelock, stranger, token, admin, fund } = await loadFixture(fixture);
      await expect(fund.connect(timelock).releaseRewardAllocation(ZERO, 1n)).to.be.revertedWithCustomError(fund, "ZeroAddress");
      const good = await successorOf(fund, token, admin);
      const goodAddr = await good.getAddress();
      await expect(fund.connect(timelock).releaseRewardAllocation(goodAddr, 0n)).to.be.revertedWithCustomError(fund, "ZeroAmount");
      await expect(fund.connect(timelock).releaseRewardAllocation(stranger.address, 1n))
        .to.be.revertedWithCustomError(fund, "NotASuccessor").withArgs(stranger.address);
      const unrelated = await deployFund(token, admin); // its source is a mock, not this fund
      await expect(fund.connect(timelock).releaseRewardAllocation(await unrelated.getAddress(), 1n))
        .to.be.revertedWithCustomError(fund, "NotASuccessor").withArgs(await unrelated.getAddress());
      await expect(fund.connect(stranger).releaseRewardAllocation(goodAddr, 1n))
        .to.be.revertedWithCustomError(fund, "AccessControlUnauthorizedAccount").withArgs(stranger.address, await fund.GOVERNANCE_ROLE());
      expect(await fund.releasedTo(goodAddr)).to.equal(0n);
    });

    it("releases only what the fund really holds beyond depositors' principal and owed rewards, even if the allocation record over-reports", async function () {
      // The source claims 10M SRX were delivered; the fund holds exactly the depositor's principal and nothing else.
      const { admin, timelock, c1, token, fund, fundAddr } = await loadFixture(unseededFixture);
      await fund.connect(c1).contribute(e18(1_000_000));
      await fund.connect(admin).startWindDown();
      expect(await fund.rewardBacking()).to.equal(BACKING);
      expect(await token.balanceOf(fundAddr)).to.equal(e18(1_000_000));
      const succ = await successorOf(fund, token, admin);
      const succAddr = await succ.getAddress();
      expect(await fund.releasableRewardAllocation()).to.equal(0n); // held = 0: principal is never releasable
      await expect(fund.connect(timelock).releaseRewardAllocation(succAddr, 1n))
        .to.be.revertedWithCustomError(fund, "ReleaseExceedsUnusedAllocation").withArgs(0n, 1n);
      // 500 SRX of genuinely free SRX arrives: exactly that much becomes releasable, and the principal stays
      await token.connect(admin).transfer(fundAddr, e18(500));
      expect(await fund.releasableRewardAllocation()).to.equal(e18(500));
      await expect(fund.connect(timelock).releaseRewardAllocation(succAddr, e18(500)))
        .to.emit(fund, "RewardAllocationReleased").withArgs(succAddr, e18(500));
      expect(await token.balanceOf(fundAddr)).to.equal(e18(1_000_000));
      expect(await fund.rewardBacking()).to.equal(BACKING - e18(500));
      expect(await fund.releasedTo(succAddr)).to.equal(e18(500));
      await fund.connect(c1).exitAfterWindDown();
      expect(await token.balanceOf(c1.address)).to.equal(e18(2_000_000)); // principal came back whole
    });
  });

  // ── forced shortfall ───────────────────────────────────────────────────────
  it("when the pool cannot cover a claim, the claim pays what the pool holds, keeps the rest owed and announces it (RewardShortfall); the remainder is paid once the pool is refunded", async function () {
    // A shortfall is not reachable through the schedule (it is bounded by the unaccrued pool), so, as the
    // staking suite does, the test forces one by writing rewardPool's storage slot.
    const { timelock, c1, token, fund, fundAddr } = await loadFixture(fixture);
    await fund.connect(c1).contribute(e18(1_000));
    await fund.connect(timelock).notifyRewardAmount(e18(5_000_000));
    await fund.connect(timelock).setRewardRate(e18(1));
    await time.increase(1_000);
    const owedBefore = await fund.earned(c1.address);
    expect(owedBefore).to.be.gt(e18(900));
    const slot = await storageSlot("StabilisationFund", "contracts/stabilisation/StabilisationFund.sol", "rewardPool");
    await setStorageUint(fundAddr, slot, e18(400)); // the pool now holds less than is owed

    const before = await token.balanceOf(c1.address);
    const r = await (await fund.connect(c1).claimRewards()).wait();
    const evs = r.logs.map((l) => { try { return fund.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const claimed = evs.find((x) => x.name === "RewardsClaimed");
    const short = evs.find((x) => x.name === "RewardShortfall");
    expect(claimed.args.amount).to.equal(e18(400));
    expect((await token.balanceOf(c1.address)) - before).to.equal(e18(400));
    expect(await fund.rewardPool()).to.equal(0n);
    // what was not paid is still owed, to the wei, and nothing was written off
    const stillOwed = await fund.pendingRewards(c1.address);
    expect(short.args.unpaid).to.equal(stillOwed);
    expect(stillOwed + e18(400)).to.be.closeTo(owedBefore + e18(1), e18(2)); // owed grew by about the one second between reads
    // the pool is refunded (a few SRX more than owed, since another second accrues before the claim lands)
    await setStorageUint(fundAddr, slot, stillOwed + e18(5));
    const poolBefore = await fund.rewardPool();
    const bal = await token.balanceOf(c1.address);
    await expect(fund.connect(c1).claimRewards()).to.emit(fund, "RewardsClaimed");
    const paid = (await token.balanceOf(c1.address)) - bal;
    expect(paid).to.be.gte(stillOwed);
    expect(paid).to.be.lte(stillOwed + e18(3));
    expect(await fund.pendingRewards(c1.address)).to.equal(0n);
    expect(await fund.rewardPool()).to.equal(poolBefore - paid);
  });

  it("OPEN (design, for Security): a pauser can keep the fund paused 29 days out of every 36 for ever and the public wind-down never opens; depositors (no paused exit) can leave only in the 7-day gaps", async function () {
    // The 30-day rule counts time actually paused within one RUN, and a gap of 7 days or more ends the run
    // (PAUSE_BREAK). So pause 29 days, open 7 days, pause 29 days ... never reaches 30 days in a run. The stated
    // purpose is that a pause "can never become permanent confinement of depositors' SRX".
    const { pauser, stranger, c1, fund } = await loadFixture(fixture);
    await fund.connect(c1).contribute(e18(1_000));
    let pausedDays = 0;
    for (let cycle = 0; cycle < 3; cycle++) {
      await fund.connect(pauser).pause();
      await time.increase(29 * DAY);
      pausedDays += 29;
      // 29 days in: one day short, nobody may wind down
      await expect(fund.connect(stranger).startWindDown()).to.be.revertedWithCustomError(fund, "NotAuthorisedToWindDown");
      await fund.connect(pauser).unpause();
      await time.increase(7 * DAY);                       // a gap of 7 days: the next pause starts a NEW run
    }
    await fund.connect(pauser).pause();
    expect(await fund.pausedInRun()).to.equal(0n);        // the run restarted: 87 paused days are forgotten
    expect(await fund.windDownOpenToAllAt()).to.equal((await fund.pausedSince()) + BigInt(30 * DAY));
    expect(pausedDays).to.equal(87);
    expect(await fund.windDown()).to.equal(false);
    // while paused the depositor has no way out at all
    await expect(fund.connect(c1).withdrawContribution(e18(1_000))).to.be.revertedWithCustomError(fund, "EnforcedPause");
    await fund.connect(pauser).unpause();
    // ...and in a gap the principal does come back (the lock of 30 days has long passed)
    await expect(fund.connect(c1).withdrawContribution(e18(1_000))).to.emit(fund, "ContributionWithdrawn");
  });

  it("FIXED (was SUSPECT, MONEY-11): startWindDown logs the rate it stopped, RewardRateSet(1 SRX/s, 0)", async function () {
    const { admin, timelock, c1, fund } = await loadFixture(fixture);
    await fund.connect(c1).contribute(e18(1_000));
    await fund.connect(timelock).notifyRewardAmount(e18(1_000_000));
    await fund.connect(timelock).setRewardRate(e18(1));
    expect(await fund.rewardRate()).to.equal(e18(1));
    const r = await (await fund.connect(admin).startWindDown()).wait();
    const ev = r.logs.map((l) => { try { return fund.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "RewardRateSet");
    expect(ev.args.oldRate).to.equal(e18(1));   // the stopped rate is logged
    expect(ev.args.newRate).to.equal(0n);
    expect(await fund.rewardRate()).to.equal(0n);
  });

  // ── reentrancy: every nonReentrant function refuses a call-back ─────────────
  describe("reentrancy", function () {
    async function hooked() {
      const [admin, user, user2] = await ethers.getSigners();
      const hook = await deployHook(admin);
      const hookAddr = await hook.getAddress();
      const src = await (await ethers.getContractFactory("MockTGEAllocationSource")).deploy(hookAddr, BACKING, true);
      const fund = await (await ethers.getContractFactory("StabilisationFund")).deploy(
        hookAddr, admin.address, 3_000, 7_000, LOCK, BACKING, await src.getAddress());
      // worst case: the call-back address holds the roles the guarded functions also check first
      await fund.connect(admin).grantRole(await fund.GOVERNANCE_ROLE(), hookAddr);
      await fund.connect(admin).grantRole(await fund.TREASURY_ROLE(), hookAddr);
      return { admin, user, user2, hook, hookAddr, fund, fundAddr: await fund.getAddress() };
    }

    it("a call-back from the token during contribute() into any other guarded function is refused, and contribute() itself completes", async function () {
      const { user, user2, hook, hookAddr, fund, fundAddr } = await loadFixture(hooked);
      const i = fund.interface;
      await hook.arm(fundAddr, [
        i.encodeFunctionData("contribute", [e18(100)]),
        i.encodeFunctionData("withdrawContribution", [1n]),
        i.encodeFunctionData("claimRewards"),
        i.encodeFunctionData("depositStableReserve", [hookAddr, 1n]),
        i.encodeFunctionData("deployLiquidity", [hookAddr, hookAddr, 1n, "reenter"]),
        i.encodeFunctionData("startWindDown"),
        i.encodeFunctionData("releaseRewardAllocation", [hookAddr, 1n]),
        i.encodeFunctionData("exitAfterWindDown"),
      ]);
      await expect(fund.connect(user).contribute(e18(100))).to.emit(fund, "Contributed").withArgs(user.address, e18(100), e18(100));
      await expectAllRefused(hook, 8);
      expect(await fund.totalContributions()).to.equal(e18(100));
      expect(await fund.windDown()).to.equal(false);
      expect(await fund.totalDeployed()).to.equal(0n);
      expect(await fund.releasedTo(hookAddr)).to.equal(0n);
      // the guard is released afterwards
      await expect(fund.connect(user2).contribute(e18(100))).to.emit(fund, "Contributed");
    });
  });
});
