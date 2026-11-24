"use client";

import { useState } from "react";
import { usePerault, useTx } from "@/lib/perault";
import { TxStatus, money, parseMoney } from "./shared";

export function VaultCard({
  vaultBalance,
  walletBalance,
  committed,
  onChange,
}: {
  vaultBalance?: bigint;
  walletBalance?: bigint;
  /** Sum of what agents that are on could still spend (may exceed the vault balance). */
  committed: bigint;
  onChange: () => void;
}) {
  const { writer } = usePerault();
  const tx = useTx();
  const [dep, setDep] = useState("");
  const [wd, setWd] = useState("");
  const depAmount = parseMoney(dep);
  const wdAmount = parseMoney(wd);
  const busy = tx.state.status === "wallet" || tx.state.status === "pending";
  const depTooMuch = depAmount !== undefined && walletBalance !== undefined && depAmount > walletBalance;
  const wdTooMuch = wdAmount !== undefined && vaultBalance !== undefined && wdAmount > vaultBalance;

  return (
    <section className="card stack" aria-labelledby="vault-h">
      <div>
        <h2 id="vault-h">Vault</h2>
        <p className="sub" style={{ marginBottom: 0 }}>
          Your agents spend from here, never from your wallet. Only you can withdraw.
        </p>
      </div>

      <div className="readout" aria-live="polite">
        <div className="readout-value">
          {money(vaultBalance)}
          <small>tUSD8</small>
        </div>
        <p className="readout-note">
          Agents that are on can draw up to {money(committed)} of it. Your wallet holds {money(walletBalance)}.
        </p>
      </div>

      <div className="form">
        <label>
          Deposit
          <div className="inline">
            <input
              className="field"
              inputMode="decimal"
              placeholder="5.00"
              value={dep}
              onChange={(e) => setDep(e.target.value)}
              aria-invalid={dep !== "" && (depAmount === undefined || depTooMuch)}
            />
            <button
              type="button"
              className="btn secondary small"
              disabled={!walletBalance}
              aria-label="Deposit 100% of your wallet balance"
              onClick={() => walletBalance !== undefined && setDep(money(walletBalance).replace(/,/g, ""))}
            >
              100%
            </button>
            <button
              type="button"
              className="btn small"
              disabled={!writer || !depAmount || depTooMuch || busy}
              onClick={() => writer && depAmount && tx.run(`Deposit ${money(depAmount)} tUSD8`, () => writer.deposit(depAmount), () => { setDep(""); onChange(); })}
            >
              Deposit
            </button>
          </div>
          <span className="hint">The first time, your wallet asks twice: once to allow the vault, once to move the money.</span>
          {depTooMuch && <span className="err">That&apos;s more than your wallet holds.</span>}
        </label>

        <label>
          Withdraw
          <div className="inline">
            <input
              className="field"
              inputMode="decimal"
              placeholder="1.50"
              value={wd}
              onChange={(e) => setWd(e.target.value)}
              aria-invalid={wd !== "" && (wdAmount === undefined || wdTooMuch)}
            />
            <button
              type="button"
              className="btn secondary small"
              disabled={!vaultBalance}
              aria-label="Withdraw 100% of your vault balance"
              onClick={() => vaultBalance !== undefined && setWd(money(vaultBalance).replace(/,/g, ""))}
            >
              100%
            </button>
            <button
              type="button"
              className="btn secondary small"
              disabled={!writer || !wdAmount || wdTooMuch || busy}
              onClick={() => writer && wdAmount && tx.run(`Withdraw ${money(wdAmount)} tUSD8`, () => writer.withdraw(wdAmount), () => { setWd(""); onChange(); })}
            >
              Withdraw
            </button>
          </div>
          {wdTooMuch && <span className="err">That&apos;s more than the vault holds for you.</span>}
        </label>
      </div>
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </section>
  );
}
