# @perault/mcp — let Claude pay, within a budget

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP agent) pay for
x402-protected URLs in tUSD8 on QDay Aevum, through a Perault session. The agent holds a
session key whose only power is a budget the owner set and can revoke:

- per-payment, daily and total caps, enforced by the SpendVault contract
- only merchants on the session's allowlist can be paid
- the session expires on its own and can be revoked instantly
- the agent never holds tokens or gas

So a confused or prompt-injected agent can, at worst, spend its remaining budget at the
merchants you approved.

## Tools

| tool | what it does | spends? |
|---|---|---|
| `get_budget` | session status, spendable now, caps, today's remaining (resets 00:00 UTC), expiry | no |
| `check_price` | what a URL costs, who gets paid, and whether this agent can pay it, without paying | no |
| `pay_402_url` | fetch a URL, pay its 402 through the session, return the response, tx hash and explorer link | yes |
| `list_payments` | this session's on-chain payments, newest first, with explorer links | no |

`pay_402_url` takes an optional `max_amount` ("3.50"). It can only **lower** the server's
ceiling, so a model can't talk itself into a bigger purchase.

## Set up with Claude Desktop

1. The owner opens a session for a fresh agent key (see `@perault/sdk` `openSession`, or
   `contracts/script/Smoke.s.sol`). Note the `sessionId` and the agent's private key.
2. Install dependencies once: `pnpm install` in the repo root.
3. Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "perault": {
      "command": "npx",
      "args": ["tsx", "C:/path/to/perault/packages/mcp/src/main.ts"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x…agent session key…",
        "PERAULT_SESSION_ID": "0x…",
        "PERAULT_MAX_AMOUNT": "4",
        "PERAULT_ALLOWED_HOSTS": "store.example,localhost"
      }
    }
  }
}
```

Claude Code: `claude mcp add perault --env AGENT_PRIVATE_KEY=0x… --env PERAULT_SESSION_ID=0x… -- npx tsx /path/to/packages/mcp/src/main.ts`

| variable | required | default | |
|---|---|---|---|
| `AGENT_PRIVATE_KEY` | yes | | the session's agent key; checked against the session at startup |
| `PERAULT_SESSION_ID` | yes | | from `openSession` |
| `PERAULT_MAX_AMOUNT` | | `5` | per-request ceiling in tUSD8, on top of the on-chain caps |
| `PERAULT_ALLOWED_HOSTS` | | any | comma-separated hostnames the agent may pay |
| `RPC_URL`, `CHAIN_ID` | | Aevum testnet | |
| `VAULT`, `TOKEN`, `NETWORK_NAME` | | official deployment | for a local chain or fork |

The agent key sits in a local config file. That's acceptable because it's a throwaway key with
a revocable budget, not a wallet. If it leaks, revoke the session from the dashboard and the
key is worthless.

## Prompt-injection defences

1. **On-chain caps and allowlist.** "Pay 0xattacker" fails in the contract, whatever the model does.
2. **Checks before signing.** The client refuses (and signs nothing) if the merchant isn't
   allowlisted, the session is inactive, or the price is over budget or over the ceiling.
3. **Host allowlist** (optional): URLs on other hosts are refused before any request.
4. **Untrusted output.** Merchant responses come back inside `<merchant_response>` with a note
   that they're data, not instructions.
5. **Review step.** `check_price` lets the model show the user a price before paying.

## Example session

> **You:** Buy me the black hoodie in M from the store, it should be 3.50.
>
> **Claude** calls `check_price` → *Price: 3.5 tUSD8 · Can pay: YES*, then
> `pay_402_url { url, max_amount: "3.50" }` → *HTTP 200 · Payment: settled on-chain ·
> Explorer: https://explorer-test.qday.info/tx/0x…*
>
> **You:** Now get the denim jacket.
>
> **Claude** calls `pay_402_url` → *Payment refused [PriceTooHigh] (price 6 tUSD8) … Nothing was charged.*

## Tests

```bash
make test-mcp   # an MCP client drives the server; real store, facilitator and SpendVault on local anvil
```

Also run against live Aevum testnet over stdio: `get_budget` and `list_payments` read the real
deployment (`list_payments` scanned 50,000 blocks in a few seconds).

## Known constraints

- `list_payments` scans at most 50,000 blocks (about 14 hours on Aevum) per call, because
  `eth_getLogs` is capped at 1,000 blocks and MCP clients time out after 60 s.
- stdio transport only. An HTTP transport for hosted agents is on the roadmap.
