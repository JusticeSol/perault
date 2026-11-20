"use client";

import { erc20Abi } from "@aevum-kit/aevum";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract } from "wagmi";
import { OpenSessionCard } from "@/components/dashboard/OpenSessionCard";
import { PaymentsFeed } from "@/components/dashboard/PaymentsFeed";
import { SessionCard, sessionStatus } from "@/components/dashboard/SessionCard";
import { ConfirmButton, TxStatus, short } from "@/components/dashboard/shared";
import { VaultCard } from "@/components/dashboard/VaultCard";
import { useNetwork } from "@/lib/network";
import { usePerault, useTx } from "@/lib/perault";

export default function DashboardPage() {
  const { net } = useNetwork();
  const { address, isConnected } = useAccount();
  const { reader, writer, vault } = usePerault();
  const queryClient = useQueryClient();
  const killAll = useTx();

  const sessions = useQuery({
    queryKey: ["perault-sessions", net.chain.id, vault, address],
    enabled: Boolean(reader && address),
    refetchInterval: 10_000,
    queryFn: () => reader!.listSessions(address!),
  });
  const vaultBalance = useQuery({
    queryKey: ["perault-vault-balance", net.chain.id, vault, address],
    enabled: Boolean(reader && address),
    refetchInterval: 10_000,
    queryFn: () => reader!.balanceOf(address!),
  });
  const token = useQuery({
    queryKey: ["perault-token", net.chain.id, vault],
    enabled: Boolean(reader),
    staleTime: Infinity,
    queryFn: () => reader!.token(),
  });
  const walletBalance = useReadContract({
    address: token.data,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: net.chain.id,
    query: { enabled: Boolean(token.data && address), refetchInterval: 10_000 },
  });

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["perault-sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["perault-vault-balance"] });
    void walletBalance.refetch();
  };

  const rows = sessions.data ?? [];
  const active = rows.filter((r) => sessionStatus(r) === "active");
  const committed = active.reduce((s, r) => s + r.budget.totalRemaining, 0n);
  const busy = killAll.state.status === "wallet" || killAll.state.status === "pending";

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Perault · owner dashboard</p>
          <h1>Budgets for your AI agents</h1>
          <p className="lede">
            Fund the vault, give each agent a capped session, watch every payment land on-chain, and revoke any session with one click.
          </p>
        </div>
        {address && (
          <div className="score">
            <span className="score-num">{active.length}</span>
            <span className="fine">active session{active.length === 1 ? "" : "s"}</span>
          </div>
        )}
      </div>

      {!vault ? (
        <div className="card empty">
          No Perault vault on {net.label}. Set <code>NEXT_PUBLIC_VAULT_{net.key.toUpperCase()}</code> in <code>web/.env.local</code>.
        </div>
      ) : !isConnected ? (
        <div className="card empty stack" style={{ alignItems: "center" }}>
          <p>Connect the wallet that owns the vault funds to manage your agents.</p>
          <ConnectButton />
        </div>
      ) : (
        <>
          <div className="grid-2">
            <VaultCard vaultBalance={vaultBalance.data} walletBalance={walletBalance.data} committed={committed} onChange={refreshAll} />
            <OpenSessionCard onOpened={refreshAll} />
          </div>

          <PaymentsFeed sessionIds={rows.map((r) => r.sessionId)} onNewPayment={refreshAll} />

          <section className="card stack" aria-labelledby="sessions-h">
            <div className="session-head">
              <div>
                <h2 id="sessions-h">Sessions</h2>
                <p className="sub" style={{ marginBottom: 0 }}>
                  Owner {short(address)} · vault {short(vault)} · {rows.length} session{rows.length === 1 ? "" : "s"}
                </p>
              </div>
              {active.length > 0 && (
                <ConfirmButton
                  label={`Revoke all (${active.length})`}
                  confirmLabel="Click again: stop every agent now"
                  className="btn danger small"
                  disabled={!writer || busy}
                  onConfirm={() => writer && killAll.run("Revoke all sessions", () => writer.revokeAll(), refreshAll)}
                />
              )}
            </div>
            <TxStatus state={killAll.state} onDismiss={killAll.reset} />
            {sessions.isLoading && <p className="fine">Reading your sessions…</p>}
            {sessions.error && <p className="err">Couldn&apos;t read sessions: {(sessions.error as Error).message}</p>}
            {sessions.data && rows.length === 0 && <p className="empty">No sessions yet. Give an agent a budget above.</p>}
            {rows.map((r) => (
              <SessionCard key={r.sessionId} row={r} onChange={refreshAll} />
            ))}
          </section>
        </>
      )}
    </main>
  );
}
