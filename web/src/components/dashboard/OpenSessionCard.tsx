"use client";

import { useMemo, useState } from "react";
import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useAccount } from "wagmi";
import { usePerault, useTx } from "@/lib/perault";
import { CopyButton, TxStatus, money, parseMoney, short } from "./shared";

const DURATIONS = [
  { label: "1 hour", seconds: 3600 },
  { label: "24 hours", seconds: 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
];

const DEFAULT_STORE = process.env.NEXT_PUBLIC_DEMO_STORE ?? "";

export function OpenSessionCard({ onOpened }: { onOpened: () => void }) {
  const { address } = useAccount();
  const { writer, vault } = usePerault();
  const tx = useTx();

  const [agent, setAgent] = useState("");
  const [generatedKey, setGeneratedKey] = useState<Hex | null>(null);
  const [perTx, setPerTx] = useState("4");
  const [daily, setDaily] = useState("5");
  const [total, setTotal] = useState("5");
  const [duration, setDuration] = useState(86_400);
  const [merchantsText, setMerchantsText] = useState(DEFAULT_STORE);
  const [opened, setOpened] = useState<{ sessionId: Hex; agentKey: Hex | null } | null>(null);

  const merchants = useMemo(
    () => [...new Set(merchantsText.split(/[\s,]+/).filter(Boolean))],
    [merchantsText],
  );
  const badMerchants = merchants.filter((m) => !isAddress(m));
  const p = parseMoney(perTx), d = parseMoney(daily), t = parseMoney(total);

  const errors = {
    agent: !agent ? "Enter the agent's address, or generate a new agent key." : !isAddress(agent) ? "Not a valid address." : undefined,
    caps:
      !p || !d || !t
        ? "Enter amounts like 4 or 3.50."
        : p > d
          ? "Per-payment cap can't exceed the daily cap."
          : d > t
            ? "Daily cap can't exceed the total budget."
            : undefined,
    merchants: badMerchants.length ? `Not an address: ${badMerchants.slice(0, 2).join(", ")}` : undefined,
  };
  const warnings = [
    agent && isAddress(agent) && address && isAddressEqual(agent as Address, address) &&
      "The agent is your own wallet. Use a separate key: the point is that the agent's key can only spend this budget.",
    merchants.length === 0 && "No merchants: the agent won't be able to pay anyone until you add one.",
  ].filter(Boolean) as string[];
  const valid = !errors.agent && !errors.caps && !errors.merchants;
  const busy = tx.state.status === "wallet" || tx.state.status === "pending";
  const durationLabel = DURATIONS.find((x) => x.seconds === duration)?.label ?? `${duration}s`;

  function generate() {
    const key = generatePrivateKey();
    setGeneratedKey(key);
    setAgent(privateKeyToAccount(key).address);
  }

  async function open() {
    if (!writer || !valid || !p || !d || !t) return;
    const agentKey = generatedKey && isAddressEqual(privateKeyToAccount(generatedKey).address, agent as Address) ? generatedKey : null;
    await tx.run(
      "Open session",
      () =>
        writer.openSession({
          agent: getAddress(agent),
          perTxCap: p,
          dailyCap: d,
          totalCap: t,
          expiresInSeconds: duration,
          merchants: merchants.map((m) => getAddress(m)),
        }),
      (r) => {
        setOpened({ sessionId: r.sessionId, agentKey });
        onOpened();
      },
    );
  }

  if (opened) {
    const mcpConfig = JSON.stringify(
      {
        mcpServers: {
          perault: {
            command: "npx",
            args: ["tsx", "<path-to-perault>/packages/mcp/src/main.ts"],
            env: {
              AGENT_PRIVATE_KEY: opened.agentKey ?? "<the agent's private key>",
              PERAULT_SESSION_ID: opened.sessionId,
              PERAULT_MAX_AMOUNT: money(p).replace(/,/g, ""),
            },
          },
        },
      },
      null,
      2,
    );
    return (
      <section className="card stack" aria-labelledby="open-h">
        <h2 id="open-h">Session opened</h2>
        <TxStatus state={tx.state} />
        <dl className="kv">
          <dt>Session ID</dt>
          <dd>{opened.sessionId}</dd>
          <dt>Agent</dt>
          <dd>{agent}</dd>
          <dt>Vault</dt>
          <dd>{vault}</dd>
        </dl>
        {opened.agentKey && (
          <div className="notice warn">
            <strong>Agent key: shown once, not stored anywhere</strong>
            <span>Copy it into your agent&apos;s config now. Its only power is this session&apos;s budget, and revoking the session makes it worthless.</span>
            <div className="secret">{opened.agentKey}</div>
            <div className="inline">
              <CopyButton text={opened.agentKey} label="Copy key" />
            </div>
          </div>
        )}
        <div className="stack" style={{ gap: 8 }}>
          <strong>Connect Claude (claude_desktop_config.json)</strong>
          <pre className="code">
            <code>{mcpConfig}</code>
          </pre>
          <div className="inline">
            <CopyButton text={mcpConfig} label="Copy MCP config" />
            <CopyButton text={opened.sessionId} label="Copy session ID" />
          </div>
        </div>
        <button
          type="button"
          className="btn secondary"
          onClick={() => {
            setOpened(null);
            setGeneratedKey(null);
            setAgent("");
            tx.reset();
          }}
        >
          Open another session
        </button>
      </section>
    );
  }

  return (
    <section className="card stack" aria-labelledby="open-h">
      <div>
        <h2 id="open-h">Give an agent a budget</h2>
        <p className="sub">Every limit is enforced by the contract, so even a tricked agent can&apos;t exceed it.</p>
      </div>
      <div className="form">
        <label>
          Agent address
          <div className="inline">
            <input
              className="field"
              placeholder="0x…"
              value={agent}
              onChange={(e) => {
                setAgent(e.target.value.trim());
                setGeneratedKey(null);
              }}
              aria-invalid={agent !== "" && Boolean(errors.agent)}
            />
            <button type="button" className="btn secondary small" onClick={generate}>
              Generate new agent key
            </button>
          </div>
          {generatedKey ? (
            <span className="hint">New key made in this browser. You&apos;ll see it once after the session opens.</span>
          ) : (
            <span className="hint">The key your agent signs with. It never holds funds or gas.</span>
          )}
          {agent !== "" && errors.agent && <span className="err">{errors.agent}</span>}
        </label>

        <div className="form-row">
          <label>
            Per payment
            <input className="field" inputMode="decimal" value={perTx} onChange={(e) => setPerTx(e.target.value)} aria-invalid={!p} />
          </label>
          <label>
            Per day
            <input className="field" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} aria-invalid={!d} />
          </label>
          <label>
            Total budget
            <input className="field" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} aria-invalid={!t} />
          </label>
          <label>
            Expires after
            <select className="field" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((x) => (
                <option key={x.seconds} value={x.seconds}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {errors.caps && <span className="err">{errors.caps}</span>}

        <label>
          Allowed merchants
          <textarea
            className="field"
            placeholder="0x… one per line"
            value={merchantsText}
            onChange={(e) => setMerchantsText(e.target.value)}
            aria-invalid={Boolean(errors.merchants)}
          />
          <span className="hint">The agent can pay these addresses and nobody else. You can add or remove them later.</span>
          {errors.merchants && <span className="err">{errors.merchants}</span>}
        </label>
      </div>

      {valid && p && d && t && (
        <div className="review" aria-live="polite">
          You&apos;re letting agent <strong className="mono">{short(agent)}</strong> spend up to <strong>{money(p)} tUSD8 per payment</strong>,{" "}
          <strong>{money(d)} per day</strong> and <strong>{money(t)} in total</strong> from your vault, only at{" "}
          <strong>
            {merchants.length} merchant{merchants.length === 1 ? "" : "s"}
          </strong>
          , for <strong>{durationLabel}</strong>. You can revoke it at any time.
        </div>
      )}
      {warnings.map((w) => (
        <div key={w} className="notice warn">
          {w}
        </div>
      ))}
      <button type="button" className="btn big" disabled={!writer || !valid || busy} onClick={open}>
        {writer ? "Open session" : "Connect your wallet to open a session"}
      </button>
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </section>
  );
}
