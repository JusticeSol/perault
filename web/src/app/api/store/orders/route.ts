import { recentOrders, storeConfig } from "@/lib/store-server";

/** GET /api/store/orders: what the store was paid in the last ~6 hours, read from the chain. */
export async function GET() {
  const cfg = storeConfig();
  try {
    return Response.json({ configured: Boolean(cfg.payTo), payTo: cfg.payTo ?? null, orders: await recentOrders() });
  } catch (e) {
    return Response.json({ configured: Boolean(cfg.payTo), payTo: cfg.payTo ?? null, orders: [], error: (e as Error).message.split("\n")[0] }, { status: 502 });
  }
}
