// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IERC20 } from "./vendor/openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ReceiverTemplate } from "./vendor/ReceiverTemplate.sol";

import { IRoyaleEscrow } from "./interfaces/IRoyaleEscrow.sol";

/// @title  RoyaleEscrow
/// @notice Holds lobby entries and pays finalists. Only a CRE report delivered by the forwarder
///         (or, in simulated mode, the same bytes from the owner) can release a pot.
contract RoyaleEscrow is IRoyaleEscrow, ReceiverTemplate {
    /* ============ Constants ============ */

    /// @inheritdoc IRoyaleEscrow
    uint256 public constant FEE_BPS = 500;

    /// @inheritdoc IRoyaleEscrow
    uint16 public constant MAX_CREATOR_FEE_BPS = 500;

    uint256 internal constant _BPS = 10_000;

    uint16 internal constant _MIN_PLAYERS = 4;

    uint16 internal constant _MAX_PLAYERS = 50;

    /* ============ Immutables ============ */

    /// @inheritdoc IRoyaleEscrow
    address public immutable token;

    /// @inheritdoc IRoyaleEscrow
    uint64 public immutable chainSelector;

    /// @inheritdoc IRoyaleEscrow
    address public immutable treasury;

    /// @inheritdoc IRoyaleEscrow
    address public immutable relayer;

    /* ============ State Variables ============ */

    /// @inheritdoc IRoyaleEscrow
    uint256 public lobbyCount;

    mapping(uint256 id => Lobby lobby) internal _lobbies;

    mapping(uint256 id => address[] players) internal _players;

    mapping(uint256 id => mapping(address player => address payer)) internal _payers;

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

    /// @inheritdoc IRoyaleEscrow
    function createLobby(uint32 duration, uint96 entry, uint16 maxPlayers) external onlyOwner returns (uint256 id) {
        return _createLobby(duration, entry, maxPlayers);
    }

    /// @inheritdoc IRoyaleEscrow
    function createRound(
        uint32 duration,
        uint96 entry,
        uint16 maxPlayers,
        address creator,
        uint16 creatorFeeBps
    ) external onlyOwner returns (uint256 id) {
        if (creatorFeeBps > MAX_CREATOR_FEE_BPS) revert CreatorFeeTooHigh(creatorFeeBps, MAX_CREATOR_FEE_BPS);
        if (creator == address(0) && creatorFeeBps != 0) revert ZeroCreatorWithFee(creatorFeeBps);

        // A round without a creator settles against the royale budget floor(pot * 9500 / 10000). That equals
        // predictSettle's pot - floor(pot * 500 / 10000) only when pot % 20 == 0, which entry % 20 == 0 guarantees.
        if (creator == address(0) && entry % 20 != 0) revert InvalidLobbyConfig();

        id = _createLobby(duration, entry, maxPlayers);

        Lobby storage lobby = _lobbies[id];
        lobby.creator = creator;
        lobby.creatorFeeBps = creatorFeeBps;

        emit RoundCreated(id, creator, creatorFeeBps);
    }

    /// @inheritdoc IRoyaleEscrow
    function joinFor(uint256 id, address player) external {
        if (msg.sender != relayer) revert NotRelayer(msg.sender);
        if (player == address(0)) revert ZeroAddress();

        _join(id, player, msg.sender);
    }

    /// @inheritdoc IRoyaleEscrow
    function join(uint256 id) external {
        _join(id, msg.sender, msg.sender);
    }

    /// @inheritdoc IRoyaleEscrow
    function start(uint256 id) external onlyOwner {
        Lobby storage lobby = _lobbies[id];

        if (lobby.status != Status.Open) revert LobbyNotOpen(id);
        if (lobby.playerCount < _MIN_PLAYERS) revert NotEnoughPlayers(id, lobby.playerCount);

        uint64 startTime = uint64(block.timestamp);
        uint64 endTime = startTime + lobby.duration;

        lobby.status = Status.Live;
        lobby.startTime = startTime;
        lobby.endTime = endTime;

        emit Started(id, startTime, endTime);
    }

    /// @inheritdoc IRoyaleEscrow
    function cancel(uint256 id) external onlyOwner {
        Lobby storage lobby = _lobbies[id];

        if (lobby.status != Status.Open && lobby.status != Status.Live) revert LobbyNotCancellable(id);

        lobby.status = Status.Cancelled;
        lobby.pot = 0;

        emit Cancelled(id);

        address[] storage players = _players[id];
        uint256 entry = lobby.entry;

        for (uint256 i; i < players.length; ++i) {
            _transfer(_payers[id][players[i]], entry);
        }
    }

    /// @inheritdoc IRoyaleEscrow
    function settleFallback(bytes calldata report) external onlyOwner {
        _settle(report);
    }

    /// @inheritdoc IRoyaleEscrow
    function getLobby(uint256 id) external view returns (Lobby memory) {
        return _lobbies[id];
    }

    /// @inheritdoc IRoyaleEscrow
    function getPlayers(uint256 id) external view returns (address[] memory) {
        return _players[id];
    }

    /// @inheritdoc IRoyaleEscrow
    function isPlayer(uint256 id, address player) external view returns (bool) {
        return _payers[id][player] != address(0);
    }

    /* ============ Internal Functions ============ */

    /// @dev Called by ReceiverTemplate.onReport after the forwarder and metadata checks.
    function _processReport(bytes calldata report) internal override {
        _settle(report);
    }

    /// @dev    Validates a settlement report and pays it out. Shared by onReport and settleFallback.
    ///         Report: abi.encode(uint64 chainSelector, uint256 lobbyId, bytes32 bookHash,
    ///         address[] winners, uint256[] amounts).
    function _settle(bytes calldata report) internal {
        (
            uint64 reportChainSelector,
            uint256 id,
            bytes32 bookHash,
            address[] memory winners,
            uint256[] memory amounts
        ) = abi.decode(report, (uint64, uint256, bytes32, address[], uint256[]));

        if (reportChainSelector != chainSelector) revert WrongChainSelector(chainSelector, reportChainSelector);

        Lobby storage lobby = _lobbies[id];

        if (lobby.status != Status.Live) revert LobbyNotLive(id);
        if (block.timestamp <= lobby.endTime) revert SettleBeforeEnd(id, lobby.endTime);
        if (winners.length != amounts.length) revert LengthMismatch(winners.length, amounts.length);

        for (uint256 i; i < winners.length; ++i) {
            if (_payers[id][winners[i]] == address(0)) revert NotPlayer(id, winners[i]);
        }

        for (uint256 i = 1; i < winners.length; ++i) {
            if (winners[i] <= winners[i - 1]) revert WinnersNotAscending(i);
        }

        uint256 pot = lobby.pot;
        address creator = lobby.creator;
        uint256 creatorFee = (pot * lobby.creatorFeeBps) / _BPS;

        // Without a creator: floor(pot * 9500 / 10000), as shared/scoring.ts settle() computes it.
        // With a creator: pot - floor(pot * 500 / 10000) - creatorFee, as predictSettle() computes it.
        uint256 budget = creator == address(0)
            ? (pot * (_BPS - FEE_BPS)) / _BPS
            : pot - (pot * FEE_BPS) / _BPS - creatorFee;
        uint256 total;

        for (uint256 i; i < amounts.length; ++i) {
            total += amounts[i];
        }

        if (total > budget) revert AmountsOverBudget(total, budget);

        lobby.status = Status.Settled;
        lobby.bookHash = bookHash;
        lobby.pot = 0;

        _transfer(creator, creatorFee);

        for (uint256 i; i < winners.length; ++i) {
            _transfer(winners[i], amounts[i]);
        }

        _transfer(treasury, pot - creatorFee - total);

        emit Settled(id, bookHash);
    }

    function _createLobby(uint32 duration, uint96 entry, uint16 maxPlayers) internal returns (uint256 id) {
        if (duration == 0 || entry == 0) revert InvalidLobbyConfig();
        if (maxPlayers < _MIN_PLAYERS || maxPlayers > _MAX_PLAYERS) revert InvalidLobbyConfig();

        id = ++lobbyCount;

        Lobby storage lobby = _lobbies[id];
        lobby.status = Status.Open;
        lobby.duration = duration;
        lobby.entry = entry;
        lobby.maxPlayers = maxPlayers;

        emit LobbyCreated(id, duration, entry, maxPlayers);
    }

    function _join(uint256 id, address player, address payer) internal {
        Lobby storage lobby = _lobbies[id];

        if (lobby.status != Status.Open) revert LobbyNotOpen(id);
        if (_payers[id][player] != address(0)) revert AlreadyJoined(id, player);
        if (lobby.playerCount >= lobby.maxPlayers) revert LobbyFull(id);

        uint256 entry = lobby.entry;

        _payers[id][player] = payer;
        _players[id].push(player);
        lobby.playerCount += 1;
        lobby.pot += entry;

        emit Joined(id, player, payer);

        if (!IERC20(token).transferFrom(payer, address(this), entry)) revert TransferFailed();
    }

    function _transfer(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
    }
}
