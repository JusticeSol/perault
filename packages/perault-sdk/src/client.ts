import {
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { spendVaultAbi } from "./abi";
import { MAX_LOG_RANGE, PERAULT_DEPLOYMENTS } from "./deployments";
import { PeraultError, codeFromSelector, explainError, VAULT_ERROR_MESSAGES, type VaultErrorCode } from "./errors";
import {
  buildIntent,
  randomNonce,
  signerAddress,
  signIntent,
  signTypedDataWith,
  type BuildIntentArgs,
  type IntentSigner,
  type PaymentIntent,
} from "./intent";

const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
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

const receiveWithAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface PeraultClientConfig {
  publicClient: PublicClient<Transport, Chain | undefined>;
  /** Needed for writes (owner actions, or a relayer/merchant submitting `pay`). */
  walletClient?: WalletClient<Transport, Chain | undefined, Account>;
  /** Defaults to the official deployment for the public client's chain. */
  vault?: Address;
  /** Defaults to `publicClient.chain.id`. */
  chainId?: number;
  /** Aevum recommends legacy (type 0) transactions. Default true. */
  legacyTransactions?: boolean;
}

export interface TxResult {
  hash: Hash;
  receipt: TransactionReceipt;
}

export type PreviewResult = { ok: true } | { ok: false; code: VaultErrorCode | "Unknown"; message: string };

export type PayResult =
  | ({ status: "paid" } & TxResult)
  /** The order was already settled by this session for this amount. Nothing was charged. */
  | { status: "already-paid"; paidAt: bigint };

export interface OpenSessionArgs {
  agent: Address;
  perTxCap: bigint;
  dailyCap: bigint;
  totalCap: bigint;
  /** Seconds from the latest block. Give this or `expiry`. */
  expiresInSeconds?: number;
  /** Absolute unix seconds. */
  expiry?: bigint;
  merchants: Address[];
}

export interface GaslessDeposit {
  from: Address;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
}

/**
 * Typed access to a SpendVault. One class serves all three roles:
 *  - owner:    deposit, openSession, setMerchant, revoke, revokeAll, withdraw
 *  - agent:    getBudget, signPayment (no gas, no funds)
 *  - merchant: preview, pay (submits the agent's signed intent)
 */
export class PeraultClient {
  readonly publicClient: PeraultClientConfig["publicClient"];
  readonly walletClient?: PeraultClientConfig["walletClient"];
  readonly vault: Address;
  readonly chainId: number;
  private readonly legacy: boolean;
  private tokenAddress?: Address;

  constructor(cfg: PeraultClientConfig) {
    this.publicClient = cfg.publicClient;
    this.walletClient = cfg.walletClient;
    const chainId = cfg.chainId ?? cfg.publicClient.chain?.id;
    if (chainId === undefined) throw new Error("chainId unknown: pass `chainId` or a public client with a chain");
    this.chainId = chainId;
    const vault = cfg.vault ?? PERAULT_DEPLOYMENTS[chainId]?.vault;
    if (!vault) throw new Error(`no Perault deployment on chain ${chainId}: pass \`vault\``);
    this.vault = vault;
    this.legacy = cfg.legacyTransactions ?? true;
  }

  // ------------------------------------------------------------------ reads

  async token(): Promise<Address> {
    this.tokenAddress ??= await this.read("token", []);
    return this.tokenAddress;
  }

  /** What the session can spend right now. `spendableNow` is the number an agent should check. */
  getBudget(sessionId: Hex) {
    return this.read("budgetOf", [sessionId]);
  }

  getSession(sessionId: Hex) {
    return this.read("getSession", [sessionId]);
  }

  isActive(sessionId: Hex) {
    return this.read("isActive", [sessionId]);
  }

  /** Whether the session may pay `merchant`. Agents check this before signing anything. */
  isMerchantAllowed(sessionId: Hex, merchant: Address): Promise<boolean> {
    return this.read("isMerchantAllowed", [sessionId, merchant]);
  }

  /** The owner's unspent balance inside the vault. */
  balanceOf(owner: Address) {
    return this.read("balanceOf", [owner]);
  }

  getReceipt(merchant: Address, orderId: Hex) {
    return this.read("receiptOf", [merchant, orderId]);
  }

  /** Dry-run of `pay` against current chain state. Free; this is the facilitator's /verify. */
  async preview(intent: PaymentIntent, signature: Hex): Promise<PreviewResult> {
    const selector = await this.read("preview", [intent, signature]);
    if (/^0x0{8}$/.test(selector)) return { ok: true };
    const code = codeFromSelector(selector) ?? "Unknown";
    return { ok: false, code, message: code === "Unknown" ? `Unknown error ${selector}` : VAULT_ERROR_MESSAGES[code] };
  }

  /** Settled payments, scanning in ≤1,000-block chunks (Aevum's eth_getLogs limit). */
  async getPayments(
    opts: { fromBlock?: bigint; toBlock?: bigint; sessionId?: Hex; merchant?: Address; orderId?: Hex; concurrency?: number } = {},
  ) {
    const to = opts.toBlock ?? (await this.publicClient.getBlockNumber({ cacheTime: 0 }));
    const from = opts.fromBlock ?? PERAULT_DEPLOYMENTS[this.chainId]?.deployBlock ?? 0n;
    const args = { sessionId: opts.sessionId, merchant: opts.merchant, orderId: opts.orderId };
    const ranges: [bigint, bigint][] = [];
    for (let start = from; start <= to; start += MAX_LOG_RANGE) {
      ranges.push([start, start + MAX_LOG_RANGE - 1n < to ? start + MAX_LOG_RANGE - 1n : to]);
    }
    const fetchRange = ([fromBlock, toBlock]: [bigint, bigint]) =>
      this.publicClient.getContractEvents({ address: this.vault, abi: spendVaultAbi, eventName: "Paid", args, fromBlock, toBlock });
    // A few requests at a time: fast enough for interactive use, gentle on the public RPC.
    const concurrency = Math.max(1, opts.concurrency ?? 6);
    const results: Awaited<ReturnType<typeof fetchRange>>[] = new Array(ranges.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, ranges.length) }, async () => {
        while (next < ranges.length) {
          const i = next++;
          results[i] = await fetchRange(ranges[i]);
        }
      }),
    );
    return results.flat().map((l) => ({ ...l.args, transactionHash: l.transactionHash, blockNumber: l.blockNumber }));
  }

  // ------------------------------------------------------------------ agent

  /** Build and sign a payment intent. The agent needs no gas and holds no funds. */
  async signPayment(signer: IntentSigner, args: BuildIntentArgs): Promise<{ intent: PaymentIntent; signature: Hex }> {
    const intent = buildIntent(args);
    return { intent, signature: await signIntent(signer, this.chainId, this.vault, intent) };
  }

  // ------------------------------------------------------- merchant / relayer

  /**
   * Submit an agent's signed intent. Checks `preview` first so a rejection costs no gas and
   * comes back as a PeraultError with a plain-language message.
   *
   * Idempotent: if this order was already paid by the same session for the same amount
   * (e.g. a retry after a timeout), returns `already-paid` instead of throwing.
   */
  async pay(intent: PaymentIntent, signature: Hex): Promise<PayResult> {
    const check = await this.preview(intent, signature);
    if (!check.ok) {
      if (check.code === "OrderAlreadyPaid" || check.code === "NonceUsed") {
        const r = await this.getReceipt(intent.merchant, intent.orderId);
        if (r.paidAt !== 0n && r.sessionId === intent.sessionId && r.amount === intent.amount) {
          return { status: "already-paid", paidAt: r.paidAt };
        }
      }
      throw new PeraultError(check.code, check.message);
    }
    return { status: "paid", ...(await this.send("pay", [intent, signature])) };
  }

  // ------------------------------------------------------------------ owner

  /** Deposit tUSD8, approving the vault first if the allowance is short. */
  async deposit(amount: bigint): Promise<TxResult & { approveHash?: Hash }> {
    const owner = this.account().address;
    const token = await this.token();
    const allowance = await this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, this.vault],
    });
    let approveHash: Hash | undefined;
    if (allowance < amount) {
      approveHash = (await this.sendTo(token, erc20Abi, "approve", [this.vault, amount])).hash;
    }
    return { ...(await this.send("deposit", [amount])), approveHash };
  }

  /**
   * Owner side of a gasless deposit: sign an EIP-3009 ReceiveWithAuthorization to the vault.
   * Hand the result to anyone with gas, who calls `submitGaslessDeposit`.
   */
  async signGaslessDeposit(
    signer: IntentSigner,
    amount: bigint,
    opts: { ttlSeconds?: number; nonce?: Hex } = {},
  ): Promise<GaslessDeposit> {
    const from = signerAddress(signer);
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 600));
    const nonce = opts.nonce ?? randomNonce();
    const typed = {
      domain: { name: "tUSD8", version: "2", chainId: this.chainId, verifyingContract: await this.token() },
      types: receiveWithAuthorizationTypes,
      primaryType: "ReceiveWithAuthorization" as const,
      message: { from, to: this.vault, value: amount, validAfter: 0n, validBefore, nonce },
    };
    const signature = await signTypedDataWith(signer, typed);
    return { from, amount, validAfter: 0n, validBefore, nonce, signature };
  }

  /** Relayer side of a gasless deposit. The funds are credited to `d.from`, never to the caller. */
  submitGaslessDeposit(d: GaslessDeposit): Promise<TxResult> {
    const r = d.signature.slice(0, 66) as Hex;
    const s = `0x${d.signature.slice(66, 130)}` as Hex;
    const v = Number.parseInt(d.signature.slice(130, 132), 16);
    return this.send("depositWithAuthorization", [d.from, d.amount, d.validAfter, d.validBefore, d.nonce, v, r, s]);
  }

  withdraw(amount: bigint): Promise<TxResult> {
    return this.send("withdraw", [amount]);
  }

  /** Open a scoped session for an agent key. Returns the new session id. */
  async openSession(a: OpenSessionArgs): Promise<TxResult & { sessionId: Hex }> {
    let expiry = a.expiry;
    if (expiry === undefined) {
      if (a.expiresInSeconds === undefined) throw new Error("give expiresInSeconds or expiry");
      // Use chain time, not the local clock: the contract compares against block.timestamp.
      const block = await this.publicClient.getBlock();
      expiry = block.timestamp + BigInt(a.expiresInSeconds);
    }
    const tx = await this.send("openSession", [a.agent, a.perTxCap, a.dailyCap, a.totalCap, Number(expiry), a.merchants]);
    const [opened] = parseEventLogs({ abi: spendVaultAbi, logs: tx.receipt.logs, eventName: "SessionOpened" });
    if (!opened) throw new Error("SessionOpened event missing from receipt");
    return { ...tx, sessionId: opened.args.sessionId };
  }

  setMerchant(sessionId: Hex, merchant: Address, allowed: boolean): Promise<TxResult> {
    return this.send("setMerchant", [sessionId, merchant, allowed]);
  }

  /** Kill one session immediately. */
  revoke(sessionId: Hex): Promise<TxResult> {
    return this.send("revoke", [sessionId]);
  }

  /** Kill switch: every session this owner has opened dies immediately. */
  revokeAll(): Promise<TxResult> {
    return this.send("revokeAll", []);
  }

  // --------------------------------------------------------------- internal

  private account(): Account {
    const acc = this.walletClient?.account;
    if (!acc) throw new Error("this action needs a walletClient with an account");
    return acc;
  }

  // viem's generics can't follow a function name chosen at runtime; the public methods above
  // pin the argument types, so the loose typing stays inside this file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private read<T = any>(functionName: string, args: readonly unknown[]): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.publicClient.readContract({ address: this.vault, abi: spendVaultAbi, functionName, args } as any) as Promise<T>;
  }

  private send(functionName: string, args: readonly unknown[]): Promise<TxResult> {
    return this.sendTo(this.vault, spendVaultAbi, functionName, args);
  }

  /** Simulate (catches reverts for free), send, wait for the receipt. Reverts become PeraultError. */
  private async sendTo(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) {
    const wallet = this.walletClient;
    if (!wallet) throw new Error("this action needs a walletClient");
    try {
      const { request } = await this.publicClient.simulateContract({
        address,
        abi,
        functionName,
        args,
        account: this.account(),
        chain: wallet.chain,
        ...(this.legacy ? { type: "legacy" } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hash = await wallet.writeContract(request as any);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
      return { hash, receipt };
    } catch (err) {
      throw explainError(err) ?? err;
    }
  }
}

export type Budget = Awaited<ReturnType<PeraultClient["getBudget"]>>;
export type Session = Awaited<ReturnType<PeraultClient["getSession"]>>;
export type Payment = Awaited<ReturnType<PeraultClient["getPayments"]>>[number];
