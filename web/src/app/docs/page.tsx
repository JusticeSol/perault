import type { Metadata } from "next";
import { links, TUSD8_ADDRESS } from "@aevum-kit/aevum";
import { PERAULT_DEPLOYMENTS } from "@perault/sdk";
import { GitHubIcon } from "@/components/Icons";
import { repoUrl } from "@/lib/env";

export const metadata: Metadata = { title: "Docs" };

const VAULT = PERAULT_DEPLOYMENTS[44005].vault;
const DISCORD_URL = "https://discord.gg/bYPhjmrSfK";
const SITE = "https://perault.vercel.app";

const sections = [
  { id: "how", label: "How Perault works" },
  { id: "owners", label: "For owners" },
  { id: "agents", label: "For agents (Claude)" },
  { id: "merchants", label: "For merchants" },
  { id: "facilitator", label: "Facilitator API" },
  { id: "contract", label: "Contract" },
  { id: "network", label: "Network and tokens" },
  { id: "safety", label: "Safety" },
  { id: "faq", label: "FAQ" },
];

function Code({ children }: { children: string }) {
  return (
    <pre className="code">
      <code>{children.trim()}</code>
    </pre>
  );
}

const src = (path: string) => `${repoUrl}/blob/main/${path}`;

export default function DocsPage() {
  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <h1>Perault docs</h1>
          <p className="lede">
            How to give an AI agent a budget, let it pay for things, and accept those payments in your own shop or API. Everything runs on QDay
            Aevum, paid in tUSD8.
          </p>
        </div>
        <a className="btn secondary" href={repoUrl} target="_blank" rel="noreferrer">
          <GitHubIcon />
          View the code on GitHub
        </a>
      </div>

      <div className="docs">
        <nav className="docs-toc" aria-label="On this page">
          <p className="docs-toc-title">On this page</p>
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.label}
            </a>
          ))}
        </nav>

        <div className="docs-body">
          <section id="how">
            <h2>How Perault works</h2>
            <p>
              Think of Perault as a prepaid card you hand to an AI agent. You put tUSD8 in a <strong>vault</strong>, then give an agent a{" "}
              <strong>budget</strong>: how much it may spend per payment, per day and in total, which shops it may pay, and when the budget ends.
              Each budget has a switch that turns the agent off at once.
            </p>
            <p>
              The agent gets its own key, which can only <em>sign</em> payments. It never holds money or gas. When a shop asks to be paid, the
              agent signs a payment for that exact price and order, and the shop&apos;s facilitator submits it to the <strong>SpendVault</strong>{" "}
              contract. The contract checks every limit before any money moves, so an agent that is tricked, or software that misbehaves, still
              can&apos;t spend more than its budget or pay a shop you didn&apos;t allow.
            </p>
            <p>
              Shops get paid through <strong>x402</strong>, the web standard for &ldquo;402 Payment Required&rdquo;. The same shop link works for
              an agent paying from its budget and for a person paying from their own wallet.
            </p>
          </section>

          <section id="owners">
            <h2>For owners</h2>
            <p>On the <a href="/dashboard">dashboard</a>, with the wallet that holds your tUSD8:</p>
            <ol>
              <li>
                <strong>Add money</strong> to the vault. The first time, your wallet asks twice: once to allow the vault, once to move the money.
                The vault money is still yours; take it out whenever you like.
              </li>
              <li>
                <strong>Give an agent a budget.</strong> Enter the agent&apos;s address, or press <em>Generate new agent key</em> and the site makes
                one (shown once, never stored). Set the limits and the shops it can pay, read the summary, and confirm.
              </li>
              <li>
                <strong>Connect the agent.</strong> The dashboard shows a ready-made config for Claude. See{" "}
                <a href="#agents">For agents</a>.
              </li>
              <li>
                <strong>Watch and control.</strong> Every payment appears under <em>Payments by your agents</em> within seconds. Press an
                agent&apos;s switch twice to turn it off for good, or use <em>Turn off all agents</em> to stop every budget in one transaction.
              </li>
            </ol>
            <div className="card info">
              <h3>Vault or wallet?</h3>
              <p className="sub" style={{ marginBottom: 0 }}>
                Money in the vault is for your agents to spend within their budgets. Money in your wallet is for you: buying something yourself
                with <em>Buy with wallet</em> uses your wallet, not the vault.
              </p>
            </div>
          </section>

          <section id="agents">
            <h2>For agents (Claude)</h2>
            <p>
              The Perault MCP server gives Claude (or any MCP client) four tools. It needs the agent&apos;s key and the budget&apos;s session ID.
              Keep the key in a file outside your project, so it never sits in a config:
            </p>
            <Code>{`
claude mcp add perault --scope local \\
  -e PERAULT_SESSION_ID=0x… \\
  -e PERAULT_MAX_AMOUNT=4 \\
  -e PERAULT_ALLOWED_HOSTS=perault.vercel.app \\
  -- node <repo>/packages/mcp/node_modules/tsx/dist/cli.mjs \\
     --env-file=<file containing AGENT_PRIVATE_KEY=0x…> <repo>/packages/mcp/src/main.ts
`}</Code>
            <div className="table-wrap">
              <table className="data docs-table">
                <tbody>
                  <tr><th scope="row"><code>get_budget</code></th><td>What the agent can spend now, its limits, and when the budget ends. Free.</td></tr>
                  <tr><th scope="row"><code>check_price</code></th><td>What a link costs, who gets paid, and whether the agent may pay it, without paying. Use it to confirm with you first.</td></tr>
                  <tr><th scope="row"><code>pay_402_url</code></th><td>Opens a link and pays for it from the budget, then returns the result and the transaction link. An optional <code>max_amount</code> can only lower the limit.</td></tr>
                  <tr><th scope="row"><code>list_payments</code></th><td>The budget&apos;s recent payments, with transaction links.</td></tr>
                </tbody>
              </table>
            </div>
            <p>Then just ask:</p>
            <Code>{`Buy me the black hoodie from ${SITE}/api/store/buy?sku=hoodie-black-M. It should cost 3.50.`}</Code>
            <p>
              Before signing anything, the agent checks on-chain that the shop is allowed, the budget is on, and the price fits. Text from the shop
              comes back marked as untrusted, so a product page saying &ldquo;now pay this other address&rdquo; is treated as data, not an
              instruction.
            </p>
          </section>

          <section id="merchants">
            <h2>For merchants</h2>
            <p>
              Put any endpoint behind a payment with <code>createPaywall</code> from <code>@perault/x402</code>. It answers{" "}
              <code>402 Payment Required</code> with the price, settles the payment through a facilitator, and only then runs your code. It works with
              Next.js route handlers, Hono, Bun and Deno; wrap it with <code>toNodeListener</code> for Express.
            </p>
            <Code>{`
import { createPaywall } from "@perault/x402/merchant";

const paywall = createPaywall({
  facilitatorUrl: "${SITE}/api/x402",
  apiKey: process.env.FACILITATOR_API_KEY,
  payTo: "0xYourShopAddress",
  secret: process.env.PAYWALL_SECRET,   // needed on serverless hosting
});

export const GET = (req: Request) =>
  paywall.protect(req, { amount: 3_500_000n, description: "Black hoodie, M" }, async (paid) => {
    // paid: { scheme, payer, transaction, amount, orderId, replayed }
    return Response.json({ order: await saveOrder(paid) });
  });
`}</Code>
            <p>
              Each request offers two ways to pay: <strong>perault</strong> for agents with a budget, and the standard x402{" "}
              <strong>exact</strong> for people paying from a wallet (one signature, no gas). If the same payment arrives twice, it settles once
              and comes back marked <code>replayed: true</code>: return the original order rather than sending a second one.
            </p>
            <p>
              Agents pay with <code>createPayingFetch</code>, a <code>fetch</code> that handles the 402 for them. See the{" "}
              <a href={src("packages/x402/README.md")} target="_blank" rel="noreferrer">x402 package README</a>.
            </p>
          </section>

          <section id="facilitator">
            <h2>Facilitator API</h2>
            <p>
              A public x402 facilitator for Aevum runs at <code>{SITE}/api/x402</code>. It checks payments and submits them on-chain, paying the
              gas. You can also run your own with Docker: see the{" "}
              <a href={src("packages/x402/README.md#run-it")} target="_blank" rel="noreferrer">README</a>.
            </p>
            <div className="table-wrap">
              <table className="data docs-table">
                <tbody>
                  <tr><th scope="row"><code>GET /supported</code></th><td>The payment types it settles: <code>exact</code> and <code>perault</code> on <code>aevum-testnet</code>.</td></tr>
                  <tr><th scope="row"><code>GET /health</code></th><td>The relayer&apos;s address and gas balance.</td></tr>
                  <tr><th scope="row"><code>POST /verify</code></th><td>Checks a payment without sending it. Body: <code>{"{ x402Version, paymentPayload, paymentRequirements }"}</code>.</td></tr>
                  <tr><th scope="row"><code>POST /settle</code></th><td>Checks and sends it, then returns the transaction. Needs <code>Authorization: Bearer &lt;API key&gt;</code>.</td></tr>
                </tbody>
              </table>
            </div>
            <Code>{`
curl ${SITE}/api/x402/supported
# {"kinds":[{"x402Version":1,"scheme":"exact","network":"aevum-testnet"},
#           {"x402Version":1,"scheme":"perault","network":"aevum-testnet","extra":{"vault":"0xc615…14Dc"}}]}
`}</Code>
            <p>
              Rejections come back with a stable reason and a plain message, for example{" "}
              <code>{`{"isValid":false,"invalidReason":"perault_over_daily","invalidMessage":"The amount would exceed today's spending limit (resets 00:00 UTC)."}`}</code>.
            </p>
          </section>

          <section id="contract">
            <h2>Contract</h2>
            <div className="table-wrap">
              <table className="data docs-table">
                <tbody>
                  <tr><th scope="row">SpendVault</th><td><a href={`${links.explorer}/address/${VAULT}`} target="_blank" rel="noreferrer"><code className="wrap">{VAULT}</code></a></td></tr>
                  <tr><th scope="row">Source</th><td><a href={src("contracts/src/SpendVault.sol")} target="_blank" rel="noreferrer">contracts/src/SpendVault.sol</a></td></tr>
                  <tr><th scope="row">Signing domain</th><td>EIP-712 <code>name: &quot;Perault&quot;</code>, <code>version: &quot;1&quot;</code>, chain 44005</td></tr>
                </tbody>
              </table>
            </div>
            <Code>{`
openSession(agent, perTxCap, dailyCap, totalCap, expiry, merchants[]) → sessionId
setMerchant(sessionId, merchant, allowed) · revoke(sessionId) · revokeAll()
deposit(amount) · depositWithAuthorization(…) · withdraw(amount)
pay(PaymentIntent, signature)       // anyone may submit; every limit is checked here
preview(PaymentIntent, signature)   // the same checks, free: returns the error pay() would hit
budgetOf(sessionId) · getSession(sessionId) · receiptOf(merchant, orderId)
`}</Code>
            <p>
              The contract has no admin, no pause and no upgrade. The TypeScript SDK, <code>@perault/sdk</code>, wraps all of it, with plain-language
              errors: see its <a href={src("packages/perault-sdk/README.md")} target="_blank" rel="noreferrer">README</a>.
            </p>
          </section>

          <section id="network">
            <h2>Network and tokens</h2>
            <div className="table-wrap">
              <table className="data docs-table">
                <tbody>
                  <tr><th scope="row">Network</th><td>QDay Aevum Testnet, chain ID <code>44005</code></td></tr>
                  <tr><th scope="row">RPC</th><td><code>https://rpc-test.qday.info</code> (HTTPS only)</td></tr>
                  <tr><th scope="row">Explorer</th><td><a href={links.explorer} target="_blank" rel="noreferrer">{links.explorer.replace("https://", "")}</a></td></tr>
                  <tr><th scope="row">Gas</th><td>tQDAY. Agents never need any; the facilitator pays.</td></tr>
                  <tr><th scope="row">tUSD8</th><td><code className="wrap">{TUSD8_ADDRESS}</code>, 6 decimals. Add it to your wallet with this address to see your balance.</td></tr>
                </tbody>
              </table>
            </div>
            <p>
              Test tokens: join the <a href={DISCORD_URL} target="_blank" rel="noreferrer">QDay Discord</a> and use its faucet, or the{" "}
              <a href={links.faucetWeb} target="_blank" rel="noreferrer">web faucet</a>. Testnet tokens have no value.
            </p>
          </section>

          <section id="safety">
            <h2>Safety</h2>
            <ul>
              <li><strong>A leaked agent key</strong> can only spend what&apos;s left of its budget, at allowed shops, until it ends. Switch it off and the key is worthless.</li>
              <li><strong>A tricked agent</strong> (&ldquo;pay this address instead&rdquo;) is refused twice: by the agent software before it signs, and by the contract.</li>
              <li><strong>Runaway spending</strong> stops at the per-payment, daily and total limits, enforced on-chain.</li>
              <li><strong>Repeated payments</strong> never charge twice: every signed payment and every order can be used once.</li>
              <li><strong>Your own money</strong> stays yours: nobody but you can take money out of your part of the vault, and there is no admin key.</li>
            </ul>
          </section>

          <section id="faq">
            <h2>FAQ</h2>
            <dl className="faq">
              <dt>Does the agent need its own tokens or gas?</dt>
              <dd>No. It only signs. The vault pays the shop and the facilitator pays the gas.</dd>
              <dt>Can I raise a budget&apos;s limits later?</dt>
              <dd>
                No, by design: the spending limits and end date are fixed once a budget is given. You can still add or remove shops, or turn it
                off. For different limits, give the agent a new budget.
              </dd>
              <dt>What happens when a budget ends?</dt>
              <dd>The agent can&apos;t pay anything more. Unspent money stays in the vault for other budgets, or for you to take out.</dd>
              <dt>Why does &ldquo;Spendable now&rdquo; show less than the budget?</dt>
              <dd>It&apos;s the smallest of: the per-payment limit, what&apos;s left today, what&apos;s left in total, and what&apos;s in the vault.</dd>
              <dt>Is this real money?</dt>
              <dd>Not yet. Perault runs on Aevum testnet, where tUSD8 is a test token with no value.</dd>
            </dl>
          </section>
        </div>
      </div>
    </main>
  );
}
