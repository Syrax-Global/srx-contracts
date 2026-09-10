const { expect } = require("chai");
const { ethers } = require("hardhat");

const REMOTE_EID = 40102;

function b32(addr) { return ethers.zeroPadValue(addr, 32); }

// OFTMsgCodec: abi.encodePacked(bytes32 sendTo, uint64 amountSD)
function oftMsg(to, amountSD) {
  return ethers.concat([b32(to), ethers.toBeHex(amountSD, 8)]);
}

describe("ZZ bridge-lens PoC", function () {
  async function fixture() {
    const [admin, attacker] = await ethers.getSigners();
    const MockLZEndpoint = await ethers.getContractFactory("MockLZEndpoint");
    const ep = await MockLZEndpoint.deploy(40161);
    await ep.waitForDeployment();
    const epAddr = await ep.getAddress();

    const SRXToken = await ethers.getContractFactory("SRXToken");
    const token = await SRXToken.deploy(epAddr, admin.address);
    await token.waitForDeployment();
    await token.connect(admin).genesis(admin.address);

    const Native = await ethers.getContractFactory("SRXOFTNative");
    const native = await Native.deploy(epAddr, admin.address);
    await native.waitForDeployment();

    // impersonate the endpoint so we can call lzReceive as it would
    await ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await ethers.provider.send("hardhat_setBalance", [epAddr, "0x21e19e0c9bab2400000"]);
    const epSigner = await ethers.getSigner(epAddr);

    return { admin, attacker, token, native, epSigner, epAddr };
  }

  // ✅ FIXED 9 Sep 2026 — SRXToken._update now enforces MAX_SUPPLY on every mint.
  //    This case previously PASSED, minting to 2e28 against a 1e28 cap. It is now
  //    a regression test: it asserts the mint is REFUSED.
  it("A: [FIXED] an inbound credit that would exceed MAX_SUPPLY is refused", async function () {
    const { admin, attacker, token, epSigner } = await fixture();

    const MAX = await token.MAX_SUPPLY();
    expect(await token.totalSupply()).to.equal(MAX);

    const peer = b32(attacker.address);
    await token.connect(admin).setPeer(REMOTE_EID, peer);

    const amountSD = MAX / (10n ** 12n); // sharedDecimals = 6 -> conversion 1e12
    const origin = { srcEid: REMOTE_EID, sender: peer, nonce: 1 };
    await expect(
      token.connect(epSigner).lzReceive(
        origin, ethers.ZeroHash, oftMsg(attacker.address, amountSD), ethers.ZeroAddress, "0x"
      )
    ).to.be.revertedWithCustomError(token, "SupplyCapExceeded");

    // supply is unchanged — the cap held rather than merely reverting late
    expect(await token.totalSupply()).to.equal(MAX);
  });

  // ⛔ STILL OPEN. Not fixed, and deliberately rewritten so it cannot be masked.
  //    The original version started at MAX_SUPPLY, so once the supply cap landed
  //    it reverted for the WRONG reason and looked fixed. This version burns
  //    first, so supply sits below the cap and the real defect is isolated:
  //    launch protection does not apply to tokens arriving over the bridge.
  //
  //    NOT fixed unilaterally: applying maxWalletBalance inside lzReceive can
  //    strand tokens mid-bridge permanently if the recipient is over the cap,
  //    which is worse than the bypass. This is a product decision.
  it("B: [OPEN] a bridge credit below the cap still bypasses maxWalletBalance", async function () {
    const { admin, attacker, token, epSigner } = await fixture();

    // burn 2B so the supply cap is not what stops us
    await token.connect(admin).grantRole(await token.BURN_ROLE(), admin.address);
    await token.connect(admin).buyAndBurn(ethers.parseUnits("2000000000", 18));

    const walletCap = ethers.parseUnits("100000000", 18);
    await token.connect(admin).setMaxWalletBalance(walletCap);

    // a direct transfer over the cap is correctly refused
    await expect(
      token.connect(admin).transfer(attacker.address, ethers.parseUnits("1000000000", 18))
    ).to.be.reverted;

    // the same value arriving over the bridge is not
    const peer = b32(attacker.address);
    await token.connect(admin).setPeer(REMOTE_EID, peer);
    const amountLD = ethers.parseUnits("1000000000", 18);
    const origin = { srcEid: REMOTE_EID, sender: peer, nonce: 1 };
    await token.connect(epSigner).lzReceive(
      origin, ethers.ZeroHash, oftMsg(attacker.address, amountLD / 10n ** 12n), ethers.ZeroAddress, "0x"
    );

    const bal = await token.balanceOf(attacker.address);
    console.log("      wallet cap        :", walletCap.toString());
    console.log("      via bridge        :", bal.toString(), "<- ten times the cap");
    expect(bal).to.equal(amountLD);
    expect(bal).to.be.gt(walletCap);
  });

  // ✅ FIXED 9 Sep 2026 — setPeer is no longer whenNotPaused on either contract.
  //    The pause is a TRANSFER circuit-breaker, not an admin lockout; guarding
  //    setPeer with it disarmed the defenders at the moment of the incident.
  it("C: [FIXED] the INCIDENT_RESPONSE peer-freeze works while paused", async function () {
    const { admin, token, native } = await fixture();

    // Step 1 of any incident: pause.
    await token.connect(admin).pause();
    expect(await token.paused()).to.equal(true);

    // Step 5 of INCIDENT_RESPONSE.md: freeze the peer. This used to revert.
    await expect(token.connect(admin).setPeer(REMOTE_EID, ethers.ZeroHash)).to.not.be.reverted;
    expect(await token.peers(REMOTE_EID)).to.equal(ethers.ZeroHash);

    // ...and on the remote contract, which is the one the runbook actually names.
    await native.connect(admin).pause();
    await expect(native.connect(admin).setPeer(REMOTE_EID, ethers.ZeroHash)).to.not.be.reverted;
    expect(await native.peers(REMOTE_EID)).to.equal(ethers.ZeroHash);

    // ⭐ Still owner-gated: removing the pause guard did not open it up.
    const [, outsider] = await ethers.getSigners();
    await expect(token.connect(outsider).setPeer(REMOTE_EID, ethers.ZeroHash)).to.be.reverted;
  });

  it("D: [BY DESIGN] setDelegate is not pause-guarded, and neither is setPeer", async function () {
    const { admin, attacker, token } = await fixture();
    await token.connect(admin).pause();
    // succeeds while paused
    await token.connect(admin).setDelegate(attacker.address);
    console.log("      setDelegate succeeded while paused");
  });

  // ✅ FIXED 9 Sep 2026 — SRXOFTNative._update now enforces the same MAX_SUPPLY.
  //    ⚠️ The original case was WEAKER THAN ITS TITLE: it minted exactly 1e28,
  //    which is AT the cap, not above it, so it never demonstrated the missing
  //    cap at all and kept passing after the fix landed. Strengthened to mint
  //    at the cap (allowed) and then one token more (refused).
  it("E: [FIXED] the remote SRXOFTNative refuses a mint above MAX_SUPPLY", async function () {
    const { admin, attacker, native, epSigner } = await fixture();
    const peer = b32(attacker.address);
    await native.connect(admin).setPeer(REMOTE_EID, peer);

    const MAX = await native.MAX_SUPPLY();

    // exactly at the cap is legitimate — all supply may bridge to one chain
    await native.connect(epSigner).lzReceive(
      { srcEid: REMOTE_EID, sender: peer, nonce: 1 },
      ethers.ZeroHash, oftMsg(attacker.address, MAX / 10n ** 12n), ethers.ZeroAddress, "0x"
    );
    expect(await native.totalSupply()).to.equal(MAX);

    // one token more must be refused
    await expect(
      native.connect(epSigner).lzReceive(
        { srcEid: REMOTE_EID, sender: peer, nonce: 2 },
        ethers.ZeroHash, oftMsg(attacker.address, 10n ** 6n), ethers.ZeroAddress, "0x"
      )
    ).to.be.revertedWithCustomError(native, "SupplyCapExceeded");

    expect(await native.totalSupply()).to.equal(MAX);
  });
});
