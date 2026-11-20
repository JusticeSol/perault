import {
  hashTypedData,
  isHex,
  keccak256,
  size,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
  type WalletClient,
} from "viem";

/** What an agent signs. Mirrors `SpendVault.PaymentIntent` field for field. */
export interface PaymentIntent {
  sessionId: Hex;
  merchant: Address;
  /** In token base units (tUSD8: 6 decimals). */
  amount: bigint;
  orderId: Hex;
  /** Single-use per session. */
  nonce: Hex;
  /** Unix seconds; valid up to and including this time. */
  deadline: bigint;
}

/** EIP-712 types. Field order must match PAYMENT_INTENT_TYPEHASH in SpendVault.sol. */
export const paymentIntentTypes = {
  PaymentIntent: [
    { name: "sessionId", type: "bytes32" },
    { name: "merchant", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "orderId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export function peraultDomain(chainId: number, vault: Address) {
  return { name: "Perault", version: "1", chainId, verifyingContract: vault } as const;
}

/** Typed data ready for any EIP-712 signer (viem, wagmi, MetaMask). */
export function intentTypedData(chainId: number, vault: Address, intent: PaymentIntent) {
  return {
    domain: peraultDomain(chainId, vault),
    types: paymentIntentTypes,
    primaryType: "PaymentIntent" as const,
    message: intent,
  };
}

/** Same digest as `SpendVault.hashIntent`, computed off-chain. */
export function hashIntent(chainId: number, vault: Address, intent: PaymentIntent): Hex {
  return hashTypedData(intentTypedData(chainId, vault, intent));
}

/**
 * Turns a human order reference ("hoodie-black-M#1042") into the bytes32 the contract stores.
 * A value that already is a 32-byte hex string is used as is.
 */
export function toOrderId(ref: string): Hex {
  if (isHex(ref) && size(ref) === 32) return ref;
  return keccak256(toHex(ref));
}

/** 32 random bytes from the platform CSPRNG. */
export function randomNonce(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export interface BuildIntentArgs {
  sessionId: Hex;
  merchant: Address;
  amount: bigint;
  /** Human reference or bytes32; see `toOrderId`. */
  orderId: string;
  /** Defaults to a random nonce. Reuse the same nonce to make a retry safe. */
  nonce?: Hex;
  /** How long the signature stays valid. Default 5 minutes; keep it short. */
  ttlSeconds?: number;
  nowMs?: number;
}

export function buildIntent(a: BuildIntentArgs): PaymentIntent {
  if (a.amount <= 0n) throw new Error("amount must be positive");
  const now = Math.floor((a.nowMs ?? Date.now()) / 1000);
  return {
    sessionId: a.sessionId,
    merchant: a.merchant,
    amount: a.amount,
    orderId: toOrderId(a.orderId),
    nonce: a.nonce ?? randomNonce(),
    deadline: BigInt(now + (a.ttlSeconds ?? 300)),
  };
}

/** A local key (`privateKeyToAccount`) or a wallet client with an account (browser wallet). */
export type IntentSigner = LocalAccount | WalletClient;

function isLocalAccount(s: IntentSigner): s is LocalAccount {
  return s.type === "local" && "address" in s;
}

/** Address of whoever `signer` signs as. */
export function signerAddress(signer: IntentSigner): Address {
  if (isLocalAccount(signer)) return signer.address;
  const w = signer as WalletClient;
  if (!w.account) throw new Error("wallet client has no account");
  return w.account.address;
}

/** EIP-712 sign with either kind of signer. */
export async function signTypedDataWith(
  signer: IntentSigner,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typed: { domain: any; types: any; primaryType: string; message: any },
): Promise<Hex> {
  if (isLocalAccount(signer)) return signer.signTypedData(typed);
  const w = signer as WalletClient;
  if (!w.account) throw new Error("wallet client has no account");
  return w.signTypedData({ account: w.account, ...typed });
}

export function signIntent(signer: IntentSigner, chainId: number, vault: Address, intent: PaymentIntent): Promise<Hex> {
  return signTypedDataWith(signer, intentTypedData(chainId, vault, intent));
}

/** JSON-safe form (bigints as decimal strings), for HTTP headers and bodies. */
export interface PaymentIntentJson {
  sessionId: Hex;
  merchant: Address;
  amount: string;
  orderId: Hex;
  nonce: Hex;
  deadline: string;
}

export function intentToJson(i: PaymentIntent): PaymentIntentJson {
  return { ...i, amount: i.amount.toString(), deadline: i.deadline.toString() };
}

export function intentFromJson(j: PaymentIntentJson): PaymentIntent {
  for (const k of ["sessionId", "orderId", "nonce"] as const) {
    if (!isHex(j[k]) || size(j[k]) !== 32) throw new Error(`${k} must be 32-byte hex`);
  }
  if (!isHex(j.merchant) || size(j.merchant) !== 20) throw new Error("merchant must be an address");
  if (!/^\d+$/.test(j.amount) || !/^\d+$/.test(j.deadline)) throw new Error("amount and deadline must be integers");
  return { ...j, amount: BigInt(j.amount), deadline: BigInt(j.deadline) };
}
