import { BaseError, ContractFunctionRevertedError, toFunctionSelector, type Hex } from "viem";
import { spendVaultAbi } from "./abi";

/** Every SpendVault error, in plain language for end users and agent prompts. */
export const VAULT_ERROR_MESSAGES = {
  ZeroAddress: "An address was empty.",
  ZeroAmount: "The amount must be greater than zero.",
  InvalidCaps: "Caps must satisfy 0 < per-payment ≤ daily ≤ total.",
  InvalidExpiry: "Session expiry must be in the future and at most 90 days away.",
  NotOwner: "Only the session's owner can do that.",
  UnknownSession: "This session does not exist.",
  BadSignature: "The payment was not signed by this session's agent key, or it was altered after signing.",
  Revoked: "The owner revoked this session. The agent can no longer pay.",
  SessionExpired: "This session has expired. Ask the owner for a new one.",
  IntentExpired: "The signed payment is past its deadline. Sign a fresh one.",
  MerchantNotAllowed: "This merchant is not on the session's allowlist.",
  NonceUsed: "This exact signed payment was already used.",
  OrderAlreadyPaid: "This order has already been paid.",
  OverPerTx: "The amount is over the session's per-payment limit.",
  OverDaily: "The amount would exceed today's spending limit (resets 00:00 UTC).",
  OverTotal: "The amount would exceed the session's total budget.",
  InsufficientBalance: "The owner's vault balance is too low.",
} as const;

export type VaultErrorCode = keyof typeof VAULT_ERROR_MESSAGES;

const BY_SELECTOR: Record<string, VaultErrorCode> = Object.fromEntries(
  spendVaultAbi
    .filter((e) => e.type === "error")
    .map((e) => [toFunctionSelector(`${e.name}()`), e.name as VaultErrorCode]),
);

/** A SpendVault rejection with a stable `code` an agent or UI can branch on. */
export class PeraultError extends Error {
  readonly code: VaultErrorCode | "Unknown";
  readonly cause?: unknown;
  constructor(code: VaultErrorCode | "Unknown", message?: string, cause?: unknown) {
    super(message ?? (code === "Unknown" ? "Unknown error" : VAULT_ERROR_MESSAGES[code]));
    this.name = "PeraultError";
    this.code = code;
    this.cause = cause;
  }
}

/** Maps a 4-byte selector (as returned by `SpendVault.preview`) to its error code. 0x00000000 = ok. */
export function codeFromSelector(selector: Hex): VaultErrorCode | null {
  if (/^0x0{8}$/.test(selector)) return null;
  return BY_SELECTOR[selector.toLowerCase()] ?? null;
}

/**
 * Turns whatever viem threw into a PeraultError when it is a SpendVault revert.
 * Returns undefined for anything else (network down, user rejected the wallet prompt...).
 */
export function explainError(err: unknown): PeraultError | undefined {
  if (err instanceof PeraultError) return err;
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  const name = revert.data?.errorName;
  if (name && name in VAULT_ERROR_MESSAGES) return new PeraultError(name as VaultErrorCode, undefined, err);
  const sel = revert.signature;
  const code = sel ? codeFromSelector(sel) : null;
  return code ? new PeraultError(code, undefined, err) : new PeraultError("Unknown", revert.shortMessage, err);
}
