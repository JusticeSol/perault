"use client";

import { PERAULT_DEPLOYMENTS, type PeraultClient } from "@perault/sdk";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { usePerault, useTx } from "@/lib/perault";
import { ConfirmButton, CopyButton, Meter, TxStatus, money, short, timeLeft } from "./shared";

export type SessionRow = Awaited<ReturnType<PeraultClient["listSessions"]>>[number];

/** Blocks scanned to rebuild a session's merchant list (Aevum ≈ 1 block/s, so ≈ 14 h). */
const MERCHANT_LOOKBACK = 50_000n;

export function sessionStatus(s: SessionRow, nowMs = Date.now()): "active" | "revoked" | "expired" | "killed" {
  if (s.budget.active) return "active";
  if (s.session.revoked) return "revoked";
  if (Number(s.session.expiry) * 1000 <= nowMs) return "expired";
  return "killed"; // ended by "Revoke all"
}

const STATUS_TEXT = { active: "Active", revoked: "Revoked", expired: "Expired", killed: "Revoked (kill switch)" };

export function SessionCard({ row, onChange }: { row: SessionRow; onChange: () => void }) {
  const { reader, writer } = usePerault();
  const tx = useTx();
  const [newMerchant, setNewMerchant] = useState("");
  const status = sessionStatus(row);
  const { session: s, budget: b } = row;
  const spentToday = s.dailyCap - b.dailyRemaining;
  const busy = tx.state.status === "wallet" || tx.state.status === "pending";

  const merchants = useQuery({
    queryKey: ["merchants", row.sessionId, reader?.vault],
    enabled: Boolean(reader) && status === "active",
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
    <article className={`session ${status === "active" ? "" : "dead"}`} aria-label={`Session ${short(row.sessionId)}`}>
      <div className="session-head">
        <div className="inline">
          <span className={`badge ${status}`}>{STATUS_TEXT[status]}</span>
          <span className="mono" title={row.sessionId}>
            Session #{row.index + 1} · {short(row.sessionId)}
          </span>
          <CopyButton text={row.sessionId} label="Copy ID" />
        </div>
        {status === "active" && (
          <ConfirmButton
            label="Revoke"
            confirmLabel="Click again to revoke"
            disabled={!writer || busy}
            onConfirm={() => writer && tx.run("Revoke session", () => writer.revoke(row.sessionId), refresh)}
          />
        )}
      </div>

      <dl className="kv">
        <dt>Agent</dt>
        <dd>{s.agent}</dd>
        <dt>Per payment</dt>
        <dd>{money(s.perTxCap)} tUSD8</dd>
        <dt>Expires</dt>
        <dd>
          {new Date(Number(s.expiry) * 1000).toLocaleString()} {status === "active" && `(in ${timeLeft(s.expiry)})`}
        </dd>
        {status === "active" && (
          <>
            <dt>Can spend now</dt>
            <dd>{money(b.spendableNow)} tUSD8</dd>
          </>
        )}
      </dl>

      <div className="session-meters">
        <Meter label="Spent today (resets 00:00 UTC)" used={status === "active" ? spentToday : 0n} cap={s.dailyCap} />
        <Meter label="Spent in total" used={s.spentTotal} cap={s.totalCap} />
      </div>

      {status === "active" && (
        <div className="stack" style={{ gap: 8 }}>
          <span className="fine">Allowed merchants</span>
          {merchants.isLoading && <span className="fine">Reading the allowlist…</span>}
          {merchants.error && <span className="err">Couldn&apos;t read merchants: {(merchants.error as Error).message}</span>}
          {merchants.data && (
            <div className="chips">
              {merchants.data.length === 0 && <span className="fine">None found in the last ~14 hours of blocks.</span>}
              {merchants.data.map((m) => (
                <span key={m} className="addr-chip">
                  {short(m, 6)}{" "}
                  <button
                    type="button"
                    className="btn ghost small"
                    style={{ minHeight: 0, padding: "0 6px", border: 0 }}
                    aria-label={`Remove merchant ${m}`}
                    disabled={!writer || busy}
                    onClick={() => writer && tx.run(`Remove merchant ${short(m)}`, () => writer.setMerchant(row.sessionId, m as Address, false), refresh)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="inline">
            <input
              className="field"
              placeholder="Add merchant 0x…"
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
                tx.run(`Allow merchant ${short(newMerchant)}`, () => writer.setMerchant(row.sessionId, getAddress(newMerchant), true), () => {
                  setNewMerchant("");
                  refresh();
                })
              }
            >
              Allow
            </button>
          </div>
        </div>
      )}
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </article>
  );
}
