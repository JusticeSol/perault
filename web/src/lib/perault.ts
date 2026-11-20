"use client";

import { PeraultClient, explainError } from "@perault/sdk";
import { useMemo, useState } from "react";
import type { Hash, PublicClient } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { explain } from "./errors";
import { useNetwork } from "./network";

/**
 * Perault clients for the app's current network.
 *  - reader: no wallet needed (balances, sessions, payments)
 *  - writer: signs with the connected wallet; undefined until it's connected to this network
 */
export function usePerault() {
  const { net } = useNetwork();
  const publicClient = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  const { data: walletClient } = useWalletClient({ chainId: net.chain.id });

  return useMemo(() => {
    if (!net.vault || !publicClient) return { vault: net.vault, reader: undefined, writer: undefined };
    const reader = new PeraultClient({ publicClient, vault: net.vault, chainId: net.chain.id });
    const writer =
      walletClient && walletClient.chain?.id === net.chain.id
        ? new PeraultClient({ publicClient, walletClient, vault: net.vault, chainId: net.chain.id })
        : undefined;
    return { vault: net.vault, reader, writer };
  }, [net.vault, net.chain.id, publicClient, walletClient]);
}

/** One sentence for any failure: vault rejections in Perault's words, wallet errors in the kit's. */
export function explainAny(e: unknown): string {
  return explainError(e)?.message ?? explain(e);
}

export type TxState =
  | { status: "idle" }
  | { status: "wallet"; label: string }
  | { status: "pending"; label: string }
  | { status: "done"; label: string; hash?: Hash }
  | { status: "error"; label: string; message: string };

/**
 * Tracks one wallet action with plain-language status: confirm in wallet → confirming → done / error.
 * The SDK waits for the receipt, so "pending" covers both the wallet prompt and the confirmation.
 */
export function useTx() {
  const [state, setState] = useState<TxState>({ status: "idle" });
  async function run<T extends { hash?: Hash } | void>(label: string, fn: () => Promise<T>, onDone?: (r: T) => void) {
    setState({ status: "wallet", label });
    // The wallet prompt and the on-chain wait happen inside one SDK call; after a short beat,
    // switch the wording so a slow block doesn't read as "still waiting for you".
    const timer = setTimeout(() => setState((s) => (s.status === "wallet" ? { status: "pending", label } : s)), 2500);
    try {
      const r = await fn();
      setState({ status: "done", label, hash: (r as { hash?: Hash } | undefined)?.hash });
      onDone?.(r);
      return r;
    } catch (e) {
      console.error(`[${label}]`, e);
      setState({ status: "error", label, message: explainAny(e) });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
  return { state, run, reset: () => setState({ status: "idle" }) };
}
