# @perault/sdk

On-chain spending budgets for AI agents on QDay Aevum. TypeScript, built on [viem](https://viem.sh).

An owner deposits tUSD8 into the `SpendVault` contract and opens a **session** for an agent key:
a per-payment cap, a daily cap, a total budget, an expiry and a merchant allowlist. The agent
signs payment intents (no gas, no funds); a merchant or relayer submits them. Every limit is
enforced by the contract, so a compromised or prompt-injected agent can't overspend.

| Network | Chain ID | SpendVault | Token |
|---|---|---|---|
| Aevum testnet | 44005 | [`0xc615c8682b1A665C6d3d7aB2128ef83210B414Dc`](https://explorer-test.qday.info/address/0xc615c8682b1A665C6d3d7aB2128ef83210B414Dc) | tUSD8 `0x4565…3483` (6 decimals) |

## Setup

```ts
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PeraultClient, aevumTestnet } from "@perault/sdk";

const publicClient = createPublicClient({ chain: aevumTestnet, transport: http() });
const walletClient = createWalletClient({ account, chain: aevumTestnet, transport: http() });

// vault defaults to the official deployment for the chain
const perault = new PeraultClient({ publicClient, walletClient });
```

## Owner: fund and scope an agent

```ts
await perault.deposit(parseUnits("5", 6)); // approves first if needed

const { sessionId } = await perault.openSession({
  agent: "0xAgentKey…",
  perTxCap: parseUnits("4", 6),
  dailyCap: parseUnits("5", 6),
  totalCap: parseUnits("5", 6),
  expiresInSeconds: 24 * 3600, // measured from chain time
  merchants: ["0xStore…"],
});

await perault.revoke(sessionId); // one session, instantly
await perault.revokeAll();       // kill switch: every session
await perault.withdraw(parseUnits("1.5", 6));
```

Gasless funding (EIP-3009): the owner signs, anyone with gas submits, the owner is credited.

```ts
const deposit = await perault.signGaslessDeposit(ownerAccount, parseUnits("5", 6));
await relayerPerault.submitGaslessDeposit(deposit);
```

## Agent: check the budget, sign a payment

The agent only needs a throwaway key. It never holds tokens or gas.

```ts
const agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
const reader = new PeraultClient({ publicClient });

const { spendableNow, active } = await reader.getBudget(sessionId);

const { intent, signature } = await reader.signPayment(agent, {
  sessionId,
  merchant: "0xStore…",
  amount: parseUnits("3.5", 6),
  orderId: "hoodie-black-M#1042", // hashed to bytes32; one payment per (merchant, order)
  ttlSeconds: 300,
});
```

Send `intentToJson(intent)` and `signature` to the merchant (HTTP-safe; bigints become strings).

## Merchant / relayer: verify and settle

```ts
const intent = intentFromJson(body.intent); // validates every field

const check = await perault.preview(intent, signature); // free dry run of the contract's checks
if (!check.ok) return res.status(402).json({ code: check.code, message: check.message });

const result = await perault.pay(intent, signature);
// { status: "paid", hash, receipt }  or  { status: "already-paid", paidAt } on a retry
```

`pay` is idempotent: if the same session already paid this order for the same amount (a retry
after a timeout), it returns `already-paid` instead of charging twice or throwing.

## Errors

Every contract rejection becomes a `PeraultError` with a stable `code` and a plain-language
`message`, before any gas is spent (writes are simulated first).

```ts
try {
  await perault.pay(intent, signature);
} catch (e) {
  if (e instanceof PeraultError && e.code === "OverDaily") { /* ask the owner for more budget */ }
}
```

| code | meaning |
|---|---|
| `OverPerTx` / `OverDaily` / `OverTotal` | over a cap (daily resets 00:00 UTC) |
| `MerchantNotAllowed` | merchant isn't on the session's allowlist |
| `Revoked` / `SessionExpired` | session is dead |
| `BadSignature` | not signed by the session's agent, or altered after signing |
| `NonceUsed` / `OrderAlreadyPaid` | replay / duplicate order |
| `IntentExpired` | signed payment is past its deadline |
| `InsufficientBalance` | owner's vault balance is too low |

Full list: `VAULT_ERROR_MESSAGES`.

## Audit trail

```ts
const payments = await perault.getPayments({ sessionId }); // scans in ≤1,000-block chunks (Aevum limit)
// [{ sessionId, merchant, orderId, owner, agent, amount, nonce, transactionHash, blockNumber }]
```

## Lower level

`buildIntent`, `signIntent`, `hashIntent`, `intentTypedData`, `peraultDomain` and
`paymentIntentTypes` are exported for custom signers (hardware wallets, MPC, browser wallets
via wagmi). `hashIntent` is tested to match `SpendVault.hashIntent` byte for byte.

## Development

```bash
cd contracts && forge build && cd ..
node tools/gen-sdk-abi.mjs            # regenerate src/abi.ts from the compiled contract
pnpm --filter @perault/sdk test       # spins up anvil (Shanghai) and runs against real bytecode
pnpm --filter @perault/sdk typecheck
```

## Known constraints

- Aevum has no WebSocket RPC; receipts are polled over HTTPS.
- `getPayments` over a long range makes one RPC call per 1,000 blocks. Pass `fromBlock` when you can.
- The SDK ships TypeScript source (workspace package). A compiled npm build is on the roadmap.
