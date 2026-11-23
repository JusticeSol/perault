import { isAddressEqual, type Hex } from "viem";
import {
  intentToJson,
  randomNonce,
  signTypedDataWith,
  signerAddress,
  type IntentSigner,
  type PeraultClient,
} from "@perault/sdk";
import { decodeHeader, encodeHeader, PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER } from "./encoding";
import { exactTypedData } from "./exact";
import { AEVUM_TESTNET, matchesNetwork, type NetworkConfig } from "./networks";
import { X402_VERSION, type PaymentPayload, type PaymentRequiredResponse, type PaymentRequirements, type SettleResponse } from "./types";

// Re-exported so agent code can import everything from "@perault/x402/client" (no node:http).
export { AEVUM_TESTNET, matchesNetwork, type NetworkConfig } from "./networks";
export type { PaymentRequiredResponse, PaymentRequirements, SettleResponse } from "./types";

export type PaymentErrorCode =
  | "NoAcceptableOption"
  | "PriceTooHigh"
  | "MerchantNotAllowed"
  | "SessionInactive"
  | "OverBudget"
  | "PaymentRejected";

/** Thrown before anything is signed (client-side guards) or when the merchant rejects the payment. */
export class PaymentError extends Error {
  readonly code: PaymentErrorCode | string;
  readonly requirements?: PaymentRequirements;
  constructor(code: PaymentErrorCode | string, message: string, requirements?: PaymentRequirements) {
    super(message);
    this.name = "PaymentError";
    this.code = code;
    this.requirements = requirements;
  }
}

export interface PaymentEvent {
  scheme: "perault" | "exact";
  requirements: PaymentRequirements;
  settlement: SettleResponse | null;
}

export interface PayingFetchConfig {
  /** Agent mode: pay through a Perault session (caps enforced on-chain). */
  perault?: { client: PeraultClient; signer: IntentSigner; sessionId: Hex };
  /** Wallet mode: plain x402 `exact` payments from `signer`'s own tUSD8. */
  exact?: { signer: IntentSigner };
  /**
   * Hard client-side ceiling per request, in base units. A 402 asking for more is refused
   * before anything is signed. Required: an agent should never sign an open-ended price.
   */
  maxAmount: bigint;
  network?: NetworkConfig;
  /** Scheme preference. Default: perault first. */
  prefer?: Array<"perault" | "exact">;
  fetch?: typeof fetch;
  onPayment?: (e: PaymentEvent) => void;
}

/**
 * `fetch` that pays x402 `402 Payment Required` responses and retries once with X-PAYMENT.
 *
 * Before signing it checks, in order: a scheme/network/asset it supports, price ≤ maxAmount,
 * and for perault: merchant on the session allowlist, session active, budget covers the price
 * (all read from the chain). The contract enforces the same rules again on settlement.
 */
export function createPayingFetch(cfg: PayingFetchConfig) {
  const net = cfg.network ?? AEVUM_TESTNET;
  const doFetch = cfg.fetch ?? fetch;
  const prefer = (cfg.prefer ?? ["perault", "exact"]).filter((s) => (s === "perault" ? cfg.perault : cfg.exact));

  async function buildPayment(accepts: PaymentRequirements[]): Promise<{ header: string; req: PaymentRequirements }> {
    const usable = (r: PaymentRequirements) =>
      matchesNetwork(net, r.network) &&
      isAddressEqual(r.asset, net.token) &&
      /^\d+$/.test(r.maxAmountRequired) &&
      (r.scheme !== "perault" || (typeof r.extra?.vault === "string" && isAddressEqual(r.extra.vault as `0x${string}`, cfg.perault!.client.vault)));

    let req: PaymentRequirements | undefined;
    for (const s of prefer) {
      req = accepts.find((r) => r.scheme === s && usable(r));
      if (req) break;
    }
    if (!req) throw new PaymentError("NoAcceptableOption", "The merchant offers no payment option this client can use.");

    const amount = BigInt(req.maxAmountRequired);
    if (amount > cfg.maxAmount) {
      throw new PaymentError("PriceTooHigh", `Price ${amount} is above this client's limit of ${cfg.maxAmount} per request.`, req);
    }
    const ttl = Math.max(30, Math.min(req.maxTimeoutSeconds || 120, 300));

    if (req.scheme === "perault") {
      const { client, signer, sessionId } = cfg.perault!;
      const orderRef = req.extra?.orderId;
      if (typeof orderRef !== "string" || orderRef.length === 0) {
        throw new PaymentError("NoAcceptableOption", "The merchant's perault quote has no orderId.", req);
      }
      const [allowed, budget] = await Promise.all([client.isMerchantAllowed(sessionId, req.payTo), client.getBudget(sessionId)]);
      if (!allowed) {
        throw new PaymentError("MerchantNotAllowed", `Merchant ${req.payTo} is not on this session's allowlist. Nothing was signed.`, req);
      }
      if (!budget.active) throw new PaymentError("SessionInactive", "This session is revoked or expired. Nothing was signed.", req);
      if (budget.spendableNow < amount) {
        throw new PaymentError("OverBudget", `Price ${amount} exceeds what this session can spend right now (${budget.spendableNow}).`, req);
      }
      const { intent, signature } = await client.signPayment(signer, {
        sessionId,
        merchant: req.payTo,
        amount,
        orderId: orderRef,
        ttlSeconds: ttl,
      });
      const payload: PaymentPayload = {
        x402Version: X402_VERSION,
        scheme: "perault",
        network: req.network,
        payload: { signature, intent: intentToJson(intent), orderRef },
      };
      return { header: encodeHeader(payload), req };
    }

    // exact: sign an EIP-3009 TransferWithAuthorization. The token domain comes from our own
    // network config, never from the server's `extra`.
    const signer = cfg.exact!.signer;
    const authorization = {
      from: signerAddress(signer),
      to: req.payTo,
      value: amount.toString(),
      validAfter: "0",
      validBefore: String(Math.floor(Date.now() / 1000) + ttl),
      nonce: randomNonce(),
    };
    const signature = await signTypedDataWith(signer, exactTypedData(net, authorization));
    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      scheme: "exact",
      network: req.network,
      payload: { signature, authorization },
    };
    return { header: encodeHeader(payload), req };
  }

  return async function payingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const original = new Request(input, init);
    const first = await doFetch(original.clone());
    if (first.status !== 402) return first;

    let body: PaymentRequiredResponse;
    try {
      body = (await first.clone().json()) as PaymentRequiredResponse;
    } catch {
      return first;
    }
    if (!Array.isArray(body?.accepts)) return first;

    const { header, req } = await buildPayment(body.accepts);
    const paid = () => {
      const r = original.clone();
      const headers = new Headers(r.headers);
      headers.set(PAYMENT_HEADER, header);
      return doFetch(new Request(r, { headers }));
    };

    // The same signed payment can be resent safely (single-use nonce, idempotent settlement),
    // so one retry on a network error can't double-charge.
    let res: Response;
    try {
      res = await paid();
    } catch {
      res = await paid();
    }
    if (res.status === 503) res = await paid();

    const settlement = getSettlement(res);
    if (res.status === 402) {
      let reason = "PaymentRejected";
      let message = "The merchant rejected the payment.";
      try {
        const j = (await res.clone().json()) as { error?: string; reason?: string };
        reason = j.reason ?? reason;
        message = j.error ?? message;
      } catch {
        /* keep defaults */
      }
      cfg.onPayment?.({ scheme: req.scheme, requirements: req, settlement: null });
      throw new PaymentError(reason, message, req);
    }
    cfg.onPayment?.({ scheme: req.scheme, requirements: req, settlement });
    return res;
  };
}

/** The facilitator's settlement for a paid response (tx hash, payer, replayed), if any. */
export function getSettlement(res: Response): SettleResponse | null {
  return decodeHeader<SettleResponse>(res.headers.get(PAYMENT_RESPONSE_HEADER));
}
