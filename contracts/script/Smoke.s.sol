// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SpendVault} from "../src/SpendVault.sol";

/// @notice End-to-end smoke test of a deployed SpendVault on Aevum testnet.
///
///   The broadcaster (owner) funds the vault and opens a session for a demo agent key;
///   the agent signs a 3.50 tUSD8 "hoodie" payment; the owner submits it (acting as relayer).
///   Then it dry-runs the attacks with `preview` (no gas), revokes the session and withdraws
///   what's left, so the owner ends with the tUSD8 it started with.
///
///   MERCHANT defaults to the owner, so the payment comes straight back to you. Set MERCHANT
///   to the store's address once it has one.
///
///   Needs AGENT_PRIVATE_KEY in contracts/.env (a throwaway key; it never holds funds).
///   forge script script/Smoke.s.sol --rpc-url https://rpc-test.qday.info --broadcast --legacy --account aevum-deployer
contract Smoke is Script {
    SpendVault constant VAULT = SpendVault(0x103Cd22F2E6d66FD9C06dDD468Fa13DFCaD8Fe81);

    uint256 agentKey;
    bytes32 sid;
    address merchant;

    function run() external {
        agentKey = vm.envUint("AGENT_PRIVATE_KEY");
        address agent = vm.addr(agentKey);
        IERC20 token = VAULT.token();

        vm.startBroadcast();
        (, address owner,) = vm.readCallers();
        merchant = vm.envOr("MERCHANT", owner);
        uint256 amount = token.balanceOf(owner) < 5e6 ? token.balanceOf(owner) : 5e6;
        require(amount >= 4e6, "need at least 4 tUSD8 in the wallet");

        // 1. Fund the vault.
        token.approve(address(VAULT), amount);
        VAULT.deposit(amount);

        // 2. Session: 4.00 per payment, 5.00 per day and in total, this merchant only, 24h.
        address[] memory shops = new address[](1);
        shops[0] = merchant;
        sid = VAULT.openSession(agent, 4e6, 5e6, 5e6, uint40(block.timestamp + 1 days), shops);

        // 3. The agent buys a 3.50 hoodie.
        (SpendVault.PaymentIntent memory hoodie, bytes memory hoodieSig) =
            _signed(merchant, 3_500_000, "hoodie-black-M", "n-hoodie");
        VAULT.pay(hoodie, hoodieSig);
        vm.stopBroadcast();

        console.log("owner     ", owner);
        console.log("agent     ", agent);
        console.log("merchant  ", merchant);
        console.log("sessionId ");
        console.logBytes32(sid);
        console.log("hoodie paid; spendable now (6dp):", VAULT.budgetOf(sid).spendableNow);

        // 4. Attacks, dry-run on-chain state with preview (free).
        (SpendVault.PaymentIntent memory i, bytes memory sig) = _signed(merchant, 6e6, "jacket", "n-jacket");
        _report("6.00 jacket            ", VAULT.preview(i, sig));
        (i, sig) = _signed(address(0xBAD), 1e6, "injected", "n-inject");
        _report("pay 0xBAD (injection)  ", VAULT.preview(i, sig));
        _report("replay hoodie          ", VAULT.preview(hoodie, hoodieSig));
        (i, sig) = _signed(merchant, 3_500_000, "hoodie-black-M", "n-retry");
        _report("same order, new nonce  ", VAULT.preview(i, sig));
        (i, sig) = _signed(merchant, 1_500_001, "socks", "n-socks");
        _report("1.500001 socks         ", VAULT.preview(i, sig));

        // 5. Kill switch, then take the rest back.
        vm.startBroadcast();
        VAULT.revoke(sid);
        uint256 left = VAULT.balanceOf(owner);
        if (left > 0) VAULT.withdraw(left);
        vm.stopBroadcast();

        (i, sig) = _signed(merchant, 1e6, "after-revoke", "n-after");
        _report("1.00 after revoke      ", VAULT.preview(i, sig));
    }

    function _signed(address to, uint256 amount, string memory orderTag, string memory nonceTag)
        internal
        view
        returns (SpendVault.PaymentIntent memory i, bytes memory sig)
    {
        i = SpendVault.PaymentIntent({
            sessionId: sid,
            merchant: to,
            amount: amount,
            orderId: keccak256(abi.encode(orderTag, sid)), // unique per run
            nonce: keccak256(abi.encode(nonceTag, sid)),
            deadline: uint64(block.timestamp + 10 minutes)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, VAULT.hashIntent(i));
        sig = abi.encodePacked(r, s, v);
    }

    function _report(string memory label, bytes4 err) internal pure {
        console.log(string.concat("  ", label, " -> ", _name(err)));
    }

    function _name(bytes4 e) internal pure returns (string memory) {
        if (e == bytes4(0)) return "OK (would pay)";
        if (e == SpendVault.OverPerTx.selector) return "REJECTED OverPerTx";
        if (e == SpendVault.OverDaily.selector) return "REJECTED OverDaily";
        if (e == SpendVault.OverTotal.selector) return "REJECTED OverTotal";
        if (e == SpendVault.MerchantNotAllowed.selector) return "REJECTED MerchantNotAllowed";
        if (e == SpendVault.NonceUsed.selector) return "REJECTED NonceUsed";
        if (e == SpendVault.OrderAlreadyPaid.selector) return "REJECTED OrderAlreadyPaid";
        if (e == SpendVault.Revoked.selector) return "REJECTED Revoked";
        if (e == SpendVault.InsufficientBalance.selector) return "REJECTED InsufficientBalance";
        if (e == SpendVault.BadSignature.selector) return "REJECTED BadSignature";
        return "REJECTED (other)";
    }
}
