// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";

import { IDuelEscrow } from "../src/interfaces/IDuelEscrow.sol";

import { DuelEscrow } from "../src/DuelEscrow.sol";
import { MockUSDC } from "../src/MockUSDC.sol";

/// @dev Records the duel's status on every outbound transfer from the escrow, and tries to settle again from inside
///      the transfer, as a malicious token would.
contract MockReentrantToken is MockUSDC {
    DuelEscrow public escrow;

    uint256 public duelId;

    bytes public replayReport;

    uint8[] public statusesSeen;

    bool public reentrySucceeded;

    function arm(DuelEscrow escrow_, uint256 duelId_, bytes calldata report) external {
        escrow = escrow_;
        duelId = duelId_;
        replayReport = report;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (address(escrow) != address(0) && msg.sender == address(escrow)) {
            statusesSeen.push(uint8(escrow.getDuel(duelId).status));

            // The token is not the owner, so this must fail; and the status is already Settled regardless.
            (bool ok, ) = address(escrow).call(abi.encodeCall(DuelEscrow.settleFallback, (replayReport)));
            if (ok) reentrySucceeded = true;
        }

        return super.transfer(to, amount);
    }

    function statusesSeenCount() external view returns (uint256) {
        return statusesSeen.length;
    }
}

contract DuelEscrowTest is Test {
    uint64 internal constant CHAIN_SELECTOR = 10344971235874465080;

    uint96 internal constant STAKE = 5_000000;

    MockUSDC internal usdc;

    DuelEscrow internal escrow;

    address internal owner = makeAddr("owner");

    address internal forwarder = makeAddr("forwarder");

    address internal treasury = makeAddr("treasury");

    address internal relayer = makeAddr("relayer");

    address internal alice = makeAddr("alice");

    address internal bob = makeAddr("bob");

    address internal carol = makeAddr("carol");

    function setUp() public {
        usdc = new MockUSDC();

        vm.prank(owner);
        escrow = new DuelEscrow(forwarder, address(usdc), CHAIN_SELECTOR, treasury, relayer);

        usdc.mint(relayer, 1_000 * uint256(STAKE));

        vm.prank(relayer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    /* ============ createDuel ============ */

    function test_CreateDuel() public {
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        vm.prank(alice);
        escrow.createDuel(STAKE);

        vm.expectRevert(IDuelEscrow.ZeroStake.selector);
        vm.prank(owner);
        escrow.createDuel(0);

        vm.expectEmit();
        emit IDuelEscrow.DuelCreated(1, STAKE);

        vm.prank(owner);
        uint256 id = escrow.createDuel(STAKE);

        assertEq(id, 1);
        assertEq(escrow.duelCount(), 1);

        IDuelEscrow.Duel memory duel = escrow.getDuel(id);

        assertEq(uint8(duel.status), uint8(IDuelEscrow.Status.Open));
        assertEq(duel.stake, STAKE);
        assertEq(duel.playerA, address(0));
        assertEq(duel.playerB, address(0));
        assertEq(duel.pot, 0);

        vm.prank(owner);
        assertEq(escrow.createDuel(STAKE), 2);
    }

    /* ============ joinFor ============ */

    function test_JoinBoth() public {
        uint256 id = _createDuel();
        uint256 relayerBefore = usdc.balanceOf(relayer);

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.NotRelayer.selector, alice));
        vm.prank(alice);
        escrow.joinFor(id, alice);

        vm.expectEmit();
        emit IDuelEscrow.Joined(id, alice, relayer);

        vm.prank(relayer);
        escrow.joinFor(id, alice);

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.AlreadyJoined.selector, id, alice));
        vm.prank(relayer);
        escrow.joinFor(id, alice);

        vm.expectEmit();
        emit IDuelEscrow.Joined(id, bob, relayer);

        vm.prank(relayer);
        escrow.joinFor(id, bob);

        IDuelEscrow.Duel memory duel = escrow.getDuel(id);

        assertEq(duel.playerA, alice);
        assertEq(duel.playerB, bob);
        assertEq(duel.pot, 2 * uint256(STAKE));
        assertEq(usdc.balanceOf(address(escrow)), 2 * uint256(STAKE));
        assertEq(usdc.balanceOf(relayer), relayerBefore - 2 * uint256(STAKE));
    }

    function test_RevertWhen_ThirdJoin() public {
        uint256 id = _createDuel();

        vm.prank(relayer);
        escrow.joinFor(id, alice);

        vm.prank(relayer);
        escrow.joinFor(id, bob);

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.DuelFull.selector, id));
        vm.prank(relayer);
        escrow.joinFor(id, carol);
    }

    /* ============ start ============ */

    function test_RevertWhen_StartWithOnePlayer() public {
        uint256 id = _createDuel();

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.NotEnoughPlayers.selector, id));
        vm.prank(owner);
        escrow.start(id);

        vm.prank(relayer);
        escrow.joinFor(id, alice);

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.NotEnoughPlayers.selector, id));
        vm.prank(owner);
        escrow.start(id);

        vm.prank(relayer);
        escrow.joinFor(id, bob);

        vm.expectEmit();
        emit IDuelEscrow.Started(id);

        vm.prank(owner);
        escrow.start(id);

        assertEq(uint8(escrow.getDuel(id).status), uint8(IDuelEscrow.Status.Live));

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.DuelNotOpen.selector, id));
        vm.prank(relayer);
        escrow.joinFor(id, carol);
    }

    /* ============ cancel ============ */

    function test_CancelRefundsBoth() public {
        uint256 id = _liveDuel();
        uint256 relayerBefore = usdc.balanceOf(relayer);

        vm.expectEmit();
        emit IDuelEscrow.Cancelled(id);

        vm.prank(owner);
        escrow.cancel(id);

        assertEq(usdc.balanceOf(relayer), relayerBefore + 2 * uint256(STAKE));
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.getDuel(id).status), uint8(IDuelEscrow.Status.Cancelled));
        assertEq(escrow.getDuel(id).pot, 0);

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.DuelNotCancellable.selector, id));
        vm.prank(owner);
        escrow.cancel(id);

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.DuelNotLive.selector, id));
        vm.prank(owner);
        escrow.settleFallback(_report(id, bytes32(0), alice));
    }

    /* ============ settle ============ */

    function test_WinPaysPotMinusFee() public {
        uint256 id = _liveDuel();
        bytes32 bookHash = keccak256("book");

        // pot 10_000000: fee floor(10_000000 * 500 / 10000) = 500000.
        vm.expectEmit();
        emit IDuelEscrow.Settled(id, bookHash, bob);

        vm.prank(forwarder);
        escrow.onReport("", _report(id, bookHash, bob));

        assertEq(usdc.balanceOf(bob), 9_500000);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(treasury), 500000);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        IDuelEscrow.Duel memory duel = escrow.getDuel(id);

        assertEq(uint8(duel.status), uint8(IDuelEscrow.Status.Settled));
        assertEq(duel.bookHash, bookHash);
        assertEq(duel.winner, bob);
        assertEq(duel.pot, 0);
    }

    function test_DrawRefundsStakes() public {
        uint256 id = _liveDuel();
        bytes32 bookHash = keccak256("draw");

        vm.expectEmit();
        emit IDuelEscrow.Settled(id, bookHash, address(0));

        vm.prank(owner);
        escrow.settleFallback(_report(id, bookHash, address(0)));

        assertEq(usdc.balanceOf(alice), STAKE);
        assertEq(usdc.balanceOf(bob), STAKE);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.getDuel(id).status), uint8(IDuelEscrow.Status.Settled));
        assertEq(escrow.getDuel(id).winner, address(0));
    }

    function test_RevertWhen_WinnerNotPlayer() public {
        uint256 id = _liveDuel();

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.NotPlayer.selector, id, carol));
        vm.prank(forwarder);
        escrow.onReport("", _report(id, bytes32(0), carol));

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.NotPlayer.selector, id, relayer));
        vm.prank(owner);
        escrow.settleFallback(_report(id, bytes32(0), relayer));
    }

    function test_RevertWhen_WrongChainSelector() public {
        uint256 id = _liveDuel();
        uint64 wrong = CHAIN_SELECTOR + 1;

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.WrongChainSelector.selector, CHAIN_SELECTOR, wrong));
        vm.prank(forwarder);
        escrow.onReport("", abi.encode(wrong, id, bytes32(0), alice));
    }

    function test_RevertWhen_SettleTwice() public {
        uint256 id = _liveDuel();

        vm.prank(forwarder);
        escrow.onReport("", _report(id, bytes32(0), alice));

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.DuelNotLive.selector, id));
        vm.prank(forwarder);
        escrow.onReport("", _report(id, bytes32(0), alice));

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.DuelNotLive.selector, id));
        vm.prank(owner);
        escrow.settleFallback(_report(id, bytes32(0), address(0)));
    }

    function test_RevertWhen_SettleNotStarted() public {
        uint256 id = _createDuel();

        vm.prank(relayer);
        escrow.joinFor(id, alice);

        vm.prank(relayer);
        escrow.joinFor(id, bob);

        vm.expectRevert(abi.encodeWithSelector(IDuelEscrow.DuelNotLive.selector, id));
        vm.prank(forwarder);
        escrow.onReport("", _report(id, bytes32(0), alice));
    }

    function test_OnReportOnlyForwarder() public {
        uint256 id = _liveDuel();

        vm.expectRevert();
        vm.prank(alice);
        escrow.onReport("", _report(id, bytes32(0), alice));

        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        vm.prank(alice);
        escrow.settleFallback(_report(id, bytes32(0), alice));
    }

    function test_SettledBeforeTransfers() public {
        MockReentrantToken token = new MockReentrantToken();

        vm.prank(owner);
        DuelEscrow reentrant = new DuelEscrow(forwarder, address(token), CHAIN_SELECTOR, treasury, relayer);

        token.mint(relayer, 10 * uint256(STAKE));

        vm.startPrank(relayer);

        token.approve(address(reentrant), type(uint256).max);

        vm.stopPrank();

        vm.prank(owner);
        uint256 id = reentrant.createDuel(STAKE);

        vm.startPrank(relayer);

        reentrant.joinFor(id, alice);
        reentrant.joinFor(id, bob);

        vm.stopPrank();

        vm.prank(owner);
        reentrant.start(id);

        bytes memory report = _report(id, keccak256("book"), alice);
        token.arm(reentrant, id, report);

        vm.prank(forwarder);
        reentrant.onReport("", report);

        // Winner and treasury transfers each saw status Settled, and the nested settle failed.
        assertEq(token.statusesSeenCount(), 2);
        assertEq(token.statusesSeen(0), uint8(IDuelEscrow.Status.Settled));
        assertEq(token.statusesSeen(1), uint8(IDuelEscrow.Status.Settled));
        assertFalse(token.reentrySucceeded());
        assertEq(token.balanceOf(alice), 9_500000);
        assertEq(token.balanceOf(treasury), 500000);
        assertEq(token.balanceOf(address(reentrant)), 0);
    }

    /* ============ helpers ============ */

    function _createDuel() internal returns (uint256 id) {
        vm.prank(owner);
        id = escrow.createDuel(STAKE);
    }

    function _liveDuel() internal returns (uint256 id) {
        id = _createDuel();

        vm.prank(relayer);
        escrow.joinFor(id, alice);

        vm.prank(relayer);
        escrow.joinFor(id, bob);

        vm.prank(owner);
        escrow.start(id);
    }

    function _report(uint256 id, bytes32 bookHash, address winner) internal pure returns (bytes memory) {
        return abi.encode(CHAIN_SELECTOR, id, bookHash, winner);
    }
}
