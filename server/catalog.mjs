// Public commercial facts for the OFFCODE hoodie.
//
// Source: the private tech pack supplied by the brand (never copied into this
// repository, `dist/` or Git) plus the brand's confirmation of the 420 g/m²
// fabric weight. Only commercial data belongs here: no supplier names, costs,
// printing placements, embroidery sizes or manufacturing instructions.
//
// The tech pack lists XS–XXL but no quantities, so availability stays
// explicitly unconfirmed instead of being guessed. Update this file when the
// brand confirms them; nothing else in the storefront or the server needs to
// change.
//
// The brand will not provide a measurement table (chest/body/sleeve) or a
// preparation time, so neither is published here: the storefront shows no size
// guide and promises no handling or delivery window.

export const SIZES = Object.freeze(["XS", "S", "M", "L", "XL", "XXL"]);

// `available: true` means the size can be ordered today. `false` means it is
// listed in the tech pack but not enabled for sale, so the server rejects it.
const sizeTable = Object.freeze([
  Object.freeze({ code: "XS", available: false }),
  Object.freeze({ code: "S", available: true }),
  Object.freeze({ code: "M", available: true }),
  Object.freeze({ code: "L", available: true }),
  Object.freeze({ code: "XL", available: true }),
  Object.freeze({ code: "XXL", available: false }),
]);

export const PRODUCT = Object.freeze({
  name: "Hoodie Oversize",
  line: "LA AFRO × OFFCODE",
  season: "SS 2026",
  color: "Negro",
  composition: "100% algodón",
  fabricWeightGsm: 420,
  fit: "Oversize",
  sizes: sizeTable,
});

export const SALE_SIZES = Object.freeze(
  sizeTable.filter((s) => s.available).map((s) => s.code),
);

export const isSaleSize = (code) => SALE_SIZES.includes(code);

// Everything below is public: it is rendered in the storefront and returned by
// /api/config. Never add tokens, sender addresses or provider credentials here.
export function publicProduct() {
  return {
    name: PRODUCT.name,
    line: PRODUCT.line,
    season: PRODUCT.season,
    color: PRODUCT.color,
    composition: PRODUCT.composition,
    fabricWeightGsm: PRODUCT.fabricWeightGsm,
    fit: PRODUCT.fit,
    sizes: PRODUCT.sizes.map((s) => ({ code: s.code, available: s.available })),
    saleSizes: [...SALE_SIZES],
  };
}
