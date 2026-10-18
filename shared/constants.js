// Business vocabulary shared by the server and the browser.
// Internal codes (POUR, NOT_POUR ...) stay stable in the database; the interface uses the shop's words.
//   POUR     = "Pour"   (burn chicken)
//   NOT_POUR = "Dress"  (dress chicken)
// What the cashier picks is one of seven SERVICES:
//   Live                       the customer takes it alive
//   Pour, Dress                burned or dressed and left whole (no cutting asked)
//   Po-ur & Slice, Dress & Slice   burned or dressed, then sliced (small, medium or large pieces)
//   Pour & Dukot, Dress & Dukot    burned or dressed, inside removed, not sliced
// Dukot is not a separate cutting choice. A service is saved as before: service (feather) POUR or NOT_POUR with cutting NONE, SLICE
// or DUKOT, so older orders still read correctly. A Pour or Dress with no cutting (cut NONE) is new in revision 10.

export const FEATHER = ['LIVE', 'POUR', 'NOT_POUR']; // the service chosen for a chicken line
export const CUT = ['NONE', 'SLICE', 'DUKOT'];
export const SLICE_SIZES = ['SMALL', 'MEDIUM', 'LARGE'];
// Fees the admin can set. Dara ("With Blood") and Dukot used to carry a fee; they no longer do. Old orders keep the fee they were charged.
export const SERVICE_CODES = ['POUR', 'NOT_POUR'];

// The seven services a chicken line can have, in the order the cashier sees them.
export const SERVICES = ['LIVE', 'POUR', 'NOT_POUR', 'POUR_SLICE', 'NOT_POUR_SLICE', 'POUR_DUKOT', 'NOT_POUR_DUKOT'];
export const SERVICE_LABELS = {
  LIVE: 'Live',
  POUR: 'Pour',
  NOT_POUR: 'Dress',
  POUR_SLICE: 'Po-ur & Slice',
  NOT_POUR_SLICE: 'Dress & Slice',
  POUR_DUKOT: 'Pour & Dukot',
  NOT_POUR_DUKOT: 'Dress & Dukot',
};

export const LABELS = {
  LIVE: 'Live',
  POUR: 'Pour',
  NOT_POUR: 'Dress',
  DARA: 'With Blood',
  NONE: 'No cutting',
  SLICE: 'Slice',
  DUKOT: 'Dukot',
  SMALL: 'Small pieces',
  MEDIUM: 'Medium pieces',
  LARGE: 'Large pieces',
};

// Small explanation shown under each service.
export const SERVICE_NOTES = {
  LIVE: 'Customer takes it alive',
  POUR: 'Burn chicken, whole (not cut)',
  NOT_POUR: 'Dress chicken, whole (not cut)',
  POUR_SLICE: 'Burn chicken, then slice',
  NOT_POUR_SLICE: 'Dress chicken, then slice',
  POUR_DUKOT: 'Burn chicken, inside removed, not sliced',
  NOT_POUR_DUKOT: 'Dress chicken, inside removed, not sliced',
};

// Names used where fees are listed (settings, order slip chips, spreadsheet). DARA and DUKOT are kept only so that
// orders saved before revision 10, which were charged those fees, still read correctly.
export const FEE_LABELS = {
  POUR: 'Pour (burn chicken)',
  NOT_POUR: 'Dress (dress chicken)',
  DARA: 'With Blood',
  DUKOT: 'Dukot',
};

export const STATUS_LABELS = {
  COMPLETED: 'Completed',
  CANCELED: 'Canceled',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partially refunded',
  REPLACED: 'Replaced',
};

// Orders that were really sold. Canceled and replaced orders are not sales.
export const COUNTS_AS_SALE = ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'];

export const PAYMENT_METHODS = {
  CASH: 'Cash',
  GCASH: 'GCash',
  MAYA: 'Maya',
  BANK: 'Bank transfer',
  OTHER: 'Other',
};

// Action type (what was done) is kept separate from the reason (why).
export const REASONS = {
  WRONG_WEIGHT: 'Wrong weight entered',
  WRONG_PRODUCT: 'Wrong product chosen',
  CUSTOMER_CHANGED_MIND: 'Customer changed their mind',
  CUSTOMER_NOT_SATISFIED: 'Customer not satisfied',
  PRICING_ERROR: 'Pricing error',
  OTHER: 'Other (explain below)',
};

export const ACTION_LABELS = {
  SUBMIT: 'Submitted',
  CANCEL: 'Canceled',
  CHANGE: 'Changed (replaced)',
  REFUND: 'Refunded',
  MOVE: 'Moved on the Order List',
};

// How a service fee is charged: once per order line (flat), once per head (x the number of heads), or per kg.
export const FEE_BASIS = ['per_item', 'per_head', 'per_kg'];
export const FEE_BASIS_LABELS = { per_item: 'per line (flat)', per_head: 'per head', per_kg: 'per kg' };
// 'display' (Revision 15) is a screen-only account for the butcher TV: it can open the Butcher screen and nothing else.
// 'assistant' (Revision 16) is the Assistant Cashier: the Order List and the Butcher view only, no prices.
export const ROLES = ['cashier', 'manager', 'admin', 'display', 'assistant'];

// Other products: a fixed price per piece/pack/sack/carton/tray (or an older dozen/batch), or a price per kg.
export const SOLD_BY = { FIXED: 'Fixed price', PER_KG: 'Per kg' };

// Every other product has the same fixed list of units. A unit is sold on the New order screen only once the admin has set its price.
// Stock (Revision 11): each fixed unit (piece, pack, sack, carton, tray) has its own row on the Daily Inventory, but "kg" does not.
// Something sold by the kilo is counted in PIECES: the cashier enters how many pieces and their weight, the price uses the weight, and
// the stock of the product's "piece" row goes down by the number of pieces.
export const PRODUCT_KINDS = { EGGS: 'Eggs', OTHER: 'Other product' };
export const UNITS = { EGGS: ['piece', 'carton', 'tray'], OTHER: ['piece', 'pack', 'sack', 'kg'] };
// How units are ordered on screen and in the spreadsheets (anything else, such as an older dozen or batch, comes after these).
export const UNIT_ORDER = ['piece', 'pack', 'sack', 'kg', 'carton', 'tray', 'dozen', 'batch'];
export const unitRank = (unit) => { const i = UNIT_ORDER.indexOf(String(unit).toLowerCase()); return i < 0 ? UNIT_ORDER.length : i; };

// Why a manager or admin changed a Beginning Balance on the Daily Inventory. Required for a correction.
export const INVENTORY_REASONS = {
  INCORRECT_INVENTORY: 'Incorrect inventory',
  RECOUNT: 'Recount (stock check)',
  TYPING_MISTAKE: 'Typing mistake',
  OTHER: 'Other (explain below)',
};

// Optional discount added on the review screen. The amount is always typed by the cashier (a fixed peso amount or a percentage);
// the reason only says why. Revision 11: Senior citizen and VIP are no longer offered; Wholesale, Dead and Katay were added.
// Dead and Katay as a discount reason are about the price only: they never change the Daily Inventory (Dead and Katay chickens
// are recorded there separately, as inventory losses).
export const DISCOUNT_TYPES = ['NONE', 'FIXED', 'PERCENT'];
export const DISCOUNT_REASONS = {
  BULK: 'Bulk Order Discount',
  REJECT: 'Reject',
  EMPLOYEE: 'Employee Discount',
  WHOLESALE: 'Wholesale',
  DEAD: 'Dead',
  KATAY: 'Katay',
  OTHER: 'Other (explain below)',
};
/** The words for a saved discount reason. Reasons that are no longer offered (Senior citizen, VIP) still read correctly on old orders. */
const OLD_DISCOUNT_REASONS = { SENIOR: 'Senior citizen (no longer offered)', VIP: 'VIP (no longer offered)' };
export const discountReasonLabel = (code) => DISCOUNT_REASONS[code] ?? OLD_DISCOUNT_REASONS[code] ?? code ?? '';

// Which block of the paper Daily Sales Report a chicken product belongs to (Revision 11: a real field, not guessed from the name).
export const CHICKEN_CATEGORIES = { BCULL: 'B-Cull', CULL: 'Cull', BROILER: 'Broiler', OTHER: 'Other chicken' };

// Which row of the EGGS table of the paper Daily Sales Report an egg product is reported on, from its name (Revision 12: "Assorted"
// is said out loud). Assorted eggs are the eggs collected in the shop from different chickens: "Eggs Assorted", "Assorted Eggs" and
// "Eggs (Asst.)" all go on the Asst. row, and so does any egg product whose name gives no size. Returns null when it is not eggs.
export const EGG_SIZES = ['Asst.', 'Sm.', 'Med.', 'Lar.', 'XL'];
export function eggSizeOf(productName) {
  const name = String(productName ?? '');
  if (!/egg|itlog/i.test(name)) return null;
  if (/assort|\basst\b/i.test(name)) return 'Asst.';
  if (/\bxl\b|extra[\s-]*large/i.test(name)) return 'XL';
  if (/small|\bsm\b/i.test(name)) return 'Sm.';
  if (/medium|\bmed\b/i.test(name)) return 'Med.';
  if (/large|\blar\b/i.test(name)) return 'Lar.';
  return 'Asst.';
}

// ---- Revision 12: the Advanced options of the New order screen ------------------------------------------------------------

// Ref stock: Katay and Dead chickens kept in the ref (refrigerator) for preservation, counted in heads. They are put in the ref from the
// Advanced button (which also adds them to the chicken's Katay or Dead on the Daily Inventory), or from the Daily Inventory itself when the
// person says they went into the ref. They are sold by the kilo at a price the cashier types, with no service fee.
export const REF_KINDS = ['KATAY', 'DEAD'];
export const REF_LABELS = { KATAY: 'Katay Chicken', DEAD: 'Dead Chicken' };
/** The Daily Inventory column a ref kind belongs to. */
export const REF_FIELD = { KATAY: 'katay', DEAD: 'dead' };

// Cash breakdown: the bills and coins the cashier counts at the end of the day, largest first. "centavos" is the value of one.
export const CASH_DENOMINATIONS = [
  { key: '1000', label: '₱1,000', centavos: 100000, type: 'bill' },
  { key: '500', label: '₱500', centavos: 50000, type: 'bill' },
  { key: '200', label: '₱200', centavos: 20000, type: 'bill' },
  { key: '100', label: '₱100', centavos: 10000, type: 'bill' },
  { key: '50', label: '₱50', centavos: 5000, type: 'bill' },
  { key: '20', label: '₱20', centavos: 2000, type: 'coin' },
  { key: '10', label: '₱10', centavos: 1000, type: 'coin' },
  { key: '5', label: '₱5', centavos: 500, type: 'coin' },
  { key: '1', label: '₱1', centavos: 100, type: 'coin' },
  { key: '0.25', label: '25 centavos', centavos: 25, type: 'coin' },
];
export const MAX_CASH_PIECES = 99999;

/** The total of a cash count: { '1000': 3, '0.25': 8 } -> centavos. Missing denominations count 0. */
export const cashCountTotal = (counts) => CASH_DENOMINATIONS.reduce((sum, d) => sum + d.centavos * (Number(counts?.[d.key]) || 0), 0);

// Order List (Kanban board): where an order is on its way to the customer. This is separate from the sale status
// above (Completed / Canceled / Refunded ...), which says whether the sale stands.
export const FULFILLMENT = ['ONGOING', 'STANDBY', 'COMPLETE'];
export const FULFILLMENT_LABELS = { ONGOING: 'Ongoing', STANDBY: 'Standby', COMPLETE: 'Complete' };
export const FULFILLMENT_HINTS = { ONGOING: 'Being prepared', STANDBY: 'Ready for pickup', COMPLETE: 'Claimed by the customer' };
