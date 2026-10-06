// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";

import { ReceiverTemplate } from "../src/vendor/ReceiverTemplate.sol";

import { IRoyaleEscrow } from "../src/interfaces/IRoyaleEscrow.sol";

import { MockUSDC } from "../src/MockUSDC.sol";
import { RoyaleEscrow } from "../src/RoyaleEscrow.sol";

contract RoyaleEscrowTest is Test {
    // Values from the golden fixtures expected-report.json and expected-payouts.json, copied so the
    // suite runs without the gate fixtures present.
    uint64 internal constant CHAIN_SELECTOR = 10344971235874465080;

    uint96 internal constant ENTRY = 5_000000;

    uint32 internal constant DURATION = 120;

    bytes internal constant GOLDEN_REPORT =
        hex"0000000000000000000000000000000000000000000000008f90b8876dee65380000000000000000000000000000000000000000000000000000000000000001b81684b748e916ee866105d40cd46b1f8348706c91c5e9d2acbc9b559157aae400000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000400000000000000000000000027c39881f20575560b34de9d0060ed352745fdd900000000000000000000000028be5222e0bb439578862e002d03e43799bc52dd00000000000000000000000043138b14247aa5d4e7a9c6a03ad70ff8a54a98b80000000000000000000000008034e3fc9ab4ba6cddcd1e77c3dcdf7824817d7e00000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000001f81a890000000000000000000000000000000000000000000000000000000000331ef300000000000000000000000000000000000000000000000000000000001d666a000000000000000000000000000000000000000000000000000000000360f5d9";

    bytes32 internal constant GOLDEN_BOOK_HASH = 0xb81684b748e916ee866105d40cd46b1f8348706c91c5e9d2acbc9b559157aae4;

    uint256 internal constant GOLDEN_FEE_UNITS = 5000001;

    MockUSDC internal usdc;

    RoyaleEscrow internal escrow;

    address internal owner = makeAddr("owner");

    address internal forwarder = makeAddr("forwarder");

    address internal treasury = makeAddr("treasury");

    address internal relayer = makeAddr("relayer");

    address internal alice = makeAddr("alice");

    function setUp() public {
        usdc = new MockUSDC();

        vm.prank(owner);
        escrow = new RoyaleEscrow(forwarder, address(usdc), CHAIN_SELECTOR, treasury, relayer);

        usdc.mint(relayer, 1_000 * uint256(ENTRY));

        vm.prank(relayer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    /* ============ join ============ */

    function test_RevertWhen_DuplicateJoin() public {
        uint256 id = _createLobby(10);
        _fundAndApprove(alice);

        vm.prank(alice);
        escrow.join(id);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.AlreadyJoined.selector, id, alice));
        vm.prank(alice);
        escrow.join(id);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.AlreadyJoined.selector, id, alice));
        vm.prank(relayer);
        escrow.joinFor(id, alice);
    }

    function test_RevertWhen_LobbyFull() public {
        uint256 id = _createLobby(4);

        for (uint256 i; i < 4; ++i) {
            vm.prank(relayer);
            escrow.joinFor(id, _player(i));
        }

        address late = _player(4);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.LobbyFull.selector, id));
        vm.prank(relayer);
        escrow.joinFor(id, late);
    }

    function test_Join() public {
        uint256 id = _createLobby(10);
        _fundAndApprove(alice);

        vm.expectEmit();
        emit IRoyaleEscrow.Joined(id, alice, alice);

        vm.prank(alice);
        escrow.join(id);

        assertEq(id, 1);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(escrow)), ENTRY);
        assertTrue(escrow.isPlayer(id, alice));

        IRoyaleEscrow.Lobby memory lobby = escrow.getLobby(id);

        assertEq(lobby.playerCount, 1);
        assertEq(lobby.pot, ENTRY);
        assertEq(escrow.getPlayers(id)[0], alice);
    }

    /* ============ joinFor ============ */

    function test_JoinFor() public {
        uint256 id = _createLobby(10);
        uint256 relayerBefore = usdc.balanceOf(relayer);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.NotRelayer.selector, alice));
        vm.prank(alice);
        escrow.joinFor(id, alice);

        vm.expectEmit();
        emit IRoyaleEscrow.Joined(id, alice, relayer);

        vm.prank(relayer);
        escrow.joinFor(id, alice);

        assertEq(usdc.balanceOf(relayer), relayerBefore - ENTRY);
        assertEq(usdc.balanceOf(address(escrow)), ENTRY);
        assertTrue(escrow.isPlayer(id, alice));
        assertFalse(escrow.isPlayer(id, relayer));
        assertEq(escrow.getLobby(id).pot, ENTRY);
    }

    /* ============ start ============ */

    function test_RevertWhen_StartUnderFourPlayers() public {
        uint256 id = _createLobby(10);

        for (uint256 i; i < 3; ++i) {
            vm.prank(relayer);
            escrow.joinFor(id, _player(i));
        }

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.NotEnoughPlayers.selector, id, 3));
        vm.prank(owner);
        escrow.start(id);

        vm.prank(relayer);
        escrow.joinFor(id, _player(3));

        vm.prank(owner);
        escrow.start(id);

        IRoyaleEscrow.Lobby memory lobby = escrow.getLobby(id);

        assertEq(uint8(lobby.status), uint8(IRoyaleEscrow.Status.Live));
        assertEq(lobby.endTime, block.timestamp + DURATION);
    }

    /* ============ cancel ============ */

    function test_CancelRefundsAll() public {
        uint256 id = _createLobby(10);
        _fundAndApprove(alice);

        vm.prank(alice);
        escrow.join(id);

        uint256 relayerBefore = usdc.balanceOf(relayer);

        for (uint256 i; i < 4; ++i) {
            vm.prank(relayer);
            escrow.joinFor(id, _player(i));
        }

        vm.prank(owner);
        escrow.start(id);

        vm.expectEmit();
        emit IRoyaleEscrow.Cancelled(id);

        vm.prank(owner);
        escrow.cancel(id);

        assertEq(usdc.balanceOf(alice), ENTRY);
        assertEq(usdc.balanceOf(relayer), relayerBefore);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.getLobby(id).status), uint8(IRoyaleEscrow.Status.Cancelled));

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.LobbyNotCancellable.selector, id));
        vm.prank(owner);
        escrow.cancel(id);
    }

    /* ============ settle ============ */

    function test_RevertWhen_WrongChainSelector() public {
        (uint256 id, address[] memory players) = _liveLobby(4);
        vm.warp(block.timestamp + DURATION + 1);

        (address[] memory winners, uint256[] memory amounts) = _twoWinners(players, 1, 1);
        bytes memory report = abi.encode(CHAIN_SELECTOR + 1, id, bytes32(0), winners, amounts);

        vm.expectRevert(
            abi.encodeWithSelector(IRoyaleEscrow.WrongChainSelector.selector, CHAIN_SELECTOR, CHAIN_SELECTOR + 1)
        );
        vm.prank(forwarder);
        escrow.onReport("", report);
    }

    function test_RevertWhen_SettleBeforeEnd() public {
        (uint256 id, address[] memory players) = _liveLobby(4);
        uint64 endTime = escrow.getLobby(id).endTime;
        vm.warp(endTime);

        (address[] memory winners, uint256[] memory amounts) = _twoWinners(players, 1, 1);
        bytes memory report = abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.SettleBeforeEnd.selector, id, endTime));
        vm.prank(forwarder);
        escrow.onReport("", report);
    }

    function test_RevertWhen_NonPlayerWinner() public {
        (uint256 id, address[] memory players) = _liveLobby(4);
        vm.warp(block.timestamp + DURATION + 1);

        address[] memory winners = new address[](2);
        winners[0] = players[0];
        winners[1] = alice;

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1;
        amounts[1] = 1;

        bytes memory report = abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.NotPlayer.selector, id, alice));
        vm.prank(forwarder);
        escrow.onReport("", report);
    }

    function test_RevertWhen_WinnersNotAscending() public {
        (uint256 id, address[] memory players) = _liveLobby(4);
        vm.warp(block.timestamp + DURATION + 1);

        (address[] memory winners, uint256[] memory amounts) = _twoWinners(players, 1_000000, 2_000000);
        (winners[0], winners[1]) = (winners[1], winners[0]);

        bytes memory report = abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.WinnersNotAscending.selector, 1));
        vm.prank(forwarder);
        escrow.onReport("", report);

        // A repeated winner is not strictly ascending either.
        winners[1] = winners[0];
        report = abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.WinnersNotAscending.selector, 1));
        vm.prank(forwarder);
        escrow.onReport("", report);
    }

    function test_RevertWhen_AmountsOverBudget() public {
        // Second lobby keeps extra funds in the escrow, so an over-budget payout would not
        // fail on balance alone.
        _liveLobby(4);
        (uint256 id, address[] memory players) = _liveLobby(4);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 budget = (4 * uint256(ENTRY) * 9_500) / 10_000;
        (address[] memory winners, uint256[] memory amounts) = _twoWinners(players, budget - 1, 2);

        bytes memory report = abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.AmountsOverBudget.selector, budget + 1, budget));
        vm.prank(forwarder);
        escrow.onReport("", report);
    }

    function test_RevertWhen_AmountsOverFlooredBudget() public {
        // pot 20_000004: budget is floor(pot * 9500 / 10000) = 19_000003, matching shared/scoring.ts,
        // not pot - floor(pot * 500 / 10000) = 19_000004.
        vm.prank(owner);
        uint256 id = escrow.createLobby(DURATION, ENTRY + 1, 10);

        address[] memory players = new address[](4);

        for (uint256 i; i < 4; ++i) {
            players[i] = _player(i);

            vm.prank(relayer);
            escrow.joinFor(id, players[i]);
        }

        vm.prank(owner);
        escrow.start(id);

        vm.warp(block.timestamp + DURATION + 1);

        (address[] memory winners, uint256[] memory amounts) = _twoWinners(players, 19_000002, 2);
        bytes memory report = abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.AmountsOverBudget.selector, 19_000004, 19_000003));
        vm.prank(forwarder);
        escrow.onReport("", report);

        amounts[1] = 1;
        report = abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts);

        vm.prank(forwarder);
        escrow.onReport("", report);

        assertEq(usdc.balanceOf(treasury), 20_000004 - 19_000003);
    }

    function test_RevertWhen_DoubleSettle() public {
        // Second lobby keeps extra funds in the escrow, so a second payout would not fail on
        // balance alone.
        (uint256 id, address[] memory players) = _liveLobby(4);
        _liveLobby(4);
        vm.warp(block.timestamp + DURATION + 1);

        (address[] memory winners, uint256[] memory amounts) = _twoWinners(players, 10_000000, 5_000000);
        bytes memory report = abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts);

        vm.prank(forwarder);
        escrow.onReport("", report);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.LobbyNotLive.selector, id));
        vm.prank(forwarder);
        escrow.onReport("", report);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.LobbyNotLive.selector, id));
        vm.prank(owner);
        escrow.settleFallback(report);
    }

    function test_OnReportOnlyForwarder() public {
        (uint256 id, address[] memory players) = _liveLobby(4);
        vm.warp(block.timestamp + DURATION + 1);

        (address[] memory winners, uint256[] memory amounts) = _twoWinners(players, 1, 1);
        bytes memory report = abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts);

        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, alice, forwarder));
        vm.prank(alice);
        escrow.onReport("", report);

        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, owner, forwarder));
        vm.prank(owner);
        escrow.onReport("", report);

        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        vm.prank(alice);
        escrow.settleFallback(report);

        assertEq(uint8(escrow.getLobby(id).status), uint8(IRoyaleEscrow.Status.Live));
    }

    function test_SettleHappyPathFeeMaths() public {
        (uint256 id, address[] memory players) = _liveLobby(4);
        vm.warp(block.timestamp + DURATION + 1);

        // pot 20_000000, fee 1_000000, distributable 19_000000; one unit of dust left over.
        (address[] memory winners, uint256[] memory amounts) = _twoWinners(players, 12_000001, 6_999998);
        bytes32 bookHash = keccak256("book");
        bytes memory report = abi.encode(CHAIN_SELECTOR, id, bookHash, winners, amounts);

        vm.expectEmit();
        emit IRoyaleEscrow.Settled(id, bookHash);

        vm.prank(owner);
        escrow.settleFallback(report);

        assertEq(usdc.balanceOf(winners[0]), 12_000001);
        assertEq(usdc.balanceOf(winners[1]), 6_999998);
        assertEq(usdc.balanceOf(treasury), 1_000001);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        IRoyaleEscrow.Lobby memory lobby = escrow.getLobby(id);

        assertEq(uint8(lobby.status), uint8(IRoyaleEscrow.Status.Settled));
        assertEq(lobby.bookHash, bookHash);
        assertEq(lobby.pot, 0);
    }

    function test_SettleGoldenReport() public {
        address[4] memory goldenWinners = [
            0x27c39881f20575560b34de9D0060Ed352745fdD9,
            0x28bE5222E0Bb439578862e002d03E43799bC52dD,
            0x43138B14247aA5d4E7a9c6A03AD70fF8a54A98b8,
            0x8034E3fc9aB4Ba6cDdCd1E77c3dcdf7824817D7E
        ];
        uint256[4] memory goldenAmounts = [uint256(33036937), 3350259, 1926762, 56686041];
        address[2] memory otherFinalists = [
            0x2B7C46CAb69aF4b549d73140637aEBD156eA0706,
            0xF4342Af27c7FCD6dac8A773FC0AD6D606c470403
        ];

        uint256 id = _createLobby(20);

        for (uint256 i; i < 4; ++i) {
            vm.prank(relayer);
            escrow.joinFor(id, goldenWinners[i]);
        }

        for (uint256 i; i < 2; ++i) {
            vm.prank(relayer);
            escrow.joinFor(id, otherFinalists[i]);
        }

        for (uint256 i; i < 14; ++i) {
            vm.prank(relayer);
            escrow.joinFor(id, _player(i));
        }

        assertEq(id, 1);
        assertEq(escrow.getLobby(id).pot, 100000000);

        vm.prank(owner);
        escrow.start(id);

        vm.warp(block.timestamp + DURATION + 1);

        vm.expectEmit();
        emit IRoyaleEscrow.Settled(id, GOLDEN_BOOK_HASH);

        vm.prank(forwarder);
        escrow.onReport("", GOLDEN_REPORT);

        for (uint256 i; i < 4; ++i) {
            assertEq(usdc.balanceOf(goldenWinners[i]), goldenAmounts[i]);
        }

        assertEq(usdc.balanceOf(otherFinalists[0]), 0);
        assertEq(usdc.balanceOf(otherFinalists[1]), 0);
        assertEq(usdc.balanceOf(treasury), GOLDEN_FEE_UNITS);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.getLobby(id).bookHash, GOLDEN_BOOK_HASH);
    }

    /* ============ Helpers ============ */

    function _createLobby(uint16 maxPlayers) internal returns (uint256 id) {
        vm.prank(owner);
        id = escrow.createLobby(DURATION, ENTRY, maxPlayers);
    }

    function _liveLobby(uint256 count) internal returns (uint256 id, address[] memory players) {
        id = _createLobby(10);
        players = new address[](count);

        for (uint256 i; i < count; ++i) {
            players[i] = makeAddr(string.concat("lobby", vm.toString(id), "-player", vm.toString(i)));

            vm.prank(relayer);
            escrow.joinFor(id, players[i]);
        }

        vm.prank(owner);
        escrow.start(id);
    }

    /// @dev Returns players[0] and players[1] sorted ascending, paired with the given amounts.
    function _twoWinners(
        address[] memory players,
        uint256 first,
        uint256 second
    ) internal pure returns (address[] memory winners, uint256[] memory amounts) {
        winners = new address[](2);
        (winners[0], winners[1]) = players[0] < players[1] ? (players[0], players[1]) : (players[1], players[0]);

        amounts = new uint256[](2);
        amounts[0] = first;
        amounts[1] = second;
    }

    function _player(uint256 i) internal returns (address) {
        return makeAddr(string.concat("player", vm.toString(i)));
    }

    function _fundAndApprove(address account) internal {
        usdc.mint(account, ENTRY);

        vm.prank(account);
        usdc.approve(address(escrow), ENTRY);
    }
}
