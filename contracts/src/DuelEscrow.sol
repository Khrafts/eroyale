// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IERC20 } from "./vendor/openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ReceiverTemplate } from "./vendor/ReceiverTemplate.sol";

import { IDuelEscrow } from "./interfaces/IDuelEscrow.sol";

/// @title  DuelEscrow
/// @notice Holds the two stakes of a ranked Stickman Duel and pays the winner. Only a CRE report delivered by the
///         forwarder (or, in simulated mode, the same bytes from the owner) can release a pot.
contract DuelEscrow is IDuelEscrow, ReceiverTemplate {
    /* ============ Constants ============ */

    /// @inheritdoc IDuelEscrow
    uint256 public constant FEE_BPS = 500;

    uint256 internal constant _BPS = 10_000;

    /* ============ Immutables ============ */

    /// @inheritdoc IDuelEscrow
    address public immutable token;

    /// @inheritdoc IDuelEscrow
    uint64 public immutable chainSelector;

    /// @inheritdoc IDuelEscrow
    address public immutable treasury;

    /// @inheritdoc IDuelEscrow
    address public immutable relayer;

    /* ============ State Variables ============ */

    /// @inheritdoc IDuelEscrow
    uint256 public duelCount;

    mapping(uint256 id => Duel duel) internal _duels;

    /* ============ Constructor ============ */

    constructor(
        address forwarder,
        address token_,
        uint64 chainSelector_,
        address treasury_,
        address relayer_
    ) ReceiverTemplate(forwarder) {
        if (token_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (relayer_ == address(0)) revert ZeroAddress();

        token = token_;
        chainSelector = chainSelector_;
        treasury = treasury_;
        relayer = relayer_;
    }

    /* ============ External Functions ============ */

    /// @inheritdoc IDuelEscrow
    function createDuel(uint96 stake) external onlyOwner returns (uint256 id) {
        if (stake == 0) revert ZeroStake();

        id = ++duelCount;

        Duel storage duel = _duels[id];
        duel.status = Status.Open;
        duel.stake = stake;

        emit DuelCreated(id, stake);
    }

    /// @inheritdoc IDuelEscrow
    function joinFor(uint256 id, address player) external {
        if (msg.sender != relayer) revert NotRelayer(msg.sender);
        if (player == address(0)) revert ZeroAddress();

        Duel storage duel = _duels[id];

        if (duel.status != Status.Open) revert DuelNotOpen(id);
        if (duel.playerA == player || duel.playerB == player) revert AlreadyJoined(id, player);
        if (duel.playerB != address(0)) revert DuelFull(id);

        if (duel.playerA == address(0)) {
            duel.playerA = player;
        } else {
            duel.playerB = player;
        }

        uint256 stake = duel.stake;
        duel.pot += stake;

        emit Joined(id, player, msg.sender);

        if (!IERC20(token).transferFrom(msg.sender, address(this), stake)) revert TransferFailed();
    }

    /// @inheritdoc IDuelEscrow
    function start(uint256 id) external onlyOwner {
        Duel storage duel = _duels[id];

        if (duel.status != Status.Open) revert DuelNotOpen(id);
        if (duel.playerB == address(0)) revert NotEnoughPlayers(id);

        duel.status = Status.Live;

        emit Started(id);
    }

    /// @inheritdoc IDuelEscrow
    function cancel(uint256 id) external onlyOwner {
        Duel storage duel = _duels[id];

        if (duel.status != Status.Open && duel.status != Status.Live) revert DuelNotCancellable(id);

        uint256 pot = duel.pot;

        duel.status = Status.Cancelled;
        duel.pot = 0;

        emit Cancelled(id);

        // Only the relayer can join, so it paid every stake.
        _transfer(relayer, pot);
    }

    /// @inheritdoc IDuelEscrow
    function settleFallback(bytes calldata report) external onlyOwner {
        _settle(report);
    }

    /// @notice Updates the forwarder allowed to call onReport. Unlike the template, address(0) is refused: it would
    ///         let anyone deliver a report and pick the winner of a Live duel.
    function setForwarderAddress(address forwarder) public override onlyOwner {
        if (forwarder == address(0)) revert ZeroForwarder();

        super.setForwarderAddress(forwarder);
    }

    /// @inheritdoc IDuelEscrow
    function getDuel(uint256 id) external view returns (Duel memory) {
        return _duels[id];
    }

    /* ============ Internal Functions ============ */

    /// @dev Called by ReceiverTemplate.onReport after the forwarder and metadata checks.
    function _processReport(bytes calldata report) internal override {
        _settle(report);
    }

    /// @dev    Validates a duel report and pays it out. Shared by onReport and settleFallback.
    ///         Report: abi.encode(uint64 chainSelector, uint256 duelId, bytes32 bookHash, address winner),
    ///         winner zero for a draw.
    function _settle(bytes calldata report) internal {
        (uint64 reportChainSelector, uint256 id, bytes32 bookHash, address winner) = abi.decode(
            report,
            (uint64, uint256, bytes32, address)
        );

        if (reportChainSelector != chainSelector) revert WrongChainSelector(chainSelector, reportChainSelector);

        Duel storage duel = _duels[id];

        if (duel.status != Status.Live) revert DuelNotLive(id);

        address playerA = duel.playerA;
        address playerB = duel.playerB;

        if (winner != address(0) && winner != playerA && winner != playerB) revert NotPlayer(id, winner);

        uint256 pot = duel.pot;

        duel.status = Status.Settled;
        duel.bookHash = bookHash;
        duel.winner = winner;
        duel.pot = 0;

        if (winner == address(0)) {
            uint256 stake = duel.stake;

            _transfer(playerA, stake);
            _transfer(playerB, stake);
        } else {
            uint256 fee = (pot * FEE_BPS) / _BPS;

            _transfer(winner, pot - fee);
            _transfer(treasury, fee);
        }

        emit Settled(id, bookHash, winner);
    }

    function _transfer(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
    }
}
