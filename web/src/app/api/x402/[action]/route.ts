import { timingSafeEqual } from "node:crypto";
import type { FacilitatorRequest } from "@perault/x402";
import { configReport, getFacilitator, storeConfig } from "@/lib/store-server";

/**
 * A public x402 facilitator for Aevum, hosted with the site:
 *   GET  /api/x402/supported   schemes and networks
 *   GET  /api/x402/health      relayer address and gas
 *   POST /api/x402/verify      { x402Version, paymentPayload, paymentRequirements }
 *   POST /api/x402/settle      same body; needs `Authorization: Bearer <FACILITATOR_API_KEY>`
 * Same API as the standalone server in packages/x402.
 */
export const maxDuration = 60;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function notConfigured() {
  return json({ error: "not_configured", message: "This site has no facilitator: set FACILITATOR_PRIVATE_KEY.", settings: configReport() }, 503);
}

function authorized(req: Request, key: string): boolean {
  const got = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(_req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const f = getFacilitator();
  if (!f) return notConfigured();
  if (action === "supported") return json(f.supported());
  if (action === "health") {
    const s = await f.status();
    return json({ ok: true, ...s, relayerBalanceWei: s.relayerBalanceWei.toString() });
  }
  return json({ error: "not_found" }, 404);
}

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (action !== "verify" && action !== "settle") return json({ error: "not_found" }, 404);
  const f = getFacilitator();
  if (!f) return notConfigured();

  const { apiKey } = storeConfig();
  if (action === "settle" && (!apiKey || !authorized(req, apiKey))) {
    // Without a key configured, outside callers can't settle at all: they'd spend the relayer's gas.
    return json({ error: "unauthorized", message: "Missing or wrong API key." }, 401);
  }
  const text = await req.text();
  if (text.length > 64 * 1024) return json({ error: "invalid_request", message: "Body over 64 KB." }, 400);
  let body: FacilitatorRequest;
  try {
    body = JSON.parse(text) as FacilitatorRequest;
  } catch {
    return json({ error: "invalid_request", message: "Body must be JSON." }, 400);
  }
  return json(action === "verify" ? await f.verify(body) : await f.settle(body));
}
