"use client";

import { PERAULT_DEPLOYMENTS, type PeraultClient } from "@perault/sdk";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { usePerault, useTx } from "@/lib/perault";
import { AgentSwitch, CopyButton, Meter, TxStatus, money, short, timeLeft } from "./shared";

export type SessionRow = Awaited<ReturnType<PeraultClient["listSessions"]>>[number];

/** Blocks scanned to rebuild a session's merchant list (Aevum ≈ 1 block/s, so ≈ 14 h). */
const MERCHANT_LOOKBACK = 50_000n;

export function sessionStatus(s: SessionRow, nowMs = Date.now()): "active" | "revoked" | "expired" | "killed" {
  if (s.budget.active) return "active";
  if (s.session.revoked) return "revoked";
  if (Number(s.session.expiry) * 1000 <= nowMs) return "expired";
  return "killed"; // ended by "Turn off all agents"
}

const OFF_TEXT = { revoked: "Turned off by you", expired: "Expired", killed: "Stopped by turn off all" };

function when(expiry: bigint | number): string {
  return new Date(Number(expiry) * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function SessionCard({ row, onChange }: { row: SessionRow; onChange: () => void }) {
  const { reader, writer } = usePerault();
  const tx = useTx();
  const [newMerchant, setNewMerchant] = useState("");
  const status = sessionStatus(row);
  const on = status === "active";
  const { session: s, budget: b } = row;
  const spentToday = s.dailyCap - b.dailyRemaining;
  const busy = tx.state.status === "wallet" || tx.state.status === "pending";

  const merchants = useQuery({
    queryKey: ["merchants", row.sessionId, reader?.vault],
    enabled: Boolean(reader) && on,
    staleTime: 60_000,
    queryFn: async () => {
      const latest = await reader!.publicClient.getBlockNumber({ cacheTime: 0 });
      const deploy = PERAULT_DEPLOYMENTS[reader!.chainId]?.deployBlock ?? 0n;
      const back = latest > MERCHANT_LOOKBACK ? latest - MERCHANT_LOOKBACK : 0n;
      return reader!.getMerchants(row.sessionId, { fromBlock: back > deploy ? back : deploy, toBlock: latest });
    },
  });

  const refresh = () => {
    void merchants.refetch();
    onChange();
  };

  return (
    <article className={`session ${on ? "" : "dead"}`} aria-label={`Agent ${short(s.agent)}`}>
      <div className="session-head">
        <div className="session-title">
          <h3>Agent {short(s.agent)}</h3>
          <span className="lamp-line">
            <span className={`dot ${on ? "" : "off"}`} aria-hidden="true" />
            {on ? `Can spend ${money(b.spendableNow)} tUSD8 now, until ${when(s.expiry)} (${timeLeft(s.expiry)} left)` : `${OFF_TEXT[status]}. Ended ${when(s.expiry) }`}
          </span>
        </div>
        <AgentSwitch
          on={on}
          disabled={!writer || busy}
          offLabel="Can't be turned back on"
          onTurnOff={() => writer && tx.run("Turn off agent", () => writer.revoke(row.sessionId), refresh)}
        />
      </div>

      <div className="session-meters">
        <Meter label="Spent today (resets at midnight UTC)" used={on ? spentToday : 0n} cap={s.dailyCap} />
        <Meter label="Spent in total" used={s.spentTotal} cap={s.totalCap} />
      </div>
      <p className="fine">No single payment can be more than {money(s.perTxCap)} tUSD8.</p>

      {on && (
        <div className="stack" style={{ gap: 8 }}>
          <span className="fine">Shops this agent can pay</span>
          {merchants.isLoading && <span className="fine">Reading the list…</span>}
          {merchants.error && <span className="err">Couldn&apos;t read the shop list: {(merchants.error as Error).message}</span>}
          {merchants.data && (
            <div className="chips">
              {merchants.data.length === 0 && <span className="fine">None set in the last 14 hours. Add one below.</span>}
              {merchants.data.map((m) => (
                <span key={m} className="addr-chip" title={m}>
                  {short(m, 6)}
                  <button
                    type="button"
                    aria-label={`Remove shop ${m}`}
                    disabled={!writer || busy}
                    onClick={() => writer && tx.run(`Remove shop ${short(m)}`, () => writer.setMerchant(row.sessionId, m as Address, false), refresh)}
                  >
                    Remove
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="inline">
            <input
              className="field"
              placeholder="Shop address 0x…"
              aria-label="Shop address to allow"
              value={newMerchant}
              onChange={(e) => setNewMerchant(e.target.value.trim())}
              aria-invalid={newMerchant !== "" && !isAddress(newMerchant)}
            />
            <button
              type="button"
              className="btn secondary small"
              disabled={!writer || !isAddress(newMerchant) || busy}
              onClick={() =>
                writer &&
                tx.run(`Allow shop ${short(newMerchant)}`, () => writer.setMerchant(row.sessionId, getAddress(newMerchant), true), () => {
                  setNewMerchant("");
                  refresh();
                })
              }
            >
              Allow shop
            </button>
          </div>
        </div>
      )}

      <div className="inline" style={{ justifyContent: "space-between" }}>
        <span className="fine" title={row.sessionId}>
          Budget {row.index + 1}, session {short(row.sessionId)}
        </span>
        <CopyButton text={row.sessionId} label="Copy session ID" />
      </div>
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </article>
  );
}
