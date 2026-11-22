/**
 * The demo store's catalog, shared by the storefront and the paywalled API.
 * Prices are in tUSD8 base units (6 decimals) and scaled to the faucet's 5 tUSD8.
 * Swap in your own products here; nothing else needs to change.
 */
export interface Product {
  sku: string;
  name: string;
  blurb: string;
  /** Base units: 3_500_000n = 3.50 tUSD8. */
  price: bigint;
  /** Two colours for the product swatch (no image assets needed). */
  swatch: [string, string];
  tag?: string;
}

export const STORE_NAME = process.env.NEXT_PUBLIC_STORE_NAME?.trim() || "Perault Demo Store";

export const CATALOG: Product[] = [
  {
    sku: "hoodie-black-M",
    name: "Heavyweight hoodie, black, M",
    blurb: "450 gsm brushed cotton, dropped shoulder, kangaroo pocket.",
    price: 3_500_000n,
    swatch: ["#1b1d22", "#3a3f4b"],
    tag: "Best seller",
  },
  {
    sku: "tee-white-L",
    name: "Boxy tee, off-white, L",
    blurb: "220 gsm combed cotton, ribbed collar, relaxed fit.",
    price: 2_000_000n,
    swatch: ["#e9e4da", "#c9c2b4"],
  },
  {
    sku: "socks-white",
    name: "Crew socks, white",
    blurb: "Cushioned sole, reinforced heel and toe. One size.",
    price: 1_000_000n,
    swatch: ["#f4f4f4", "#d7dbe2"],
  },
  {
    sku: "jacket-denim-L",
    name: "Selvedge denim jacket, L",
    blurb: "14 oz raw selvedge, copper buttons. Over the demo agent's 4.00 cap.",
    price: 6_000_000n,
    swatch: ["#1f3a5f", "#34598a"],
    tag: "Premium",
  },
];

export function productBySku(sku: string | null): Product | undefined {
  return CATALOG.find((p) => p.sku === sku);
}
