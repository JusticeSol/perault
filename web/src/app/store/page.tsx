"use client";

import { erc20Abi } from "@aevum-kit/aevum";
import { createPayingFetch, getSettlement, PaymentError } from "@perault/x402/client";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAccount, useReadContract, useWalletClient } from "wagmi";
import { CopyButton, TxLink, money, short } from "@/components/dashboard/shared";
import { CATALOG, STORE_NAME, type Product } from "@/lib/catalog";
import { useNetwork } from "@/lib/network";
import { explainAny } from "@/lib/perault";

interface Order {
  id: string;
  sku: string;
  name: string;
  price: string;
  scheme: "perault" | "exact";
  payer?: string;
  tx: string;
  at: string;
}

type BuyState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "done"; order: Order; tx: string }
  | { status: "error"; message: string };

const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483" as const;

export default function StorePage() {
  const { net } = useNetwork();
  const { address, isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient({ chainId: net.chain.id });
  const queryClient = useQueryClient();
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const onAevum = net.key === "aevum";

  const orders = useQuery({
    queryKey: ["store-orders"],
    refetchInterval: 4000,
    queryFn: async () => (await fetch("/api/store/orders")).json() as Promise<{ configured: boolean; payTo: string | null; orders: Order[] }>,
  });
  const balance = useReadContract({
    address: TUSD8,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: net.chain.id,
    query: { enabled: Boolean(address) && onAevum, refetchInterval: 10_000 },
  });

  const configured = orders.data?.configured ?? true;
  const ready = isConnected && chainId === net.chain.id && Boolean(walletClient) && onAevum;

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Storefront · pays in tUSD8 on Aevum</p>
          <h1>{STORE_NAME}</h1>
          <p className="lede">
            Every product is one x402 endpoint. Buy it yourself with your wallet (one signature, no gas), or hand the link to your AI agent and it
            pays from its Perault budget.
          </p>
        </div>
        <div className="stack" style={{ alignItems: "flex-end", gap: 8 }}>
          {address && onAevum && <span className="fine">Your wallet: {money(balance.data)} tUSD8</span>}
          {!isConnected && <ConnectButton label="Connect to buy" />}
        </div>
      </div>

      {!configured && (
        <div className="notice warn">
          <strong>The store isn&apos;t configured yet</strong>
          <span>
            Set <code>STORE_ADDRESS</code>, <code>FACILITATOR_URL</code> and <code>FACILITATOR_API_KEY</code> in <code>web/.env.local</code> and
            restart. Purchases will fail until then.
          </span>
        </div>
      )}
      {!onAevum && <div className="notice warn">The store settles on Aevum testnet. Switch the network in the header to buy.</div>}

      <section className="products" aria-label="Products">
        {CATALOG.map((p) => (
          <ProductCard
            key={p.sku}
            product={p}
            origin={origin}
            ready={ready}
            balance={balance.data}
            buy={async () => {
              if (!walletClient) throw new Error("Connect your wallet first.");
              const pay = createPayingFetch({ exact: { signer: walletClient }, maxAmount: p.price });
              const res = await pay(`${origin}/api/store/buy?sku=${encodeURIComponent(p.sku)}`);
              const body = (await res.json()) as { order?: Order; error?: string };
              if (!res.ok || !body.order) throw new Error(body.error ?? `The store answered HTTP ${res.status}.`);
              const s = getSettlement(res);
              void queryClient.invalidateQueries({ queryKey: ["store-orders"] });
              void balance.refetch();
              return { order: body.order, tx: s?.transaction ?? body.order.tx };
            }}
          />
        ))}
      </section>

      <section className="card stack" aria-labelledby="agent-h">
        <div>
          <h2 id="agent-h">Let your agent shop</h2>
          <p className="sub">
            Give Claude (with the Perault MCP server) a budget from the <a href="/dashboard">dashboard</a>, then ask it in plain words. It checks
            the price, pays within its caps, and shows you the transaction.
          </p>
        </div>
        <pre className="code">
          <code>{`Buy me the black hoodie from ${origin || "http://localhost:3000"}/api/store/buy?sku=hoodie-black-M. It should cost 3.50.`}</code>
        </pre>
        <div className="inline">
          <CopyButton text={`Buy me the black hoodie from ${origin}/api/store/buy?sku=hoodie-black-M. It should cost 3.50.`} label="Copy prompt" />
          <CopyButton text={`${origin}/api/store/catalog`} label="Copy catalog URL" />
        </div>
      </section>

      <section className="card flush" aria-labelledby="orders-h">
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10, padding: "18px 20px", borderBottom: "1px solid var(--line)" }}>
          <div>
            <h2 id="orders-h">Recent orders</h2>
            <p className="fine">
              Paid to {orders.data?.payTo ? short(orders.data.payTo) : "—"} · since the store server started
            </p>
          </div>
          <span className="live">
            <span className="dot" aria-hidden="true" /> Live
          </span>
        </div>
        {!orders.data?.orders.length ? (
          <p className="empty">No orders yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="right">Price</th>
                  <th>Paid by</th>
                  <th>Buyer</th>
                  <th>Time</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {orders.data.orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.name}</td>
                    <td className="right num">{o.price} tUSD8</td>
                    <td>
                      <span className={`badge ${o.scheme === "perault" ? "active" : "expired"}`}>{o.scheme === "perault" ? "AI agent" : "Wallet"}</span>
                    </td>
                    <td className="mono" title={o.payer}>
                      {short(o.payer)}
                    </td>
                    <td className="num">{new Date(o.at).toLocaleTimeString()}</td>
                    <td>
                      <TxLink hash={o.tx} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function ProductCard({
  product: p,
  origin,
  ready,
  balance,
  buy,
}: {
  product: Product;
  origin: string;
  ready: boolean;
  balance?: bigint;
  buy: () => Promise<{ order: Order; tx: string }>;
}) {
  const [state, setState] = useState<BuyState>({ status: "idle" });
  const short_ = balance !== undefined && balance < p.price;
  const agentUrl = `${origin}/api/store/buy?sku=${p.sku}`;

  async function onBuy() {
    setState({ status: "signing" });
    try {
      const r = await buy();
      setState({ status: "done", ...r });
    } catch (e) {
      const message = e instanceof PaymentError ? e.message : explainAny(e);
      setState({ status: "error", message });
    }
  }

  return (
    <article className="product card">
      <div className="swatch" style={{ background: `linear-gradient(135deg, ${p.swatch[0]}, ${p.swatch[1]})` }} aria-hidden="true">
        {p.tag && <span className="tag">{p.tag}</span>}
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <h2>{p.name}</h2>
        <p className="sub" style={{ margin: 0 }}>
          {p.blurb}
        </p>
      </div>
      <div className="price">
        {money(p.price)} <small>tUSD8</small>
      </div>
      <button type="button" className="btn block" disabled={!ready || short_ || state.status === "signing"} onClick={onBuy}>
        {state.status === "signing" ? "Sign in your wallet…" : "Buy with wallet"}
      </button>
      {ready && short_ && <span className="err">You need {money(p.price)} tUSD8 (you have {money(balance)}).</span>}
      {state.status === "signing" && <span className="fine">One signature, no gas. The store&apos;s facilitator settles it on Aevum.</span>}
      {state.status === "done" && (
        <div className="notice good" role="status">
          <strong>Paid. Order confirmed.</strong>
          <span>
            Transaction <TxLink hash={state.tx} />
          </span>
        </div>
      )}
      {state.status === "error" && (
        <div className="notice bad" role="alert">
          <strong>Not charged</strong>
          <span>{state.message}</span>
        </div>
      )}
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <span className="fine mono" title={agentUrl}>
          Agent link: …?sku={p.sku}
        </span>
        <CopyButton text={agentUrl} label="Copy" />
      </div>
    </article>
  );
}
