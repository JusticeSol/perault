import type { Metadata } from "next";
import Link from "next/link";
import { links } from "@aevum-kit/aevum";
import { PERAULT_DEPLOYMENTS } from "@perault/sdk";
import { BudgetDemo } from "@/components/landing/BudgetDemo";
import { repoUrl } from "@/lib/env";

export const metadata: Metadata = {
  title: { absolute: "Perault: budgets for AI agents" },
  description: "Give your AI agent a budget, not your wallet. Spending limits and an off switch, enforced on-chain on QDay Aevum.",
};

const VAULT = PERAULT_DEPLOYMENTS[44005].vault;
const tx = (h: string) => `${links.explorer}/tx/${h}`;

const PROOF = [
  { text: "Claude buys a hoodie through the Perault MCP server", hash: "0x261b7403288011006ee56868fabb4700e30c88948abfc5afa7e17840c3ae3a26" },
  { text: "A person buys socks on this site with their own wallet", hash: "0xcf873a7958e1c777b065ace458757e0a385d8b4dfce628b94b6357f855457a57" },
  { text: "An owner turns an agent off", hash: "0x182400a6130ad60c475774d88497880fec1de5b139b559a1523a65d31c20f644" },
];

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

export default function Home() {
  return (
    <main className="shell landing">
      <section className="hero">
        <div className="hero-copy">
          <h1>Give your AI agent a budget, not your wallet.</h1>
          <p className="lede">
            Perault lets an agent pay for things with limits you set: how much per payment, per day and in total, which shops, and until when.
            Flip its switch and it stops at once. The rules live in a contract on QDay Aevum, so even a tricked agent can&apos;t break them.
          </p>
          <div className="inline hero-actions">
            <Link className="btn big" href="/dashboard">
              Give an agent a budget
            </Link>
            <Link className="btn secondary big" href="/store">
              Visit the demo store
            </Link>
          </div>
        </div>
        <BudgetDemo />
      </section>

      <section className="steps-row" aria-labelledby="how-h">
        <h2 id="how-h">How it works</h2>
        <ol className="how">
          <li>
            <h3>Fill the vault</h3>
            <p>Put tUSD8 in your vault. It stays yours, and only you can take it out.</p>
          </li>
          <li>
            <h3>Give an agent a budget</h3>
            <p>Set its limits and the shops it may pay. The agent gets a key that can only sign payments within them.</p>
          </li>
          <li>
            <h3>Let it shop</h3>
            <p>
              Shops ask for payment with x402. The agent signs, the shop&apos;s facilitator settles, and the contract checks every limit before
              money moves.
            </p>
          </li>
        </ol>
      </section>

      <section className="split" aria-labelledby="proof-h">
        <div>
          <h2 id="proof-h">Already running on Aevum</h2>
          <p className="sub">Real transactions on QDay Aevum testnet. Open any of them on the explorer.</p>
        </div>
        <ul className="proof">
          {PROOF.map((p) => (
            <li key={p.hash}>
              <span>{p.text}</span>
              <a href={tx(p.hash)} target="_blank" rel="noreferrer">
                {short(p.hash)}
              </a>
            </li>
          ))}
          <li>
            <span>The SpendVault contract</span>
            <a href={`${links.explorer}/address/${VAULT}`} target="_blank" rel="noreferrer">
              {short(VAULT)}
            </a>
          </li>
        </ul>
      </section>

      <section className="split" aria-labelledby="build-h">
        <div>
          <h2 id="build-h">Build with it</h2>
          <p className="sub">Open source under MIT. Use the parts you need.</p>
        </div>
        <dl className="kits">
          <dt>For shops and APIs</dt>
          <dd>
            Put any endpoint behind a payment in a few lines, and use the public x402 facilitator for Aevum. <Link href="/docs#merchants">Merchant docs</Link>
          </dd>
          <dt>For agents</dt>
          <dd>
            Connect Claude through the MCP server, or use a <code>fetch</code> that pays on its own. <Link href="/docs#agents">Agent docs</Link>
          </dd>
          <dt>For apps</dt>
          <dd>
            Open, watch and turn off budgets from code with the TypeScript SDK.{" "}
            <a href={`${repoUrl}/tree/main/packages/perault-sdk`} target="_blank" rel="noreferrer">
              SDK on GitHub
            </a>
          </dd>
        </dl>
      </section>
    </main>
  );
}
