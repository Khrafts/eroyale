// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test, Vm } from "forge-std/Test.sol";

import { IRoyaleEscrow } from "../src/interfaces/IRoyaleEscrow.sol";

import { MockUSDC } from "../src/MockUSDC.sol";
import { RoyaleEscrow } from "../src/RoyaleEscrow.sol";

contract RoyaleEscrowPredictTest is Test {
    // Golden values from the predict golden fixtures expected-report.json and expected-payouts.json, copied so
    // the suite runs without the gate fixtures present.
    uint64 internal constant CHAIN_SELECTOR = 10344971235874465080;

    uint96 internal constant ENTRY = 5000000;

    uint32 internal constant DURATION = 180;

    uint16 internal constant GOLDEN_CREATOR_FEE_BPS = 300;

    uint256 internal constant GOLDEN_POT = 100000000;

    uint256 internal constant GOLDEN_CREATOR_FEE_UNITS = 3000000;

    uint256 internal constant GOLDEN_FEE_UNITS = 5000002;

    bytes32 internal constant GOLDEN_BOOK_HASH = 0x619e5c6eec724567c4dc769c77c55c710588c58c475e375f15f00138926656ad;

    bytes internal constant GOLDEN_REPORT =
        hex"0000000000000000000000000000000000000000000000008f90b8876dee65380000000000000000000000000000000000000000000000000000000000000001619e5c6eec724567c4dc769c77c55c710588c58c475e375f15f00138926656ad00000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000050000000000000000000000000606f04e1c95fa8203ba1aac04407635152445950000000000000000000000000e86601631ea1da018e17f1297d3fb84a87929680000000000000000000000008a60066492e5931bb608462478dad9acff5c4030000000000000000000000000aea3125c5838ae3ddd55debeffe3dec98c3229b9000000000000000000000000b188e178b8591016741b1c6ad6e5eea9e2625840000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000015ceaea000000000000000000000000000000000000000000000000000000000090732a000000000000000000000000000000000000000000000000000000000118c3000000000000000000000000000000000000000000000000000000000001a112d50000000000000000000000000000000000000000000000000000000000d49b15";

    bytes32 internal constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");

    MockUSDC internal usdc;

    RoyaleEscrow internal escrow;

    address internal owner = makeAddr("owner");

    address internal forwarder = makeAddr("forwarder");

    address internal treasury = makeAddr("treasury");

    address internal relayer = makeAddr("relayer");

    address internal creator = makeAddr("creator");

    address internal alice = makeAddr("alice");

    function setUp() public {
        usdc = new MockUSDC();

        vm.prank(owner);
        escrow = new RoyaleEscrow(forwarder, address(usdc), CHAIN_SELECTOR, treasury, relayer);

        usdc.mint(relayer, 1_000 * uint256(ENTRY));

        vm.prank(relayer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    /* ============ createRound ============ */

    function test_RevertWhen_CreateRoundNotOwner() public {
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        vm.prank(alice);
        escrow.createRound(DURATION, ENTRY, 10, creator, 100);

        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", relayer));
        vm.prank(relayer);
        escrow.createRound(DURATION, ENTRY, 10, address(0), 0);

        assertEq(escrow.lobbyCount(), 0);
    }

    function test_RevertWhen_CreatorFeeOverCap() public {
        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.CreatorFeeTooHigh.selector, 501, 500));
        vm.prank(owner);
        escrow.createRound(DURATION, ENTRY, 10, creator, 501);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.CreatorFeeTooHigh.selector, type(uint16).max, 500));
        vm.prank(owner);
        escrow.createRound(DURATION, ENTRY, 10, creator, type(uint16).max);

        assertEq(escrow.lobbyCount(), 0);

        // The cap itself is allowed.
        vm.prank(owner);
        uint256 id = escrow.createRound(DURATION, ENTRY, 10, creator, 500);

        assertEq(escrow.getLobby(id).creatorFeeBps, 500);
    }

    function test_RevertWhen_ZeroCreatorWithFee() public {
        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.ZeroCreatorWithFee.selector, 1));
        vm.prank(owner);
        escrow.createRound(DURATION, ENTRY, 10, address(0), 1);

        assertEq(escrow.lobbyCount(), 0);

        // No creator and no fee is a valid round (the protocol round).
        vm.prank(owner);
        uint256 id = escrow.createRound(DURATION, ENTRY, 10, address(0), 0);

        assertEq(escrow.getLobby(id).creator, address(0));
        assertEq(escrow.getLobby(id).creatorFeeBps, 0);
    }

    function test_RevertWhen_NoCreatorEntryNotMultipleOf20() public {
        // Without a creator the royale budget floor(pot * 9500 / 10000) applies; an entry that is not a
        // multiple of 20 could leave it one unit under predictSettle's pot - floor(pot * 500 / 10000).
        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.InvalidLobbyConfig.selector));
        vm.prank(owner);
        escrow.createRound(DURATION, 1_000001, 50, address(0), 0);

        assertEq(escrow.lobbyCount(), 0);

        // With a creator the predict budget applies, so any entry is fine.
        vm.prank(owner);
        uint256 id = escrow.createRound(DURATION, 1_000001, 50, creator, 0);

        assertEq(escrow.getLobby(id).entry, 1_000001);

        vm.prank(owner);
        id = escrow.createRound(DURATION, 1_000020, 50, address(0), 0);

        assertEq(escrow.getLobby(id).entry, 1_000020);
    }

    function test_CreateRound() public {
        assertEq(escrow.MAX_CREATOR_FEE_BPS(), 500);

        vm.expectEmit();
        emit IRoyaleEscrow.LobbyCreated(1, DURATION, ENTRY, 12);

        vm.expectEmit();
        emit IRoyaleEscrow.RoundCreated(1, creator, 300);

        vm.prank(owner);
        uint256 id = escrow.createRound(DURATION, ENTRY, 12, creator, 300);

        assertEq(id, 1);
        assertEq(escrow.lobbyCount(), 1);

        IRoyaleEscrow.Lobby memory lobby = escrow.getLobby(id);

        assertEq(uint8(lobby.status), uint8(IRoyaleEscrow.Status.Open));
        assertEq(lobby.duration, DURATION);
        assertEq(lobby.entry, ENTRY);
        assertEq(lobby.maxPlayers, 12);
        assertEq(lobby.creator, creator);
        assertEq(lobby.creatorFeeBps, 300);
        assertEq(lobby.pot, 0);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.InvalidLobbyConfig.selector));
        vm.prank(owner);
        escrow.createRound(DURATION, ENTRY, 51, creator, 300);
    }

    /* ============ settle ============ */

    function test_CreatorFeePaid() public {
        (uint256 id, address[] memory players) = _liveRound(4, creator, 300);
        vm.warp(block.timestamp + DURATION + 1);

        // pot 20_000000: fee 1_000000, creator fee floor(20_000000 * 300 / 10000) = 600000, winners 18_400000.
        (address[] memory winners, uint256[] memory amounts) = _twoWinners(players, 10_000000, 8_400000);
        bytes32 bookHash = keccak256("round");

        vm.expectEmit();
        emit IRoyaleEscrow.Settled(id, bookHash);

        vm.prank(forwarder);
        escrow.onReport("", abi.encode(CHAIN_SELECTOR, id, bookHash, winners, amounts));

        assertEq(usdc.balanceOf(creator), 600000);
        assertEq(usdc.balanceOf(winners[0]), 10_000000);
        assertEq(usdc.balanceOf(winners[1]), 8_400000);
        assertEq(usdc.balanceOf(treasury), 1_000000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.getLobby(id).status), uint8(IRoyaleEscrow.Status.Settled));
    }

    function test_CreatorPaidBeforeWinners() public {
        (uint256 id, address[] memory players) = _liveRound(4, creator, 500);
        vm.warp(block.timestamp + DURATION + 1);

        // pot 20_000000: fee 1_000000, creator fee 1_000000, winners 18_000000 minus 1 unit of dust.
        (address[] memory winners, uint256[] memory amounts) = _twoWinners(players, 9_000000, 8_999999);

        vm.recordLogs();

        vm.prank(owner);
        escrow.settleFallback(abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        address[] memory recipients = new address[](logs.length);
        uint256[] memory values = new uint256[](logs.length);
        uint256 count;

        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(usdc) || logs[i].topics[0] != TRANSFER_TOPIC) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) != address(escrow)) continue;

            recipients[count] = address(uint160(uint256(logs[i].topics[2])));
            values[count] = abi.decode(logs[i].data, (uint256));
            ++count;
        }

        assertEq(count, 4);
        assertEq(recipients[0], creator);
        assertEq(values[0], 1_000000);
        assertEq(recipients[1], winners[0]);
        assertEq(values[1], 9_000000);
        assertEq(recipients[2], winners[1]);
        assertEq(values[2], 8_999999);
        assertEq(recipients[3], treasury);
        assertEq(values[3], 1_000001);
    }

    function test_BudgetIncludesCreatorFee() public {
        // A second lobby keeps extra funds in the escrow, so an over-budget payout would not fail on
        // balance alone.
        (uint256 id, address[] memory players) = _liveRound(4, creator, 300);
        _liveRound(4, address(0), 0);
        vm.warp(block.timestamp + DURATION + 1);

        // pot 20_000000 - fee 1_000000 - creator fee 600000.
        uint256 budget = 18_400000;
        (address[] memory winners, uint256[] memory amounts) = _twoWinners(players, budget - 1, 2);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.AmountsOverBudget.selector, budget + 1, budget));
        vm.prank(forwarder);
        escrow.onReport("", abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts));

        // Paying the creator fee to winners instead is over budget too.
        amounts[0] = 19_000000 - 1;
        amounts[1] = 1;

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.AmountsOverBudget.selector, 19_000000, budget));
        vm.prank(forwarder);
        escrow.onReport("", abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts));

        amounts[0] = budget - 1;
        amounts[1] = 1;

        vm.prank(forwarder);
        escrow.onReport("", abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts));

        assertEq(usdc.balanceOf(winners[0]), budget - 1);
        assertEq(usdc.balanceOf(winners[1]), 1);
        assertEq(usdc.balanceOf(creator), 600000);
        assertEq(usdc.balanceOf(treasury), 1_000000);
        assertEq(usdc.balanceOf(address(escrow)), 4 * uint256(ENTRY));
    }

    function test_GoldenPredictReport() public {
        string[20] memory players = [
            "0x02e154e842804c5f16683094cbcd39775d0c3093",
            "0x0606f04e1c95fa8203ba1aac0440763515244595",
            "0x0e86601631ea1da018e17f1297d3fb84a8792968",
            "0x1af1abf7a674c072780e179252beeb06e5a2e0cf",
            "0x2157aaf7db7a7387acf53935461dd4e760a86291",
            "0x3c1ae69b04515c342a55d8a58ef08dca4abefa43",
            "0x3ff75938ec38860ba29ba6fe46b5f59c86e69e5a",
            "0x4b103ba3a8469f13213181ddfb14fc0de02c0ceb",
            "0x4d674d14efb6fd777199debbb5dfe675ccda3ff2",
            "0x54662b81043f7ff3c74b84607d339218dcba84a0",
            "0x59bb017c50f244ce8356f166324c90218241b1cd",
            "0x8a60066492e5931bb608462478dad9acff5c4030",
            "0x993fd76211052752668cb0e3ae3c450cacecf14c",
            "0xaea3125c5838ae3ddd55debeffe3dec98c3229b9",
            "0xb188e178b8591016741b1c6ad6e5eea9e2625840",
            "0xbfa52284c70280857de39136e38e1fe8092302cd",
            "0xdb4538f0a5a793c680ba812d18211c0e8710346c",
            "0xe7df5d9eae31387f28d7ab90ddeb29b2250c53e1",
            "0xe8f6fde289f40d13e64436c7df7a7317d888b441",
            "0xeb49719d460a8f017ce46a865e0ca9e2d13819cf"
        ];
        string[5] memory winnerStrings = [
            "0x0606f04e1c95fa8203ba1aac0440763515244595",
            "0x0e86601631ea1da018e17f1297d3fb84a8792968",
            "0x8a60066492e5931bb608462478dad9acff5c4030",
            "0xaea3125c5838ae3ddd55debeffe3dec98c3229b9",
            "0xb188e178b8591016741b1c6ad6e5eea9e2625840"
        ];
        uint256[5] memory amounts = [uint256(22866666), 9466666, 18400000, 27333333, 13933333];
        address goldenCreator = vm.parseAddress("0x256edda03ab626e1e617a25b0b62ba98f9e60284");

        vm.prank(owner);
        uint256 id = escrow.createRound(DURATION, ENTRY, 50, goldenCreator, GOLDEN_CREATOR_FEE_BPS);

        assertEq(id, 1);

        for (uint256 i; i < players.length; ++i) {
            vm.prank(relayer);
            escrow.joinFor(id, vm.parseAddress(players[i]));
        }

        assertEq(escrow.getLobby(id).pot, GOLDEN_POT);

        vm.prank(owner);
        escrow.start(id);

        vm.warp(block.timestamp + DURATION + 1);

        vm.expectEmit();
        emit IRoyaleEscrow.Settled(id, GOLDEN_BOOK_HASH);

        vm.prank(forwarder);
        escrow.onReport("", GOLDEN_REPORT);

        uint256 paid;

        for (uint256 i; i < winnerStrings.length; ++i) {
            assertEq(usdc.balanceOf(vm.parseAddress(winnerStrings[i])), amounts[i]);
            paid += amounts[i];
        }

        for (uint256 i; i < players.length; ++i) {
            address player = vm.parseAddress(players[i]);
            bool won;

            for (uint256 j; j < winnerStrings.length; ++j) {
                if (vm.parseAddress(winnerStrings[j]) == player) won = true;
            }

            if (!won) assertEq(usdc.balanceOf(player), 0);
        }

        assertEq(usdc.balanceOf(goldenCreator), GOLDEN_CREATOR_FEE_UNITS);
        assertEq(usdc.balanceOf(treasury), GOLDEN_FEE_UNITS);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(paid + GOLDEN_CREATOR_FEE_UNITS + GOLDEN_FEE_UNITS, GOLDEN_POT);

        IRoyaleEscrow.Lobby memory lobby = escrow.getLobby(id);

        assertEq(uint8(lobby.status), uint8(IRoyaleEscrow.Status.Settled));
        assertEq(lobby.bookHash, GOLDEN_BOOK_HASH);
        assertEq(lobby.pot, 0);
    }

    function test_RoyaleLobbyUnchanged() public {
        vm.prank(owner);
        uint256 id = escrow.createLobby(DURATION, ENTRY + 1, 10);

        IRoyaleEscrow.Lobby memory lobby = escrow.getLobby(id);

        assertEq(lobby.creator, address(0));
        assertEq(lobby.creatorFeeBps, 0);

        address[] memory players = new address[](4);

        for (uint256 i; i < 4; ++i) {
            players[i] = _player(id, i);

            vm.prank(relayer);
            escrow.joinFor(id, players[i]);
        }

        vm.prank(owner);
        escrow.start(id);

        vm.warp(block.timestamp + DURATION + 1);

        // pot 20_000004: the royale budget stays floor(pot * 9500 / 10000) = 19_000003, as before.
        (address[] memory winners, uint256[] memory amounts) = _twoWinners(players, 19_000002, 2);

        vm.expectRevert(abi.encodeWithSelector(IRoyaleEscrow.AmountsOverBudget.selector, 19_000004, 19_000003));
        vm.prank(forwarder);
        escrow.onReport("", abi.encode(CHAIN_SELECTOR, id, bytes32(0), winners, amounts));

        amounts[1] = 1;
        bytes32 bookHash = keccak256("royale");

        vm.recordLogs();

        vm.prank(forwarder);
        escrow.onReport("", abi.encode(CHAIN_SELECTOR, id, bookHash, winners, amounts));

        // Winners then treasury, nothing else.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 transfers;

        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(usdc) && logs[i].topics[0] == TRANSFER_TOPIC) ++transfers;
        }

        assertEq(transfers, 3);
        assertEq(usdc.balanceOf(winners[0]), 19_000002);
        assertEq(usdc.balanceOf(winners[1]), 1);
        assertEq(usdc.balanceOf(treasury), 20_000004 - 19_000003);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.getLobby(id).bookHash, bookHash);
    }

    /* ============ cancel ============ */

    function test_CancelRoundRefundsAll() public {
        vm.prank(owner);
        uint256 id = escrow.createRound(DURATION, ENTRY, 10, creator, 500);

        usdc.mint(alice, ENTRY);

        vm.prank(alice);
        usdc.approve(address(escrow), ENTRY);

        vm.prank(alice);
        escrow.join(id);

        uint256 relayerBefore = usdc.balanceOf(relayer);

        for (uint256 i; i < 4; ++i) {
            vm.prank(relayer);
            escrow.joinFor(id, _player(id, i));
        }

        vm.prank(owner);
        escrow.start(id);

        vm.expectEmit();
        emit IRoyaleEscrow.Cancelled(id);

        vm.prank(owner);
        escrow.cancel(id);

        assertEq(usdc.balanceOf(alice), ENTRY);
        assertEq(usdc.balanceOf(relayer), relayerBefore);
        assertEq(usdc.balanceOf(creator), 0);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.getLobby(id).status), uint8(IRoyaleEscrow.Status.Cancelled));
        assertEq(escrow.getLobby(id).pot, 0);
    }

    /* ============ Helpers ============ */

    function _liveRound(
        uint256 count,
        address roundCreator,
        uint16 creatorFeeBps
    ) internal returns (uint256 id, address[] memory players) {
        vm.prank(owner);
        id = escrow.createRound(DURATION, ENTRY, 10, roundCreator, creatorFeeBps);

        players = new address[](count);

        for (uint256 i; i < count; ++i) {
            players[i] = _player(id, i);

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

    function _player(uint256 id, uint256 i) internal returns (address) {
        return makeAddr(string.concat("round", vm.toString(id), "-player", vm.toString(i)));
    }
}
