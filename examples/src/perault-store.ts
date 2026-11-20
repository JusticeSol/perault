// Demo clothing store: one x402-paywalled endpoint, paid through the Perault facilitator.
//   GET /catalog                 free, lists items and prices
//   GET /buy?sku=hoodie-black-M  402 until paid; then returns the order
//   GET /orders                  free, what's been sold
//
// pnpm --filter examples perault-store
import { createServer } from "node:http";
import { formatUnits } from "viem";
import { createPaywall, toNodeListener } from "@perault/x402";
import { requiredAddress } from "./env";

const STORE = requiredAddress("STORE_ADDRESS");
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4020";
const PORT = Number(process.env.STORE_PORT ?? 3001);

// Prices are scaled to the faucet's 5 tUSD8 (6 decimals: 3_500_000n = 3.50).
const CATALOG: Record<string, { name: string; price: bigint }> = {
  "hoodie-black-M": { name: "Black hoodie, size M", price: 3_500_000n },
  "jacket-denim-L": { name: "Denim jacket, size L", price: 6_000_000n },
  "socks-white": { name: "White socks", price: 1_000_000n },
};

interface Order {
  id: string;
  sku: string;
  name: string;
  price: string;
  payer?: string;
  scheme: string;
  tx: string;
  at: string;
}
const orders = new Map<string, Order>();

const paywall = createPaywall({
  facilitatorUrl: FACILITATOR_URL,
  apiKey: process.env.FACILITATOR_API_KEY,
  payTo: STORE,
});

const app = toNodeListener(async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/catalog") {
    return Response.json(
      Object.entries(CATALOG).map(([sku, i]) => ({ sku, name: i.name, price: formatUnits(i.price, 6), currency: "tUSD8" })),
    );
  }
  if (url.pathname === "/orders") return Response.json([...orders.values()]);
  if (url.pathname !== "/buy") return Response.json({ error: "not found" }, { status: 404 });

  const sku = url.searchParams.get("sku") ?? "";
  const item = CATALOG[sku];
  if (!item) return Response.json({ error: `unknown sku '${sku}'`, catalog: Object.keys(CATALOG) }, { status: 404 });

  return paywall.protect(req, { amount: item.price, description: item.name }, (paid) => {
    // Idempotent fulfilment: a replayed payment returns the same order, never a second one.
    const key = paid.orderId ?? paid.transaction;
    let order = orders.get(key);
    if (!order) {
      order = {
        id: key,
        sku,
        name: item.name,
        price: formatUnits(item.price, 6),
        payer: paid.payer,
        scheme: paid.scheme,
        tx: paid.transaction,
        at: new Date().toISOString(),
      };
      orders.set(key, order);
      console.log(`SOLD ${order.name} for ${order.price} tUSD8 (${paid.scheme}) tx ${paid.transaction}`);
    } else {
      console.log(`replayed payment for order ${key}: returned the existing order`);
    }
    return Response.json({ status: "paid", order, replayed: paid.replayed });
  });
});

createServer(app).listen(PORT, () => {
  console.log(`Perault demo store on http://localhost:${PORT}`);
  console.log(`  pays to      ${STORE}`);
  console.log(`  facilitator  ${FACILITATOR_URL}${process.env.FACILITATOR_API_KEY ? "" : " (no API key set)"}`);
});
