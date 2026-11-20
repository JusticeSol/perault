// Integration tests: real SpendVault bytecode on a local Shanghai anvil chain.
// Needs `forge build` (contracts/out) and anvil (on PATH, ANVIL_BIN, or ~/.foundry/bin).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  PeraultClient,
  PeraultError,
  hashIntent,
  intentFromJson,
  intentToJson,
  spendVaultAbi,
  toOrderId,
} from "../src/index";

const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dirname, "../../..");

// anvil's well-known public dev keys. Local chain only; never fund these anywhere real.
const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  stranger: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;

const artifact = (name: string) => {
  const j = JSON.parse(readFileSync(join(ROOT, `contracts/out/${name}.sol/${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
};

function anvilBin(): string {
  if (process.env.ANVIL_BIN) return process.env.ANVIL_BIN;
  const home = join(homedir(), ".foundry/bin", process.platform === "win32" ? "anvil.exe" : "anvil");
  return existsSync(home) ? home : "anvil";
}

let anvil: ChildProcess;
let pub: PublicClient;
let owner: PrivateKeyAccount, relayer: PrivateKeyAccount, agent: PrivateKeyAccount;
let vault: Address, token: Address;
const merchant = "0x0000000000000000000000000000000000005409" as Address; // the store
const attacker = "0x000000000000000000000000000000000000dEaD" as Address;

const clientFor = (acc: PrivateKeyAccount) =>
  new PeraultClient({
    publicClient: pub,
    walletClient: createWalletClient({ account: acc, chain: foundry, transport: http(RPC) }),
    vault,
  });

async function deploy(acc: PrivateKeyAccount, name: string, args: unknown[] = []) {
  const w = createWalletClient({ account: acc, chain: foundry, transport: http(RPC) });
  const { abi, bytecode } = artifact(name);
  const hash = await w.deployContract({ abi, bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  return r.contractAddress!;
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
  owner = privateKeyToAccount(KEYS.owner);
  relayer = privateKeyToAccount(KEYS.relayer);
  agent = privateKeyToAccount(KEYS.agent);
  token = await deploy(owner, "MockUSD8");
  vault = await deploy(owner, "SpendVault", [token]);
  const w = createWalletClient({ account: owner, chain: foundry, transport: http(RPC) });
  const mint = await w.writeContract({
    address: token,
    abi: artifact("MockUSD8").abi,
    functionName: "mint",
    args: [owner.address, 100_000_000n],
  });
  await pub.waitForTransactionReceipt({ hash: mint });
});

after(() => {
  anvil?.kill();
});

describe("intent encoding", () => {
  test("toOrderId hashes refs and passes bytes32 through", () => {
    const id = toOrderId("hoodie-black-M");
    assert.equal(id.length, 66);
    assert.equal(toOrderId(id), id);
  });

  test("JSON round trip, and rejects malformed input", async () => {
    const c = clientFor(agent);
    const { intent } = await c.signPayment(agent, {
      sessionId: `0x${"11".repeat(32)}`,
      merchant,
      amount: 3_500_000n,
      orderId: "x",
    });
    assert.deepEqual(intentFromJson(intentToJson(intent)), intent);
    assert.throws(() => intentFromJson({ ...intentToJson(intent), amount: "-1" }));
    assert.throws(() => intentFromJson({ ...intentToJson(intent), nonce: "0x12" }));
  });
});

describe("full flow against SpendVault", () => {
  let sessionId: Hex;

  test("owner deposits (auto-approve) and opens a session", async () => {
    const o = clientFor(owner);
    const dep = await o.deposit(10_000_000n);
    assert.ok(dep.approveHash, "approved first");
    assert.equal(await o.balanceOf(owner.address), 10_000_000n);

    const s = await o.openSession({
      agent: agent.address,
      perTxCap: 4_000_000n,
      dailyCap: 5_000_000n,
      totalCap: 5_000_000n,
      expiresInSeconds: 86_400,
      merchants: [merchant],
    });
    sessionId = s.sessionId;
    const session = await o.getSession(sessionId);
    assert.equal(session.agent, agent.address);
    assert.equal(session.perTxCap, 4_000_000n);
    assert.equal(await o.isActive(sessionId), true);
  });

  test("SDK digest equals the contract's hashIntent (EIP-712 parity)", async () => {
    const c = clientFor(agent);
    const { intent } = await c.signPayment(agent, { sessionId, merchant, amount: 1n, orderId: "parity" });
    const onchain = await pub.readContract({ address: vault, abi: spendVaultAbi, functionName: "hashIntent", args: [intent] });
    assert.equal(hashIntent(31337, vault, intent), onchain);
  });

  test("agent signs, relayer settles, merchant is paid", async () => {
    const a = clientFor(agent);
    const { intent, signature } = await a.signPayment(agent, {
      sessionId,
      merchant,
      amount: 3_500_000n,
      orderId: "hoodie-black-M",
    });
    assert.deepEqual(await a.preview(intent, signature), { ok: true });

    const res = await clientFor(relayer).pay(intent, signature);
    assert.equal(res.status, "paid");
    const bal = await pub.readContract({
      address: token,
      abi: artifact("MockUSD8").abi,
      functionName: "balanceOf",
      args: [merchant],
    });
    assert.equal(bal, 3_500_000n);

    const budget = await a.getBudget(sessionId);
    assert.equal(budget.spendableNow, 1_500_000n);
    assert.equal(budget.dailyRemaining, 1_500_000n);
  });

  test("retrying a paid order is idempotent: already-paid, no second charge", async () => {
    const a = clientFor(agent);
    // Fresh signature (new nonce) for the same order, like an agent retrying after a timeout.
    const retry = await a.signPayment(agent, { sessionId, merchant, amount: 3_500_000n, orderId: "hoodie-black-M" });
    const res = await clientFor(relayer).pay(retry.intent, retry.signature);
    assert.equal(res.status, "already-paid");
    assert.equal((await a.getBudget(sessionId)).totalRemaining, 1_500_000n, "budget unchanged");
  });

  test("same order id with a different amount is NOT treated as paid", async () => {
    const a = clientFor(agent);
    const p = await a.signPayment(agent, { sessionId, merchant, amount: 1_000_000n, orderId: "hoodie-black-M" });
    await assert.rejects(clientFor(relayer).pay(p.intent, p.signature), { code: "OrderAlreadyPaid" });
  });

  const rejects = async (code: string, args: Parameters<PeraultClient["signPayment"]>[1], signer = agent) => {
    const a = clientFor(agent);
    const p = await a.signPayment(signer, args);
    const preview = await a.preview(p.intent, p.signature);
    assert.equal(preview.ok, false);
    assert.equal(!preview.ok && preview.code, code);
    await assert.rejects(clientFor(relayer).pay(p.intent, p.signature), (e: unknown) => {
      assert.ok(e instanceof PeraultError);
      assert.equal(e.code, code);
      assert.ok(e.message.length > 10, "plain-language message");
      return true;
    });
  };

  test("over per-payment cap", () => rejects("OverPerTx", { sessionId, merchant, amount: 6_000_000n, orderId: "jacket" }));
  test("over daily cap", () => rejects("OverDaily", { sessionId, merchant, amount: 1_500_001n, orderId: "socks" }));
  test("prompt-injected merchant", () =>
    rejects("MerchantNotAllowed", { sessionId, merchant: attacker, amount: 1_000_000n, orderId: "inject" }));
  test("signed by the wrong key", () =>
    rejects("BadSignature", { sessionId, merchant, amount: 1_000_000n, orderId: "forged" }, privateKeyToAccount(KEYS.stranger)));
  test("expired intent", () =>
    rejects("IntentExpired", { sessionId, merchant, amount: 1n, orderId: "late", nowMs: Date.now() - 3_600_000 }));

  test("owner write reverts become PeraultError before any gas is spent", async () => {
    await assert.rejects(clientFor(owner).withdraw(999_000_000n), { name: "PeraultError", code: "InsufficientBalance" });
    await assert.rejects(clientFor(agent).revoke(sessionId), { code: "NotOwner" });
  });

  test("gasless deposit: owner signs, relayer pays gas, owner is credited", async () => {
    const o = clientFor(owner);
    const before = await o.balanceOf(owner.address);
    const d = await o.signGaslessDeposit(owner, 2_000_000n);
    await clientFor(relayer).submitGaslessDeposit(d);
    assert.equal(await o.balanceOf(owner.address), before + 2_000_000n);
    assert.equal(await o.balanceOf(relayer.address), 0n);
  });

  test("getPayments returns the audit trail", async () => {
    const payments = await clientFor(agent).getPayments({ fromBlock: 0n, sessionId });
    assert.equal(payments.length, 1);
    assert.equal(payments[0].amount, 3_500_000n);
    assert.equal(payments[0].orderId, toOrderId("hoodie-black-M"));
    assert.ok(payments[0].transactionHash);
  });

  test("revoke kills the session", async () => {
    await clientFor(owner).revoke(sessionId);
    assert.equal(await clientFor(agent).isActive(sessionId), false);
    assert.equal((await clientFor(agent).getBudget(sessionId)).spendableNow, 0n);
    await rejects("Revoked", { sessionId, merchant, amount: 1n, orderId: "after-revoke" });
  });

  test("revokeAll kills every session", async () => {
    const o = clientFor(owner);
    const s1 = await o.openSession({ agent: agent.address, perTxCap: 1n, dailyCap: 1n, totalCap: 1n, expiresInSeconds: 600, merchants: [merchant] });
    const s2 = await o.openSession({ agent: agent.address, perTxCap: 1n, dailyCap: 1n, totalCap: 1n, expiresInSeconds: 600, merchants: [merchant] });
    await o.revokeAll();
    assert.equal(await o.isActive(s1.sessionId), false);
    assert.equal(await o.isActive(s2.sessionId), false);
  });
});
