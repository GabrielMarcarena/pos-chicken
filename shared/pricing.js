// Line and order totals. The server is the authority; the browser uses the same functions for the live preview.

import { mulDivRound } from './money.js';

/**
 * Which paid services does this preparation use? Live uses none. Pour (burn) and Dress each carry their own fee, per head, whatever the
 * cutting is (whole, sliced or Dukot). With Blood (dara) and Dukot are no longer charged.
 */
export function serviceCodes(prep) {
  const codes = [];
  if (prep.feather === 'POUR') codes.push('POUR');
  if (prep.feather === 'NOT_POUR') codes.push('NOT_POUR');
  return codes;
}

/**
 * Price one chicken line.
 *   weight charge = price per kg x live weight (rounded half up to the centavo)
 *   each service fee = flat amount, or rate per kg x live weight (rounded half up)
 *   line total = weight charge + service fees
 * fees looks like { POUR: { amount: 4500, basis: 'per_item' }, ... }; a missing fee counts as 0.
 *
 * heads is the number of chickens on the line. weightG is the TOTAL weight of all of them, weighed together, so the
 * weight charge never depends on heads. Only a fee set to "per head" is multiplied by heads.
 */
export function chickenLine({ pricePerKgCentavos, weightG, heads = 1, prep, fees }) {
  const weightAmount = mulDivRound(pricePerKgCentavos, weightG, 1000);
  const feeLines = serviceCodes(prep).map((code) => {
    const fee = fees[code] ?? { amount: 0, basis: 'per_item' };
    const amount = fee.basis === 'per_kg' ? mulDivRound(fee.amount, weightG, 1000) : fee.basis === 'per_head' ? fee.amount * heads : fee.amount;
    return { code, amount, basis: fee.basis, rate: fee.amount };
  });
  const serviceFee = feeLines.reduce((sum, f) => sum + f.amount, 0);
  return { weightAmount, heads, fees: feeLines, serviceFee, lineTotal: weightAmount + serviceFee };
}

/**
 * Price one other-product line: price x quantity (quantity in thousandths).
 * A fixed-price item (piece, dozen, pack, batch) uses a whole quantity; a per-kg item uses the weight in kg.
 * Both are the same sum: unit price x quantity.
 */
export function otherLine({ unitPriceCentavos, quantityMilli }) {
  return { lineTotal: mulDivRound(unitPriceCentavos, quantityMilli, 1000) };
}

/**
 * Price one Katay or Dead chicken line from the ref (Revision 12): the price per kg the cashier typed x the weight of all the heads,
 * rounded half up to the centavo, like a chicken line. No service fee is ever added.
 */
export function refLine({ pricePerKgCentavos, weightG }) {
  return { lineTotal: mulDivRound(pricePerKgCentavos, weightG, 1000) };
}

/** The subtotal is the sum of the already-rounded line totals, so the slip always adds up exactly. */
export function grandTotal(lineTotals) {
  return lineTotals.reduce((sum, t) => sum + t, 0);
}

/**
 * Discount amount in centavos for a subtotal.
 *   FIXED:   value is centavos
 *   PERCENT: value is basis points (20% = 2000), rounded half up to the centavo
 * Returns 0 for no discount. The caller checks that the amount is above 0 and below the subtotal.
 */
export function discountAmount(subtotal, type, value) {
  if (type === 'FIXED') return value;
  if (type === 'PERCENT') return mulDivRound(subtotal, value, 10_000);
  return 0;
}
