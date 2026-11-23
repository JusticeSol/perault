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
          <h1>Your agents&apos; budgets</h1>
          <p className="lede">
            Each agent gets a budget with limits you choose. Every payment it makes shows up below, and its switch turns it off at once.
          </p>
        </div>
      </div>

      {!vault ? (
        <div className="card empty">
          No Perault vault is set for {net.label}. Add <code>NEXT_PUBLIC_VAULT_{net.key.toUpperCase()}</code> to <code>web/.env.local</code>.
        </div>
      ) : !isConnected ? (
        <div className="card empty stack" style={{ alignItems: "center" }}>
          <p>Connect the wallet that funds your agents to see their budgets.</p>
          <ConnectButton />
        </div>
      ) : (
        <>
          <section className="card flush" aria-labelledby="agents-h">
            <div className="module-head">
              <div>
                <h2 id="agents-h">Agents</h2>
                <p className="fine">
                  {active.length} of {rows.length} on. Signed in as {short(address)}.
                </p>
              </div>
            </div>
            {sessions.isLoading && <p className="empty">Reading your agents…</p>}
            {sessions.error && <p className="empty err">Couldn&apos;t read your agents: {(sessions.error as Error).message}</p>}
            {sessions.data && rows.length === 0 && <p className="empty">No agents yet. Give one a budget below.</p>}
            {rows.map((r) => (
              <SessionCard key={r.sessionId} row={r} onChange={refreshAll} />
            ))}
            {active.length > 0 && (
              <div className="kill">
                <span className="fine">Something wrong? Stop every agent in one transaction.</span>
                <ConfirmButton
                  label={`Turn off all agents (${active.length})`}
                  confirmLabel="Press again to stop them all"
                  className="btn danger small"
                  disabled={!writer || busy}
                  onConfirm={() => writer && killAll.run("Turn off all agents", () => writer.revokeAll(), refreshAll)}
                />
              </div>
            )}
            {killAll.state.status !== "idle" && (
              <div style={{ padding: "0 22px 18px" }}>
                <TxStatus state={killAll.state} onDismiss={killAll.reset} />
              </div>
            )}
          </section>

          <div className="grid-2">
            <VaultCard vaultBalance={vaultBalance.data} walletBalance={walletBalance.data} committed={committed} onChange={refreshAll} />
            <OpenSessionCard onOpened={refreshAll} />
          </div>

          <PaymentsFeed sessionIds={rows.map((r) => r.sessionId)} onNewPayment={refreshAll} />
        </>
      )}
    </main>
  );
}
