import { formatUnits } from "viem";
import { productBySku } from "@/lib/catalog";
import { getPaywall, storeConfig } from "@/lib/store-server";

// Settling waits for Aevum to confirm the payment; give it room on serverless hosts.
export const maxDuration = 60;

/**
 * GET /api/store/buy?sku=hoodie-black-M
 *
 * x402-paywalled: answers 402 with two ways to pay (perault for agents, exact for wallets),
 * settles through the facilitator, then returns the order. Agents and people hit the same URL.
 * Fulfilment is idempotent: a replayed payment comes back with `replayed: true` and the same
 * order id, and nothing is charged again.
 */
export async function GET(req: Request) {
  const product = productBySku(new URL(req.url).searchParams.get("sku"));
  if (!product) return Response.json({ error: "Unknown product. See /api/store/catalog." }, { status: 404 });

  const paywall = getPaywall();
  if (!paywall) {
    return Response.json(
      { error: "Checkout isn't set up: set STORE_ADDRESS and FACILITATOR_PRIVATE_KEY (or FACILITATOR_URL) for the site." },
      { status: 503 },
    );
  }

  return paywall.protect(req, { amount: product.price, description: product.name }, (paid) =>
    Response.json({
      status: "paid",
      order: {
        id: paid.orderId ?? paid.transaction,
        sku: product.sku,
        name: product.name,
        price: formatUnits(product.price, 6),
        scheme: paid.scheme,
        payer: paid.payer,
        tx: paid.transaction,
        at: new Date().toISOString(),
      },
      replayed: paid.replayed,
      store: storeConfig().payTo,
    }),
  );
}
