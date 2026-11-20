#!/usr/bin/env -S npx tsx
// Perault MCP server over stdio. stdout carries the MCP protocol: log to stderr only.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPublicClient, defineChain, http, isAddress, isHex, parseUnits, size, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PeraultClient, aevumTestnet } from "@perault/sdk";
import { AEVUM_TESTNET, type NetworkConfig } from "@perault/x402/client";
import { createPeraultMcpServer } from "./server";

const die = (msg: string): never => {
  console.error(`perault-mcp: ${msg}`);
  process.exit(1);
};

const key = process.env.AGENT_PRIVATE_KEY ?? die("AGENT_PRIVATE_KEY is not set (the agent's session key).");
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die("AGENT_PRIVATE_KEY must be 0x + 64 hex characters.");
const sessionId = process.env.PERAULT_SESSION_ID ?? die("PERAULT_SESSION_ID is not set (from openSession).");
if (!isHex(sessionId) || size(sessionId) !== 32) die("PERAULT_SESSION_ID must be a 32-byte hex value.");

const maxAmount: bigint = (() => {
  try {
    return parseUnits(process.env.PERAULT_MAX_AMOUNT ?? "5", 6);
  } catch {
    return die('PERAULT_MAX_AMOUNT must be a tUSD8 amount like "5" or "3.50".');
  }
})();

const chainId = Number(process.env.CHAIN_ID ?? aevumTestnet.id);
const rpc = process.env.RPC_URL ?? aevumTestnet.rpcUrls.default.http[0];
const vaultEnv = process.env.VAULT;
if (vaultEnv && !isAddress(vaultEnv)) die("VAULT is not an address.");
const tokenEnv = process.env.TOKEN;
if (tokenEnv && !isAddress(tokenEnv)) die("TOKEN is not an address.");

const chain = chainId === aevumTestnet.id ? aevumTestnet : defineChain({ ...aevumTestnet, id: chainId, name: `chain ${chainId}` });
const publicClient = createPublicClient({ chain, transport: http(rpc) });
const network: NetworkConfig = {
  ...AEVUM_TESTNET,
  name: process.env.NETWORK_NAME ?? AEVUM_TESTNET.name,
  aliases: [`eip155:${chainId}`],
  chainId,
  vault: (vaultEnv as Address | undefined) ?? AEVUM_TESTNET.vault,
  token: (tokenEnv as Address | undefined) ?? AEVUM_TESTNET.token,
};
const client = new PeraultClient({ publicClient, vault: network.vault, chainId });
const signer = privateKeyToAccount(key as Hex);

const session = await client.getSession(sessionId as Hex).catch((e: Error) => die(`cannot read the session from ${rpc}: ${e.message}`));
if (session.owner === "0x0000000000000000000000000000000000000000") die(`session ${sessionId} does not exist on vault ${network.vault}.`);
if (session.agent.toLowerCase() !== signer.address.toLowerCase()) {
  die(`AGENT_PRIVATE_KEY is ${signer.address}, but the session's agent is ${session.agent}.`);
}

const allowedHosts = process.env.PERAULT_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
const server = createPeraultMcpServer({ client, signer, sessionId: sessionId as Hex, maxAmount, network, allowedHosts });
await server.connect(new StdioServerTransport());
console.error(
  `perault-mcp: ready. agent ${signer.address}, session ${sessionId.slice(0, 10)}…, vault ${network.vault}, ` +
    `ceiling ${process.env.PERAULT_MAX_AMOUNT ?? "5"} tUSD8${allowedHosts ? `, hosts ${allowedHosts.join(",")}` : ""}`,
);
