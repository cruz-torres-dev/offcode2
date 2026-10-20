// Transfer instructions are frozen into each order: a later change of the
// owner's bank settings must never alter what a buyer was told to pay into.
const ORDER_ID = /^OF-[A-F0-9]{12}$/;

// SPEI concepts are free text, but several banking apps reject accents,
// punctuation or anything over 40 characters. Letters, digits and spaces only.
export const TRANSFER_CONCEPT = /^[A-Z0-9 ]{1,40}$/;

export function transferConcept(orderId) {
  if (typeof orderId !== "string" || !ORDER_ID.test(orderId))
    throw Error("invalid_order_reference");
  const concept = "OFFCODE " + orderId.replace("-", "");
  if (!TRANSFER_CONCEPT.test(concept)) throw Error("invalid_transfer_concept");
  return concept;
}

export function bankSnapshot(bank) {
  const name = typeof bank?.name === "string" ? bank.name.trim() : "";
  const beneficiary = typeof bank?.beneficiary === "string" ? bank.beneficiary.trim() : "";
  const clabe = typeof bank?.clabe === "string" ? bank.clabe.trim() : "";
  if (!name || !beneficiary || !/^\d{18}$/.test(clabe)) return null;
  return { name, beneficiary, clabe };
}

// Null whenever the order cannot be paid by transfer right now, so callers
// never render a partial set of bank details.
export function transferInstructions(order) {
  const account = bankSnapshot(order?.transferAccount);
  if (!account || order.status !== "awaiting_transfer" || !Number.isSafeInteger(order.totalCents) ||
      typeof order.transferConcept !== "string" || !TRANSFER_CONCEPT.test(order.transferConcept))
    return null;
  return {
    reference: order.id,
    concept: order.transferConcept,
    totalCents: order.totalCents,
    currency: "MXN",
    bank: account.name,
    beneficiary: account.beneficiary,
    clabe: account.clabe,
  };
}
