import type { Address } from "viem";
import { PERAULT_DEPLOYMENTS } from "@perault/sdk";

export interface NetworkConfig {
  /** x402 network name used in requirements and payloads. */
  name: string;
  /** Other names accepted for the same network (CAIP-2 form used by x402 v2). */
  aliases: string[];
  chainId: number;
  /** The only asset this facilitator settles. */
  token: Address;
  /** tUSD8's EIP-712 domain, needed to check EIP-3009 signatures. */
  tokenDomain: { name: string; version: string };
  vault: Address;
}

const aevum = PERAULT_DEPLOYMENTS[44005];

export const AEVUM_TESTNET: NetworkConfig = {
  name: "aevum-testnet",
  aliases: ["eip155:44005"],
  chainId: 44005,
  token: aevum.token,
  tokenDomain: { name: "tUSD8", version: "2" },
  vault: aevum.vault,
};

export function matchesNetwork(cfg: NetworkConfig, network: string): boolean {
  return network === cfg.name || cfg.aliases.includes(network);
}
