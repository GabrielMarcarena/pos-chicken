// Business vocabulary shared by the server and the browser.
// Internal codes (POUR, NOT_POUR ...) stay stable in the database; the interface uses the shop's words.
//   POUR     = "Po-ur & Slice"   (burn chicken)
//   NOT_POUR = "Dressed & Slice" (dress chicken)

export const FEATHER = ['LIVE', 'POUR', 'NOT_POUR']; // the service chosen for a chicken line
export const CUT = ['NONE', 'SLICE', 'DUKOT'];
export const SLICE_SIZES = ['SMALL', 'MEDIUM', 'LARGE'];
export const SERVICE_CODES = ['POUR', 'NOT_POUR', 'DARA', 'DUKOT']; // codes that can carry a fee

export const LABELS = {
  LIVE: 'Live',
  POUR: 'Po-ur & Slice',
  NOT_POUR: 'Dressed & Slice',
  DARA: 'Dara',
  NONE: 'No cutting',
  SLICE: 'Slice',
  DUKOT: 'Dukot',
  SMALL: 'Small pieces',
  MEDIUM: 'Medium pieces',
  LARGE: 'Large pieces',
};

// Small explanation shown under each service.
export const SERVICE_NOTES = { LIVE: 'Customer takes it alive', POUR: 'Burn chicken', NOT_POUR: 'Dress chicken' };

// Names used where fees are listed (settings, order slip chips, spreadsheet).
export const FEE_LABELS = {
  POUR: 'Po-ur & Slice (burn chicken)',
  NOT_POUR: 'Dressed & Slice (dress chicken)',
  DARA: 'Dara',
  DUKOT: 'Dukot (extra fee)',
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
export const ROLES = ['cashier', 'manager', 'admin'];

// Other products: a fixed price per piece/pack/dozen/batch, or a price per kg.
export const SOLD_BY = { FIXED: 'Fixed price', PER_KG: 'Per kg' };

// Optional discount added on the review screen.
export const DISCOUNT_TYPES = ['NONE', 'FIXED', 'PERCENT'];
export const DISCOUNT_REASONS = {
  SENIOR: 'Senior citizen',
  BULK: 'Bulk Order Discount',
  REJECT: 'Reject',
  EMPLOYEE: 'Employee Discount',
  VIP: 'VIP',
  OTHER: 'Other (explain below)',
};

// Order List (Kanban board): where an order is on its way to the customer. This is separate from the sale status
// above (Completed / Canceled / Refunded ...), which says whether the sale stands.
export const FULFILLMENT = ['ONGOING', 'STANDBY', 'COMPLETE'];
export const FULFILLMENT_LABELS = { ONGOING: 'Ongoing', STANDBY: 'Standby', COMPLETE: 'Complete' };
export const FULFILLMENT_HINTS = { ONGOING: 'Being prepared', STANDBY: 'Ready for pickup', COMPLETE: 'Claimed by the customer' };
