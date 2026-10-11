// What the browser remembers: who is signed in, the price list, and the order being typed.
// The unsent order is kept in sessionStorage so a refresh or an accidental Back never loses it.
// (This is only a convenience copy. The saved record always lives on the server.)
import { uuid } from './util.js';
import { chickenLine, otherLine, grandTotal, discountAmount } from '/shared/pricing.js';
import { parseWeightToGrams, parseQuantityToMilli, parseWholeQuantityToMilli, parsePesosToCentavos, parsePercentToBp, parseHeads } from '/shared/money.js';

export const state = { user: null, config: null, draft: null };

export function newDraft() {
  return {
    items: [], otherItems: [], customerNumber: '', submissionKey: uuid(),
    payment: { method: 'NONE', amount: '', amountEdited: false, paidAt: '', accountName: '', accountNumber: '', reference: '' },
    discount: { type: 'NONE', value: '', reason: '', note: '' },
    changeOf: null, reason: { code: '', note: '' }, reviewed: false,
  };
}

export function loadDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('pos-draft') ?? 'null');
    if (saved && saved.userId === state.user?.id) {
      const fresh = newDraft();
      state.draft = { ...fresh, ...saved.draft, discount: { ...fresh.discount, ...saved.draft.discount }, payment: { ...fresh.payment, ...saved.draft.payment } };
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
  // Fixed-price items (piece, dozen, pack, batch) are whole numbers; per-kg items take a weight with decimals.
  const quantityMilli = found.option.sold_by === 'PER_KG' ? parseQuantityToMilli(item.quantity) : parseWholeQuantityToMilli(item.quantity);
  if (quantityMilli === null) return null;
  return { product: found.product, option: found.option, quantityMilli, ...otherLine({ unitPriceCentavos: found.option.price_centavos, quantityMilli }) };
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
  const subtotal = grandTotal([...draft.items.map((i) => priceItem(i)?.lineTotal ?? 0), ...draft.otherItems.map((i) => priceOther(i)?.lineTotal ?? 0)]);
  const { amount, error } = draftDiscount(subtotal, draft.discount);
  return { subtotal, discount: amount, discountError: error, total: subtotal - amount };
}

export const draftTotal = (draft = state.draft) => draftTotals(draft).total;

export const draftLineCount = (draft = state.draft) => draft.items.length + draft.otherItems.length;

export async function refreshConfig(api) {
  state.config = await api('GET', '/api/config');
}
