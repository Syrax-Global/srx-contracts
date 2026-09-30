// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title GenesisAgreementRegistry
 * @notice Records, on the Syrax Chain, that a wallet accepted a Genesis purchase
 *         agreement, and when (Genesis journey, 25 Sep 2026).
 *
 * The invitee accepts by sending one transaction from their own Syrax Vault. That
 * transaction is the acceptance: it needs the owner's passkey, it proves they
 * control the wallet, and it fixes the wallet address from the wallet itself
 * rather than from anything typed.
 *
 * What is recorded is a commitment, never the agreement:
 *
 *   commitment = keccak256(abi.encodePacked(
 *       "SYRAX-GENESIS-AGREEMENT-V1", sha256(agreement document), salt))
 *
 * The document (which names the person, the amount and this wallet) and the
 * 32-byte random salt stay off-chain with Syrax. Without the salt the commitment
 * reveals nothing about the person; with it, anyone holding the document can
 * prove this exact text was accepted by this wallet at this time. Deleting the
 * salt makes the record meaningless, which is how a privacy deletion can be
 * honoured on a chain that keeps everything.
 *
 * The same commitment is the `agreementRef` of the buyer's approval in
 * PreSaleRound, which ties a payment to the agreement it was made under.
 *
 * No admin, no owner, no funds, no upgrade path: nothing here can be changed or
 * taken away once written. An amended agreement is a new commitment.
 */
contract GenesisAgreementRegistry {
    /// @notice When `wallet` accepted `commitment`, in unix seconds; 0 = never.
    mapping(address => mapping(bytes32 => uint256)) public acceptedAt;

    event AgreementAccepted(address indexed wallet, bytes32 indexed commitment, uint256 acceptedAt);

    error ZeroCommitment();
    error AlreadyAccepted(address wallet, bytes32 commitment);

    /// @notice Accept the agreement whose commitment is `commitment`, as the caller.
    function accept(bytes32 commitment) external {
        if (commitment == bytes32(0)) revert ZeroCommitment();
        if (acceptedAt[msg.sender][commitment] != 0) revert AlreadyAccepted(msg.sender, commitment);
        acceptedAt[msg.sender][commitment] = block.timestamp;
        emit AgreementAccepted(msg.sender, commitment, block.timestamp);
    }
}
