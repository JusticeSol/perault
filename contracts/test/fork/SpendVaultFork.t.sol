// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SpendVault} from "../../src/SpendVault.sol";
import {Signing} from "../Signing.sol";

interface ITUSD8f is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Full Perault flow against the REAL tUSD8 on a local fork of Aevum testnet.
///         Run with: make test-fork
contract SpendVaultForkTest is Test {
    ITUSD8f constant TUSD8 = ITUSD8f(0x456569838f1d43009A91ebA4263147Afd7233483);

    SpendVault vault;
    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address merchant = makeAddr("store");
    address relayer = makeAddr("relayer");

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        vault = new SpendVault(TUSD8);
        deal(address(TUSD8), owner, 100e6);
    }

    function _signedIntent(bytes32 sid, uint256 amount, bytes32 orderId, bytes32 nonce)
        internal
        view
        returns (SpendVault.PaymentIntent memory i, bytes memory sig)
    {
        i = SpendVault.PaymentIntent({
            sessionId: sid,
            merchant: merchant,
            amount: amount,
            orderId: orderId,
            nonce: nonce,
            deadline: uint64(block.timestamp + 5 minutes)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, vault.hashIntent(i));
        sig = abi.encodePacked(r, s, v);
    }

    function _gaslessDeposit(uint256 amount) internal {
        Signing.Auth memory a = Signing.Auth({
            from: owner,
            to: address(vault),
            value: amount,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: keccak256("fork-deposit")
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, ownerKey, TUSD8.DOMAIN_SEPARATOR(), a);
        vm.prank(relayer);
        vault.depositWithAuthorization(owner, amount, 0, a.validBefore, a.nonce, v, r, s);
    }

    function test_realTusd8_gaslessDeposit_agentPays_capsHold() public {
        assertEq(block.chainid, 44005, "run with --fork-url aevum");

        // 1. Owner funds the vault gaslessly with an EIP-3009 signature.
        _gaslessDeposit(60e6);
        assertEq(vault.balanceOf(owner), 60e6);

        // 2. Owner opens a $50 total / $40-per-payment session for the store only, 24h.
        address[] memory shops = new address[](1);
        shops[0] = merchant;
        vm.prank(owner);
        bytes32 sid = vault.openSession(agent, 40e6, 50e6, 50e6, uint40(block.timestamp + 1 days), shops);

        // 3. Agent buys a $35 hoodie; the merchant's facilitator submits.
        (SpendVault.PaymentIntent memory i, bytes memory sig) =
            _signedIntent(sid, 35e6, "hoodie-black-M", keccak256("n1"));
        vm.prank(merchant);
        vault.pay(i, sig);
        assertEq(TUSD8.balanceOf(merchant), 35e6);

        // 4. Agent tries a $40 jacket: within per-tx, but over the $50 budget.
        (i, sig) = _signedIntent(sid, 40e6, "jacket", keccak256("n2"));
        vm.prank(merchant);
        vm.expectRevert(SpendVault.OverDaily.selector);
        vault.pay(i, sig);

        // 5. Owner withdraws the rest.
        vm.prank(owner);
        vault.withdraw(25e6);
        assertEq(TUSD8.balanceOf(owner), 65e6);
        assertEq(TUSD8.balanceOf(address(vault)), 0);
    }
}
