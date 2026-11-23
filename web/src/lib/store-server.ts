import "server-only";
import { PERAULT_DEPLOYMENTS, aevumTestnet, explorerTxUrl } from "@perault/sdk";
import { AEVUM_TESTNET, createFacilitator, type Facilitator } from "@perault/x402";
import { createPaywall, type Paywall } from "@perault/x402/merchant";
import { createPublicClient, createWalletClient, formatUnits, http, isAddress, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CATALOG } from "./catalog";

/**
 * Server side of the demo store, built to run on serverless hosting (Vercel):
 *  - the x402 facilitator runs in-process when FACILITATOR_PRIVATE_KEY (the relayer) is set,
 *    otherwise the store calls an external one at FACILITATOR_URL;
 *  - quotes are signed with PAYWALL_SECRET, so a paid retry can land on any instance;
 *  - the order list is read from the chain, so it's always complete and survives restarts.
 * Instances are cached on globalThis so dev hot-reloads and warm functions reuse them.
 */

const RPC = process.env.RPC_URL?.trim() || aevumTestnet.rpcUrls.default.http[0];

/** Tolerates what dashboards add when pasting: surrounding quotes, whitespace, a missing 0x. */
function clean(v: string | undefined): string | undefined {
  const t = v?.trim().replace(/^["']|["']$/g, "").trim();
  return t || undefined;
}

function relayerKey(): string | undefined {
  const k = clean(process.env.FACILITATOR_PRIVATE_KEY);
  if (!k) return undefined;
  return /^[0-9a-fA-F]{64}$/.test(k) ? `0x${k}` : k;
}

/**
 * Which settings the server can see, without revealing any value. Shown in "not configured"
 * errors so a wrong name or a bad paste on the hosting dashboard is easy to spot.
 */
export function configReport() {
  const key = relayerKey();
  return {
    STORE_ADDRESS: storeConfig().payTo ? "ok" : process.env.STORE_ADDRESS ? "set but not an address" : "missing",
    FACILITATOR_PRIVATE_KEY: !key ? "missing" : /^0x[0-9a-fA-F]{64}$/.test(key) ? "ok" : `set but not a 32-byte hex key (${key.length} characters)`,
    FACILITATOR_API_KEY: clean(process.env.FACILITATOR_API_KEY) ? "ok" : "missing",
    PAYWALL_SECRET: clean(process.env.PAYWALL_SECRET) ? "ok" : "missing",
  };
}

export function storeConfig() {
  const payTo = clean(process.env.STORE_ADDRESS);
  return {
    payTo: payTo && isAddress(payTo) ? (payTo as Address) : undefined,
    relayerKey: relayerKey(),
    facilitatorUrl: clean(process.env.FACILITATOR_URL),
    apiKey: clean(process.env.FACILITATOR_API_KEY),
    secret: clean(process.env.PAYWALL_SECRET),
  };
}

interface Cache {
  key: string;
  facilitator: Facilitator | null;
  paywall: Paywall | null;
  orders?: { at: number; data: StoreOrder[] };
}
const g = globalThis as typeof globalThis & { __perault?: Cache };

export const publicClient = createPublicClient({ chain: aevumTestnet, transport: http(RPC) });

function state(): Cache {
  const cfg = storeConfig();
  const key = JSON.stringify(cfg);
  if (g.__perault?.key === key) return g.__perault;

  let facilitator: Facilitator | null = null;
  if (cfg.relayerKey && /^0x[0-9a-fA-F]{64}$/.test(cfg.relayerKey)) {
    const account = privateKeyToAccount(cfg.relayerKey as Hex);
    facilitator = createFacilitator({
      network: AEVUM_TESTNET,
      publicClient,
      walletClient: createWalletClient({ account, chain: aevumTestnet, transport: http(RPC) }),
    });
  }
  const canSettle = facilitator || cfg.facilitatorUrl;
  const paywall =
    cfg.payTo && canSettle
      ? createPaywall({
          facilitator: facilitator ?? undefined,
          facilitatorUrl: cfg.facilitatorUrl,
          apiKey: cfg.apiKey,
          secret: cfg.secret,
          payTo: cfg.payTo,
        })
      : null;
  g.__perault = { key, facilitator, paywall };
  return g.__perault;
}

export const getFacilitator = () => state().facilitator;
export const getPaywall = () => state().paywall;

// ------------------------------------------------------------------ orders, read from the chain

export interface StoreOrder {
  id: string;
  name: string;
  price: string;
  scheme: "perault" | "exact";
  payer?: string;
  tx: string;
  explorer: string;
  block: string;
  at: string;
}

/** ≈ 6 hours of Aevum blocks; eth_getLogs is capped at 1,000 blocks per call. */
const LOOKBACK = 20_000n;
const CHUNK = 1_000n;
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const paidEvent = parseAbiItem(
  "event Paid(bytes32 indexed sessionId, address indexed merchant, bytes32 indexed orderId, address owner, address agent, uint256 amount, bytes32 nonce)",
);

/** The demo catalogue has one product per price, so a payment's amount names the item. */
function itemFor(amount: bigint): string {
  return CATALOG.find((p) => p.price === amount)?.name ?? `Payment of ${formatUnits(amount, 6)} tUSD8`;
}

async function scan<T>(from: bigint, to: bigint, fetch: (a: bigint, b: bigint) => Promise<T[]>): Promise<T[]> {
  const ranges: [bigint, bigint][] = [];
  for (let s = from; s <= to; s += CHUNK) ranges.push([s, s + CHUNK - 1n < to ? s + CHUNK - 1n : to]);
  const out: T[][] = new Array(ranges.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, ranges.length) }, async () => {
      while (next < ranges.length) {
        const i = next++;
        out[i] = await fetch(ranges[i][0], ranges[i][1]);
      }
    }),
  );
  return out.flat();
}

/**
 * Everything the store was paid in the last ~6 hours, newest first: SpendVault payments to the
 * store (agents) and direct tUSD8 transfers to it (wallets, via x402 `exact`). Cached for 8 s.
 */
export async function recentOrders(): Promise<StoreOrder[]> {
  const s = state();
  const payTo = storeConfig().payTo;
  if (!payTo) return [];
  if (s.orders && Date.now() - s.orders.at < 8_000) return s.orders.data;

  const vault = PERAULT_DEPLOYMENTS[44005].vault;
  const token = PERAULT_DEPLOYMENTS[44005].token;
  const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
  const from = latest > LOOKBACK ? latest - LOOKBACK : 0n;

  const [paid, transfers] = await Promise.all([
    scan(from, latest, (a, b) => publicClient.getLogs({ address: vault, event: paidEvent, args: { merchant: payTo }, fromBlock: a, toBlock: b })),
    scan(from, latest, (a, b) => publicClient.getLogs({ address: token, event: transferEvent, args: { to: payTo }, fromBlock: a, toBlock: b })),
  ]);

  const rows: (Omit<StoreOrder, "at"> & { blockNumber: bigint })[] = [
    ...paid.map((l) => ({
      id: l.args.orderId!,
      name: itemFor(l.args.amount!),
      price: formatUnits(l.args.amount!, 6),
      scheme: "perault" as const,
      payer: l.args.owner,
      tx: l.transactionHash!,
      explorer: explorerTxUrl(l.transactionHash!),
      block: l.blockNumber!.toString(),
      blockNumber: l.blockNumber!,
    })),
    // Agent payments also move tokens vault -> store; those are already listed above.
    ...transfers
      .filter((l) => l.args.from?.toLowerCase() !== vault.toLowerCase())
      .map((l) => ({
        id: `${l.transactionHash}-${l.logIndex}`,
        name: itemFor(l.args.value!),
        price: formatUnits(l.args.value!, 6),
        scheme: "exact" as const,
        payer: l.args.from,
        tx: l.transactionHash!,
        explorer: explorerTxUrl(l.transactionHash!),
        block: l.blockNumber!.toString(),
        blockNumber: l.blockNumber!,
      })),
  ].sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : 1));

  // Block times, one lookup per distinct block (a handful at most).
  const times = new Map<bigint, string>();
  await Promise.all(
    [...new Set(rows.map((r) => r.blockNumber))].map(async (n) => {
      const b = await publicClient.getBlock({ blockNumber: n });
      times.set(n, new Date(Number(b.timestamp) * 1000).toISOString());
    }),
  );
  const data = rows.map(({ blockNumber, ...r }) => ({ ...r, at: times.get(blockNumber) ?? "" }));
  s.orders = { at: Date.now(), data };
  return data;
}
