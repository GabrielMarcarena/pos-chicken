// Daily Inventory arithmetic and wording, shared by the server (which enforces it) and the browser (which shows it).
//
// All stock figures are whole thousandths ("milli"): 77 heads = 77000. Chicken is counted in heads, other products in pieces
// (or packs, sacks, cartons, trays); something sold by the kilo is counted in pieces too.
//
//   Chicken:        Total = Beginning + Additional      Left = Total - Sold      New Total = Left - Reject - Katay - Dead - Pull Out
//   Other products: Total = Beginning + Additional      Left = Total - Sold      New Total = Left
//
// Sold is never typed in. It is worked out from the saved orders of the business day (see src/services/inventory.js).
// Reject, Katay, Dead and Pull Out are inventory losses, not sales and not discounts, and exist for chicken only.
// Katay (Revision 11): a dying chicken that is slaughtered and bled at once so the meat is not damaged.

// The columns of the two tables, in this order, on the screen and in the exports.
export const CHICKEN_COLUMNS = ['Chicken Category', 'Beginning Balance', 'Additional', 'Total', 'Sold', 'Left', 'Reject', 'Katay', 'Dead', 'Pull Out', 'New Total'];
export const OTHER_COLUMNS = ['Product Name', 'Beginning Balance', 'Additional', 'Total', 'Sold', 'Left', 'New Total'];

export const LOSS_FIELDS = ['reject', 'katay', 'dead', 'pull_out'];
export const LOSS_LABELS = { reject: 'Reject', katay: 'Katay', dead: 'Dead', pull_out: 'Pull Out' };

/** Reject + Katay + Dead + Pull Out of a chicken record (a record saved before Katay existed counts 0 Katay). */
export const lossesOf = (rec) => rec.reject + (rec.katay ?? 0) + rec.dead + rec.pull_out;

/**
 * The calculated columns of one row. rec has beginning, additional, reject, katay, dead, pull_out (thousandths); sold is thousandths.
 * Returns { total, sold, left, new_total }.
 */
export function computeRow(kind, rec, sold) {
  const total = rec.beginning + rec.additional;
  const left = total - sold;
  const losses = kind === 'CHICKEN' ? lossesOf(rec) : 0;
  return { total, sold, left, new_total: left - losses };
}

/**
 * A row with nothing in it: no Beginning Balance, nothing added and nothing sold. Other products with such a row are left out of the
 * Daily Inventory list and the Daily Report (the Whole Inventory export keeps them). A row that sold out today is NOT empty, so a
 * product that ran out is still shown with what happened to it. Chicken rows are always shown.
 */
export const isEmptyRow = (row) => row.kind === 'OTHER' && row.beginning === 0 && row.additional === 0 && row.sold === 0;

/** "2026-10-12" -> "10/12/2026" (month/day/year, as the shop writes it) */
export function formatDateMDY(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
}

/** The small italic note beside a Beginning Balance: the previous business day's Beginning Balance and its date, e.g. "(177 10/12/2026)". */
export function previousBeginningText(row) {
  return row.prev_beginning === null || row.prev_beginning === undefined ? '' : `(${formatQty(row.prev_beginning)} ${formatDateMDY(row.prev_date)})`;
}

const trimmed = (milli) => String(Number((milli / 1000).toFixed(3)));
/** 77000 -> "77", 1500 -> "1.5" */
export const formatQty = (milli) => trimmed(milli);

/** "piece" -> "pieces", "batch" -> "batches", "kg" stays "kg"; singular when the amount is exactly 1. */
export function unitWord(unit, milli) {
  if (unit === 'kg' || milli === 1000) return unit;
  return /(s|x|ch|sh)$/.test(unit) ? `${unit}es` : `${unit}s`;
}

/** "3 heads", "1 head", "20 pieces", "1.5 kg" */
export function describeQty(kind, unit, milli) {
  const word = kind === 'CHICKEN' ? (milli === 1000 ? 'head' : 'heads') : unitWord(unit, milli);
  return `${formatQty(milli)} ${word}`;
}

/** The exact message shown when an order asks for more than is available. */
export function insufficientStockMessage(kind, name, unit, availableMilli) {
  return `Insufficient stock. Only ${describeQty(kind, unit, Math.max(availableMilli, 0))} of ${name} ${availableMilli === 1000 ? 'is' : 'are'} available.`;
}

/**
 * Check one row after a proposed change. Returns a list of plain-language problems (empty = fine).
 *   * no figure may be negative (the database also refuses that)
 *   * Reject + Katay + Dead + Pull Out together may not be more than what is Left
 *   * the New Total may not end up below zero
 */
export function checkRow(kind, rec, sold, unit = 'heads') {
  const errors = [];
  for (const field of ['beginning', 'additional', ...(kind === 'CHICKEN' ? LOSS_FIELDS : [])]) {
    if (!Number.isInteger(rec[field]) || rec[field] < 0) errors.push(`${field === 'pull_out' ? 'Pull Out' : field[0].toUpperCase() + field.slice(1)} cannot be negative.`);
  }
  if (errors.length) return errors;
  const calc = computeRow(kind, rec, sold);
  if (kind === 'CHICKEN') {
    const losses = lossesOf(rec);
    if (losses > Math.max(calc.left, 0)) {
      errors.push(`Reject, Katay, Dead and Pull Out together (${formatQty(losses)}) cannot be more than what is left (${formatQty(Math.max(calc.left, 0))} ${unit}).`);
      return errors;
    }
  }
  if (calc.new_total < 0) {
    errors.push(`That would leave a negative balance (${formatQty(calc.new_total)} ${unit}). ${formatQty(sold)} ${unit} ${sold === 1000 ? 'is' : 'are'} already sold on this business day, so the total cannot be lower than that.`);
  }
  return errors;
}
