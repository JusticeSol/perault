import { defineChain, type Address } from "viem";

/**
 * QDay Aevum testnet. Kept here (rather than imported from the starter kit) so the SDK has no
 * dependency besides viem and can be published on its own.
 *
 * Aevum quirks: Shanghai EVM, eth_getLogs capped at 1,000 blocks per call, no WebSocket RPC
 * (poll over HTTPS), legacy (type 0) transactions recommended.
 */
export const aevumTestnet = defineChain({
  id: 44005,
  name: "QDay Aevum Testnet",
  nativeCurrency: { name: "Test QDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: "https://explorer-test.qday.info" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export interface PeraultDeployment {
  /** SpendVault contract. */
  vault: Address;
  /** Settlement token (tUSD8 on Aevum). */
  token: Address;
  /** Block the vault was deployed in; where event scans start. */
  deployBlock: bigint;
}

/** Official Perault deployments, by chain ID. Source of truth: deployments/aevum-testnet.json. */
export const PERAULT_DEPLOYMENTS: Record<number, PeraultDeployment> = {
  44005: {
    vault: "0xc615c8682b1A665C6d3d7aB2128ef83210B414Dc",
    token: "0x456569838f1d43009A91ebA4263147Afd7233483",
    deployBlock: 3660741n,
  },
};

/** tUSD8 has 6 decimals: 1 tUSD8 = 1_000_000n. */
export const TOKEN_DECIMALS = 6;

/** Largest block range one eth_getLogs call may cover on Aevum. */
export const MAX_LOG_RANGE = 1000n;

export function explorerTxUrl(hash: string): string {
  return `${aevumTestnet.blockExplorers.default.url}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${aevumTestnet.blockExplorers.default.url}/address/${address}`;
}
