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
  /** Base URL of a Perault x402 facilitator, e.g. http://localhost:4020 */
  facilitatorUrl: string;
  /** Sent as `Authorization: Bearer` to /settle. */
  apiKey?: string;
  /** Your receiving address. */
  payTo: Address;
  network?: NetworkConfig;
  /** Accepted schemes, in the order offered. Default both. */
  schemes?: Array<"perault" | "exact">;
  fetch?: typeof fetch;
}

interface Quote {
  ref: string;
  amount: bigint;
  resource: string;
  expiresAt: number;
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
  const base = cfg.facilitatorUrl.replace(/\/$/, "");
  const quotes = new Map<Hex, Quote>();

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

  function newQuote(price: Price, resource: string): string {
    sweep();
    const ref = price.orderId ?? `ord_${randomNonce().slice(2, 26)}`;
    quotes.set(toOrderId(ref), {
      ref,
      amount: price.amount,
      resource,
      expiresAt: Date.now() + (price.maxTimeoutSeconds ?? 120) * 1000,
    });
    return ref;
  }

  async function settle(body: FacilitatorRequest): Promise<SettleResponse | null> {
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
    requirements(price: Price, resource: string): PaymentRequirements[] {
      return requirementsFor(price, resource, newQuote(price, resource));
    },

    async protect(
      request: Request,
      price: Price | ((req: Request) => Price | Promise<Price>),
      handler: (paid: PaidContext, req: Request) => Response | Promise<Response>,
    ): Promise<Response> {
      const p = typeof price === "function" ? await price(request) : price;
      const resource = p.resource ?? request.url;
      const header = request.headers.get(PAYMENT_HEADER);

      if (!header) {
        return paymentRequired(`${PAYMENT_HEADER} header is required`, requirementsFor(p, resource, newQuote(p, resource)));
      }
      const payment = decodeHeader<PaymentPayload>(header);
      const fresh = () => requirementsFor(p, resource, newQuote(p, resource));
      if (!payment || (payment.scheme !== "perault" && payment.scheme !== "exact")) {
        return paymentRequired(`Malformed ${PAYMENT_HEADER} header`, fresh(), "invalid_payload");
      }
      if (!schemes.includes(payment.scheme)) {
        return paymentRequired(`Scheme '${payment.scheme}' is not accepted here`, fresh(), "invalid_scheme");
      }

      // perault: the agent signed a specific order. Find which one we quoted.
      let orderRef: string | undefined;
      if (payment.scheme === "perault") {
        const intent = (payment.payload as { intent?: PaymentIntentJson })?.intent;
        const signedOrder = intent?.orderId?.toLowerCase() as Hex | undefined;
        if (p.orderId !== undefined) {
          orderRef = p.orderId;
        } else {
          sweep();
          const q = signedOrder ? quotes.get(signedOrder) : undefined;
          if (!q || q.resource !== resource) {
            return paymentRequired("Unknown or expired quote. Request the resource again for a new one.", fresh(), "unknown_quote");
          }
          orderRef = q.ref;
        }
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
        return paymentRequired(settlement.errorMessage ?? "Payment was not accepted", fresh(), settlement.errorReason);
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
