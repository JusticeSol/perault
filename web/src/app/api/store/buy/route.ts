import { formatUnits } from "viem";
import { productBySku } from "@/lib/catalog";
import { getPaywall, orders, storeConfig } from "@/lib/store-server";

/**
 * GET /api/store/buy?sku=hoodie-black-M
 *
 * x402-paywalled: answers 402 with two ways to pay (perault for agents, exact for wallets),
 * settles through the Perault facilitator, then returns the order. Agents and people hit the
 * same URL. Fulfilment is idempotent: a replayed payment returns the original order.
 */
export async function GET(req: Request) {
  const product = productBySku(new URL(req.url).searchParams.get("sku"));
  if (!product) return Response.json({ error: "Unknown product. See /api/store/catalog." }, { status: 404 });

  const paywall = getPaywall();
  if (!paywall) {
    return Response.json(
      { error: "Store not configured: set STORE_ADDRESS (and FACILITATOR_URL, FACILITATOR_API_KEY) in web/.env.local." },
      { status: 503 },
    );
  }

  return paywall.protect(req, { amount: product.price, description: product.name }, (paid) => {
    const book = orders();
    const key = paid.orderId ?? paid.transaction;
    let order = book.get(key);
    if (!order) {
      order = {
        id: key,
        sku: product.sku,
        name: product.name,
        price: formatUnits(product.price, 6),
        scheme: paid.scheme,
        payer: paid.payer,
        tx: paid.transaction,
        at: new Date().toISOString(),
      };
      book.set(key, order);
      console.log(`[store] SOLD ${order.name} for ${order.price} tUSD8 via ${order.scheme}, tx ${order.tx}`);
    }
    return Response.json({ status: "paid", order, replayed: paid.replayed, store: storeConfig().payTo });
  });
}
