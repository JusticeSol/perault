// End-to-end: real SpendVault + MockUSD8 bytecode on a local Shanghai anvil, the facilitator's
// HTTP server in-process, requests over fetch exactly as a merchant would send them.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { PeraultClient, intentToJson, randomNonce } from "@perault/sdk";
import {
  createFacilitator,
  createFacilitatorServer,
  exactTypedData,
  type FacilitatorRequest,
  type NetworkConfig,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "../src/index";

const PORT = 8548;
const RPC = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dirname, "../../..");
const API_KEY = "test-api-key";

// anvil's public dev keys. Local chain only.
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  buyer: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;
const STORE = "0x0000000000000000000000000000000000005409" as Address;

const artifact = (name: string) => {
  const j = JSON.parse(readFileSync(join(ROOT, `contracts/out/${name}.sol/${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
};
const anvilBin = () => {
  if (process.env.ANVIL_BIN) return process.env.ANVIL_BIN;
  const p = join(homedir(), ".foundry/bin", process.platform === "win32" ? "anvil.exe" : "anvil");
  return existsSync(p) ? p : "anvil";
};

let anvil: ChildProcess;
let server: Server;
let base: string;
let pub: PublicClient;
let net: NetworkConfig;
let owner: PrivateKeyAccount, agent: PrivateKeyAccount, buyer: PrivateKeyAccount;
let sessionId: Hex;

const wallet = (acc: PrivateKeyAccount) => createWalletClient({ account: acc, chain: foundry, transport: http(RPC) });

async function deploy(name: string, args: unknown[] = []) {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet(owner).deployContract({ abi, bytecode, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
}

async function post<T>(path: string, body: unknown, key: string | null = API_KEY): Promise<{ status: number; json: T }> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

const tokenBalance = (a: Address) =>
  pub.readContract({ address: net.token, abi: artifact("MockUSD8").abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

function requirements(scheme: "exact" | "perault", amount: bigint, extra: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme,
    network: "anvil-local",
    maxAmountRequired: amount.toString(),
    resource: "http://store.local/api/buy?sku=hoodie-black-M",
    description: "Black hoodie, size M",
    mimeType: "application/json",
    payTo: STORE,
    maxTimeoutSeconds: 120,
    asset: net.token,
    extra: scheme === "exact" ? { name: "tUSD8", version: "2" } : { vault: net.vault, ...extra },
  };
}

async function exactRequest(amount: bigint, over: Partial<{ to: Address; validBefore: bigint; signer: PrivateKeyAccount }> = {}) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const authorization = {
    from: buyer.address,
    to: over.to ?? STORE,
    value: amount.toString(),
    validAfter: "0",
    validBefore: (over.validBefore ?? now + 300n).toString(),
    nonce: randomNonce(),
  };
  const signature = await (over.signer ?? buyer).signTypedData(exactTypedData(net, authorization));
  const req: FacilitatorRequest = {
    x402Version: 1,
    paymentPayload: { x402Version: 1, scheme: "exact", network: "anvil-local", payload: { signature, authorization } },
    paymentRequirements: requirements("exact", amount),
  };
  return req;
}

async function peraultRequest(amount: bigint, orderRef: string, over: { merchant?: Address; priceOverride?: bigint } = {}) {
  const c = new PeraultClient({ publicClient: pub, vault: net.vault, chainId: 31337 });
  const { intent, signature } = await c.signPayment(agent, { sessionId, merchant: over.merchant ?? STORE, amount, orderId: orderRef });
  const req: FacilitatorRequest = {
    x402Version: 1,
    paymentPayload: { x402Version: 1, scheme: "perault", network: "anvil-local", payload: { signature, intent: intentToJson(intent) } },
    paymentRequirements: requirements("perault", over.priceOverride ?? amount, { orderId: orderRef }),
  };
  return req;
}

before(async () => {
  anvil = spawn(anvilBin(), ["--hardfork", "shanghai", "--port", String(PORT), "--silent"], { stdio: "ignore" });
  pub = createPublicClient({ chain: foundry, transport: http(RPC) });
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      if (i > 50) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  owner = privateKeyToAccount(KEYS.deployer);
  agent = privateKeyToAccount(KEYS.agent);
  buyer = privateKeyToAccount(KEYS.buyer);
  const token = await deploy("MockUSD8");
  const vault = await deploy("SpendVault", [token]);
  net = { name: "anvil-local", aliases: ["eip155:31337"], chainId: 31337, token, tokenDomain: { name: "tUSD8", version: "2" }, vault };

  const mockAbi = artifact("MockUSD8").abi;
  for (const to of [owner.address, buyer.address]) {
    const h = await wallet(owner).writeContract({ address: token, abi: mockAbi, functionName: "mint", args: [to, 50_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const o = new PeraultClient({ publicClient: pub, walletClient: wallet(owner), vault, chainId: 31337 });
  await o.deposit(10_000_000n);
  ({ sessionId } = await o.openSession({
    agent: agent.address,
    perTxCap: 4_000_000n,
    dailyCap: 5_000_000n,
    totalCap: 5_000_000n,
    expiresInSeconds: 86_400,
    merchants: [STORE],
  }));

  const f = createFacilitator({ network: net, publicClient: pub, walletClient: wallet(privateKeyToAccount(KEYS.relayer)) });
  server = createFacilitatorServer(f, { apiKey: API_KEY, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  anvil?.kill();
});

describe("HTTP surface", () => {
  test("GET /supported lists both schemes", async () => {
    const res = await fetch(`${base}/supported`);
    const j = (await res.json()) as { kinds: { scheme: string; network: string }[] };
    assert.deepEqual(j.kinds.map((k) => k.scheme).sort(), ["exact", "perault"]);
    assert.ok(j.kinds.every((k) => k.network === "anvil-local"));
  });

  test("GET /health reports the relayer", async () => {
    const j = (await (await fetch(`${base}/health`)).json()) as { ok: boolean; relayer: string };
    assert.equal(j.ok, true);
    assert.equal(j.relayer, privateKeyToAccount(KEYS.relayer).address);
  });

  test("POST /settle without the API key is 401", async () => {
    const r = await post("/settle", await exactRequest(1_000_000n), null);
    assert.equal(r.status, 401);
  });

  test("malformed JSON is 400; unknown route 404", async () => {
    assert.equal((await post("/verify", "{not json")).status, 400);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  test("envelope checks: version, network, asset", async () => {
    const good = await exactRequest(1_000_000n);
    const bad = async (mut: (r: FacilitatorRequest) => void, reason: string) => {
      const r = structuredClone(good);
      mut(r);
      assert.equal((await post<VerifyResponse>("/verify", r)).json.invalidReason, reason);
    };
    await bad((r) => (r.x402Version = 2), "invalid_x402_version");
    await bad((r) => (r.paymentPayload.network = "base-sepolia"), "invalid_network");
    await bad((r) => (r.paymentRequirements.asset = STORE), "unsupported_asset");
    await bad((r) => (r.paymentPayload.scheme = "perault"), "invalid_scheme");
  });
});

describe("exact scheme (standard x402, EIP-3009)", () => {
  test("verify then settle moves tUSD8 from buyer to store", async () => {
    const req = await exactRequest(2_000_000n);
    const v = await post<VerifyResponse>("/verify", req);
    assert.equal(v.json.isValid, true, v.json.invalidReason);
    assert.equal(v.json.payer, buyer.address);

    const before = await tokenBalance(STORE);
    const s = await post<SettleResponse>("/settle", req);
    assert.equal(s.json.success, true, s.json.errorReason);
    assert.match(s.json.transaction, /^0x[0-9a-f]{64}$/);
    assert.equal(await tokenBalance(STORE), before + 2_000_000n);

    // Retry returns the same transaction, no second transfer.
    const again = await post<SettleResponse>("/settle", req);
    assert.equal(again.json.transaction, s.json.transaction);
    assert.equal(await tokenBalance(STORE), before + 2_000_000n);

    // But verify now reports the nonce as spent.
    assert.equal((await post<VerifyResponse>("/verify", req)).json.invalidReason, "nonce_already_used");
  });

  test("concurrent duplicate settles produce one transfer", async () => {
    const req = await exactRequest(1_000_000n);
    const before = await tokenBalance(STORE);
    const [a, b] = await Promise.all([post<SettleResponse>("/settle", req), post<SettleResponse>("/settle", req)]);
    assert.equal(a.json.success && b.json.success, true);
    assert.equal(a.json.transaction, b.json.transaction);
    assert.equal(await tokenBalance(STORE), before + 1_000_000n);
  });

  test("rejections", async () => {
    const reason = async (req: FacilitatorRequest) => (await post<VerifyResponse>("/verify", req)).json.invalidReason;
    assert.equal(await reason(await exactRequest(1_000_000n, { to: owner.address })), "invalid_exact_evm_payload_recipient_mismatch");
    assert.equal(await reason(await exactRequest(1_000_000n, { signer: agent })), "invalid_exact_evm_payload_signature");
    assert.equal(await reason(await exactRequest(1_000_000n, { validBefore: 1n })), "invalid_exact_evm_payload_authorization_valid_before");
    assert.equal(await reason(await exactRequest(999_000_000n)), "insufficient_funds");

    const wrongPrice = await exactRequest(1_000_000n);
    wrongPrice.paymentRequirements.maxAmountRequired = "2000000";
    assert.equal(await reason(wrongPrice), "invalid_exact_evm_payload_authorization_value");

    const settle = await post<SettleResponse>("/settle", await exactRequest(1_000_000n, { signer: agent }));
    assert.equal(settle.json.success, false);
    assert.equal(settle.json.errorReason, "invalid_exact_evm_payload_signature");
  });
});

describe("perault scheme (session-capped agent payments)", () => {
  test("agent buys the hoodie; payer is the session owner", async () => {
    const req = await peraultRequest(3_500_000n, "hoodie-black-M#1");
    const v = await post<VerifyResponse>("/verify", req);
    assert.equal(v.json.isValid, true, v.json.invalidReason);
    assert.equal(v.json.payer, owner.address);

    const before = await tokenBalance(STORE);
    const s = await post<SettleResponse>("/settle", req);
    assert.equal(s.json.success, true, s.json.errorReason);
    assert.match(s.json.transaction, /^0x[0-9a-f]{64}$/);
    assert.equal(await tokenBalance(STORE), before + 3_500_000n);

    const again = await post<SettleResponse>("/settle", req);
    assert.equal(again.json.transaction, s.json.transaction, "idempotent");
    assert.equal(await tokenBalance(STORE), before + 3_500_000n);
  });

  test("a fresh signature for an already-paid order settles as success with the original tx", async () => {
    const first = await post<SettleResponse>("/settle", await peraultRequest(1_000_000n, "socks#1"));
    assert.equal(first.json.success, true, first.json.errorReason);
    const retry = await post<SettleResponse>("/settle", await peraultRequest(1_000_000n, "socks#1"));
    assert.equal(retry.json.success, true);
    assert.equal(retry.json.transaction, first.json.transaction);
  });

  test("vault rejections come back as perault_* reasons with plain-language messages", async () => {
    // 3.5 + 1.0 spent of a 5.0 budget
    const v1 = await post<VerifyResponse>("/verify", await peraultRequest(6_000_000n, "jacket#1"));
    assert.equal(v1.json.invalidReason, "perault_over_per_tx");
    assert.ok(v1.json.invalidMessage?.includes("per-payment"));

    const v2 = await post<VerifyResponse>("/verify", await peraultRequest(1_000_000n, "cap#1"));
    assert.equal(v2.json.invalidReason, "perault_over_daily");

    const s = await post<SettleResponse>("/settle", await peraultRequest(1_000_000n, "cap#2"));
    assert.equal(s.json.success, false);
    assert.equal(s.json.errorReason, "perault_over_daily");
  });

  test("binding checks: the intent must match what the merchant asked for", async () => {
    const reason = async (req: FacilitatorRequest) => (await post<VerifyResponse>("/verify", req)).json.invalidReason;

    // Prompt injection: agent signed a payment to someone else, merchant's payTo is the store.
    assert.equal(await reason(await peraultRequest(100n, "x#1", { merchant: owner.address })), "perault_merchant_mismatch");
    // Merchant asks 2.00, intent says 1.00.
    assert.equal(await reason(await peraultRequest(100n, "x#2", { priceOverride: 200n })), "perault_amount_mismatch");
    // Intent for one order replayed against another.
    const r = await peraultRequest(100n, "x#3");
    r.paymentRequirements.extra = { vault: net.vault, orderId: "x#4" };
    assert.equal(await reason(r), "perault_order_mismatch");
    // Wrong vault.
    const w = await peraultRequest(100n, "x#5");
    w.paymentRequirements.extra = { vault: STORE, orderId: "x#5" };
    assert.equal(await reason(w), "perault_vault_mismatch");
    // Garbage intent.
    const g = await peraultRequest(100n, "x#6");
    (g.paymentPayload.payload as { intent: { amount: string } }).intent.amount = "-5";
    assert.equal(await reason(g), "invalid_payload");
  });

  test("after revoke, the agent can't pay", async () => {
    const o = new PeraultClient({ publicClient: pub, walletClient: wallet(owner), vault: net.vault, chainId: 31337 });
    await o.revoke(sessionId);
    const v = await post<VerifyResponse>("/verify", await peraultRequest(100n, "late#1"));
    assert.equal(v.json.invalidReason, "perault_revoked");
  });
});
