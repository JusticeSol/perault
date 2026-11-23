import type { IncomingMessage, ServerResponse } from "node:http";
import type { Address, Hex } from "viem";
import { randomNonce, toOrderId, type PaymentIntentJson } from "@perault/sdk";
import { decodeHeader, encodeHeader, PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER } from "./encoding";
import { AEVUM_TESTNET, type NetworkConfig } from "./networks";
import {
  X402_VERSION,
  type FacilitatorRequest,
  type PaymentPayload,
  type PaymentRequiredResponse,
  type PaymentRequirements,
  type SettleResponse,
} from "./types";

export interface Price {
  /** Token base units (tUSD8: 6 decimals, so 3.50 = 3_500_000n). */
  amount: bigint;
  description: string;
  /** Defaults to the request URL. */
  resource?: string;
  mimeType?: string;
  /** How long a quote (and the signature for it) stays valid. Default 120 s. */
  maxTimeoutSeconds?: number;
  /**
   * Your own order reference (from your order database). If omitted, the paywall issues one
   * per quote and remembers it in memory until the quote expires.
   */
  orderId?: string;
}

export interface PaidContext {
  scheme: "exact" | "perault";
  /** Who paid: the session owner (perault) or the signing wallet (exact). */
  payer?: Address;
  transaction: Hex | "";
  amount: bigint;
  /** perault only: the order reference the agent paid for. */
  orderId?: string;
  /**
   * True when this payment had been settled before (a retry or a replayed header). Nothing new
   * was charged. Your handler must return the ORIGINAL order, not fulfil a new one.
   */
  replayed: boolean;
  settlement: SettleResponse;
}

export interface PaywallConfig {
  /** Base URL of a Perault x402 facilitator, e.g. http://localhost:4020. Or pass `facilitator`. */
  facilitatorUrl?: string;
  /** Sent as `Authorization: Bearer` to /settle. */
  apiKey?: string;
  /** Your receiving address. */
  payTo: Address;
  network?: NetworkConfig;
  /** Accepted schemes, in the order offered. Default both. */
  schemes?: Array<"perault" | "exact">;
  fetch?: typeof fetch;
  /**
   * Call a facilitator in the same process instead of over HTTP (e.g. a Next.js app that hosts
   * its own facilitator routes). Takes precedence over `facilitatorUrl`.
   */
  facilitator?: { settle(req: FacilitatorRequest): Promise<SettleResponse> };
  /**
   * Signs quotes so any instance can verify a returning payment without shared memory. Required on
   * serverless or multi-instance hosting (Vercel, Lambda, several replicas): without it, quotes
   * live in this process's memory and a paid retry that lands on another instance is refused.
   * Use a long random string and keep it secret.
   */
  secret?: string;
}

interface Quote {
  ref: string;
  amount: bigint;
  resource: string;
  expiresAt: number;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 via Web Crypto (Node, browsers, edge runtimes). */
async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Put any Fetch-API handler (Next.js route handlers, Hono, Bun, Deno, Cloudflare) behind an
 * x402 payment. Express / plain Node: wrap the result with `toNodeListener`.
 *
 *   const paywall = createPaywall({ facilitatorUrl, apiKey, payTo: STORE });
 *   export const GET = (req: Request) =>
 *     paywall.protect(req, { amount: 3_500_000n, description: "Black hoodie, M" },
 *       async (paid) => Response.json({ order: await fulfil(paid) }));
 */
export function createPaywall(cfg: PaywallConfig) {
  const net = cfg.network ?? AEVUM_TESTNET;
  const schemes = cfg.schemes ?? ["perault", "exact"];
  const doFetch = cfg.fetch ?? fetch;
  if (!cfg.facilitator && !cfg.facilitatorUrl) throw new Error("createPaywall needs facilitatorUrl or facilitator");
  const base = (cfg.facilitatorUrl ?? "").replace(/\/$/, "");
  const quotes = new Map<Hex, Quote>();

  /** What a signed order reference commits to: the purchase it was quoted for. */
  const macInput = (rand: string, exp: string, resource: string, amount: bigint) => `${rand}|${exp}|${resource}|${amount}`;

  function sweep() {
    const now = Date.now();
    for (const [k, q] of quotes) if (q.expiresAt < now) quotes.delete(k);
  }

  function requirementsFor(price: Price, resource: string, orderRef: string | undefined): PaymentRequirements[] {
    const common = {
      network: net.name,
      maxAmountRequired: price.amount.toString(),
      resource,
      description: price.description,
      mimeType: price.mimeType ?? "application/json",
      payTo: cfg.payTo,
      maxTimeoutSeconds: price.maxTimeoutSeconds ?? 120,
      asset: net.token,
    };
    return schemes.map((scheme) =>
      scheme === "perault"
        ? { ...common, scheme, extra: { vault: net.vault, orderId: orderRef } }
        : { ...common, scheme, extra: { ...net.tokenDomain } },
    );
  }

  function paymentRequired(error: string, accepts: PaymentRequirements[], reason?: string): Response {
    const body: PaymentRequiredResponse & { reason?: string } = { x402Version: X402_VERSION, error, accepts, reason };
    return Response.json(body, { status: 402, headers: { "cache-control": "no-store" } });
  }

  async function newQuote(price: Price, resource: string): Promise<string> {
    if (price.orderId) return price.orderId;
    const expiresAt = Date.now() + (price.maxTimeoutSeconds ?? 120) * 1000;
    const rand = randomNonce().slice(2, 22);
    if (cfg.secret) {
      // Stateless: ord_<random>_<expiry>_<mac>. Any instance with the secret can check it.
      const exp = String(Math.floor(expiresAt / 1000));
      const mac = (await hmac(cfg.secret, macInput(rand, exp, resource, price.amount))).slice(0, 32);
      return `ord_${rand}_${exp}_${mac}`;
    }
    sweep();
    const ref = `ord_${rand}`;
    quotes.set(toOrderId(ref), { ref, amount: price.amount, resource, expiresAt });
    return ref;
  }

  /** The quoted order a perault payment is for, or why it can't be accepted. */
  async function quotedOrder(price: Price, resource: string, payment: PaymentPayload): Promise<string | { error: string }> {
    if (price.orderId !== undefined) return price.orderId;
    const payload = payment.payload as { intent?: PaymentIntentJson; orderRef?: unknown };
    const signedOrder = payload?.intent?.orderId?.toLowerCase() as Hex | undefined;
    const unknown = { error: "Unknown or expired quote. Request the resource again for a new one." };
    if (!signedOrder) return unknown;

    if (cfg.secret && typeof payload.orderRef === "string") {
      const ref = payload.orderRef;
      const m = /^ord_([0-9a-f]{20})_(\d{1,12})_([0-9a-f]{32})$/.exec(ref);
      if (!m) return unknown;
      const [, rand, exp, mac] = m;
      const want = (await hmac(cfg.secret, macInput(rand, exp, resource, price.amount))).slice(0, 32);
      // Signed for this resource and price, not expired, and it's the order the agent signed.
      if (!sameString(mac, want) || Number(exp) * 1000 < Date.now() || toOrderId(ref) !== signedOrder) return unknown;
      return ref;
    }
    sweep();
    const q = quotes.get(signedOrder);
    return q && q.resource === resource ? q.ref : unknown;
  }

  async function settle(body: FacilitatorRequest): Promise<SettleResponse | null> {
    if (cfg.facilitator) {
      try {
        return await cfg.facilitator.settle(body);
      } catch {
        return null;
      }
    }
    try {
      const res = await doFetch(`${base}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      return (await res.json()) as SettleResponse;
    } catch {
      return null;
    }
  }

  return {
    /** The 402 requirements for a price, e.g. to show a "pay with agent" button. */
    async requirements(price: Price, resource: string): Promise<PaymentRequirements[]> {
      return requirementsFor(price, resource, await newQuote(price, resource));
    },

    async protect(
      request: Request,
      price: Price | ((req: Request) => Price | Promise<Price>),
      handler: (paid: PaidContext, req: Request) => Response | Promise<Response>,
    ): Promise<Response> {
      const p = typeof price === "function" ? await price(request) : price;
      const resource = p.resource ?? request.url;
      const header = request.headers.get(PAYMENT_HEADER);

      const fresh = async () => requirementsFor(p, resource, await newQuote(p, resource));
      if (!header) {
        return paymentRequired(`${PAYMENT_HEADER} header is required`, await fresh());
      }
      const payment = decodeHeader<PaymentPayload>(header);
      if (!payment || (payment.scheme !== "perault" && payment.scheme !== "exact")) {
        return paymentRequired(`Malformed ${PAYMENT_HEADER} header`, await fresh(), "invalid_payload");
      }
      if (!schemes.includes(payment.scheme)) {
        return paymentRequired(`Scheme '${payment.scheme}' is not accepted here`, await fresh(), "invalid_scheme");
      }

      // perault: the agent signed a specific order. Check it's one we quoted.
      let orderRef: string | undefined;
      if (payment.scheme === "perault") {
        const q = await quotedOrder(p, resource, payment);
        if (typeof q !== "string") return paymentRequired(q.error, await fresh(), "unknown_quote");
        orderRef = q;
      }

      const requirement = requirementsFor(p, resource, orderRef).find((r) => r.scheme === payment.scheme)!;
      const settlement = await settle({ x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: requirement });
      if (!settlement) {
        return Response.json(
          { x402Version: X402_VERSION, error: "Payment service unavailable. Nothing was charged; try again shortly." },
          { status: 503, headers: { "retry-after": "5" } },
        );
      }
      if (!settlement.success) {
        return paymentRequired(settlement.errorMessage ?? "Payment was not accepted", await fresh(), settlement.errorReason);
      }

      const out = await handler(
        {
          scheme: payment.scheme,
          payer: settlement.payer,
          transaction: settlement.transaction,
          amount: p.amount,
          orderId: orderRef,
          replayed: settlement.replayed === true,
          settlement,
        },
        request,
      );
      const headers = new Headers(out.headers);
      headers.set(PAYMENT_RESPONSE_HEADER, encodeHeader(settlement));
      headers.append("access-control-expose-headers", PAYMENT_RESPONSE_HEADER);
      return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
    },
  };
}

export type Paywall = ReturnType<typeof createPaywall>;

/**
 * Adapter for Express / node:http. `app.get("/buy", toNodeListener((req) => paywall.protect(...)))`
 */
export function toNodeListener(handler: (req: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    }
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = new Uint8Array(Buffer.concat(chunks));
    }
    const out = await handler(new Request(url, { method: req.method, headers, body }));
    res.statusCode = out.status;
    out.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await out.arrayBuffer()));
  };
}
