# @perault/x402 — x402 facilitator for Aevum

QDay has no hosted x402 facilitator for Aevum, so this is one: an open-source service that
verifies and settles [x402](https://github.com/coinbase/x402) payments in tUSD8 on Aevum testnet.
Merchants call it; it checks the payment, submits it on-chain and pays the gas.

It settles two schemes:

| scheme | who pays | how | limits |
|---|---|---|---|
| `exact` | any wallet or standard x402 client | EIP-3009 `transferWithAuthorization` on tUSD8 | none beyond the signature |
| `perault` | an AI agent with a Perault session key | `SpendVault.pay` with the agent's signed intent | per-payment, daily and total caps, expiry, merchant allowlist, revocation — enforced on-chain |

`exact` is the standard x402 EVM scheme, so existing x402 clients work unchanged. `perault` is
the answer to "why not just give the agent a wallet?": with `exact` the agent holds a key that
can drain its wallet; with `perault` it holds a key whose only power is a budget the owner can
revoke.

## Run it

```bash
cp packages/x402/.env.example packages/x402/.env   # set FACILITATOR_PRIVATE_KEY and FACILITATOR_API_KEY
make facilitator                                   # or: pnpm --filter @perault/x402 start
```

Docker (build from the repo root):

```bash
docker build -f packages/x402/Dockerfile -t perault-facilitator .
docker run --rm -p 4020:4020 --env-file packages/x402/.env perault-facilitator
```

| variable | required | default | |
|---|---|---|---|
| `FACILITATOR_PRIVATE_KEY` | yes | | relayer key; pays gas, holds no customer funds. Fund with a little tQDAY only. |
| `FACILITATOR_API_KEY` | recommended | | merchants send `Authorization: Bearer <key>` on `/settle` |
| `PORT` | | `4020` | |
| `RPC_URL` | | `https://rpc-test.qday.info` | |
| `CHAIN_ID` | | `44005` | checked against the RPC at startup |
| `VAULT`, `TOKEN`, `NETWORK_NAME` | | Aevum testnet deployment | overrides for a local anvil or fork |

## API

Standard x402 facilitator endpoints. Network name `aevum-testnet` (CAIP-2 `eip155:44005` also accepted).

### `GET /supported`

```json
{ "kinds": [
  { "x402Version": 1, "scheme": "exact",   "network": "aevum-testnet" },
  { "x402Version": 1, "scheme": "perault", "network": "aevum-testnet",
    "extra": { "vault": "0xc615c8682b1A665C6d3d7aB2128ef83210B414Dc" } } ] }
```

### `POST /verify` and `POST /settle`

Body: `{ x402Version: 1, paymentPayload, paymentRequirements }`, where `paymentPayload` is the
decoded `X-PAYMENT` header the client sent the merchant.

`perault` requirements and payload:

```json
{
  "paymentRequirements": {
    "scheme": "perault", "network": "aevum-testnet",
    "maxAmountRequired": "3500000",
    "payTo": "0xStore…", "asset": "0x456569838f1d43009A91ebA4263147Afd7233483",
    "resource": "https://store.example/api/buy?sku=hoodie-black-M",
    "description": "Black hoodie, size M", "mimeType": "application/json", "maxTimeoutSeconds": 120,
    "extra": { "vault": "0xc615…14Dc", "orderId": "hoodie-black-M#1042" }
  },
  "paymentPayload": {
    "x402Version": 1, "scheme": "perault", "network": "aevum-testnet",
    "payload": {
      "signature": "0x…",
      "intent": { "sessionId": "0x…", "merchant": "0xStore…", "amount": "3500000",
                  "orderId": "0x…", "nonce": "0x…", "deadline": "1795000000" }
    }
  }
}
```

Build the payload with the SDK: `perault.signPayment(agentKey, {...})` then `intentToJson(intent)`.

Responses:

```json
{ "isValid": true, "payer": "0xOwner…" }
{ "isValid": false, "invalidReason": "perault_over_daily",
  "invalidMessage": "The amount would exceed today's spending limit (resets 00:00 UTC).", "payer": "0xOwner…" }

{ "success": true, "transaction": "0x…", "network": "aevum-testnet", "payer": "0xOwner…" }
{ "success": false, "errorReason": "perault_merchant_not_allowed", "errorMessage": "…", "transaction": "", "network": "aevum-testnet" }
```

For `perault`, `payer` is the session **owner** (whose vault balance pays), not the agent key.

### `GET /health`

Relayer address and gas balance, for monitoring.

## What it checks

Every request: x402 version, scheme, network, `asset` is tUSD8, `payTo` and amount well formed.

`exact`: recipient is `payTo`, value equals the price, `validAfter`/`validBefore` against
**chain time** (with a 6 s margin), the signature recovers to `from`, the nonce is unused, the
balance covers it, and the transfer simulates cleanly.

`perault`: the signed intent must match the purchase — merchant is `payTo`
(`perault_merchant_mismatch`, which is what a prompt-injected "pay 0xattacker" hits), amount
equals the price, `orderId` matches `extra.orderId`, vault matches — then `SpendVault.preview`
runs every on-chain rule. Vault rejections come back as `perault_<code>` (`perault_over_per_tx`,
`perault_revoked`, …) with a plain-language message.

## Reliability

- **Settle re-verifies** right before submitting; nothing is sent that would revert.
- **Idempotent:** concurrent duplicate `/settle` calls share one submission; retries within an
  hour return the original transaction hash. A `perault` order settled before a restart is found
  on-chain and reported as success with its original hash.
- **Bounded waits:** confirmations time out after 60 s instead of hanging a merchant request.
- Bodies over 64 KB are rejected; the API key is compared in constant time.

## Tests

```bash
make test-x402   # local Shanghai anvil, real SpendVault + MockUSD8 bytecode, requests over HTTP
```

Also checked against a fork of Aevum testnet: `exact` settled against the real tUSD8
(FiatTokenV2) and `perault` against the deployed SpendVault.

## Known constraints

- In-memory idempotency cache: run one instance per relayer key (or put a shared store in front).
- An `exact` payment settled before a restart reports `nonce_already_used` on retry rather than
  the original hash.
- x402 v1 wire format. v2 (`PAYMENT-SIGNATURE` header, CAIP-2 everywhere) is on the roadmap;
  CAIP-2 network names are already accepted.
