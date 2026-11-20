// Facilitator entry point: `pnpm --filter @perault/x402 start`, or the Docker image.
import { createPublicClient, createWalletClient, defineChain, formatEther, http, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aevumTestnet } from "@perault/sdk";
import { createFacilitator } from "./facilitator";
import { AEVUM_TESTNET, type NetworkConfig } from "./networks";
import { createFacilitatorServer } from "./server";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    console.error(`Missing ${name}. See packages/x402/.env.example.`);
    process.exit(1);
  }
  return v;
}

const key = env("FACILITATOR_PRIVATE_KEY");
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("FACILITATOR_PRIVATE_KEY must be 0x + 64 hex characters.");
  process.exit(1);
}
const rpc = env("RPC_URL", aevumTestnet.rpcUrls.default.http[0]);
const chainId = Number(env("CHAIN_ID", "44005"));

// Overrides let the same image run against a local anvil/fork (vault + token deployed there).
const override = (name: string, d: Address): Address => {
  const v = process.env[name];
  if (!v) return d;
  if (!isAddress(v)) {
    console.error(`${name} is not an address.`);
    process.exit(1);
  }
  return v;
};
const network: NetworkConfig = {
  ...AEVUM_TESTNET,
  name: process.env.NETWORK_NAME ?? AEVUM_TESTNET.name,
  aliases: [`eip155:${chainId}`],
  chainId,
  vault: override("VAULT", AEVUM_TESTNET.vault),
  token: override("TOKEN", AEVUM_TESTNET.token),
};

const chain = chainId === aevumTestnet.id ? aevumTestnet : defineChain({ ...aevumTestnet, id: chainId, name: `chain ${chainId}` });
const account = privateKeyToAccount(key as `0x${string}`);
const publicClient = createPublicClient({ chain, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain, transport: http(rpc) });

const actual = await publicClient.getChainId();
if (actual !== chainId) {
  console.error(`RPC ${rpc} is chain ${actual}, expected ${chainId}.`);
  process.exit(1);
}

const facilitator = createFacilitator({ network, publicClient, walletClient });
const apiKey = process.env.FACILITATOR_API_KEY || undefined;
const port = Number(process.env.PORT ?? 4020);
const server = createFacilitatorServer(facilitator, { apiKey });

server.listen(port, async () => {
  const s = await facilitator.status();
  console.log(`Perault x402 facilitator on :${port}`);
  console.log(`  network  ${network.name} (chain ${chainId}) via ${rpc}`);
  console.log(`  vault    ${network.vault}`);
  console.log(`  token    ${network.token}`);
  console.log(`  relayer  ${s.relayer} (${formatEther(s.relayerBalanceWei)} gas)`);
  if (!apiKey) console.warn("  WARNING: FACILITATOR_API_KEY not set; anyone can call /settle and spend relayer gas.");
  if (s.relayerBalanceWei === 0n) console.warn("  WARNING: relayer has no gas; /settle will fail until it is funded.");
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
