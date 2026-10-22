// The bridge's verifier rule (THREAT_MODEL: at least 2 DVNs, never the LayerZero defaults)
// was written down and checked nowhere (internal review, 7 Oct 2026). lib/dvnCheck.js now
// reads it from the endpoint in verify_roles (hub) and verify_spoke (each spoke). These
// tests feed it the exact bytes a LayerZero V2 endpoint returns for a ULN config.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { checkDvnConfig, decodeUln, ULN_TUPLE } = require("../../scripts/deploy/lib/dvnCheck");

const A = (n) => ethers.getAddress("0x" + String(n).padStart(40, "0"));
const enc = ({ required = [], optional = [], threshold = 0 }) => ethers.AbiCoder.defaultAbiCoder().encode([ULN_TUPLE],
  [[15n, required.length, optional.length, threshold, required, optional]]);

function fakeEndpoint({ send, recv, sendDefault = false, recvDefault = false }) {
  const SEND = A(0x5e), RECV = A(0x7e);
  return {
    getSendLibrary: async () => SEND,
    isDefaultSendLibrary: async () => sendDefault,
    getReceiveLibrary: async () => [RECV, recvDefault],
    getConfig: async (_oapp, lib, _eid, type) => {
      expect(type).to.equal(2); // ULN config
      return lib === SEND ? enc(send) : enc(recv);
    },
  };
}

const run = (ep) => checkDvnConfig({ endpoint: ep, oapp: A(1), remoteEid: 40102, label: "x" });

describe("DVN configuration check (lib/dvnCheck.js)", function () {
  it("passes own libraries with two required DVNs each way", async function () {
    const two = { required: [A(0xd1), A(0xd2)] };
    expect(await run(fakeEndpoint({ send: two, recv: two }))).to.deep.equal([]);
  });

  it("counts the optional threshold: 1 required + 1 of 2 optional is two DVNs", async function () {
    const mixed = { required: [A(0xd1)], optional: [A(0xd2), A(0xd3)], threshold: 1 };
    expect(await run(fakeEndpoint({ send: mixed, recv: mixed }))).to.deep.equal([]);
  });

  it("refuses a single DVN on the receive side (the side that decides what is credited)", async function () {
    const f = await run(fakeEndpoint({ send: { required: [A(0xd1), A(0xd2)] }, recv: { required: [A(0xd1)] } }));
    expect(f).to.have.length(1);
    expect(f[0]).to.match(/x receive: a message needs 1 DVN/);
  });

  it("refuses optional DVNs that are listed but not required to agree (threshold 0)", async function () {
    const lax = { required: [A(0xd1)], optional: [A(0xd2), A(0xd3)], threshold: 0 };
    expect(await run(fakeEndpoint({ send: lax, recv: lax }))).to.have.length(2);
  });

  it("refuses the endpoint's default libraries even when the default has enough DVNs", async function () {
    const two = { required: [A(0xd1), A(0xd2)] };
    const f = await run(fakeEndpoint({ send: two, recv: two, sendDefault: true, recvDefault: true }));
    expect(f).to.deep.equal(["x send: uses the endpoint's default send library", "x receive: uses the endpoint's default receive library"]);
  });

  it("refuses the same DVN counted twice", async function () {
    const dup = { required: [A(0xd1)], optional: [A(0xd1)], threshold: 1 };
    const f = await run(fakeEndpoint({ send: dup, recv: { required: [A(0xd1), A(0xd2)] } }));
    expect(f).to.deep.equal(["x send: a DVN is listed twice"]);
  });

  it("decodes the endpoint's bytes exactly", function () {
    const u = decodeUln(enc({ required: [A(0xd1)], optional: [A(0xd2)], threshold: 1 }));
    expect(u.requiredDVNs).to.deep.equal([A(0xd1)]);
    expect(u.optionalDVNs).to.deep.equal([A(0xd2)]);
    expect(u.optionalDVNThreshold).to.equal(1);
    expect(u.confirmations).to.equal(15n);
  });
});

describe("Enforced delivery gas (07 SET_PEERS, checked by both verifiers)", function () {
  const { checkEnforcedOptions, lzReceiveOption } = require("../../scripts/deploy/lib/dvnCheck");

  it("encodes the LayerZero type-3 executor option exactly (the bytes the Sepolia quote accepted on 7 Oct)", function () {
    expect(lzReceiveOption(200000)).to.equal("0x00030100110100000000000000000000000000030d40");
  });

  it("flags a pathway with no enforced options, and passes once 07's setting is applied", async function () {
    const [admin] = await ethers.getSigners();
    const ep = await (await ethers.getContractFactory("MockLZEndpoint")).deploy(40161);
    const token = await (await ethers.getContractFactory("SRXToken")).deploy(await ep.getAddress(), admin.address);
    expect(await checkEnforcedOptions({ oapp: token, remoteEid: 40102, label: "x" }))
      .to.deep.equal(["x: no enforced options for SEND, so a transfer with empty options cannot be delivered"]);
    await token.setEnforcedOptions([{ eid: 40102, msgType: 1, options: lzReceiveOption(200000) }]);
    expect(await checkEnforcedOptions({ oapp: token, remoteEid: 40102, label: "x" })).to.deep.equal([]);
  });
});
