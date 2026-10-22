// GenesisAgreementRegistry holds no funds: it has no way to receive ETH.
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Gaps — GenesisAgreementRegistry holds no ETH", function () {
  const COMMITMENT = ethers.id("SYRAX-GENESIS-AGREEMENT-V1:gaps-test");

  async function deploy() {
    const [signer, other] = await ethers.getSigners();
    const Reg = await ethers.getContractFactory("GenesisAgreementRegistry");
    const reg = await Reg.deploy();
    return { reg, signer, other };
  }

  it("R1 has no receive or fallback in its ABI and accept() is nonpayable", async function () {
    const { reg } = await deploy();
    const kinds = reg.interface.fragments.map((f) => f.type);
    expect(kinds).to.not.include("receive");
    expect(kinds).to.not.include("fallback");
    expect(reg.interface.getFunction("accept").stateMutability).to.equal("nonpayable");
    // the only state-changing function is accept
    const mutating = reg.interface.fragments
      .filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
      .map((f) => f.name);
    expect(mutating).to.deep.equal(["accept"]);
  });

  it("R1 sending value to accept(), or plain ETH to the address, reverts and the balance stays 0; a no-value accept works (control)", async function () {
    const { reg, signer, other } = await deploy();
    const data = reg.interface.encodeFunctionData("accept", [COMMITMENT]);

    // raw transactions: ethers would refuse to attach value to a nonpayable method client-side
    await expect(signer.sendTransaction({ to: reg.target, data, value: 1n })).to.be.reverted;
    await expect(signer.sendTransaction({ to: reg.target, value: 1n })).to.be.reverted;
    await expect(other.sendTransaction({ to: reg.target, data: "0x", value: ethers.parseEther("1") })).to.be.reverted;
    expect(await ethers.provider.getBalance(reg.target)).to.equal(0n);
    expect(await reg.acceptedAt(signer.address, COMMITMENT)).to.equal(0n); // the refused accept recorded nothing

    // control: the same call with no value is accepted
    await expect(signer.sendTransaction({ to: reg.target, data })).to.emit(reg, "AgreementAccepted");
    expect(await reg.acceptedAt(signer.address, COMMITMENT)).to.be.gt(0n);
    expect(await ethers.provider.getBalance(reg.target)).to.equal(0n);
    // a repeat is refused and the balance is still 0
    await expect(reg.connect(signer).accept(COMMITMENT)).to.be.revertedWithCustomError(reg, "AlreadyAccepted");
    expect(await ethers.provider.getBalance(reg.target)).to.equal(0n);
  });
});
