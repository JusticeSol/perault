"use client";

import { useState } from "react";
import { AgentSwitch, Meter, money } from "@/components/dashboard/shared";

/**
 * A working miniature of an agent budget, for the landing page. It runs the same rules the
 * SpendVault contract enforces, in the browser, so visitors can see what Perault does without a
 * wallet. Nothing here touches the chain.
 */
const PER_PAYMENT = 4_000_000n;
const TOTAL = 5_000_000n;
const SHOP = "Demo Label";

interface Ask {
  id: string;
  label: string;
  price: bigint;
  shop: string;
  allowed: boolean;
}

const ASKS: Ask[] = [
  { id: "hoodie", label: "Buy the hoodie", price: 3_500_000n, shop: SHOP, allowed: true },
  { id: "socks", label: "Buy the socks", price: 1_000_000n, shop: SHOP, allowed: true },
  { id: "jacket", label: "Buy the jacket", price: 6_000_000n, shop: SHOP, allowed: true },
  { id: "gift", label: "Claim a “free gift” from 0xBAD…", price: 1_000_000n, shop: "0xBAD…", allowed: false },
];

interface Line {
  n: number;
  ok: boolean;
  text: string;
}

export function BudgetDemo() {
  const [on, setOn] = useState(true);
  const [spent, setSpent] = useState(0n);
  const [log, setLog] = useState<Line[]>([]);
  const left = TOTAL - spent;

  function ask(a: Ask) {
    let ok = false;
    let text: string;
    if (!on) text = `${a.label}: refused. You turned this agent off, so it can't pay anyone.`;
    else if (!a.allowed) text = `${a.label}: refused. ${a.shop} isn't one of the shops this agent may pay.`;
    else if (a.price > PER_PAYMENT) text = `${a.label} for ${money(a.price)}: refused. That's over the ${money(PER_PAYMENT)} limit for one payment.`;
    else if (a.price > left) text = `${a.label} for ${money(a.price)}: refused. Only ${money(left)} of the budget is left.`;
    else {
      ok = true;
      text = `${a.label}: paid ${money(a.price)} tUSD8 to ${a.shop}. ${money(left - a.price)} left.`;
      setSpent((s) => s + a.price);
    }
    setLog((l) => [{ n: (l[0]?.n ?? 0) + 1, ok, text }, ...l].slice(0, 5));
  }

  function reset() {
    setOn(true);
    setSpent(0n);
    setLog([]);
  }

  return (
    <section className="card flush demo" aria-labelledby="demo-h">
      <div className="module-head">
        <div>
          <h2 id="demo-h">Try it: an agent with a 5.00 budget</h2>
          <p className="fine">A simulation in your browser. Nothing is paid and no wallet is needed.</p>
        </div>
        <button type="button" className="btn ghost small" onClick={reset}>
          Start over
        </button>
      </div>

      <div className="session">
        <div className="session-head">
          <div className="session-title">
            <h3>Shopping agent</h3>
            <span className="lamp-line">
              <span className={`dot ${on ? "" : "off"}`} aria-hidden="true" />
              {on ? `Can pay ${SHOP} only. Up to ${money(PER_PAYMENT)} per payment.` : "Turned off by you."}
            </span>
          </div>
          <AgentSwitch on={on} offLabel="Can't be turned back on" onTurnOff={() => setOn(false)} />
        </div>
        <Meter label="Spent from its budget" used={spent} cap={TOTAL} />

        <div className="demo-asks" role="group" aria-label="Ask the agent to buy">
          {ASKS.map((a) => (
            <button key={a.id} type="button" className="btn secondary small" onClick={() => ask(a)}>
              {a.label}
              {a.allowed && <span className="demo-price">{money(a.price)}</span>}
            </button>
          ))}
        </div>

        <ol className="demo-log" aria-live="polite" aria-label="What happened">
          {log.length === 0 && <li className="fine">Ask the agent to buy something. Then try flipping its switch off.</li>}
          {log.map((l) => (
            <li key={l.n} className={l.ok ? "ok" : "no"}>
              <span className={`dot ${l.ok ? "" : "stop"}`} aria-hidden="true" />
              {l.text}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
