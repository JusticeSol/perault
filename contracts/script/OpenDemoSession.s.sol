// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SpendVault} from "../src/SpendVault.sol";

/// @notice Owner funds the vault and opens the demo agent's session, with the store as the only
///         allowed merchant. The session id is printed and saved in the broadcast log.
///
///   STORE (required)      the store's receiving address
///   DEPOSIT (optional)    tUSD8 base units to deposit; default: up to 5 tUSD8 from the wallet
///   Needs AGENT_PRIVATE_KEY in contracts/.env (only its address is used here).
///
///   forge script script/OpenDemoSession.s.sol --rpc-url https://rpc-test.qday.info --broadcast --legacy --account aevum-deployer --sender <owner>
contract OpenDemoSession is Script {
    SpendVault constant VAULT = SpendVault(0xc615c8682b1A665C6d3d7aB2128ef83210B414Dc);

    function run() external returns (bytes32 sessionId) {
        address store = vm.envAddress("STORE");
        address agent = vm.addr(vm.envUint("AGENT_PRIVATE_KEY"));
        IERC20 token = VAULT.token();

        vm.startBroadcast();
        (, address owner,) = vm.readCallers();
        // Foundry's placeholder sender: means forge couldn't tell which wallet to use.
        require(owner != 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38, "No sender: add --sender <your address> to the command.");
        uint256 wallet = token.balanceOf(owner);
        uint256 amount = vm.envOr("DEPOSIT", wallet < 5e6 ? wallet : 5e6);
        if (amount > 0) {
            token.approve(address(VAULT), amount);
            VAULT.deposit(amount);
        }
        address[] memory shops = new address[](1);
        shops[0] = store;
        // Demo budget: 4.00 per payment, 5.00 per day and in total, store only, 7 days.
        sessionId = VAULT.openSession(agent, 4e6, 5e6, 5e6, uint40(block.timestamp + 7 days), shops);
        vm.stopBroadcast();

        console.log("owner        ", owner);
        console.log("agent        ", agent);
        console.log("store        ", store);
        console.log("vault balance", VAULT.balanceOf(owner));
        console.log("sessionId:");
        console.logBytes32(sessionId);
    }
}
