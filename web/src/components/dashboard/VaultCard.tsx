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
  /** Sum of what active sessions could still spend (may exceed the vault balance). */
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
        <p className="sub">Agents spend from here, never from your wallet. Only you can withdraw.</p>
      </div>
      <div className="stats">
        <div className="stat">
          <span className="stat-num">
            {money(vaultBalance)} <small>tUSD8</small>
          </span>
          <span className="stat-label">in the vault</span>
        </div>
        <div className="stat">
          <span className="stat-num">
            {money(walletBalance)} <small>tUSD8</small>
          </span>
          <span className="stat-label">in your wallet</span>
        </div>
        <div className="stat">
          <span className="stat-num">
            {money(committed)} <small>tUSD8</small>
          </span>
          <span className="stat-label">active sessions can still spend</span>
        </div>
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
              onClick={() => walletBalance !== undefined && setDep(money(walletBalance).replace(/,/g, ""))}
            >
              Max
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
          <span className="hint">Approves the vault first if needed, so your wallet may ask twice.</span>
          {depTooMuch && <span className="err">More than your wallet holds.</span>}
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
              onClick={() => vaultBalance !== undefined && setWd(money(vaultBalance).replace(/,/g, ""))}
            >
              Max
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
          {wdTooMuch && <span className="err">More than the vault holds for you.</span>}
        </label>
      </div>
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </section>
  );
}
