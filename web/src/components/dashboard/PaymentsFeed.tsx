"use client";

import type { Payment } from "@perault/sdk";
import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import { usePerault } from "@/lib/perault";
import { TxLink, money, short } from "./shared";

const INITIAL_LOOKBACK = 20_000n; // ≈ 6 hours on Aevum
const POLL_MS = 5_000; // Aevum has no WebSocket RPC: poll

/**
 * Live feed of payments made by `sessionIds`. Loads the last ~6 h once, then polls only the new
 * blocks every 5 s, so it stays cheap however long the page is open.
 */
export function PaymentsFeed({ sessionIds, onNewPayment }: { sessionIds: Hex[]; onNewPayment: () => void }) {
  const { reader } = usePerault();
  const [items, setItems] = useState<Payment[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [state, setState] = useState<"loading" | "live" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const lastBlock = useRef<bigint | null>(null);
  const key = sessionIds.join(",");
  const onNewRef = useRef(onNewPayment);
  onNewRef.current = onNewPayment;

  useEffect(() => {
    if (!reader || sessionIds.length === 0) {
      setItems([]);
      setState("live");
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    lastBlock.current = null;
    setItems([]);
    setState("loading");

    async function tick() {
      try {
        const latest = await reader!.publicClient.getBlockNumber({ cacheTime: 0 });
        const first = lastBlock.current === null;
        const from = first ? (latest > INITIAL_LOOKBACK ? latest - INITIAL_LOOKBACK : 0n) : lastBlock.current! + 1n;
        if (from <= latest) {
          const got = await reader!.getPayments({ sessionId: sessionIds, fromBlock: from, toBlock: latest });
          if (stopped) return;
          lastBlock.current = latest;
          if (got.length) {
            setItems((prev) => [...got.reverse(), ...prev]);
            if (!first) {
              setFresh(new Set(got.map((p) => p.transactionHash!)));
              onNewRef.current();
            }
          }
        }
        setState("live");
        setError(null);
      } catch (e) {
        if (stopped) return;
        setState("error");
        setError((e as Error).message.split("\n")[0]);
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    }
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, key]);

  const total = items.reduce((s, p) => s + (p.amount ?? 0n), 0n);

  return (
    <section className="card flush" aria-labelledby="feed-h">
      <div className="module-head">
        <div>
          <h2 id="feed-h">Payments by your agents</h2>
          <p className="fine">
            {items.length === 0 ? "From the last 6 hours, newest first." : `${items.length} in the last 6 hours, ${money(total)} tUSD8 in all. Newest first.`}
          </p>
        </div>
        <span className="live" aria-live="polite">
          {state === "loading" ? (
            "Loading…"
          ) : state === "error" ? (
            <span className="err">Lost the connection, retrying. {error}</span>
          ) : (
            <>
              <span className="dot" aria-hidden="true" /> Checking every 5 seconds
            </>
          )}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="empty">{state === "loading" ? "Reading recent blocks…" : "No payments yet. When an agent pays, it shows up here within seconds."}</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="right">Amount</th>
                <th>Merchant</th>
                <th>Agent</th>
                <th>Session</th>
                <th className="right">Block</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={`${p.transactionHash}-${p.nonce}`} className={fresh.has(p.transactionHash!) ? "fresh" : undefined}>
                  <td className="right num">{money(p.amount)} tUSD8</td>
                  <td className="mono" title={p.merchant}>
                    {short(p.merchant)}
                  </td>
                  <td className="mono" title={p.agent}>
                    {short(p.agent)}
                  </td>
                  <td className="mono" title={p.sessionId}>
                    {short(p.sessionId)}
                  </td>
                  <td className="right num">{p.blockNumber?.toString()}</td>
                  <td>
                    <TxLink hash={p.transactionHash ?? undefined} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
