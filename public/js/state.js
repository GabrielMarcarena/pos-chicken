// What the browser remembers: who is signed in, the price list, and the order being typed.
// The unsent order is kept in sessionStorage so a refresh or an accidental Back never loses it.
// (This is only a convenience copy. The saved record always lives on the server.)
import { uuid } from './util.js';
import { chickenLine, otherLine, refLine, grandTotal, discountAmount } from '/shared/pricing.js';
import { parseWeightToGrams, parseQuantityToMilli, parseWholeQuantityToMilli, parsePesosToCentavos, parsePercentToBp, parseHeads } from '/shared/money.js';

export const state = { user: null, config: null, draft: null };

export function newDraft() {
  return {
    items: [], otherItems: [], refItems: [], customerNumber: '', submissionKey: uuid(),
    payment: { method: 'NONE', amount: '', amountEdited: false, received: '', paidAt: '', accountName: '', accountNumber: '', reference: '' },
    discount: { type: 'NONE', value: '', reason: '', note: '' },
    changeOf: null, reason: { code: '', note: '' }, reviewed: false,
  };
}

export function loadDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('pos-draft') ?? 'null');
    if (saved && saved.userId === state.user?.id) {
      const fresh = newDraft();
      state.draft = { ...fresh, ...saved.draft, refItems: saved.draft.refItems ?? [], discount: { ...fresh.discount, ...saved.draft.discount }, payment: { ...fresh.payment, ...saved.draft.payment } };
      return;
    }
  } catch { /* ignore a damaged copy */ }
  state.draft = newDraft();
}

export function saveDraft() {
  try { sessionStorage.setItem('pos-draft', JSON.stringify({ userId: state.user?.id, draft: state.draft })); } catch { /* storage full or blocked */ }
}

export function clearDraft() {
  state.draft = newDraft();
  saveDraft();
}

export const findProduct = (id) => state.config.products.find((p) => p.id === id) ?? null;
export const findOther = (id) => state.config.other_products.find((p) => p.id === id) ?? null;
/** An other-product price option (for example Eggs (Small), per dozen) with its product. */
export function findOption(optionId) {
  for (const product of state.config.other_products) {
    const option = product.options.find((o) => o.id === optionId);
    if (option) return { product, option };
  }
  return null;
}

/** Price one draft chicken item from the current price list. Returns null while the item is not valid. */
export function priceItem(item) {
  const product = findProduct(item.productId);
  const weightG = parseWeightToGrams(item.weight);
  const heads = parseHeads(item.heads ?? '1'); // an order typed before heads existed counts as 1
  if (!product || weightG === null || heads === null) return null;
  return { product, weightG, heads, ...chickenLine({ pricePerKgCentavos: product.price_per_kg_centavos, weightG, heads, prep: item.prep, fees: state.config.fees }) };
}

export function priceOther(item) {
  const found = findOption(item.optionId);
  if (!found) return null;
  // Fixed-price items (piece, dozen, pack, batch) are whole numbers; per-kg items take a weight with decimals and (Revision 11) the
  // number of pieces weighed, which is what comes off the stock.
  const perKg = found.option.sold_by === 'PER_KG';
  const quantityMilli = perKg ? parseQuantityToMilli(item.quantity) : parseWholeQuantityToMilli(item.quantity);
  const pieces = perKg ? parseHeads(item.pieces ?? '1') : null;
  if (quantityMilli === null || (perKg && pieces === null)) return null;
  return { product: found.product, option: found.option, quantityMilli, pieces, ...otherLine({ unitPriceCentavos: found.option.price_centavos, quantityMilli }) };
}

/**
 * Price one Katay or Dead chicken line from the ref (Revision 12): the price per kg the cashier typed x the weight of all the heads.
 * No service fee. Returns null while the line is not valid.
 */
export function priceRef(item) {
  const weightG = parseWeightToGrams(item.weight);
  const heads = parseHeads(item.heads ?? '1');
  const price = parsePesosToCentavos(item.price);
  if (weightG === null || heads === null || price === null || price <= 0) return null;
  const label = state.config?.ref_labels?.[item.kind] ?? item.kind;
  // Revision 13: the line names the chicken it came from ("Katay Chicken - B-Cull").
  return { kind: item.kind, name: item.productName ? `${label} - ${item.productName}` : label, weightG, heads, price, ...refLine({ pricePerKgCentavos: price, weightG }) };
}

/** The optional discount as typed on the review screen: { amount, error }. */
export function draftDiscount(subtotal, d) {
  if (!d || d.type === 'NONE') return { amount: 0, error: null };
  const value = d.type === 'FIXED' ? parsePesosToCentavos(d.value) : parsePercentToBp(d.value);
  if (value === null || value <= 0) return { amount: 0, error: d.type === 'FIXED' ? 'Enter the discount amount in pesos.' : 'Enter a percentage above 0 and up to 100.' };
  if (!d.reason) return { amount: 0, error: 'Choose a reason for the discount.' };
  if (d.reason === 'OTHER' && d.note.trim().length < 3) return { amount: 0, error: 'Explain the discount in the notes box.' };
  const amount = discountAmount(subtotal, d.type, value);
  if (amount <= 0 || amount >= subtotal) return { amount: 0, error: 'The discount must be less than the order subtotal.' };
  return { amount, error: null };
}

/** subtotal (all lines), discount, and the total the customer pays. */
export function draftTotals(draft = state.draft) {
  const subtotal = grandTotal([...draft.items.map((i) => priceItem(i)?.lineTotal ?? 0), ...draft.otherItems.map((i) => priceOther(i)?.lineTotal ?? 0),
    ...(draft.refItems ?? []).map((i) => priceRef(i)?.lineTotal ?? 0)]);
  const { amount, error } = draftDiscount(subtotal, draft.discount);
  return { subtotal, discount: amount, discountError: error, total: subtotal - amount };
}

export const draftTotal = (draft = state.draft) => draftTotals(draft).total;

export const draftLineCount = (draft = state.draft) => draft.items.length + draft.otherItems.length + (draft.refItems?.length ?? 0);

export async function refreshConfig(api) {
  state.config = await api('GET', '/api/config');
}

// ---- Stock (Revision 9) -----------------------------------------------------------------------------------------
// The server sends what can still be sold on the open business day (the New Total of the Daily Inventory) in config.stock.
// The screen subtracts what the order being typed already asks for, so the cashier sees what is really left for this order.
// The server checks again when the order is saved; that check is the one that counts.

/** True when the server sent stock figures (so the screen can check quantities). */
export const hasStock = () => Boolean(state.config?.stock);

/** Heads saved as available for a chicken product on the open business day. */
export const savedHeads = (productId) => state.config?.stock?.chicken_heads?.[productId] ?? 0;
/**
 * The stock row an other-product option is counted on: its own, or (Revision 11) for an option sold by the kilo, the product's piece row.
 */
export const stockOptionOf = (optionId) => state.config?.stock?.other_stock_of?.[optionId] ?? optionId;
/** Thousandths saved as available for an other-product option on the open business day (pieces, for an option sold by the kilo). */
export const savedMilli = (optionId) => state.config?.stock?.other_milli?.[stockOptionOf(optionId)] ?? 0;

/** What one draft or saved other-product line takes from its stock row, in thousandths: its pieces when sold by the kilo, else its quantity. */
export function stockTaken(optionId, quantityText, piecesText) {
  const found = findOption(optionId);
  if (found?.option.sold_by === 'PER_KG') return (parseHeads(piecesText ?? '1') ?? 0) * 1000;
  return parseWholeQuantityToMilli(quantityText) ?? 0;
}

/** What an order being changed holds right now: its own stock counts as free for the replacement (same business day only). */
function released() {
  const held = state.draft?.changeOf?.held;
  const sameDay = held && state.draft.changeOf.dayId === state.config?.stock?.business_day_id;
  return sameDay ? held : { chicken: {}, other: {} };
}

/** Heads of Katay or Dead chicken in the ref (Revision 12). Not tied to a business day. Revision 13: of one chicken when productId is given. */
export const savedRefHeads = (kind, productId = null) => (productId === null
  ? state.config?.stock?.ref_heads?.[kind] ?? 0
  : state.config?.stock?.ref_by_product?.[kind]?.[productId] ?? 0);

/** The chickens with Katay or Dead heads in the ref (Revision 13): [{ id, name, heads }], most heads first. */
export function refProducts(kind) {
  const by = state.config?.stock?.ref_by_product?.[kind] ?? {};
  return Object.entries(by).map(([id, heads]) => ({ id: Number(id), name: findProduct(Number(id))?.name ?? `Chicken #${id}`, heads }))
    .sort((a, b) => b.heads - a.heads || a.name.localeCompare(b.name));
}

/**
 * Heads of Katay or Dead chicken of one chicken product still available for the order being typed (not counting the line being edited).
 * An order being changed gives its own ref heads back, whatever day it was sold on (one sold before Revision 13 has no chicken: its
 * heads count for any chicken of the same kind).
 */
export function availableRefHeads(kind, productId, excludeKey = null) {
  const used = (state.draft.refItems ?? []).filter((i) => i.kind === kind && i.productId === productId && i.key !== excludeKey)
    .reduce((sum, i) => sum + (parseHeads(i.heads ?? '1') ?? 0), 0);
  const held = state.draft?.changeOf?.held?.ref ?? {};
  return Math.max(savedRefHeads(kind, productId) + (held[`${kind}:${productId}`] ?? 0) + (held[`${kind}:null`] ?? 0) - used, 0);
}

/** Heads of a chicken product still available for the order being typed (not counting the line being edited). */
export function availableHeads(productId, excludeKey = null) {
  const used = state.draft.items.filter((i) => i.productId === productId && i.key !== excludeKey).reduce((sum, i) => sum + (parseHeads(i.heads ?? '1') ?? 0), 0);
  return Math.max(savedHeads(productId) + (released().chicken[productId] ?? 0) - used, 0);
}

/**
 * Thousandths of an other-product option still available for the order being typed (not counting the line being edited). Lines that
 * share a stock row are added up: a whole duck by the piece and ducks by the kilo both come off "Ducks - piece".
 */
export function availableMilli(optionId, excludeKey = null) {
  const row = stockOptionOf(optionId);
  const used = state.draft.otherItems.filter((i) => stockOptionOf(i.optionId) === row && i.key !== excludeKey)
    .reduce((sum, i) => sum + stockTaken(i.optionId, i.quantity, i.pieces), 0);
  return Math.max(savedMilli(optionId) + (released().other[row] ?? 0) - used, 0);
}
