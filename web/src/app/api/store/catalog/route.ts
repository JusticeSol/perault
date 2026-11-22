import { formatUnits } from "viem";
import { CATALOG, STORE_NAME } from "@/lib/catalog";

/** GET /api/store/catalog: free, machine-readable product list for agents. */
export async function GET(req: Request) {
  const base = new URL(req.url).origin;
  return Response.json({
    store: STORE_NAME,
    currency: "tUSD8",
    network: "aevum-testnet",
    payment: "x402 (schemes: perault, exact)",
    products: CATALOG.map((p) => ({
      sku: p.sku,
      name: p.name,
      description: p.blurb,
      price: formatUnits(p.price, 6),
      buy: `${base}/api/store/buy?sku=${p.sku}`,
    })),
  });
}
