import { isAddressEqual, isHex, parseSignature, recoverTypedDataAddress, size, type Address, type Hex } from "viem";
import type { ExactAuthorization, ExactPayload, InvalidReason, PaymentRequirements } from "./types";
import type { NetworkConfig } from "./networks";

/** tUSD8 (FiatTokenV2) and MockUSD8 both implement this. */
export const eip3009Abi = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Typed data a client signs for the `exact` scheme. */
export function exactTypedData(net: NetworkConfig, a: ExactAuthorization) {
  return {
    domain: { ...net.tokenDomain, chainId: net.chainId, verifyingContract: net.token },
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
  };
}

export type Check = { ok: true; payer: Address } | { ok: false; reason: InvalidReason; message: string; payer?: Address };

const uint = /^\d+$/;

export function parseExactPayload(p: unknown): ExactPayload | null {
  const x = p as ExactPayload;
  const a = x?.authorization;
  if (!x || !isHex(x.signature) || !a) return null;
  if (!isHex(a.from) || size(a.from) !== 20 || !isHex(a.to) || size(a.to) !== 20) return null;
  if (!isHex(a.nonce) || size(a.nonce) !== 32) return null;
  if (![a.value, a.validAfter, a.validBefore].every((v) => typeof v === "string" && uint.test(v))) return null;
  return x;
}

/**
 * Everything that can be checked without the chain: recipient, amount, time window, signature.
 * `nowSec` is chain time (latest block timestamp), not the local clock.
 */
export async function checkExactOffchain(
  net: NetworkConfig,
  req: PaymentRequirements,
  p: ExactPayload,
  nowSec: bigint,
): Promise<Check> {
  const a = p.authorization;
  const payer = a.from;
  if (!isAddressEqual(a.to, req.payTo)) {
    return { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch", message: "Payment is not addressed to this merchant.", payer };
  }
  if (BigInt(a.value) !== BigInt(req.maxAmountRequired)) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_value", message: "Payment amount does not match the price.", payer };
  }
  // Leave a few seconds so the transaction can still land before validBefore.
  if (BigInt(a.validBefore) <= nowSec + 6n) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_before", message: "Signed payment has expired or expires too soon.", payer };
  }
  if (BigInt(a.validAfter) > nowSec) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_after", message: "Signed payment is not valid yet.", payer };
  }
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({ ...exactTypedData(net, a), signature: p.signature });
  } catch {
    return { ok: false, reason: "invalid_exact_evm_payload_signature", message: "Signature is malformed.", payer };
  }
  if (!isAddressEqual(signer, a.from)) {
    return { ok: false, reason: "invalid_exact_evm_payload_signature", message: "Signature was not made by the payer.", payer };
  }
  return { ok: true, payer };
}

export function exactCallArgs(p: ExactPayload) {
  const a = p.authorization;
  const sig = parseSignature(p.signature);
  const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0);
  return [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, v, sig.r, sig.s] as const;
}

export type { Hex };
