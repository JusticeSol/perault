/**
 * Flat garment silhouettes for the demo store, so products read as clothing without photos.
 * The kind comes from the SKU prefix (hoodie-…, tee-…, socks-…, jacket-…). Swap in product
 * photos for a real shop.
 */
const SHAPES: Record<string, string> = {
  tee: "M31 20 L43 14 Q50 20 57 14 L69 20 L86 34 L77 45 L69 39 L69 88 L31 88 L31 39 L23 45 L14 34 Z",
  hoodie:
    "M37 22 Q50 4 63 22 L70 24 L86 40 L89 80 L79 81 L74 48 L71 48 L71 90 L29 90 L29 48 L26 48 L21 81 L11 80 L14 40 L30 24 Z",
  jacket:
    "M37 15 L44 12 L50 24 L56 12 L63 15 L71 19 L86 38 L89 82 L79 83 L74 47 L71 47 L71 90 L29 90 L29 47 L26 47 L21 83 L11 82 L14 38 L29 19 Z",
  socks: "M39 10 L57 10 L57 58 Q57 70 69 75 L80 80 Q89 85 85 92 L49 92 Q38 90 39 78 Z",
};

const DETAILS: Record<string, string> = {
  hoodie: "M38 66 L62 66 L66 80 L34 80 Z",
  jacket: "M50 24 L50 90",
  tee: "",
  socks: "M39 18 L57 18 M39 24 L57 24",
};

export function Garment({ sku, color }: { sku: string; color: string }) {
  const kind = sku.split("-")[0];
  const shape = SHAPES[kind];
  if (!shape) return null;
  const detail = DETAILS[kind];
  return (
    <svg className="garment-art" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path d={shape} fill={color} />
      {detail && <path d={detail} fill={kind === "hoodie" ? "rgba(0,0,0,0.12)" : "none"} stroke="rgba(0,0,0,0.18)" strokeWidth="1.2" />}
    </svg>
  );
}
