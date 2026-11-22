import "server-only";
import { createPaywall, type Paywall } from "@perault/x402/merchant";
import { isAddress, type Address } from "viem";

/**
 * Server side of the demo store: one paywall (it remembers quotes between the 402 and the paid
 * retry) and an in-memory order book. Both live on globalThis so dev hot-reloads keep them.
 * For production, put orders in a database and pass your own orderId to the paywall.
 */
export interface StoreOrder {
  id: string;
  sku: string;
  name: string;
  price: string;
  scheme: "perault" | "exact";
  payer?: string;
  tx: string;
  at: string;
}

interface StoreState {
  paywall: Paywall | null;
  orders: Map<string, StoreOrder>;
  config: string;
}

const g = globalThis as typeof globalThis & { __peraultStore?: StoreState };

export function storeConfig() {
  const payTo = process.env.STORE_ADDRESS?.trim();
  const facilitatorUrl = process.env.FACILITATOR_URL?.trim() || "http://localhost:4020";
  const apiKey = process.env.FACILITATOR_API_KEY?.trim() || undefined;
  return { payTo: payTo && isAddress(payTo) ? (payTo as Address) : undefined, facilitatorUrl, apiKey };
}

function state(): StoreState {
  const cfg = storeConfig();
  const key = JSON.stringify(cfg);
  if (!g.__peraultStore) g.__peraultStore = { paywall: null, orders: new Map(), config: "" };
  const s = g.__peraultStore;
  if (s.config !== key) {
    s.paywall = cfg.payTo ? createPaywall({ facilitatorUrl: cfg.facilitatorUrl, apiKey: cfg.apiKey, payTo: cfg.payTo }) : null;
    s.config = key;
  }
  return s;
}

export function getPaywall(): Paywall | null {
  return state().paywall;
}

export function orders(): Map<string, StoreOrder> {
  return state().orders;
}
