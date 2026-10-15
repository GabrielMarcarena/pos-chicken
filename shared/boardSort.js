// Sorting for the Order List. Pure functions, so the browser and the tests use exactly the same code.
//
// Every option sorts on stored data (submitted_at, customer_number, order_number, id), never on where a card happens to be
// on the screen. Sorting returns a new list and never changes an order.

export const SORTS = [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['name_az', 'Customer A–Z'],
  ['name_za', 'Customer Z–A'],
  ['number', 'Order number'],
];
export const DEFAULT_SORT = 'newest';

/** Milliseconds since 1970, or null when the stored date is missing or not a real date. */
export function timeOf(iso) {
  if (iso === null || iso === undefined || iso === '') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** The customer's name as typed at checkout; '' for a walk-in (no name). */
export function customerName(order) {
  const text = String(order.customer_number ?? '').trim();
  return text === '' || text.toUpperCase() === 'WALK-IN' ? '' : text;
}

const text = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });
const idOf = (o) => Number(o.id) || 0;

// Newest first, orders with no usable date last, ties broken by id so the order is always the same.
function newestFirst(a, b) {
  const ta = timeOf(a.submitted_at), tb = timeOf(b.submitted_at);
  if (ta === null && tb === null) return idOf(b) - idOf(a);
  if (ta === null) return 1;
  if (tb === null) return -1;
  return tb - ta || idOf(b) - idOf(a);
}

function oldestFirst(a, b) {
  const ta = timeOf(a.submitted_at), tb = timeOf(b.submitted_at);
  if (ta === null && tb === null) return idOf(a) - idOf(b);
  if (ta === null) return 1;
  if (tb === null) return -1;
  return ta - tb || idOf(a) - idOf(b);
}

// Named customers first, walk-ins (no name) after them in either direction; equal names show the newest order first.
function byName(direction) {
  return (a, b) => {
    const na = customerName(a), nb = customerName(b);
    if (!na && !nb) return newestFirst(a, b);
    if (!na) return 1;
    if (!nb) return -1;
    return direction * text(na, nb) || newestFirst(a, b);
  };
}

// ORD-20261011-009 reads as date then number of the day, so plain ascending order is also oldest-to-newest by order number.
function byOrderNumber(a, b) {
  return text(String(a.order_number ?? ''), String(b.order_number ?? '')) || idOf(a) - idOf(b);
}

const COMPARE = { newest: newestFirst, oldest: oldestFirst, name_az: byName(1), name_za: byName(-1), number: byOrderNumber };

export function sortOrders(orders, mode = DEFAULT_SORT) {
  return [...orders].sort(COMPARE[mode] ?? newestFirst);
}
