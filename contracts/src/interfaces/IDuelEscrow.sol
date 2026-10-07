// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  IDuelEscrow
/// @notice Holds Stickman Duel stakes and pays the winner from a CRE settlement report.
interface IDuelEscrow {
    /* ============ Structs ============ */

    enum Status {
        None,
        Open,
        Live,
        Settled,
        Cancelled
    }

    struct Duel {
        Status status; // ─╮ Lifecycle stage.
        uint96 stake; // ──╯ Stake per player in token units.
        address playerA; // First player joined (side 0).
        address playerB; // Second player joined (side 1).
        uint256 pot; // Sum of stakes held for this duel.
        bytes32 bookHash; // Final book hash, set on settlement.
        address winner; // Set on settlement; zero for a draw.
    }

    /* ============ Events ============ */

    event DuelCreated(uint256 indexed id, uint96 stake);

    event Joined(uint256 indexed id, address indexed player, address indexed payer);

    event Started(uint256 indexed id);

    event Cancelled(uint256 indexed id);

    event Settled(uint256 indexed id, bytes32 bookHash, address winner);

    /* ============ Errors ============ */

    error ZeroAddress();

    error ZeroStake();

    error DuelNotOpen(uint256 id);

    error DuelNotLive(uint256 id);

    error DuelNotCancellable(uint256 id);

    error AlreadyJoined(uint256 id, address player);

    error DuelFull(uint256 id);

    error NotEnoughPlayers(uint256 id);

    error NotRelayer(address caller);

    error WrongChainSelector(uint64 expected, uint64 actual);

    error NotPlayer(uint256 id, address winner);

    error TransferFailed();

    /* ============ Interactive Functions ============ */

    /// @notice Opens a new duel. Ids start at 1.
    /// @param  stake Stake per player in token units.
    /// @return id The new duel id.
    function createDuel(uint96 stake) external returns (uint256 id);

    /// @notice Joins `player` to duel `id`; the relayer pays the stake. Exactly two players.
    function joinFor(uint256 id, address player) external;

    /// @notice Starts duel `id`. Needs both players.
    function start(uint256 id) external;

    /// @notice Cancels an open or live duel and refunds every stake paid to the relayer that paid it.
    function cancel(uint256 id) external;

    /// @notice Settles with the same report bytes the CRE workflow would deliver. Simulated mode only.
    function settleFallback(bytes calldata report) external;

    /* ============ View/Pure Functions ============ */

    /// @notice Fee taken from a won pot, in basis points.
    function FEE_BPS() external view returns (uint256);

    /// @notice The stake token.
    function token() external view returns (address);

    /// @notice CRE chain selector the report must carry.
    function chainSelector() external view returns (uint64);

    /// @notice Receives the fee.
    function treasury() external view returns (address);

    /// @notice The only address allowed to call joinFor.
    function relayer() external view returns (address);

    /// @notice Number of duels created; also the latest id.
    function duelCount() external view returns (uint256);

    /// @notice Duel state.
    function getDuel(uint256 id) external view returns (Duel memory);
}
