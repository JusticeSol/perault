import type { PaymentPayload, SettleResponse } from "./types";

/** x402 headers carry base64-encoded JSON. Works in Node, browsers and edge runtimes. */
export function encodeHeader(value: PaymentPayload | SettleResponse): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeHeader<T>(header: string | null | undefined): T | null {
  if (!header || header.length > 16_384) return null;
  try {
    const bin = atob(header);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

export const PAYMENT_HEADER = "X-PAYMENT";
export const PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";
