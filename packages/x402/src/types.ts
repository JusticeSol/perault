import type { Address, Hex } from "viem";
import type { PaymentIntentJson } from "@perault/sdk";

/**
 * x402 v1 wire types (https://github.com/coinbase/x402). Amounts are decimal strings in token
 * base units, as the spec requires.
 */
export const X402_VERSION = 1;

/** What a resource server puts in its 402 response, one entry per accepted way to pay. */
export interface PaymentRequirements {
  scheme: "exact" | "perault";
  network: string;
  /** Base units. For both schemes the payment must equal this exactly. */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  outputSchema?: unknown;
  /**
   * exact:   { name, version } of the token's EIP-712 domain ("tUSD8", "2").
   * perault: { vault, orderId } – the SpendVault, and the merchant's order reference the
   *          agent must sign (binds the payment to this purchase).
   */
  extra?: Record<string, unknown>;
}

/** The body of a 402 response. */
export interface PaymentRequiredResponse {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
}

export interface ExactAuthorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface ExactPayload {
  signature: Hex;
  authorization: ExactAuthorization;
}

export interface PeraultPayload {
  signature: Hex;
  intent: PaymentIntentJson;
}

/** Decoded `X-PAYMENT` header. */
export interface PaymentPayload {
  x402Version: number;
  scheme: "exact" | "perault";
  network: string;
  payload: ExactPayload | PeraultPayload;
}

/** POST /verify and POST /settle request body. */
export interface FacilitatorRequest {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  /** Human-readable detail (Perault extension). */
  invalidMessage?: string;
  payer?: Address;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: Address;
  transaction: Hex | "";
  network: string;
}

export interface SupportedResponse {
  kinds: { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }[];
}

/** Standard x402 reason codes used here, plus `perault_*` for vault rejections. */
export type InvalidReason =
  | "invalid_x402_version"
  | "invalid_scheme"
  | "invalid_network"
  | "invalid_payload"
  | "invalid_payment_requirements"
  | "unsupported_asset"
  | "invalid_exact_evm_payload_signature"
  | "invalid_exact_evm_payload_recipient_mismatch"
  | "invalid_exact_evm_payload_authorization_value"
  | "invalid_exact_evm_payload_authorization_valid_before"
  | "invalid_exact_evm_payload_authorization_valid_after"
  | "insufficient_funds"
  | "nonce_already_used"
  | "invalid_transaction_state"
  | "perault_merchant_mismatch"
  | "perault_amount_mismatch"
  | "perault_order_mismatch"
  | "perault_vault_mismatch"
  | `perault_${string}`
  | "unexpected_settle_error";
