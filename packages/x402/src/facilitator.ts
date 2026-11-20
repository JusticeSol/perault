import {
  isAddress,
  isAddressEqual,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { PeraultClient, PeraultError, intentFromJson, toOrderId, type PaymentIntent } from "@perault/sdk";
import { checkExactOffchain, eip3009Abi, exactCallArgs, parseExactPayload, type Check } from "./exact";
import { matchesNetwork, type NetworkConfig } from "./networks";
import {
  X402_VERSION,
  type FacilitatorRequest,
  type PeraultPayload,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "./types";

export interface FacilitatorConfig {
  network: NetworkConfig;
  publicClient: PublicClient<Transport, Chain | undefined>;
  /** Relayer: pays gas for settlements. Holds no customer funds. */
  walletClient: WalletClient<Transport, Chain | undefined, Account>;
  /** Max wait for a settlement to confirm. Default 60 s. */
  settleTimeoutMs?: number;
  /** Aevum recommends legacy (type 0) transactions. Default true. */
  legacyTransactions?: boolean;
  /** How long settled results are remembered for idempotent retries. Default 1 h. */
  resultTtlMs?: number;
}

export interface Facilitator {
  supported(): SupportedResponse;
  verify(req: FacilitatorRequest): Promise<VerifyResponse>;
  settle(req: FacilitatorRequest): Promise<SettleResponse>;
  /** Relayer address and gas balance, for health checks. */
  status(): Promise<{ network: string; chainId: number; relayer: Address; relayerBalanceWei: bigint; vault: Address; token: Address }>;
}

type Envelope = { ok: true } | { ok: false; reason: VerifyResponse["invalidReason"]; message: string };

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

export function createFacilitator(cfg: FacilitatorConfig): Facilitator {
  const net = cfg.network;
  const { publicClient, walletClient } = cfg;
  const legacy = cfg.legacyTransactions ?? true;
  const settleTimeoutMs = cfg.settleTimeoutMs ?? 60_000;
  const resultTtlMs = cfg.resultTtlMs ?? 3_600_000;
  const vaultClient = new PeraultClient({
    publicClient,
    walletClient,
    vault: net.vault,
    chainId: net.chainId,
    legacyTransactions: legacy,
  });

  // Idempotency: one settlement per payment, ever. Concurrent duplicates share the in-flight
  // promise; later retries get the remembered result (same tx hash) instead of a failure.
  const inflight = new Map<string, Promise<SettleResponse>>();
  const settled = new Map<string, { res: SettleResponse; at: number }>();

  function remember(key: string, res: SettleResponse) {
    const now = Date.now();
    for (const [k, v] of settled) if (now - v.at > resultTtlMs) settled.delete(k);
    settled.set(key, { res, at: now });
  }

  function envelope(req: FacilitatorRequest): Envelope {
    const p = req?.paymentPayload;
    const r = req?.paymentRequirements;
    if (!p || !r) return { ok: false, reason: "invalid_payload", message: "paymentPayload and paymentRequirements are required." };
    if (req.x402Version !== X402_VERSION || p.x402Version !== X402_VERSION) {
      return { ok: false, reason: "invalid_x402_version", message: `Only x402Version ${X402_VERSION} is supported.` };
    }
    if (p.scheme !== r.scheme || (p.scheme !== "exact" && p.scheme !== "perault")) {
      return { ok: false, reason: "invalid_scheme", message: "Scheme must be 'exact' or 'perault' and match the requirements." };
    }
    if (!matchesNetwork(net, p.network) || !matchesNetwork(net, r.network)) {
      return { ok: false, reason: "invalid_network", message: `This facilitator settles on ${net.name} only.` };
    }
    if (typeof r.asset !== "string" || !isAddress(r.asset) || !isAddressEqual(r.asset, net.token)) {
      return { ok: false, reason: "unsupported_asset", message: "Only tUSD8 is supported." };
    }
    if (typeof r.payTo !== "string" || !isAddress(r.payTo) || !/^\d+$/.test(r.maxAmountRequired ?? "") || BigInt(r.maxAmountRequired) === 0n) {
      return { ok: false, reason: "invalid_payment_requirements", message: "payTo or maxAmountRequired is invalid." };
    }
    return { ok: true };
  }

  async function chainNow(): Promise<bigint> {
    return (await publicClient.getBlock()).timestamp;
  }

  // ------------------------------------------------------------------ exact

  async function verifyExact(req: FacilitatorRequest): Promise<Check & { args?: ReturnType<typeof exactCallArgs> }> {
    const p = parseExactPayload(req.paymentPayload.payload);
    if (!p) return { ok: false, reason: "invalid_payload", message: "Malformed exact payload." };
    const off = await checkExactOffchain(net, req.paymentRequirements, p, await chainNow());
    if (!off.ok) return off;
    const a = p.authorization;
    const [used, balance] = await Promise.all([
      publicClient.readContract({ address: net.token, abi: eip3009Abi, functionName: "authorizationState", args: [a.from, a.nonce] }),
      publicClient.readContract({ address: net.token, abi: eip3009Abi, functionName: "balanceOf", args: [a.from] }),
    ]);
    if (used) return { ok: false, reason: "nonce_already_used", message: "This signed payment was already used.", payer: a.from };
    if (balance < BigInt(a.value)) return { ok: false, reason: "insufficient_funds", message: "Payer's tUSD8 balance is too low.", payer: a.from };
    const args = exactCallArgs(p);
    try {
      await publicClient.simulateContract({
        address: net.token,
        abi: eip3009Abi,
        functionName: "transferWithAuthorization",
        args,
        account: walletClient.account,
      });
    } catch (e) {
      return { ok: false, reason: "invalid_transaction_state", message: shortError(e), payer: a.from };
    }
    return { ok: true, payer: a.from, args };
  }

  async function settleExact(req: FacilitatorRequest): Promise<SettleResponse> {
    const v = await verifyExact(req);
    if (!v.ok || !v.args) return fail(v.ok ? "unexpected_settle_error" : v.reason, v.ok ? "" : v.message, v.payer);
    try {
      const hash = await walletClient.writeContract({
        address: net.token,
        abi: eip3009Abi,
        functionName: "transferWithAuthorization",
        args: v.args,
        account: walletClient.account,
        chain: walletClient.chain,
        ...(legacy ? { type: "legacy" as const } : {}),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: settleTimeoutMs });
      if (receipt.status !== "success") return fail("invalid_transaction_state", "Transaction reverted.", v.payer, hash);
      return { success: true, payer: v.payer, transaction: hash, network: net.name };
    } catch (e) {
      return fail("unexpected_settle_error", shortError(e), v.payer);
    }
  }

  // ---------------------------------------------------------------- perault

  type Bound = { ok: true; intent: PaymentIntent; signature: Hex } | { ok: false; reason: VerifyResponse["invalidReason"]; message: string };

  /** Checks that the signed intent is for exactly what the merchant asked for. */
  function bindPerault(req: FacilitatorRequest): Bound {
    const raw = req.paymentPayload.payload as PeraultPayload;
    let intent: PaymentIntent;
    try {
      intent = intentFromJson(raw?.intent);
    } catch (e) {
      return { ok: false, reason: "invalid_payload", message: `Malformed intent: ${(e as Error).message}` };
    }
    if (typeof raw.signature !== "string" || !raw.signature.startsWith("0x")) {
      return { ok: false, reason: "invalid_payload", message: "Missing signature." };
    }
    const r = req.paymentRequirements;
    const extra = r.extra ?? {};
    if (extra.vault !== undefined && (typeof extra.vault !== "string" || !isAddress(extra.vault) || !isAddressEqual(extra.vault, net.vault))) {
      return { ok: false, reason: "perault_vault_mismatch", message: "Requirements name a different SpendVault." };
    }
    if (!isAddressEqual(intent.merchant, r.payTo)) {
      return { ok: false, reason: "perault_merchant_mismatch", message: "Intent pays a different merchant than payTo." };
    }
    if (intent.amount !== BigInt(r.maxAmountRequired)) {
      return { ok: false, reason: "perault_amount_mismatch", message: "Intent amount does not match the price." };
    }
    if (typeof extra.orderId === "string" && intent.orderId !== toOrderId(extra.orderId)) {
      return { ok: false, reason: "perault_order_mismatch", message: "Intent is for a different order." };
    }
    return { ok: true, intent, signature: raw.signature as Hex };
  }

  async function payerOf(intent: PaymentIntent): Promise<Address | undefined> {
    const s = await vaultClient.getSession(intent.sessionId);
    return s.owner === "0x0000000000000000000000000000000000000000" ? undefined : s.owner;
  }

  async function verifyPerault(req: FacilitatorRequest): Promise<VerifyResponse> {
    const b = bindPerault(req);
    if (!b.ok) return { isValid: false, invalidReason: b.reason, invalidMessage: b.message };
    const [check, payer] = await Promise.all([vaultClient.preview(b.intent, b.signature), payerOf(b.intent)]);
    if (!check.ok) return { isValid: false, invalidReason: `perault_${snake(check.code)}`, invalidMessage: check.message, payer };
    return { isValid: true, payer };
  }

  async function settlePerault(req: FacilitatorRequest): Promise<SettleResponse> {
    const b = bindPerault(req);
    if (!b.ok) return fail(b.reason, b.message);
    const payer = await payerOf(b.intent);
    try {
      const res = await vaultClient.pay(b.intent, b.signature);
      if (res.status === "paid") return { success: true, payer, transaction: res.hash, network: net.name };
      // Already settled earlier (e.g. before a restart): find the original transaction.
      const latest = await publicClient.getBlockNumber();
      const [p] = await vaultClient.getPayments({
        merchant: b.intent.merchant,
        orderId: b.intent.orderId,
        fromBlock: latest > 10_000n ? latest - 10_000n : 0n,
      });
      return { success: true, payer, transaction: p?.transactionHash ?? "", network: net.name };
    } catch (e) {
      if (e instanceof PeraultError) return fail(`perault_${snake(e.code)}`, e.message, payer);
      return fail("unexpected_settle_error", shortError(e), payer);
    }
  }

  // ---------------------------------------------------------------- shared

  function fail(reason: string | undefined, message: string, payer?: Address, transaction: Hex | "" = ""): SettleResponse {
    return { success: false, errorReason: reason ?? "unexpected_settle_error", errorMessage: message, payer, transaction, network: net.name };
  }

  function idempotencyKey(req: FacilitatorRequest): string | null {
    const p = req.paymentPayload.payload as Partial<PeraultPayload> & { authorization?: { from?: string; nonce?: string } };
    if (req.paymentPayload.scheme === "exact" && p.authorization?.from && p.authorization.nonce) {
      return `exact:${p.authorization.from.toLowerCase()}:${p.authorization.nonce.toLowerCase()}`;
    }
    if (req.paymentPayload.scheme === "perault" && p.intent?.sessionId && p.intent.nonce) {
      return `perault:${p.intent.sessionId.toLowerCase()}:${p.intent.nonce.toLowerCase()}`;
    }
    return null;
  }

  return {
    supported() {
      return {
        kinds: [
          { x402Version: X402_VERSION, scheme: "exact", network: net.name },
          { x402Version: X402_VERSION, scheme: "perault", network: net.name, extra: { vault: net.vault } },
        ],
      };
    },

    async verify(req) {
      const env = envelope(req);
      if (!env.ok) return { isValid: false, invalidReason: env.reason, invalidMessage: env.message };
      try {
        if (req.paymentPayload.scheme === "perault") return await verifyPerault(req);
        const v = await verifyExact(req);
        return v.ok ? { isValid: true, payer: v.payer } : { isValid: false, invalidReason: v.reason, invalidMessage: v.message, payer: v.payer };
      } catch (e) {
        return { isValid: false, invalidReason: "invalid_transaction_state", invalidMessage: shortError(e) };
      }
    },

    async settle(req) {
      const env = envelope(req);
      if (!env.ok) return fail(env.reason, env.message);
      const key = idempotencyKey(req);
      if (!key) return fail("invalid_payload", "Malformed payload.");
      const done = settled.get(key);
      if (done && Date.now() - done.at <= resultTtlMs) return done.res;
      const running = inflight.get(key);
      if (running) return running;

      const job = (req.paymentPayload.scheme === "perault" ? settlePerault(req) : settleExact(req)).then((res) => {
        if (res.success) remember(key, res);
        return res;
      });
      inflight.set(key, job);
      try {
        return await job;
      } finally {
        inflight.delete(key);
      }
    },

    async status() {
      const relayer = walletClient.account.address;
      return {
        network: net.name,
        chainId: net.chainId,
        relayer,
        relayerBalanceWei: await publicClient.getBalance({ address: relayer }),
        vault: net.vault,
        token: net.token,
      };
    },
  };
}

function shortError(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  return m.split("\n")[0].slice(0, 300);
}
