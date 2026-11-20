// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SpendVault} from "../src/SpendVault.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

/// @dev Minimal ERC-1271 smart account: valid if `signer` signed the digest.
contract MockSmartAgent is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (address rec, ECDSA.RecoverError e,) = ECDSA.tryRecover(hash, sig);
        return e == ECDSA.RecoverError.NoError && rec == signer ? IERC1271.isValidSignature.selector : bytes4(0);
    }
}

contract SpendVaultTest is Test {
    MockUSD8 token;
    SpendVault vault;

    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address merchant = makeAddr("merchant"); // the clothing store
    address attacker = makeAddr("attacker");
    address relayer = makeAddr("relayer");

    uint128 constant PER_TX = 40e6;
    uint128 constant DAILY = 50e6;
    uint128 constant TOTAL = 100e6;
    uint256 constant DEPOSIT = 200e6;

    bytes32 sid;
    uint256 nonceCounter;

    function setUp() public {
        vm.warp(1_763_337_600); // 2025-11-17 00:00 UTC, a clean day boundary
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        token = new MockUSD8();
        vault = new SpendVault(IERC20(address(token)));
        token.mint(owner, 1_000e6);

        vm.startPrank(owner);
        token.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT);
        sid = vault.openSession(agent, PER_TX, DAILY, TOTAL, uint40(block.timestamp + 1 days), _list(merchant));
        vm.stopPrank();
    }

    // ================================================================ helpers

    function _list(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function _intent(uint256 amount, bytes32 orderId) internal returns (SpendVault.PaymentIntent memory) {
        return SpendVault.PaymentIntent({
            sessionId: sid,
            merchant: merchant,
            amount: amount,
            orderId: orderId,
            nonce: keccak256(abi.encode("nonce", nonceCounter++)),
            deadline: uint64(block.timestamp + 5 minutes)
        });
    }

    function _sign(SpendVault.PaymentIntent memory i, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, vault.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /// Asserts `preview` and `pay` agree on the failure.
    function _expectFail(SpendVault.PaymentIntent memory i, bytes memory sig, bytes4 err) internal {
        assertEq(vault.preview(i, sig), err, "preview");
        vm.prank(relayer);
        vm.expectRevert(err);
        vault.pay(i, sig);
    }

    function _pay(uint256 amount, bytes32 orderId) internal returns (SpendVault.PaymentIntent memory i) {
        i = _intent(amount, orderId);
        bytes memory sig = _sign(i, agentKey);
        assertEq(vault.preview(i, sig), bytes4(0), "preview ok");
        vm.prank(relayer);
        vault.pay(i, sig);
    }

    // ================================================================ deposit / withdraw

    function test_deposit_credits() public view {
        assertEq(vault.balanceOf(owner), DEPOSIT);
        assertEq(token.balanceOf(address(vault)), DEPOSIT);
    }

    function test_deposit_zeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(SpendVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_depositWithAuthorization_gasless() public {
        (address alice, uint256 aliceKey) = makeAddrAndKey("alice");
        token.mint(alice, 30e6);
        Signing.Auth memory a = Signing.Auth({
            from: alice,
            to: address(vault),
            value: 30e6,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: keccak256("dep-1")
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, aliceKey, token.DOMAIN_SEPARATOR(), a);

        vm.expectEmit(true, true, false, true, address(vault));
        emit SpendVault.Deposited(alice, relayer, 30e6);
        vm.prank(relayer); // relayer pays gas, alice is credited
        vault.depositWithAuthorization(alice, 30e6, 0, a.validBefore, a.nonce, v, r, s);

        assertEq(vault.balanceOf(alice), 30e6);
        assertEq(vault.balanceOf(relayer), 0);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_withdraw() public {
        vm.prank(owner);
        vault.withdraw(50e6);
        assertEq(vault.balanceOf(owner), DEPOSIT - 50e6);
        assertEq(token.balanceOf(owner), 1_000e6 - DEPOSIT + 50e6);
    }

    function test_withdraw_overBalanceReverts() public {
        vm.prank(owner);
        vm.expectRevert(SpendVault.InsufficientBalance.selector);
        vault.withdraw(DEPOSIT + 1);
    }

    function test_agentCannotWithdrawOwnerFunds() public {
        vm.prank(agent);
        vm.expectRevert(SpendVault.InsufficientBalance.selector);
        vault.withdraw(1);
    }

    // ================================================================ openSession

    function test_openSession_storesEverything() public view {
        SpendVault.Session memory s = vault.getSession(sid);
        assertEq(s.owner, owner);
        assertEq(s.agent, agent);
        assertEq(s.perTxCap, PER_TX);
        assertEq(s.dailyCap, DAILY);
        assertEq(s.totalCap, TOTAL);
        assertEq(s.expiry, block.timestamp + 1 days);
        assertFalse(s.revoked);
        assertTrue(vault.isActive(sid));
        assertTrue(vault.isMerchantAllowed(sid, merchant));
        assertFalse(vault.isMerchantAllowed(sid, attacker));
    }

    function test_openSession_uniqueIds() public {
        vm.prank(owner);
        bytes32 sid2 = vault.openSession(agent, 1, 1, 1, uint40(block.timestamp + 1), new address[](0));
        assertTrue(sid2 != sid);
        assertEq(vault.sessionCount(owner), 2);
    }

    function test_openSession_validation() public {
        uint40 exp = uint40(block.timestamp + 1 hours);
        address[] memory none = new address[](0);
        vm.startPrank(owner);

        vm.expectRevert(SpendVault.ZeroAddress.selector);
        vault.openSession(address(0), 1, 1, 1, exp, none);

        vm.expectRevert(SpendVault.InvalidCaps.selector);
        vault.openSession(agent, 0, 1, 1, exp, none); // zero per-tx

        vm.expectRevert(SpendVault.InvalidCaps.selector);
        vault.openSession(agent, 2, 1, 2, exp, none); // per-tx > daily

        vm.expectRevert(SpendVault.InvalidCaps.selector);
        vault.openSession(agent, 1, 3, 2, exp, none); // daily > total

        vm.expectRevert(SpendVault.InvalidExpiry.selector);
        vault.openSession(agent, 1, 1, 1, uint40(block.timestamp), none); // already expired

        vm.expectRevert(SpendVault.InvalidExpiry.selector);
        vault.openSession(agent, 1, 1, 1, uint40(block.timestamp + 91 days), none); // too long

        vm.expectRevert(SpendVault.ZeroAddress.selector);
        vault.openSession(agent, 1, 1, 1, exp, _list(address(0))); // zero merchant
        vm.stopPrank();
    }

    // ================================================================ pay: happy path

    function test_pay_settlesAndRecords() public {
        SpendVault.PaymentIntent memory i = _intent(35e6, "hoodie-black-M");
        bytes memory sig = _sign(i, agentKey);

        vm.expectEmit(true, true, true, true, address(vault));
        emit SpendVault.Paid(sid, merchant, "hoodie-black-M", owner, agent, 35e6, i.nonce);
        vm.prank(relayer);
        vault.pay(i, sig);

        assertEq(token.balanceOf(merchant), 35e6);
        assertEq(vault.balanceOf(owner), DEPOSIT - 35e6);
        assertEq(token.balanceOf(address(vault)), DEPOSIT - 35e6);
        assertTrue(vault.nonceUsed(sid, i.nonce));

        SpendVault.Receipt memory rc = vault.receiptOf(merchant, "hoodie-black-M");
        assertEq(rc.sessionId, sid);
        assertEq(rc.amount, 35e6);
        assertEq(rc.paidAt, block.timestamp);

        SpendVault.Session memory s = vault.getSession(sid);
        assertEq(s.spentToday, 35e6);
        assertEq(s.spentTotal, 35e6);
    }

    function test_pay_exactlyAtPerTxCap() public {
        _pay(PER_TX, "o1");
        assertEq(token.balanceOf(merchant), PER_TX);
    }

    function test_pay_anyoneCanSubmit() public {
        SpendVault.PaymentIntent memory i = _intent(1e6, "o1");
        bytes memory sig = _sign(i, agentKey);
        vm.prank(attacker); // a stranger submitting just delivers the merchant's money faster
        vault.pay(i, sig);
        assertEq(token.balanceOf(merchant), 1e6);
        assertEq(token.balanceOf(attacker), 0);
    }

    function test_pay_erc1271SmartAgent() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("smart-agent-signer");
        MockSmartAgent smart = new MockSmartAgent(signer);
        vm.prank(owner);
        sid = vault.openSession(address(smart), PER_TX, DAILY, TOTAL, uint40(block.timestamp + 1 hours), _list(merchant));

        SpendVault.PaymentIntent memory i = _intent(5e6, "o1");
        vm.prank(relayer);
        vault.pay(i, _sign(i, signerKey));
        assertEq(token.balanceOf(merchant), 5e6);
    }

    // ================================================================ pay: every failure

    function test_fail_unknownSession() public {
        SpendVault.PaymentIntent memory i = _intent(1e6, "o1");
        i.sessionId = keccak256("nope");
        _expectFail(i, _sign(i, agentKey), SpendVault.UnknownSession.selector);
    }

    function test_fail_badSignature_wrongKey() public {
        SpendVault.PaymentIntent memory i = _intent(1e6, "o1");
        _expectFail(i, _sign(i, ownerKey), SpendVault.BadSignature.selector); // even the owner can't sign as agent
    }

    function test_fail_badSignature_tamperedAmount() public {
        SpendVault.PaymentIntent memory i = _intent(1e6, "o1");
        bytes memory sig = _sign(i, agentKey);
        i.amount = 30e6; // relayer bumps the amount
        _expectFail(i, sig, SpendVault.BadSignature.selector);
    }

    function test_fail_badSignature_tamperedMerchant() public {
        SpendVault.PaymentIntent memory i = _intent(1e6, "o1");
        bytes memory sig = _sign(i, agentKey);
        i.merchant = attacker;
        _expectFail(i, sig, SpendVault.BadSignature.selector);
    }

    function test_fail_badSignature_garbage() public {
        SpendVault.PaymentIntent memory i = _intent(1e6, "o1");
        _expectFail(i, hex"deadbeef", SpendVault.BadSignature.selector);
    }

    function test_fail_revoked() public {
        _pay(1e6, "o1");
        vm.expectEmit(true, true, false, false, address(vault));
        emit SpendVault.SessionRevoked(sid, owner);
        vm.prank(owner);
        vault.revoke(sid);
        assertFalse(vault.isActive(sid));

        SpendVault.PaymentIntent memory i = _intent(1e6, "o2");
        _expectFail(i, _sign(i, agentKey), SpendVault.Revoked.selector);
    }

    function test_fail_revokeAll_killsEverySession() public {
        vm.prank(owner);
        bytes32 sid2 = vault.openSession(agent, PER_TX, DAILY, TOTAL, uint40(block.timestamp + 1 hours), _list(merchant));

        vm.prank(owner);
        vault.revokeAll();
        assertFalse(vault.isActive(sid));
        assertFalse(vault.isActive(sid2));

        SpendVault.PaymentIntent memory i = _intent(1e6, "o1");
        _expectFail(i, _sign(i, agentKey), SpendVault.Revoked.selector);
        i.sessionId = sid2;
        _expectFail(i, _sign(i, agentKey), SpendVault.Revoked.selector);

        // New sessions after the kill switch work again.
        vm.prank(owner);
        sid = vault.openSession(agent, PER_TX, DAILY, TOTAL, uint40(block.timestamp + 1 hours), _list(merchant));
        _pay(1e6, "o2");
    }

    function test_fail_sessionExpired() public {
        SpendVault.PaymentIntent memory i = _intent(1e6, "o1");
        i.deadline = uint64(block.timestamp + 2 days);
        bytes memory sig = _sign(i, agentKey);
        vm.warp(block.timestamp + 1 days); // expiry is exclusive
        _expectFail(i, sig, SpendVault.SessionExpired.selector);
    }

    function test_fail_intentExpired() public {
        SpendVault.PaymentIntent memory i = _intent(1e6, "o1");
        bytes memory sig = _sign(i, agentKey);
        vm.warp(i.deadline); // deadline is inclusive: still fine
        assertEq(vault.preview(i, sig), bytes4(0));
        vm.warp(i.deadline + 1);
        _expectFail(i, sig, SpendVault.IntentExpired.selector);
    }

    function test_fail_zeroAmount() public {
        SpendVault.PaymentIntent memory i = _intent(0, "o1");
        _expectFail(i, _sign(i, agentKey), SpendVault.ZeroAmount.selector);
    }

    /// Prompt injection: "send $10 to 0xattacker". The agent signs it, the contract refuses.
    function test_fail_merchantNotAllowed() public {
        SpendVault.PaymentIntent memory i = _intent(10e6, "o1");
        i.merchant = attacker;
        _expectFail(i, _sign(i, agentKey), SpendVault.MerchantNotAllowed.selector);
        assertEq(token.balanceOf(attacker), 0);
    }

    function test_setMerchant_addAndRemove() public {
        address shop2 = makeAddr("shop2");
        vm.prank(owner);
        vault.setMerchant(sid, shop2, true);
        SpendVault.PaymentIntent memory i = _intent(1e6, "o1");
        i.merchant = shop2;
        vm.prank(relayer);
        vault.pay(i, _sign(i, agentKey));
        assertEq(token.balanceOf(shop2), 1e6);

        vm.prank(owner);
        vault.setMerchant(sid, shop2, false);
        i = _intent(1e6, "o2");
        i.merchant = shop2;
        _expectFail(i, _sign(i, agentKey), SpendVault.MerchantNotAllowed.selector);
    }

    /// Exact replay of a settled payment.
    function test_fail_replay() public {
        SpendVault.PaymentIntent memory i = _pay(5e6, "o1");
        _expectFail(i, _sign(i, agentKey), SpendVault.NonceUsed.selector);
        assertEq(token.balanceOf(merchant), 5e6, "charged once");
    }

    /// Same order, fresh nonce: an idempotent retry must not charge twice.
    function test_fail_orderAlreadyPaid() public {
        _pay(5e6, "o1");
        SpendVault.PaymentIntent memory i = _intent(5e6, "o1");
        _expectFail(i, _sign(i, agentKey), SpendVault.OrderAlreadyPaid.selector);
    }

    function test_sameOrderIdDifferentMerchants_ok() public {
        address shop2 = makeAddr("shop2");
        vm.prank(owner);
        vault.setMerchant(sid, shop2, true);
        _pay(1e6, "order-1");
        SpendVault.PaymentIntent memory i = _intent(1e6, "order-1");
        i.merchant = shop2;
        vm.prank(relayer);
        vault.pay(i, _sign(i, agentKey));
    }

    function test_fail_overPerTx() public {
        SpendVault.PaymentIntent memory i = _intent(PER_TX + 1, "jacket");
        _expectFail(i, _sign(i, agentKey), SpendVault.OverPerTx.selector);
    }

    function test_fail_overPerTx_hugeAmountNoOverflow() public {
        SpendVault.PaymentIntent memory i = _intent(type(uint256).max, "o1");
        _expectFail(i, _sign(i, agentKey), SpendVault.OverPerTx.selector);
    }

    function test_fail_overDaily_thenResetsNextUtcDay() public {
        // Long session so the daily reset is reachable.
        vm.prank(owner);
        sid = vault.openSession(agent, PER_TX, DAILY, TOTAL, uint40(block.timestamp + 7 days), _list(merchant));

        _pay(40e6, "o1");
        SpendVault.PaymentIntent memory i = _intent(11e6, "o2"); // 40 + 11 > 50
        _expectFail(i, _sign(i, agentKey), SpendVault.OverDaily.selector);
        _pay(10e6, "o3"); // exactly 50

        vm.warp(block.timestamp + 1 days); // next UTC day
        i = _intent(11e6, "o2");
        vm.prank(relayer);
        vault.pay(i, _sign(i, agentKey));
        assertEq(vault.getSession(sid).spentToday, 11e6);
        assertEq(vault.getSession(sid).spentTotal, 61e6);
    }

    function test_fail_overTotal_acrossDays() public {
        vm.prank(owner);
        sid = vault.openSession(agent, PER_TX, DAILY, TOTAL, uint40(block.timestamp + 7 days), _list(merchant));
        _pay(40e6, "d1");
        vm.warp(block.timestamp + 1 days);
        _pay(40e6, "d2");
        vm.warp(block.timestamp + 1 days);
        SpendVault.PaymentIntent memory i = _intent(21e6, "d3"); // 80 + 21 > 100
        _expectFail(i, _sign(i, agentKey), SpendVault.OverTotal.selector);
        _pay(20e6, "d3"); // exactly 100
    }

    function test_fail_insufficientBalance() public {
        vm.prank(owner);
        vault.withdraw(DEPOSIT - 5e6); // owner pulls money out from under the agent
        SpendVault.PaymentIntent memory i = _intent(6e6, "o1");
        _expectFail(i, _sign(i, agentKey), SpendVault.InsufficientBalance.selector);
        _pay(5e6, "o1");
    }

    // ================================================================ access control

    function test_onlyOwnerManagesSession() public {
        vm.startPrank(agent);
        vm.expectRevert(SpendVault.NotOwner.selector);
        vault.revoke(sid);
        vm.expectRevert(SpendVault.NotOwner.selector);
        vault.setMerchant(sid, attacker, true);
        vm.stopPrank();

        vm.prank(owner);
        vm.expectRevert(SpendVault.UnknownSession.selector);
        vault.revoke(keccak256("nope"));
    }

    function test_agentRevokeAll_doesNotAffectOwner() public {
        vm.prank(agent);
        vault.revokeAll(); // bumps the agent's own epoch only
        assertTrue(vault.isActive(sid));
    }

    // ================================================================ views

    function test_budgetOf() public {
        SpendVault.Budget memory b = vault.budgetOf(sid);
        assertTrue(b.active);
        assertEq(b.spendableNow, PER_TX);

        _pay(30e6, "o1");
        b = vault.budgetOf(sid);
        assertEq(b.dailyRemaining, 20e6);
        assertEq(b.totalRemaining, 70e6);
        assertEq(b.spendableNow, 20e6);
        assertEq(b.ownerBalance, DEPOSIT - 30e6);

        vm.prank(owner);
        vault.revoke(sid);
        b = vault.budgetOf(sid);
        assertFalse(b.active);
        assertEq(b.spendableNow, 0);
    }

    function test_budgetOf_dailyResetIsVisibleBeforeNextPay() public {
        vm.prank(owner);
        sid = vault.openSession(agent, PER_TX, DAILY, TOTAL, uint40(block.timestamp + 7 days), _list(merchant));
        _pay(40e6, "o1");
        assertEq(vault.budgetOf(sid).dailyRemaining, 10e6);
        vm.warp(block.timestamp + 1 days);
        assertEq(vault.budgetOf(sid).dailyRemaining, DAILY);
    }

    /// Pins the EIP-712 encoding so off-chain SDKs (viem signTypedData) stay in sync.
    function test_hashIntent_matchesManualEip712() public view {
        SpendVault.PaymentIntent memory i = SpendVault.PaymentIntent({
            sessionId: sid,
            merchant: merchant,
            amount: 35e6,
            orderId: "hoodie",
            nonce: bytes32(uint256(1)),
            deadline: 1_800_000_000
        });
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("CapVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PaymentIntent(bytes32 sessionId,address merchant,uint256 amount,bytes32 orderId,bytes32 nonce,uint64 deadline)"
                ),
                i.sessionId,
                i.merchant,
                i.amount,
                i.orderId,
                i.nonce,
                i.deadline
            )
        );
        assertEq(vault.DOMAIN_SEPARATOR(), domain);
        assertEq(vault.hashIntent(i), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    // ================================================================ fuzz

    function testFuzz_perTxBoundary(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);
        SpendVault.PaymentIntent memory i = _intent(amount, "o1");
        bytes memory sig = _sign(i, agentKey);
        bytes4 expected = amount > PER_TX ? SpendVault.OverPerTx.selector : bytes4(0);
        assertEq(vault.preview(i, sig), expected);
    }

    /// Random payments over random time: caps are never exceeded, money is conserved,
    /// and `preview` always predicts `pay` exactly.
    function testFuzz_capsHoldOverRandomSequences(uint64[12] calldata amounts, uint32[12] calldata gaps) public {
        vm.prank(owner);
        sid = vault.openSession(agent, PER_TX, DAILY, TOTAL, uint40(block.timestamp + 30 days), _list(merchant));

        uint256 paid;
        uint256 dayIndex = block.timestamp / 1 days;
        uint256 paidToday;
        for (uint256 k = 0; k < amounts.length; k++) {
            vm.warp(block.timestamp + bound(gaps[k], 0, 2 days));
            if (block.timestamp / 1 days != dayIndex) {
                dayIndex = block.timestamp / 1 days;
                paidToday = 0;
            }
            uint256 amount = bound(amounts[k], 1, 60e6);
            SpendVault.PaymentIntent memory i = _intent(amount, bytes32(k));
            bytes memory sig = _sign(i, agentKey);
            bytes4 predicted = vault.preview(i, sig);

            vm.prank(relayer);
            try vault.pay(i, sig) {
                assertEq(predicted, bytes4(0), "pay succeeded but preview said no");
                paid += amount;
                paidToday += amount;
            } catch (bytes memory reason) {
                assertEq(bytes4(reason), predicted, "pay error != preview");
                assertTrue(predicted != bytes4(0));
            }
            assertLe(paidToday, DAILY, "daily cap broken");
            assertLe(paid, TOTAL, "total cap broken");
        }
        assertEq(token.balanceOf(merchant), paid, "merchant got exactly what was paid");
        assertEq(vault.balanceOf(owner), DEPOSIT - paid, "owner debited exactly");
        assertEq(token.balanceOf(address(vault)), vault.balanceOf(owner), "vault solvent");
    }
}
