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
  /** [background, garment colour] for the drawn silhouette, used when there is no photo. */
  swatch: [string, string];
  /** Product photo in web/public, e.g. "/products/hoodie-black.webp". Fills the panel (cropped to 4:5). */
  image?: string;
  /** Which part of the photo to keep when it is cropped, as CSS object-position. Default "center". */
  imageFocus?: string;
  tag?: string;
}

export const STORE_NAME = process.env.NEXT_PUBLIC_STORE_NAME?.trim() || "Demo Label";

export const CATALOG: Product[] = [
  {
    sku: "hoodie-black-M",
    image: "/products/hoodie-black.webp",
    name: "Heavyweight hoodie, black, M",
    blurb: "450 gsm brushed cotton, dropped shoulder, kangaroo pocket.",
    price: 3_500_000n,
    swatch: ["#d9dadf", "#24262b"],
    tag: "Best seller",
  },
  {
    sku: "tee-white-L",
    image: "/products/tee-white.jpg",
    name: "Boxy tee, off-white, L",
    blurb: "220 gsm combed cotton, ribbed collar, relaxed fit.",
    price: 2_000_000n,
    swatch: ["#c4cbd6", "#f2efe8"],
  },
  {
    sku: "socks-white",
    image: "/products/socks-white.jpg",
    imageFocus: "center bottom",
    name: "Crew socks, white",
    blurb: "Cushioned sole, reinforced heel and toe. One size.",
    price: 1_000_000n,
    swatch: ["#2f3a52", "#f4f5f7"],
  },
  {
    sku: "jacket-denim-L",
    image: "/products/jacket-denim.jpg",
    name: "Selvedge denim jacket, L",
    blurb: "14 oz raw selvedge denim, copper buttons, boxy cut.",
    price: 6_000_000n,
    swatch: ["#e3e5ea", "#2b4a75"],
    tag: "Premium",
  },
];

export function productBySku(sku: string | null): Product | undefined {
  return CATALOG.find((p) => p.sku === sku);
}
