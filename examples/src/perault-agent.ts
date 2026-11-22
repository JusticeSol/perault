// An agent buys from the demo store through its Perault session, one SKU after another.
// Each purchase is either settled on-chain (with an explorer link) or refused with a reason,
// and nothing is signed when a client-side check fails.
//
// pnpm --filter examples perault-agent hoodie-black-M jacket-denim-L
import { createPublicClient, formatUnits, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PeraultClient, aevumTestnet, explorerTxUrl } from "@perault/sdk";
import { PaymentError, createPayingFetch, getSettlement } from "@perault/x402/client";
import { required, requiredKey } from "./env";

const agent = privateKeyToAccount(requiredKey("AGENT_PRIVATE_KEY"));
const sessionId = required("PERAULT_SESSION_ID") as Hex;
const storeUrl = (process.env.STORE_URL ?? "http://localhost:3001").replace(/\/$/, "");
const skus = process.argv.slice(2).length ? process.argv.slice(2) : ["hoodie-black-M"];

// RPC_URL lets the same script run against a local fork of Aevum.
const client = new PeraultClient({ publicClient: createPublicClient({ chain: aevumTestnet, transport: http(process.env.RPC_URL || undefined) }) });
const pay = createPayingFetch({ perault: { client, signer: agent, sessionId }, maxAmount: 4_000_000n });
const fmt = (v: bigint) => `${formatUnits(v, 6)} tUSD8`;

const before = await client.getBudget(sessionId);
console.log(`agent ${agent.address}`);
console.log(`budget: ${before.active ? "active" : "INACTIVE"}, spendable now ${fmt(before.spendableNow)}\n`);

for (const sku of skus) {
  process.stdout.write(`buying ${sku} ... `);
  try {
    const res = await pay(`${storeUrl}/buy?sku=${encodeURIComponent(sku)}`);
    const body = (await res.json()) as { order?: { name: string; price: string }; replayed?: boolean; error?: string };
    const s = getSettlement(res);
    if (res.ok && s?.success) {
      console.log(`${body.replayed ? "ALREADY PAID" : "PAID"} ${body.order?.price} tUSD8 for ${body.order?.name}`);
      console.log(`  tx ${explorerTxUrl(s.transaction)}`);
    } else {
      console.log(`HTTP ${res.status}: ${body.error ?? JSON.stringify(body)}`);
    }
  } catch (e) {
    if (e instanceof PaymentError) console.log(`REFUSED [${e.code}] ${e.message}`);
    else throw e;
  }
}

const after = await client.getBudget(sessionId);
console.log(`\nbudget after: spendable now ${fmt(after.spendableNow)}, total remaining ${fmt(after.totalRemaining)}`);
