const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const REMOTE_EID = 40102;
function b32(addr) { return ethers.zeroPadValue(addr, 32); }
// OFTMsgCodec: abi.encodePacked(bytes32 sendTo, uint64 amountSD)
function oftMsg(to, amountSD) {
  return ethers.concat([b32(to), ethers.toBeHex(amountSD, 8)]);
}

describe("ZZ token-standard lens", function () {

  async function fixture() {
    const [admin, u1, u2, u3] = await ethers.getSigners();
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const ep = await MockLZEndpoint.deploy(40161);
    await ep.waitForDeployment();
    const epAddr = await ep.getAddress();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(epAddr, admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    await ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await ethers.provider.send("hardhat_setBalance", [epAddr, "0x21e19e0c9bab2400000"]);
    const epSigner = await ethers.getSigner(epAddr);

    return { admin, u1, u2, u3, token, ep, epAddr, epSigner };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // T1. EIP-20: "Transfers of 0 values MUST be treated as normal transfers"
  // ───────────────────────────────────────────────────────────────────────────
  // ✅ FIXED 9 Sep 2026 — SRXToken._update now requires value != 0 before applying
  //    the launch-protection checks. EIP-20 requires a zero-value transfer to be
  //    treated as a normal transfer and to succeed. Previously it reverted whenever
  //    the recipient was already over the cap, which fails conformance suites and
  //    breaks exchange integrations that probe with a zero-value call.
  it("T1: [FIXED] a ZERO-value transfer succeeds even when the recipient is over the cap", async function () {
    const { token, admin, u1, u2, u3 } = await fixture();

    const CAP = ethers.parseUnits("100000000", 18); // 100M — the doc's suggested launch value
    await token.connect(admin).transfer(u1.address, ethers.parseUnits("200000000", 18));
    await token.connect(admin).transfer(u2.address, ethers.parseUnits("1000", 18));
    await token.connect(admin).setMaxWalletBalance(CAP);

    expect(await token.balanceOf(u1.address)).to.be.gt(CAP);

    // EIP-20: a zero-value transfer is a normal transfer and MUST succeed.
    await expect(token.connect(u2).transfer(u1.address, 0n)).to.not.be.reverted;

    await token.connect(u2).approve(admin.address, ethers.MaxUint256);
    await expect(token.connect(admin).transferFrom(u2.address, u1.address, 0n)).to.not.be.reverted;

    // ...and to a wallet that has never held SRX
    await expect(token.connect(u2).transfer(u3.address, 0n)).to.not.be.reverted;

    // ⚠️ Control: the cap itself must still bite on a NON-zero transfer, so this
    //    fix cannot be mistaken for having disabled launch protection.
    await expect(
      token.connect(u2).transfer(u1.address, 1n)
    ).to.be.revertedWithCustomError(token, "WalletExceedsMaxBalance");
  });

  it("T2: exempting a DEX pool (as SRXToken.sol:86 requires) disables maxTransferAmount for every trade", async function () {
    const { token, admin, u1, u2 } = await fixture();

    const MAX_TX  = ethers.parseUnits("50000000", 18);  // 50M — doc's suggested value
    const MAX_WAL = ethers.parseUnits("100000000", 18); // 100M
    const pool = u2; // stand-in for the Uniswap pair

    await token.connect(admin).transfer(u1.address, ethers.parseUnits("500000000", 18));
    await token.connect(admin).setMaxTransferAmount(MAX_TX);
    await token.connect(admin).setMaxWalletBalance(MAX_WAL);

    // Without the exemption a 400M dump into the pool is refused...
    await expect(token.connect(u1).transfer(pool.address, ethers.parseUnits("400000000", 18)))
      .to.be.revertedWithCustomError(token, "TransferExceedsMaxAmount");

    // ...but the pool CANNOT be left unexempt either: once ordinary, within-cap
    // sells fill it past maxWalletBalance, every further sell reverts.
    await token.connect(u1).transfer(pool.address, ethers.parseUnits("50000000", 18));
    await token.connect(u1).transfer(pool.address, ethers.parseUnits("50000000", 18));
    await expect(token.connect(u1).transfer(pool.address, ethers.parseUnits("1", 18)))
      .to.be.revertedWithCustomError(token, "WalletExceedsMaxBalance");

    // So the pool is exempted, exactly as the contract comment instructs.
    await token.connect(admin).setExemptFromLimits(pool.address, true);

    // Now the 400M dump — 8x the per-tx cap — goes through.
    await expect(token.connect(u1).transfer(pool.address, ethers.parseUnits("400000000", 18)))
      .to.not.be.reverted;
    console.log("      pool balance after an 8x-over-cap dump:",
      ethers.formatUnits(await token.balanceOf(pool.address), 18));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // T3. getPastTotalSupply (the quorum denominator) is CHAIN-LOCAL and shrinks
  //     when SRX bridges out, because OFT._debit burns locally.
  // ───────────────────────────────────────────────────────────────────────────
  it("T3: [FIXED] quorum is fixed at 4% of the global cap regardless of bridging", async function () {
    const { token, admin, epSigner } = await fixture();

    const SRXTimelock = await ethers.getContractFactory("SRXTimelock");
    const timelock = await SRXTimelock.deploy(172800, [], [ethers.ZeroAddress], admin.address);
    await timelock.waitForDeployment();
    const SRXGovernor = await ethers.getContractFactory("SRXGovernor");
    const governor = await SRXGovernor.deploy(await token.getAddress(), await timelock.getAddress());
    await governor.waitForDeployment();

    await time.increase(10);
    let tp = (await time.latest()) - 1;
    const quorumBefore = await governor.quorum(tp);
    console.log("      quorum with 10B on Ethereum :", ethers.formatUnits(quorumBefore, 18), "SRX");
    expect(quorumBefore).to.equal(ethers.parseUnits("400000000", 18)); // 4% of 10B

    // Bridge 6B out. OFT._debit does `_burn(_from, amountSentLD)` (OFT.sol:68),
    // which is the same internal path as buyAndBurn's _burn — burn is what
    // Votes._transferVotingUnits subtracts from _totalCheckpoints.
    const BURN_ROLE = await token.BURN_ROLE();
    await token.connect(admin).grantRole(BURN_ROLE, admin.address);
    await token.connect(admin).buyAndBurn(ethers.parseUnits("6000000000", 18));

    await time.increase(10);
    tp = (await time.latest()) - 1;
    const quorumAfter = await governor.quorum(tp);
    console.log("      quorum with 4B on Ethereum  :", ethers.formatUnits(quorumAfter, 18), "SRX");
    // ✅ FIXED — quorum is 4% of the FIXED 10B cap, not of live Ethereum-side
    //    supply, so burning 6B out over the bridge no longer moves it. It was
    //    160,000,000 here, meaning an actor who could bridge could lower the bar
    //    for their own proposal and bring the tokens back afterwards.
    expect(quorumAfter).to.equal(ethers.parseUnits("400000000", 18));
    expect(quorumAfter).to.equal(quorumBefore);

    // And an inbound bridge credit puts it straight back up — no role needed,
    // just a peered remote chain.
    const peer = b32(admin.address);
    await token.connect(admin).setPeer(REMOTE_EID, peer);
    await token.connect(epSigner).lzReceive(
      { srcEid: REMOTE_EID, sender: peer, nonce: 1 },
      ethers.ZeroHash,
      oftMsg(admin.address, ethers.parseUnits("6000000000", 18) / 10n ** 12n),
      ethers.ZeroAddress, "0x"
    );
    await time.increase(10);
    tp = (await time.latest()) - 1;
    console.log("      quorum after bridging back  :",
      ethers.formatUnits(await governor.quorum(tp), 18), "SRX");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // T4. permit and delegateBySig share one nonce counter.
  // ───────────────────────────────────────────────────────────────────────────
  it("T4: [UPSTREAM OZ] permit and delegateBySig share one nonce counter, by library design", async function () {
    const { token, admin, u1, u2 } = await fixture();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const verifyingContract = await token.getAddress();
    const deadline = (await time.latest()) + 3600;

    const n0 = await token.nonces(u1.address);
    expect(n0).to.equal(0n);

    // u1 pre-signs a delegation at nonce 0 and hands it to a relayer.
    const delegSig = await u1.signTypedData(
      { name: "Syrax Token", version: "1", chainId, verifyingContract },
      { Delegation: [
        { name: "delegatee", type: "address" },
        { name: "nonce",     type: "uint256" },
        { name: "expiry",    type: "uint256" },
      ]},
      { delegatee: u2.address, nonce: 0n, expiry: deadline }
    );
    const ds = ethers.Signature.from(delegSig);

    // u1 also signs a permit at nonce 0 (a different app, same wallet) and that
    // one lands first.
    const permitSig = await u1.signTypedData(
      { name: "Syrax Token", version: "1", chainId, verifyingContract },
      { Permit: [
        { name: "owner",    type: "address" },
        { name: "spender",  type: "address" },
        { name: "value",    type: "uint256" },
        { name: "nonce",    type: "uint256" },
        { name: "deadline", type: "uint256" },
      ]},
      { owner: u1.address, spender: u2.address, value: 1n, nonce: 0n, deadline }
    );
    const ps = ethers.Signature.from(permitSig);
    await token.permit(u1.address, u2.address, 1n, deadline, ps.v, ps.r, ps.s);

    expect(await token.nonces(u1.address)).to.equal(1n);

    // The delegation signature is now dead.
    await expect(
      token.delegateBySig(u2.address, 0n, deadline, ds.v, ds.r, ds.s)
    ).to.be.revertedWithCustomError(token, "InvalidAccountNonce");
    expect(await token.delegates(u1.address)).to.equal(ethers.ZeroAddress);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // T5. Sanity controls — things that are NOT broken.
  // ───────────────────────────────────────────────────────────────────────────
  it("T5: self-transfer, clock mode, and permit domain are conformant", async function () {
    const { token, admin, u1 } = await fixture();

    // self-transfer over both caps is allowed and balance-neutral
    await token.connect(admin).transfer(u1.address, ethers.parseUnits("200000000", 18));
    await token.connect(admin).setMaxTransferAmount(ethers.parseUnits("1", 18));
    await token.connect(admin).setMaxWalletBalance(ethers.parseUnits("1", 18));
    const before = await token.balanceOf(u1.address);
    await expect(token.connect(u1).transfer(u1.address, before)).to.not.be.reverted;
    expect(await token.balanceOf(u1.address)).to.equal(before);

    // ERC-6372
    expect(await token.CLOCK_MODE()).to.equal("mode=timestamp");
    expect(await token.clock()).to.equal(BigInt(await time.latest()));

    // EIP-712 domain name matches the ERC-20 name (a classic permit footgun)
    const d = await token.eip712Domain();
    console.log("      eip712 name/version:", d.name, d.version, "| erc20 name:", await token.name());
    expect(d.name).to.equal(await token.name());
  });
});
