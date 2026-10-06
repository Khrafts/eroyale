// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  IRoyaleEscrow
/// @notice Holds Trading Royale entries and pays survivors from a CRE settlement report.
interface IRoyaleEscrow {
    /* ============ Structs ============ */

    enum Status {
        None,
        Open,
        Live,
        Settled,
        Cancelled
    }

    struct Lobby {
        Status status; // ──────╮ Lifecycle stage.
        uint16 maxPlayers; //   │ Seat limit.
        uint32 duration; //     │ Match length in seconds.
        uint64 startTime; //    │ Set by start().
        uint64 endTime; // ─────╯ startTime + duration.
        uint96 entry; // ───────╮ Entry in token units.
        uint32 playerCount; // ─╯ Players joined.
        uint256 pot; // Sum of entries held for this lobby.
        bytes32 bookHash; // Final book hash, set on settlement.
    }

    /* ============ Events ============ */

    event LobbyCreated(uint256 indexed id, uint32 duration, uint96 entry, uint16 maxPlayers);

    event Joined(uint256 indexed id, address indexed player, address indexed payer);

    event Started(uint256 indexed id, uint64 startTime, uint64 endTime);

    event Cancelled(uint256 indexed id);

    event Settled(uint256 indexed id, bytes32 bookHash);

    /* ============ Errors ============ */

    error ZeroAddress();

    error InvalidLobbyConfig();

    error LobbyNotOpen(uint256 id);

    error LobbyNotLive(uint256 id);

    error LobbyNotCancellable(uint256 id);

    error AlreadyJoined(uint256 id, address player);

    error LobbyFull(uint256 id);

    error NotEnoughPlayers(uint256 id, uint256 count);

    error NotRelayer(address caller);

    error WrongChainSelector(uint64 expected, uint64 actual);

    error SettleBeforeEnd(uint256 id, uint64 endTime);

    error LengthMismatch(uint256 winners, uint256 amounts);

    error NotPlayer(uint256 id, address winner);

    error WinnersNotAscending(uint256 index);

    error AmountsOverBudget(uint256 total, uint256 budget);

    error TransferFailed();

    /* ============ Interactive Functions ============ */

    /// @notice Opens a new lobby. Ids start at 1.
    /// @param  duration   Match length in seconds.
    /// @param  entry      Entry in token units.
    /// @param  maxPlayers Seat limit, 4 to 50.
    /// @return id The new lobby id.
    function createLobby(uint32 duration, uint96 entry, uint16 maxPlayers) external returns (uint256 id);

    /// @notice Joins `player` to lobby `id`; the relayer pays the entry.
    function joinFor(uint256 id, address player) external;

    /// @notice Joins the caller to lobby `id`; the caller pays the entry.
    function join(uint256 id) external;

    /// @notice Starts lobby `id`. Needs 4 or more players.
    function start(uint256 id) external;

    /// @notice Cancels an open or live lobby and refunds every entry to whoever paid it.
    function cancel(uint256 id) external;

    /// @notice Settles with the same report bytes the CRE workflow would deliver. Simulated mode only.
    function settleFallback(bytes calldata report) external;

    /* ============ View/Pure Functions ============ */

    /// @notice Fee taken from every pot, in basis points.
    function FEE_BPS() external view returns (uint256);

    /// @notice The settlement token.
    function token() external view returns (address);

    /// @notice CRE chain selector the report must carry.
    function chainSelector() external view returns (uint64);

    /// @notice Receives the fee and rounding dust.
    function treasury() external view returns (address);

    /// @notice The only address allowed to call joinFor.
    function relayer() external view returns (address);

    /// @notice Number of lobbies created; also the latest id.
    function lobbyCount() external view returns (uint256);

    /// @notice Lobby state.
    function getLobby(uint256 id) external view returns (Lobby memory);

    /// @notice Players of lobby `id`, in join order.
    function getPlayers(uint256 id) external view returns (address[] memory);

    /// @notice Whether `player` joined lobby `id`.
    function isPlayer(uint256 id, address player) external view returns (bool);
}
