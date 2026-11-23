"use client";

import { erc20Abi } from "@aevum-kit/aevum";
import { createPayingFetch, getSettlement, PaymentError } from "@perault/x402/client";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAccount, useReadContract, useWalletClient } from "wagmi";
import { CopyButton, TxLink, money, short } from "@/components/dashboard/shared";
import { Garment } from "@/components/Garment";
import { CATALOG, STORE_NAME, type Product } from "@/lib/catalog";
import { useNetwork } from "@/lib/network";
import { explainAny } from "@/lib/perault";

interface Order {
  id: string;
  sku?: string;
  name: string;
  price: string;
  scheme: "perault" | "exact";
  payer?: string;
  tx: string;
  at: string;
}

type BuyState = { status: "idle" } | { status: "signing" } | { status: "done"; tx: string } | { status: "error"; message: string };

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
  const prompt = `Buy me the black hoodie from ${origin || "http://localhost:3000"}/api/store/buy?sku=hoodie-black-M. It should cost 3.50.`;

  return (
    <main className="shop">
      <div className="shop-inner">
        <header className="shop-masthead">
          <div className="stack" style={{ gap: 12 }}>
            <h1 className="shop-name">{STORE_NAME}</h1>
            <p className="shop-intro">Heavy cotton basics, paid in tUSD8. Buy with your own wallet, or send your AI agent to shop for you.</p>
          </div>
          <div className="stack" style={{ gap: 8, alignItems: "flex-end" }}>
            {address && onAevum ? <span className="shop-wallet">Your wallet: {money(balance.data)} tUSD8</span> : null}
            {!isConnected && <ConnectButton label="Connect wallet to buy" />}
          </div>
        </header>

        {!configured && (
          <div className="notice warn">
            <strong>Checkout isn&apos;t set up</strong>
            <span>
              Add <code>STORE_ADDRESS</code>, <code>FACILITATOR_URL</code> and <code>FACILITATOR_API_KEY</code> to <code>web/.env.local</code>, then
              restart the site.
            </span>
          </div>
        )}
        {!onAevum && <div className="notice warn">This shop takes payment on Aevum testnet. Switch networks in the top bar to buy.</div>}

        <section className="rack" aria-label="Products">
          {CATALOG.map((p) => (
            <Item
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
                if (!res.ok || !body.order) throw new Error(body.error ?? `The shop answered with error ${res.status}.`);
                void queryClient.invalidateQueries({ queryKey: ["store-orders"] });
                void balance.refetch();
                return getSettlement(res)?.transaction ?? body.order.tx;
              }}
            />
          ))}
        </section>

        <section className="shop-agent" aria-labelledby="agent-h">
          <div className="stack" style={{ gap: 10 }}>
            <h2 id="agent-h" style={{ fontSize: 22, fontWeight: 700, fontStretch: "112%" }}>
              Shopping with an AI agent
            </h2>
            <p className="item-blurb">
              Give your agent a budget on the <a href="/dashboard">Perault dashboard</a>, then just ask. It checks the price, pays within the limits
              you set, and brings back the receipt. It can&apos;t spend more than its budget, or pay anyone you haven&apos;t allowed.
            </p>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <pre className="code">
              <code>{prompt}</code>
            </pre>
            <div className="inline">
              <CopyButton text={prompt} label="Copy this request" />
              <CopyButton text={`${origin}/api/store/catalog`} label="Copy catalogue link" />
            </div>
          </div>
        </section>

        <section className="shop-section" aria-labelledby="orders-h">
          <div className="inline" style={{ justifyContent: "space-between" }}>
            <h2 id="orders-h">Recent orders</h2>
            <span className="fine">Paid to {orders.data?.payTo ? short(orders.data.payTo) : "the shop"} in the last 6 hours, read from the chain</span>
          </div>
          {!orders.data?.orders.length ? (
            <p className="fine">No orders yet. The first one will show up here a few seconds after it&apos;s paid.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="right">Price</th>
                    <th>Bought by</th>
                    <th>Paid from</th>
                    <th>Time</th>
                    <th>Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.data.orders.map((o) => (
                    <tr key={o.id}>
                      <td>{o.name}</td>
                      <td className="right">{money(BigInt(Math.round(Number(o.price) * 1e6)))} tUSD8</td>
                      <td>
                        <span className={`buyer ${o.scheme === "perault" ? "agent" : "wallet"}`}>{o.scheme === "perault" ? "AI agent" : "Person"}</span>
                      </td>
                      <td title={o.payer}>{short(o.payer)}</td>
                      <td>{new Date(o.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
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
      </div>
    </main>
  );
}

function Item({
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
  buy: () => Promise<string>;
}) {
  const [state, setState] = useState<BuyState>({ status: "idle" });
  const [copied, setCopied] = useState(false);
  const tooLittle = balance !== undefined && balance < p.price;
  const agentUrl = `${origin}/api/store/buy?sku=${p.sku}`;

  async function onBuy() {
    setState({ status: "signing" });
    try {
      setState({ status: "done", tx: await buy() });
    } catch (e) {
      setState({ status: "error", message: e instanceof PaymentError ? e.message : explainAny(e) });
    }
  }

  return (
    <article className="item">
      <div className="garment" style={{ background: p.swatch[0] }} role="img" aria-label={p.name}>
        <Garment sku={p.sku} color={p.swatch[1]} />
        <span className="woven">{money(p.price)} tUSD8</span>
        {p.tag && <span className="garment-note">{p.tag}</span>}
      </div>
      <div className="stack" style={{ gap: 4 }}>
        <h2>{p.name}</h2>
        <p className="item-blurb">{p.blurb}</p>
      </div>
      <button type="button" className="btn block" disabled={!ready || tooLittle || state.status === "signing"} onClick={onBuy}>
        {state.status === "signing" ? "Approve in your wallet…" : `Buy for ${money(p.price)} tUSD8`}
      </button>
      {ready && tooLittle && (
        <span className="err">
          Your wallet has {money(balance)} tUSD8. Money in your Perault vault is for your agents: take it out on the{" "}
          <a href="/dashboard">dashboard</a> to spend it yourself.
        </span>
      )}
      {state.status === "signing" && <span className="fine">One signature and no gas. The payment settles on Aevum in a few seconds.</span>}
      {state.status === "done" && (
        <div className="notice good" role="status">
          <strong>Paid. Your order is in.</strong>
          <span>
            Receipt <TxLink hash={state.tx} />
          </span>
        </div>
      )}
      {state.status === "error" && (
        <div className="notice bad" role="alert">
          <strong>Not charged</strong>
          <span>{state.message}</span>
        </div>
      )}
      <div className="item-agent">
        <span>Sending an agent?</span>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(agentUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              // Clipboard blocked: the link is in the catalogue too.
            }
          }}
        >
          {copied ? "Link copied" : "Copy its link"}
        </button>
      </div>
    </article>
  );
}
