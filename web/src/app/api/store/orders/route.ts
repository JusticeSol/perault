import { orders, storeConfig } from "@/lib/store-server";

/** GET /api/store/orders: what the store has sold since the server started, newest first. */
export async function GET() {
  const list = [...orders().values()].sort((a, b) => b.at.localeCompare(a.at));
  const cfg = storeConfig();
  return Response.json({ configured: Boolean(cfg.payTo), payTo: cfg.payTo ?? null, orders: list });
}
