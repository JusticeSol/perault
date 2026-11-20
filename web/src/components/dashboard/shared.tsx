"use client";

import { txUrl } from "@aevum-kit/aevum";
import { useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useNetwork } from "@/lib/network";
import type { TxState } from "@/lib/perault";

export const DECIMALS = 6;

/** 3500000n -> "3.50" */
export function money(v: bigint | undefined): string {
  if (v === undefined) return "—";
  const [i, f = ""] = formatUnits(v, DECIMALS).split(".");
  return `${Number(i).toLocaleString("en-US")}.${(f + "00").slice(0, Math.max(2, f.replace(/0+$/, "").length))}`;
}

/** "3.5" -> 3500000n; undefined if not a positive amount with ≤6 decimals. */
export function parseMoney(s: string): bigint | undefined {
  const t = s.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return undefined;
  try {
    const v = parseUnits(t, DECIMALS);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
}

export function short(a: string | undefined, n = 4): string {
  return a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : "—";
}

/** "6d 23h", "4h 12m", "38m", "expired" */
export function timeLeft(expirySec: bigint | number, nowMs = Date.now()): string {
  const s = Number(expirySec) - Math.floor(nowMs / 1000);
  if (s <= 0) return "expired";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${Math.max(m, 1)}m`;
}

export function TxLink({ hash }: { hash?: string }) {
  const { net } = useNetwork();
  if (!hash) return null;
  return net.hasExplorer ? (
    <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="mono">
      {short(hash, 6)} ↗
    </a>
  ) : (
    <span className="mono">{short(hash, 6)}</span>
  );
}

/** Plain-language progress for one wallet action. */
export function TxStatus({ state, onDismiss }: { state: TxState; onDismiss?: () => void }) {
  if (state.status === "idle") return null;
  if (state.status === "wallet" || state.status === "pending") {
    return (
      <div className="notice warn" role="status" aria-live="polite">
        <strong>{state.label}</strong>
        <span>{state.status === "wallet" ? "Confirm in your wallet…" : "Waiting for Aevum to confirm (a few seconds)…"}</span>
      </div>
    );
  }
  if (state.status === "done") {
    return (
      <div className="notice good" role="status">
        <div className="row-between">
          <strong>{state.label}: done</strong>
          {onDismiss && (
            <button type="button" className="btn ghost small" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
        {state.hash && (
          <span>
            Transaction <TxLink hash={state.hash} />
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="notice bad" role="alert">
      <div className="row-between">
        <strong>{state.label} failed</strong>
        {onDismiss && (
          <button type="button" className="btn ghost small" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
      <span>{state.message}</span>
    </div>
  );
}

/** A button that needs a second click within 4 s. For revocations. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  className = "btn warn small",
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={armed ? "btn danger small" : className}
      disabled={disabled}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          timer.current = setTimeout(() => setArmed(false), 4000);
          return;
        }
        clearTimeout(timer.current);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

export function Meter({ used, cap, label }: { used: bigint; cap: bigint; label: string }) {
  const pct = cap > 0n ? Number((used * 1000n) / cap) / 10 : 0;
  return (
    <div className="meter">
      <div className="meter-top">
        <span>{label}</span>
        <span className="num">
          {money(used)} / {money(cap)}
        </span>
      </div>
      <div className={`progress ${pct >= 100 ? "full" : pct >= 80 ? "high" : ""}`} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn secondary small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard blocked (http, permissions): the text is on screen to copy by hand.
        }
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
