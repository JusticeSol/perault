// The whole loop over real HTTP: agent (payingFetch) -> store (paywall) -> facilitator -> SpendVault.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { PeraultClient, intentToJson } from "@perault/sdk";
import {
  PAYMENT_HEADER,
  PaymentError,
  createFacilitator,
  createFacilitatorServer,
  createPayingFetch,
  createPaywall,
  getSettlement,
  toNodeListener,
  type NetworkConfig,
  type PaymentRequiredResponse,
} from "../src/index";

const PORT = 8549;
const RPC = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dirname, "../../..");
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  buyer: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  store: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const;

const artifact = (name: string) => {
  const j = JSON.parse(readFileSync(join(ROOT, `contracts/out/${name}.sol/${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
};
const anvilBin = () => {
  if (process.env.ANVIL_BIN) return process.env.ANVIL_BIN;
  const p = join(homedir(), ".foundry/bin", process.platform === "win32" ? "anvil.exe" : "anvil");
  return existsSync(p) ? p : "anvil";
};
const listen = (s: Server) =>
  new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

let anvil: ChildProcess;
const servers: Server[] = [];
let pub: PublicClient;
let net: NetworkConfig;
let owner: PrivateKeyAccount, agent: PrivateKeyAccount, buyer: PrivateKeyAccount;
let STORE: Address;
let storeUrl: string;
let sessionId: Hex;
let ownerClient: PeraultClient;
const orders = new Map<string, { id: string; sku: string; tx: string }>();
let fulfilled = 0;

const CATALOG: Record<string, { price: bigint; name: string }> = {
  "hoodie-black-M": { price: 3_500_000n, name: "Black hoodie, M" },
  "jacket-denim-L": { price: 6_000_000n, name: "Denim jacket, L" },
  "socks-white": { price: 1_000_000n, name: "White socks" },
};

const wallet = (acc: PrivateKeyAccount) => createWalletClient({ account: acc, chain: foundry, transport: http(RPC) });
const balance = (a: Address) =>
  pub.readContract({ address: net.token, abi: artifact("MockUSD8").abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

function agentFetch(maxAmount = 5_000_000n, onPayment?: Parameters<typeof createPayingFetch>[0]["onPayment"]) {
  return createPayingFetch({
    perault: { client: new PeraultClient({ publicClient: pub, vault: net.vault, chainId: 31337 }), signer: agent, sessionId },
    maxAmount,
    network: net,
    onPayment,
  });
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
  STORE = privateKeyToAccount(KEYS.store).address;

  const deploy = async (name: string, args: unknown[] = []) => {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet(owner).deployContract({ abi, bytecode, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const token = await deploy("MockUSD8");
  const vault = await deploy("SpendVault", [token]);
  net = { name: "anvil-local", aliases: ["eip155:31337"], chainId: 31337, token, tokenDomain: { name: "tUSD8", version: "2" }, vault };
  for (const to of [owner.address, buyer.address]) {
    const h = await wallet(owner).writeContract({ address: token, abi: artifact("MockUSD8").abi, functionName: "mint", args: [to, 50_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  ownerClient = new PeraultClient({ publicClient: pub, walletClient: wallet(owner), vault, chainId: 31337 });
  await ownerClient.deposit(20_000_000n);
  ({ sessionId } = await ownerClient.openSession({
    agent: agent.address,
    perTxCap: 4_000_000n,
    dailyCap: 5_000_000n,
    totalCap: 5_000_000n,
    expiresInSeconds: 86_400,
    merchants: [STORE],
  }));

  // Facilitator
  const fac = createFacilitatorServer(
    createFacilitator({ network: net, publicClient: pub, walletClient: wallet(privateKeyToAccount(KEYS.relayer)) }),
    { apiKey: "k", log: () => {} },
  );
  servers.push(fac);
  const facUrl = await listen(fac);

  // The clothing store: one paywalled endpoint, orders keyed by orderId so replays never ship twice.
  const paywall = createPaywall({ facilitatorUrl: facUrl, apiKey: "k", payTo: STORE, network: net });
  const store = createServer(
    toNodeListener(async (req) => {
      const sku = new URL(req.url).searchParams.get("sku") ?? "";
      const item = CATALOG[sku];
      if (!item) return Response.json({ error: "unknown sku" }, { status: 404 });
      return paywall.protect(req, { amount: item.price, description: item.name }, async (paid) => {
        const key = paid.orderId ?? paid.transaction;
        let order = orders.get(key);
        if (!order) {
          order = { id: key, sku, tx: paid.transaction };
          orders.set(key, order);
          fulfilled++;
        }
        return Response.json({ order, replayed: paid.replayed, payer: paid.payer });
      });
    }),
  );
  servers.push(store);
  storeUrl = await listen(store);
});

after(() => {
  servers.forEach((s) => s.close());
  anvil?.kill();
});

describe("agent buys from the store through x402 + Perault", () => {
  let hoodieHeader: string;

  test("a plain request gets 402 with both options and an order id", async () => {
    const res = await fetch(`${storeUrl}/buy?sku=hoodie-black-M`);
    assert.equal(res.status, 402);
    const j = (await res.json()) as PaymentRequiredResponse;
    assert.deepEqual(j.accepts.map((a) => a.scheme), ["perault", "exact"]);
    const p = j.accepts[0];
    assert.equal(p.maxAmountRequired, "3500000");
    assert.equal(p.payTo, STORE);
    assert.match(String(p.extra?.orderId), /^ord_/);
  });

  test("the agent buys the hoodie: 200, on-chain tx, store paid, owner debited", async () => {
    const storeBefore = await balance(STORE);
    let header: string | undefined;
    const f = createPayingFetch({
      perault: { client: new PeraultClient({ publicClient: pub, vault: net.vault, chainId: 31337 }), signer: agent, sessionId },
      maxAmount: 5_000_000n,
      network: net,
      // Capture the X-PAYMENT header the agent sends, to replay it later.
      fetch: async (input, init) => {
        const r = new Request(input, init);
        header ??= r.headers.get(PAYMENT_HEADER) ?? undefined;
        return fetch(r);
      },
    });
    const res = await f(`${storeUrl}/buy?sku=hoodie-black-M`);
    assert.equal(res.status, 200);
    const j = (await res.json()) as { order: { sku: string }; replayed: boolean; payer: string };
    assert.equal(j.order.sku, "hoodie-black-M");
    assert.equal(j.replayed, false);
    assert.equal(j.payer, owner.address);

    const s = getSettlement(res);
    assert.ok(s?.success);
    assert.match(String(s?.transaction), /^0x[0-9a-f]{64}$/);
    assert.equal(await balance(STORE), storeBefore + 3_500_000n);
    assert.equal((await ownerClient.getBudget(sessionId)).spendableNow, 1_500_000n);
    hoodieHeader = header!;
  });

  test("replaying the captured X-PAYMENT header returns the same order, no new charge, no new shipment", async () => {
    const storeBefore = await balance(STORE);
    const shippedBefore = fulfilled;
    const res = await fetch(`${storeUrl}/buy?sku=hoodie-black-M`, { headers: { [PAYMENT_HEADER]: hoodieHeader } });
    assert.equal(res.status, 200);
    const j = (await res.json()) as { replayed: boolean };
    assert.equal(j.replayed, true);
    assert.equal(await balance(STORE), storeBefore);
    assert.equal(fulfilled, shippedBefore);
  });

  test("the captured header can't buy a different item", async () => {
    const res = await fetch(`${storeUrl}/buy?sku=socks-white`, { headers: { [PAYMENT_HEADER]: hoodieHeader } });
    assert.equal(res.status, 402);
    assert.equal(((await res.json()) as { reason: string }).reason, "unknown_quote");
  });

  test("jacket (6.00) is refused by the agent before signing: over its own limit", async () => {
    await assert.rejects(agentFetch()(`${storeUrl}/buy?sku=jacket-denim-L`), (e: unknown) => {
      assert.ok(e instanceof PaymentError);
      assert.equal(e.code, "PriceTooHigh");
      return true;
    });
  });

  test("with a looser client limit, the session budget still stops it before signing", async () => {
    await assert.rejects(agentFetch(100_000_000n)(`${storeUrl}/buy?sku=jacket-denim-L`), { code: "OverBudget" });
  });

  test("socks (1.00) fit the remaining 1.50 budget", async () => {
    const events: string[] = [];
    const res = await agentFetch(5_000_000n, (e) => events.push(`${e.scheme}:${e.settlement?.success}`))(`${storeUrl}/buy?sku=socks-white`);
    assert.equal(res.status, 200);
    assert.deepEqual(events, ["perault:true"]);
  });

  test("a merchant not on the allowlist is refused before signing (prompt injection)", async () => {
    // A rogue store with a different payTo: the agent is tricked into "buying" there.
    const rogueFac = createFacilitatorServer(
      createFacilitator({ network: net, publicClient: pub, walletClient: wallet(privateKeyToAccount(KEYS.relayer)) }),
      { log: () => {} },
    );
    servers.push(rogueFac);
    const rogue = createPaywall({ facilitatorUrl: await listen(rogueFac), payTo: owner.address, network: net });
    const s = createServer(toNodeListener((req) => rogue.protect(req, { amount: 100n, description: "free gift" }, () => Response.json({}))));
    servers.push(s);
    await assert.rejects(agentFetch()(`${await listen(s)}/gift`), { code: "MerchantNotAllowed" });
  });

  test("after the owner revokes, the agent refuses to sign", async () => {
    await ownerClient.revoke(sessionId);
    await assert.rejects(agentFetch()(`${storeUrl}/buy?sku=socks-white`), { code: "SessionInactive" });
  });

  test("a human wallet can pay the same endpoint with plain x402 `exact`", async () => {
    const f = createPayingFetch({ exact: { signer: buyer }, maxAmount: 10_000_000n, network: net });
    const before = await balance(buyer.address);
    const res = await f(`${storeUrl}/buy?sku=jacket-denim-L`);
    assert.equal(res.status, 200);
    assert.equal(getSettlement(res)?.payer, buyer.address);
    assert.equal(await balance(buyer.address), before - 6_000_000n);
  });

  test("a server-side rejection surfaces as PaymentError with the vault's reason", async () => {
    // Bypass the client guards: sign a payment the session can't afford and send it raw.
    const o = new PeraultClient({ publicClient: pub, walletClient: wallet(owner), vault: net.vault, chainId: 31337 });
    const { sessionId: s2 } = await o.openSession({
      agent: agent.address, perTxCap: 1_000_000n, dailyCap: 1_000_000n, totalCap: 1_000_000n, expiresInSeconds: 600, merchants: [STORE],
    });
    const quote = (await (await fetch(`${storeUrl}/buy?sku=hoodie-black-M`)).json()) as PaymentRequiredResponse;
    const lying = createPayingFetch({
      perault: {
        // A client that misreports the budget, to prove the contract is the real gate.
        client: Object.assign(new PeraultClient({ publicClient: pub, vault: net.vault, chainId: 31337 }), {
          getBudget: async () => ({ active: true, spendableNow: 10n ** 12n }),
        }) as PeraultClient,
        signer: agent,
        sessionId: s2,
      },
      maxAmount: 10_000_000n,
      network: net,
    });
    assert.ok(quote.accepts.length > 0);
    await assert.rejects(lying(`${storeUrl}/buy?sku=hoodie-black-M`), (e: unknown) => {
      assert.ok(e instanceof PaymentError);
      assert.equal(e.code, "perault_over_per_tx");
      assert.match(e.message, /per-payment/);
      return true;
    });
  });
});

describe("stateless quotes (serverless: every request may hit a different instance)", () => {
  const SECRET = "test-secret-long-random-string";
  let sid2: Hex;
  let urlA: string, urlB: string;

  before(async () => {
    ({ sessionId: sid2 } = await ownerClient.openSession({
      agent: agent.address, perTxCap: 4_000_000n, dailyCap: 10_000_000n, totalCap: 10_000_000n, expiresInSeconds: 3600, merchants: [STORE],
    }));
    // The facilitator in-process (as the Vercel app hosts it), and two store "instances" that
    // share nothing but the secret.
    const fac = createFacilitator({ network: net, publicClient: pub, walletClient: wallet(privateKeyToAccount(KEYS.relayer)) });
    const mk = () => {
      const pw = createPaywall({ facilitator: fac, secret: SECRET, payTo: STORE, network: net });
      return createServer(toNodeListener((req) => pw.protect(req, { amount: 1_000_000n, description: "Socks", resource: "https://shop.example/buy?sku=socks" }, (p) => Response.json({ order: p.orderId, replayed: p.replayed }))));
    };
    const a = mk(), b = mk();
    servers.push(a, b);
    urlA = await listen(a);
    urlB = await listen(b);
  });

  const agentClient = () => new PeraultClient({ publicClient: pub, vault: net.vault, chainId: 31337 });

  test("quote from instance A, pay at instance B: accepted", async () => {
    // Route the unpaid request to A and the paid retry to B.
    let calls = 0;
    const f = createPayingFetch({
      perault: { client: agentClient(), signer: agent, sessionId: sid2 },
      maxAmount: 5_000_000n,
      network: net,
      fetch: (input, init) => fetch(String(new Request(input, init).url).replace(/^http:\/\/[^/]+/, calls++ === 0 ? urlA : urlB), init ?? (input instanceof Request ? input : undefined)),
    });
    const res = await f(`${urlA}/buy?sku=socks`);
    assert.equal(res.status, 200, await res.clone().text());
    const j = (await res.json()) as { order: string };
    assert.match(j.order, /^ord_[0-9a-f]{20}_\d+_[0-9a-f]{32}$/);
  });

  test("a forged or reused order reference is refused", async () => {
    const quote = (await (await fetch(`${urlA}/buy?sku=socks`)).json()) as PaymentRequiredResponse;
    const ref = String(quote.accepts.find((a) => a.scheme === "perault")!.extra!.orderId);
    const c = agentClient();
    const send = async (orderRef: string, signedRef: string) => {
      const { intent, signature } = await c.signPayment(agent, { sessionId: sid2, merchant: STORE, amount: 1_000_000n, orderId: signedRef });
      const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "perault", network: net.name, payload: { signature, intent: intentToJson(intent), orderRef } })).toString("base64");
      const r = await fetch(`${urlB}/buy?sku=socks`, { headers: { [PAYMENT_HEADER]: header } });
      return { status: r.status, reason: ((await r.json()) as { reason?: string }).reason };
    };
    // Flip one character of the MAC: forged.
    const forged = ref.slice(0, -1) + (ref.endsWith("0") ? "1" : "0");
    assert.deepEqual(await send(forged, forged), { status: 402, reason: "unknown_quote" });
    // A valid reference, but the agent signed a different order: mismatch.
    assert.deepEqual(await send(ref, "something-else"), { status: 402, reason: "unknown_quote" });
    // Made-up format.
    assert.deepEqual(await send("ord_free_stuff", "ord_free_stuff"), { status: 402, reason: "unknown_quote" });
  });
});
