// Daily Sales Report ("Download Daily Report"): the shop's paper form, filled in with what the app knows.
//
// Revision 14: the paper form again (landscape, the chicken blocks side by side), with each block now also showing the Katay and Dead
// chicken of that type sold from the ref, under its live sales. Live, Katay and Dead each have their own heads, kilos and amount; only the
// money is added (TOTAL AMOUNT). DISCOUNTS sits above EXPENSES, and every column ends on the same last row: the TOTAL AMOUNT of each block,
// the TOTAL AMOUNT of the expenses and EXCESS/LOSS.
//
// Filled in automatically: date, time span, cashier, the sales ledger for each chicken type (heads, customer, kilos,
// price, service, amount) with totals, heads sold, eggs and other products sold, the list of discounts and the sales totals.
// Revision 12 also fills in: the Katay / Dead chicken sold from the ref (a block of its own), the EXPENSES typed in New order > Advanced,
// and the CASH BREAKDOWN counted there (every bill and coin), with the expected cash and the EXCESS/LOSS.
// Left blank on purpose, because the cashier counts them by hand: chicken balance / additional / left, egg beginning and left.
//
// Only orders that were really sold are listed (Completed, Refunded). Canceled and replaced orders are not.
// Revision 11: the report date is the BUSINESS DAY the orders were sold on (the same day the Daily Inventory counts them on), and a
// chicken product goes into the block chosen as its category on the Products screen (B-Cull, Cull, Broiler, or a block of its own).
import { COUNTS_AS_SALE, CASH_DENOMINATIONS, discountReasonLabel, eggSizeOf, EGG_SIZES } from '../../shared/constants.js';
import { expensesOf, latestCashCount, latestCashOnHand, cashSales } from './cashbook.js';
import { toPhtDateTime } from '../time.js';
import { Sheet, buildWorkbook, style, colName } from '../xlsx.js';

// ---- Which block of the form does a product belong to? ----------------------------------------------

const BLOCKS = { BCULL: 'B-CULL', CULL: 'CULL', BROILER: 'BROILER', REF: 'KATAY / DEAD (source not recorded)' };

/**
 * B-CULL, CULL and BROILER are the form's three blocks, chosen by the product's category. Any other chicken product gets a block of its own.
 * Revision 13: Katay and Dead chicken sold from the ref go into the block of the chicken they came from. Only a sale made before
 * Revision 13 (when the chicken was not recorded) goes into a block of its own, KATAY / DEAD (source not recorded).
 */
export function blockFor(category, productName) {
  if (BLOCKS[category]) return { key: category, title: BLOCKS[category] };
  const name = String(productName);
  return { key: `OTHER:${name.toLowerCase()}`, title: name.toUpperCase() };
}

/** The egg size row for an other product, or null when the product is not eggs (shared with the Products screen, which shows it). */
export const eggSize = eggSizeOf;
export { EGG_SIZES };

// ---- Gathering -------------------------------------------------------------------------------------

const fmt12 = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const qtyText = (milli) => (milli % 1000 === 0 ? String(milli / 1000) : String(Number((milli / 1000).toFixed(3))));

export function gatherDaily(db, { date, cashierId = null }) {
  const marks = COUNTS_AS_SALE.map(() => '?').join(',');
  const orders = db.prepare(`
    SELECT o.id, o.order_number, o.submitted_at, o.customer_number, o.status, o.discount_centavos, o.discount_reason, o.discount_note,
           o.refund_centavos, u.display_name AS cashier_name
    FROM orders o JOIN users u ON u.id = o.cashier_id LEFT JOIN business_days d ON d.id = o.business_day_id
    WHERE COALESCE(d.business_date, o.business_date) = ? AND o.status IN (${marks}) ${cashierId ? 'AND o.cashier_id = ?' : ''}
    ORDER BY o.id`).all(date, ...COUNTS_AS_SALE, ...(cashierId ? [cashierId] : []));

  const chicken = [];
  const other = [];
  const discounts = [];
  for (const o of orders) {
    const base = {
      order: o.order_number, time: toPhtDateTime(o.submitted_at).slice(11), cashier: o.cashier_name,
      customer: o.customer_number === 'WALK-IN' ? 'Walk-in' : o.customer_number, refunded: o.refund_centavos > 0,
    };
    for (const i of db.prepare('SELECT i.*, p.category FROM order_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = ? ORDER BY i.line_no').all(o.id)) {
      chicken.push({
        ...base, product: i.product_name, category: i.category ?? 'OTHER', heads: i.heads, kilos: i.weight_g / 1000, price: i.price_per_kg_centavos,
        service: i.service_fee_centavos, weightAmount: i.weight_amount_centavos, amount: i.line_total_centavos,
      });
    }
    for (const i of db.prepare('SELECT x.*, p.kind AS product_kind FROM order_other_items x LEFT JOIN other_products p ON p.id = x.other_product_id WHERE x.order_id = ? ORDER BY x.line_no').all(o.id)) {
      other.push({ ...base, product: i.product_name, unit: i.unit, qtyMilli: i.quantity_milli, pieces: i.pieces ?? null, price: i.unit_price_centavos, amount: i.line_total_centavos, kind: i.product_kind ?? 'OTHER' });
    }
    // Revision 12: Katay / Dead chicken from the ref. No service fee; the price per kg is the one the cashier typed.
    // Revision 13: with the chicken it came from (its category picks the block); refKind marks it as Katay or Dead, never live.
    for (const i of db.prepare(`SELECT x.*, p.name AS source, p.category FROM order_ref_items x LEFT JOIN products p ON p.id = x.product_id
                                WHERE x.order_id = ? ORDER BY x.line_no`).all(o.id)) {
      chicken.push({
        ...base, product: i.source ?? i.product_name, category: i.source ? i.category ?? 'OTHER' : 'REF', refKind: i.ref_kind,
        heads: i.heads, kilos: i.weight_g / 1000, price: i.price_per_kg_centavos, service: 0, weightAmount: i.line_total_centavos, amount: i.line_total_centavos,
      });
    }
    if (o.discount_centavos > 0) {
      discounts.push({ ...base, reason: `${discountReasonLabel(o.discount_reason)}${o.discount_note ? `: ${o.discount_note}` : ''}`, amount: o.discount_centavos });
    }
  }
  const times = orders.map((o) => toPhtDateTime(o.submitted_at).slice(11));
  const names = [...new Set(orders.map((o) => o.cashier_name))];
  let cashierLabel = names.length ? names.join(', ') : 'All cashiers';
  if (cashierId) cashierLabel = db.prepare('SELECT display_name FROM users WHERE id = ?').get(cashierId)?.display_name ?? cashierLabel;
  // Revision 12: the expenses and the cash count of the business day (only what this cashier typed, on a report for one cashier).
  const day = db.prepare('SELECT id FROM business_days WHERE business_date = ?').get(date);
  const expenses = day ? expensesOf(db, day.id, { cashierId, includeRemoved: false }).map((e) => ({ item: e.item, amount: e.amount_centavos })) : [];
  const cashCount = day ? latestCashCount(db, day.id, cashierId) : null;
  const money = day ? cashSales(db, day.id, cashierId) : { cash: 0, non_cash: 0 };
  const cashOnHand = day ? latestCashOnHand(db, day.id)?.amount_centavos ?? 0 : 0;   // Revision 16: the starting cash of the day
  return {
    date, cashierLabel, orderCount: orders.length,
    expenses, expensesTotal: expenses.reduce((sum, e) => sum + e.amount, 0), cashCount, nonCash: money.non_cash, cashOnHand,
    timeLabel: times.length ? `${fmt12(times[0])} - ${fmt12(times[times.length - 1])}` : '',
    chicken, other, discounts,
    discount: orders.reduce((s, o) => s + o.discount_centavos, 0),
    refunds: orders.reduce((s, o) => s + o.refund_centavos, 0),
  };
}

const sumOf = (lines) => ({
  heads: lines.reduce((s, l) => s + l.heads, 0), kilos: lines.reduce((s, l) => s + l.kilos, 0), amount: lines.reduce((s, l) => s + l.amount, 0),
});

/**
 * Group the lines into the form's blocks, egg sizes and "others" rows. A block's `lines` are its live chicken; Revision 13: `katay` and
 * `dead` are the Katay and Dead of that chicken sold from the ref, each with its own totals (`katayTotal`, `deadTotal`). heads, kilos
 * and amount of a block are its live chicken only.
 */
export function buildModel(data) {
  const blank = (key, title) => ({ key, title, lines: [], katay: [], dead: [] });
  const blocks = [blank('BCULL', 'B-CULL'), blank('CULL', 'CULL'), blank('BROILER', 'BROILER')];
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  const later = [];   // blocks of their own: after B-CULL, CULL and BROILER, with "source not recorded" last
  for (const line of data.chicken) {
    const { key, title } = blockFor(line.category, line.product);
    let block = byKey.get(key);
    if (!block) { block = blank(key, title); later.push(block); byKey.set(key, block); }
    if (line.refKind === 'KATAY') block.katay.push(line);
    else if (line.refKind === 'DEAD') block.dead.push(line);
    else block.lines.push(line);
  }
  blocks.push(...later.filter((b) => b.key !== 'REF'), ...later.filter((b) => b.key === 'REF'));
  for (const b of blocks) {
    const prices = new Set(b.lines.map((l) => l.price));
    b.price = prices.size === 1 ? [...prices][0] : null;       // one price that day, or null when it varied
    Object.assign(b, sumOf(b.lines));
    b.katayTotal = sumOf(b.katay);
    b.deadTotal = sumOf(b.dead);
  }
  const eggs = new Map(EGG_SIZES.map((s) => [s, { size: s, units: new Map(), amount: 0 }]));
  const others = new Map();
  for (const l of data.other) {
    // An Eggs product goes on the EGGS table even when its name has no "egg" in it (for example "Itlog"): on the Asst. row unless the name gives a size.
    const size = eggSize(l.product) ?? (l.kind === 'EGGS' ? 'Asst.' : null);
    if (size) {
      const row = eggs.get(size);
      row.units.set(l.unit, (row.units.get(l.unit) ?? 0) + l.qtyMilli);
      row.amount += l.amount;
    } else {
      const key = `${l.product}|${l.unit}`;
      const row = others.get(key) ?? { product: l.product, unit: l.unit, qtyMilli: 0, pieces: 0, amount: 0 };
      row.qtyMilli += l.qtyMilli; row.amount += l.amount; row.pieces += l.pieces ?? 0;
      others.set(key, row);
    }
  }
  const eggRows = [...eggs.values()].map((r) => ({ ...r, sold: [...r.units].map(([unit, q]) => `${qtyText(q)} ${unit}`).join(' + ') }));
  // Something sold by the kilo also shows the pieces it was (for example "2.4 kg (2 pcs)"): the stock is counted in pieces.
  const otherRows = [...others.values()].sort((a, b) => a.product.localeCompare(b.product) || a.unit.localeCompare(b.unit))
    .map((r) => ({ ...r, sold: `${qtyText(r.qtyMilli)} ${r.unit}${r.pieces ? ` (${r.pieces} pc${r.pieces === 1 ? '' : 's'})` : ''}` }));
  return { blocks, eggRows, otherRows, eggAmount: eggRows.reduce((s, r) => s + r.amount, 0), otherAmount: otherRows.reduce((s, r) => s + r.amount, 0) };
}

// ---- The Excel sheet -----------------------------------------------------------------------------------

class Grid {
  constructor() { this.cells = new Map(); this.merges = []; this.maxR = 0; this.maxC = 0; }
  put(r, c, v, s, extra = {}) {
    this.cells.set(`${r},${c}`, { v, s, ...extra });
    this.maxR = Math.max(this.maxR, r); this.maxC = Math.max(this.maxC, c);
  }
  /** A merged box. Every cell in it carries the style so the border shows all the way round. */
  box(r1, c1, r2, c2, v, s, extra = {}) {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) this.put(r, c, r === r1 && c === c1 ? v : null, s, r === r1 && c === c1 ? extra : {});
    if (r1 !== r2 || c1 !== c2) this.merges.push(`${colName(c1)}${r1}:${colName(c2)}${r2}`);
  }
  rows() {
    const out = [];
    for (let r = 1; r <= this.maxR; r++) {
      const row = [];
      for (let c = 1; c <= this.maxC; c++) row.push(this.cells.get(`${r},${c}`) ?? null);
      out.push(row);
    }
    return out;
  }
}

const BLUE = '1F5FA8';
const RED = 'C00000';
const S = {
  title: style({ bold: true, size: 18, color: '14573F', align: 'center' }),
  info: style({ bold: true, size: 11, border: 'thin', fill: 'F4F6F3' }),
  blockTitle: style({ bold: true, size: 13, color: BLUE, border: 'thin', fill: 'E8F0FA', align: 'center' }),
  section: style({ bold: true, size: 12, color: BLUE, border: 'thin', fill: 'E8F0FA', align: 'center' }),
  sub: style({ bold: true, italic: true, color: '7A4B00', border: 'thin', fill: 'FFF4D6', align: 'left' }),
  label: style({ bold: true, border: 'thin', fill: 'F4F6F3', align: 'center' }),
  head: style({ bold: true, border: 'thin', fill: 'E1EFE7', align: 'center', wrap: true }),
  blank: style({ border: 'thin' }),
  blankPeso: style({ border: 'thin', align: 'right', format: 'peso' }),
  text: style({ border: 'thin', align: 'left' }),
  center: style({ border: 'thin', align: 'center' }),
  count: style({ border: 'thin', align: 'center', format: 'count' }),
  kg: style({ border: 'thin', align: 'right', format: 'kg' }),
  peso: style({ border: 'thin', align: 'right', format: 'peso' }),
  totalLabel: style({ bold: true, color: RED, border: 'thin', align: 'center', fill: 'FFF4D6' }),
  totalCount: style({ bold: true, border: 'thin', align: 'center', fill: 'FFF4D6', format: 'count' }),
  totalKg: style({ bold: true, border: 'thin', align: 'center', fill: 'FFF4D6', format: 'kg' }),
  totalPeso: style({ bold: true, border: 'thin', align: 'right', fill: 'FFF4D6', format: 'peso' }),
  grand: style({ bold: true, size: 11, color: RED, border: 'thin', align: 'center', fill: 'FFF4D6' }),
  note: style({ italic: true, color: '566870', wrap: true, valign: 'top' }),
  noteBold: style({ bold: true, size: 11 }),
};

const BLOCK_COLS = 7;           // # of HDS, customer, kilos, price, service, price, amount
const MIN_LEDGER_ROWS = 15;
const ref = (r, c) => `${colName(c)}${r}`;
const range = (r1, r2, c) => `${ref(r1, c)}:${ref(r2, c)}`;
const pesoNum = (c) => c / 100;
const round2 = (n) => Number(n.toFixed(2));
const round3 = (n) => Number(n.toFixed(3));

export function buildDailyXlsx(data) {
  const m = buildModel(data);
  // B-CULL, CULL and BROILER always show; a block of its own only when it sold something.
  const blocks = m.blocks.filter((b, i) => i < 3 || b.lines.length || b.katay.length || b.dead.length);
  const N = blocks.length;
  const eggC = 1 + BLOCK_COLS * N;      // eggs, discounts and expenses: 5 columns
  const othC = eggC + 5;                // others, collections and the cash breakdown: 3 columns
  const totalCols = othC + 2;
  const expenses = data.expenses ?? [];
  const D = CASH_DENOMINATIONS.length;
  const g = new Grid();

  // ---- Heights. Every column ends on the same last row (`bottom`), so the report is one clean rectangle: the TOTAL AMOUNT of every
  // chicken block, the TOTAL AMOUNT of the expenses and EXCESS/LOSS are all on it. Blank (writable) rows take up the slack. ----
  const LEDGER0 = 9;
  const content = (b) => b.lines.length + 1 + (b.katay.length ? b.katay.length + 1 : 0) + (b.dead.length ? b.dead.length + 1 : 0) + 1;
  const discRows = Math.max(3, data.discounts.length);
  const eggRowsEnd = 5 + m.eggRows.length;                 // the eggs TOTAL AMOUNT row
  const discTitle = eggRowsEnd + 2;
  const discTotal = discTitle + 2 + discRows;
  const expTitle = discTotal + 2;
  const collLines = N + 2;                                 // one per block, then EGGS and OTHERS
  const othersNeeded = Math.max(5, m.otherRows.length);
  const othersRowsAt = (bottom) => {                       // OTHERS rows that fit above COLLECTIONS and the cash block ending at `bottom`
    const cashTitle = bottom - (D + 6);
    const collTitle = cashTitle - 2 - (collLines + 5);
    return collTitle - 2 - 5;
  };
  let bottom = Math.max(LEDGER0 + Math.max(MIN_LEDGER_ROWS, ...blocks.map(content)) + 4, expTitle + 2 + Math.max(5, expenses.length));
  while (othersRowsAt(bottom) < othersNeeded) bottom += 1;
  const ledgerRows = bottom - 4 - LEDGER0;
  const R = { title: 1, info: 2, blockHead: 3, stockLabel: 4, stockBox: 5, sold: 6, left: 7, ledgerHead: 8, ledger0: LEDGER0, totHead: bottom - 4, live: bottom - 3, katay: bottom - 2, dead: bottom - 1, total: bottom };

  g.box(R.title, 1, R.title, totalCols, 'DAILY SALES REPORT', S.title);
  const dateText = new Date(`${data.date}T00:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
  g.box(R.info, 1, R.info, BLOCK_COLS, `DATE: ${dateText}`, S.info);
  g.box(R.info, 1 + BLOCK_COLS, R.info, 2 * BLOCK_COLS, `TIME: ${data.timeLabel}`, S.info);
  g.box(R.info, 1 + 2 * BLOCK_COLS, R.info, 3 * BLOCK_COLS, `CASHIER: ${data.cashierLabel}`, S.info);

  // ---- One block per chicken type: the live sales, then that chicken's Katay and Dead from the ref, each with its own totals ----
  const amountCell = [];   // where each block's TOTAL AMOUNT sits, for COLLECTIONS
  blocks.forEach((b, bi) => {
    const c0 = 1 + BLOCK_COLS * bi;
    const own = b.key === 'REF';   // "source not recorded": no live sales, no price, no stock boxes
    if (own) g.box(R.blockHead, c0, R.blockHead, c0 + 6, b.title, S.blockTitle);
    else {
      g.box(R.blockHead, c0, R.blockHead, c0 + 1, b.title, S.blockTitle);
      g.box(R.blockHead, c0 + 2, R.blockHead, c0 + 3, 'PRICE ₱', S.label);
      if (b.price !== null) g.box(R.blockHead, c0 + 4, R.blockHead, c0 + 6, pesoNum(b.price), S.peso);
      else g.box(R.blockHead, c0 + 4, R.blockHead, c0 + 6, b.lines.length ? 'various' : null, S.center);
      // counted by hand: left empty
      g.box(R.stockLabel, c0, R.stockLabel, c0 + 1, 'Chicken Balance', S.label);
      g.box(R.stockLabel, c0 + 2, R.stockLabel, c0 + 3, 'Additional', S.label);
      g.box(R.stockLabel, c0 + 4, R.stockLabel, c0 + 6, 'TOTAL', S.label);
      g.box(R.stockBox, c0, R.stockBox, c0 + 1, null, S.blank);
      g.box(R.stockBox, c0 + 2, R.stockBox, c0 + 3, null, S.blank);
      g.box(R.stockBox, c0 + 4, R.stockBox, c0 + 6, null, S.blank);
      // SOLD is the live heads sold (Katay and Dead come from the ref); LEFT is counted by hand
      g.box(R.sold, c0, R.sold, c0 + 1, 'SOLD (live)', S.label);
      g.box(R.sold, c0 + 2, R.sold, c0 + 6, b.heads, S.count, { f: ref(R.live, c0) });
      g.box(R.left, c0, R.left, c0 + 1, 'LEFT', S.label);
      g.box(R.left, c0 + 2, R.left, c0 + 6, null, S.blank);
    }
    ['# of HDS', "Customer's #/NAME", 'KILOS', 'Price', 'Service', 'Price', 'AMOUNT'].forEach((h, i) => g.put(R.ledgerHead, c0 + i, h, S.head));

    const line = (r, l) => {
      g.put(r, c0, l ? l.heads : null, S.count);
      g.put(r, c0 + 1, l ? (l.refunded ? `${l.customer} (refunded)` : l.customer) : null, S.text);
      g.put(r, c0 + 2, l ? l.kilos : null, S.kg);
      g.put(r, c0 + 3, l ? pesoNum(l.price) : null, S.peso);
      g.put(r, c0 + 4, l ? pesoNum(l.service) : null, S.peso);
      g.put(r, c0 + 5, l ? pesoNum(l.weightAmount) : null, S.peso);
      g.put(r, c0 + 6, l ? pesoNum(l.amount) : null, S.peso);
    };
    let r = R.ledger0;
    // live: its lines and one empty row to write in. A Katay / Dead part follows only when there is one.
    const liveFirst = r;
    b.lines.forEach((l) => { line(r, l); r += 1; });
    line(r, null); r += 1;
    const liveLast = r - 1;
    const part = (title, lines) => {
      if (!lines.length) return null;
      g.box(r, c0, r, c0 + 6, title, S.sub);
      r += 1;
      const first = r;
      lines.forEach((l) => { line(r, l); r += 1; });
      return [first, r - 1];
    };
    const katayRows = part(own ? 'KATAY (from the ref), no service fee' : `${b.title}: KATAY (from the ref), no service fee`, b.katay);
    const deadRows = part(own ? 'DEAD (from the ref), no service fee' : `${b.title}: DEAD (from the ref), no service fee`, b.dead);
    while (r < R.ledger0 + ledgerRows) { line(r, null); r += 1; }

    // Totals: heads, kilos and amount of Live, Katay and Dead each on their own row (never added together), then the money of all three.
    g.put(R.totHead, c0, '# OF HDS', S.head); g.put(R.totHead, c0 + 1, null, S.head); g.put(R.totHead, c0 + 2, 'KILOS', S.head); g.box(R.totHead, c0 + 3, R.totHead, c0 + 6, 'AMOUNT', S.head);
    const totalRow = (row, label, rows, t) => {
      g.put(row, c0 + 1, label, S.totalLabel);
      if (rows && rows[1] >= rows[0]) {
        g.put(row, c0, t.heads, S.totalCount, { f: `SUM(${range(rows[0], rows[1], c0)})` });
        g.put(row, c0 + 2, round3(t.kilos), S.totalKg, { f: `SUM(${range(rows[0], rows[1], c0 + 2)})` });
        g.box(row, c0 + 3, row, c0 + 6, pesoNum(t.amount), S.totalPeso, { f: `SUM(${range(rows[0], rows[1], c0 + 6)})` });
      } else {
        g.put(row, c0, 0, S.totalCount); g.put(row, c0 + 2, 0, S.totalKg); g.box(row, c0 + 3, row, c0 + 6, 0, S.totalPeso);
      }
    };
    totalRow(R.live, 'LIVE', own ? null : [liveFirst, liveLast], b);
    totalRow(R.katay, 'KATAY', katayRows, b.katayTotal);
    totalRow(R.dead, 'DEAD', deadRows, b.deadTotal);
    const amountOf = (row) => ref(row, c0 + 3);
    const money = pesoNum(b.amount + b.katayTotal.amount + b.deadTotal.amount);
    g.box(R.total, c0, R.total, c0 + 2, 'TOTAL AMOUNT', S.totalLabel);
    g.box(R.total, c0 + 3, R.total, c0 + 6, money, S.totalPeso, { f: `${amountOf(R.live)}+${amountOf(R.katay)}+${amountOf(R.dead)}` });
    amountCell.push({ title: b.title, cell: ref(R.total, c0 + 3), value: money });
  });

  // ---- Eggs (sold and amount known; beginning and left counted by hand) ----
  g.box(3, eggC, 3, eggC + 4, 'EGGS', S.section);
  ['SIZES', 'BEG', 'SOLD', 'LEFT', 'AMOUNT'].forEach((h, i) => g.put(4, eggC + i, h, S.head));
  m.eggRows.forEach((e, i) => {
    const r = 5 + i;
    g.put(r, eggC, e.size, S.label);
    g.put(r, eggC + 1, null, S.blank);
    g.put(r, eggC + 2, e.sold || null, S.center);
    g.put(r, eggC + 3, null, S.blank);
    g.put(r, eggC + 4, pesoNum(e.amount), S.peso);
  });
  g.box(eggRowsEnd, eggC, eggRowsEnd, eggC + 3, 'TOTAL AMOUNT', S.totalLabel);
  g.put(eggRowsEnd, eggC + 4, pesoNum(m.eggAmount), S.totalPeso, { f: `SUM(${range(5, eggRowsEnd - 1, eggC + 4)})` });
  const eggCell = ref(eggRowsEnd, eggC + 4);

  // ---- Discounts (Revision 14: moved here, above the expenses): one row per discounted order, then the total of all discounts ----
  g.box(discTitle, eggC, discTitle, eggC + 4, 'DISCOUNTS', S.section);
  g.box(discTitle + 1, eggC, discTitle + 1, eggC + 1, 'CUSTOMER NAME', S.head);
  g.box(discTitle + 1, eggC + 2, discTitle + 1, eggC + 3, 'REASON', S.head);
  g.put(discTitle + 1, eggC + 4, 'DISCOUNT', S.head);
  for (let i = 0; i < discRows; i++) {
    const d = data.discounts[i];
    const r = discTitle + 2 + i;
    g.box(r, eggC, r, eggC + 1, d ? d.customer : null, S.text);
    g.box(r, eggC + 2, r, eggC + 3, d ? d.reason : null, S.text);
    g.put(r, eggC + 4, d ? pesoNum(d.amount) : null, S.peso);
  }
  g.box(discTotal, eggC, discTotal, eggC + 3, 'TOTAL DISCOUNTS', S.totalLabel);
  g.put(discTotal, eggC + 4, pesoNum(data.discount), S.totalPeso, { f: `SUM(${range(discTitle + 2, discTotal - 1, eggC + 4)})` });
  const discountCell = ref(discTotal, eggC + 4);

  // ---- Expenses: the ones typed in New order > Advanced fill the rows, the rest stay empty to write in. Its TOTAL AMOUNT is on the last row. ----
  g.box(expTitle, eggC, expTitle, eggC + 4, 'EXPENSES', S.section);
  g.box(expTitle + 1, eggC, expTitle + 1, eggC + 3, 'EXPENSE ITEMS', S.head);
  g.put(expTitle + 1, eggC + 4, 'AMOUNT', S.head);
  for (let r = expTitle + 2; r < bottom; r++) {
    const e = expenses[r - expTitle - 2];
    g.box(r, eggC, r, eggC + 3, e ? e.item : null, e ? S.text : S.blank);
    g.put(r, eggC + 4, e ? pesoNum(e.amount) : null, S.blankPeso);
  }
  const expensesTotal = pesoNum(data.expensesTotal ?? 0);
  g.box(bottom, eggC, bottom, eggC + 3, 'TOTAL AMOUNT', S.totalLabel);
  g.put(bottom, eggC + 4, expensesTotal, S.totalPeso, { f: `SUM(${range(expTitle + 2, bottom - 1, eggC + 4)})` });
  const expenseCell = ref(bottom, eggC + 4);

  // ---- Others ----
  const othRows = othersRowsAt(bottom);
  g.box(3, othC, 3, othC + 2, 'OTHERS', S.section);
  ['PRODUCTS', 'SOLD', 'AMOUNT'].forEach((h, i) => g.put(4, othC + i, h, S.head));
  for (let i = 0; i < othRows; i++) {
    const o = m.otherRows[i];
    g.put(5 + i, othC, o ? o.product : null, S.text);
    g.put(5 + i, othC + 1, o ? o.sold : null, S.center);
    g.put(5 + i, othC + 2, o ? pesoNum(o.amount) : null, S.peso);
  }
  const othTotalRow = 5 + othRows;
  g.box(othTotalRow, othC, othTotalRow, othC + 1, 'TOTAL AMOUNT', S.totalLabel);
  g.put(othTotalRow, othC + 2, pesoNum(m.otherAmount), S.totalPeso, { f: `SUM(${range(5, othTotalRow - 1, othC + 2)})` });

  // ---- Collections, gross sales, net sales ----
  const collTitle = othTotalRow + 2;
  g.box(collTitle, othC, collTitle, othC + 2, 'COLLECTIONS', S.section);
  const first = collTitle + 1;
  const lines = [...amountCell.map((a) => ({ title: a.title, f: a.cell, value: a.value })),
    { title: 'EGGS', f: eggCell, value: pesoNum(m.eggAmount) },
    { title: 'OTHERS', f: ref(othTotalRow, othC + 2), value: pesoNum(m.otherAmount) }];
  lines.forEach((l, i) => { g.box(first + i, othC, first + i, othC + 1, l.title, S.label); g.put(first + i, othC + 2, l.value, S.peso, { f: l.f }); });
  const gross = lines.reduce((s, l) => s + l.value, 0);
  const grossRow = first + lines.length;
  g.box(grossRow, othC, grossRow, othC + 1, 'GROSS SALES', S.grand);
  g.put(grossRow, othC + 2, round2(gross), S.totalPeso, { f: `SUM(${range(first, grossRow - 1, othC + 2)})` });
  const discRow = grossRow + 1;
  g.box(discRow, othC, discRow, othC + 1, 'LESS DISCOUNTS', S.label);
  g.put(discRow, othC + 2, pesoNum(data.discount), S.peso, { f: discountCell });
  const refundRow = discRow + 1;
  g.box(refundRow, othC, refundRow, othC + 1, 'LESS REFUNDS', S.label);
  g.put(refundRow, othC + 2, pesoNum(data.refunds), S.peso);
  const expRow = refundRow + 1;
  g.box(expRow, othC, expRow, othC + 1, 'LESS EXPENSES', S.label);
  g.put(expRow, othC + 2, expensesTotal, S.peso, { f: expenseCell });
  const netRow = expRow + 1;
  const net = round2(gross - pesoNum(data.discount) - pesoNum(data.refunds) - expensesTotal);
  g.box(netRow, othC, netRow, othC + 1, 'NET SALES', S.grand);
  g.put(netRow, othC + 2, net, S.totalPeso,
    { f: `${ref(grossRow, othC + 2)}-${ref(discRow, othC + 2)}-${ref(refundRow, othC + 2)}-${ref(expRow, othC + 2)}` });

  // ---- Cash breakdown (every bill and coin, from the count saved in New order > Advanced). EXCESS/LOSS is on the last row. ----
  // PIECES is how many of each; AMOUNT = pieces x the bill or coin (a formula, so a number typed in by hand adds up too).
  const cash = bottom - (D + 6);
  const counts = data.cashCount?.counts ?? null;
  g.box(cash, othC, cash, othC + 2, data.cashCount ? `CASH BREAKDOWN (counted by ${data.cashCount.by} at ${toPhtDateTime(data.cashCount.counted_at).slice(11)})` : 'CASH BREAKDOWN', S.section);
  ['BILLS AND COINS', 'PIECES', 'AMOUNT'].forEach((h, i) => g.put(cash + 1, othC + i, h, S.head));
  const first0 = cash + 2;
  CASH_DENOMINATIONS.forEach((d, i) => {
    const r = first0 + i;
    const n = counts ? Number(counts[d.key]) || 0 : null;
    g.put(r, othC, `${d.label} ${d.type}`, S.label);
    g.put(r, othC + 1, n, S.count);
    g.put(r, othC + 2, n === null ? 0 : round2((n * d.centavos) / 100), S.peso, { f: `${ref(r, othC + 1)}*${d.centavos / 100}` });
  });
  const totalRow0 = first0 + D;
  const overall = counts ? pesoNum(data.cashCount.total_centavos) : 0;
  g.box(totalRow0, othC, totalRow0, othC + 1, 'OVERALL TOTAL', S.grand);
  g.put(totalRow0, othC + 2, overall, S.totalPeso, { f: `SUM(${range(first0, totalRow0 - 1, othC + 2)})` });
  // What the drawer should hold: net sales, less what was paid by GCash, Maya, bank or other (that money is not in the drawer).
  const nonCashRow = totalRow0 + 1;
  g.box(nonCashRow, othC, nonCashRow, othC + 1, 'LESS NON-CASH PAYMENTS', S.label);
  g.put(nonCashRow, othC + 2, pesoNum(data.nonCash ?? 0), S.peso);
  // Revision 16: the starting cash (panukli) is in the drawer too, so it is added to what the drawer should hold.
  const onHandRow = nonCashRow + 1;
  const onHand = pesoNum(data.cashOnHand ?? 0);
  g.box(onHandRow, othC, onHandRow, othC + 1, 'PLUS CASH ON HAND', S.label);
  g.put(onHandRow, othC + 2, onHand, S.peso);
  const expectedRow = onHandRow + 1;
  const expected = round2(net - pesoNum(data.nonCash ?? 0) + onHand);
  g.box(expectedRow, othC, expectedRow, othC + 1, 'EXPECTED CASH', S.label);
  g.put(expectedRow, othC + 2, expected, S.peso, { f: `${ref(netRow, othC + 2)}-${ref(nonCashRow, othC + 2)}+${ref(onHandRow, othC + 2)}` });
  const excessRow = expectedRow + 1;   // === bottom
  g.box(excessRow, othC, excessRow, othC + 1, 'EXCESS/LOSS', S.grand);
  g.put(excessRow, othC + 2, counts ? round2(overall - expected) : '', S.totalPeso,
    { f: `IF(${ref(totalRow0, othC + 2)}=0,"",${ref(totalRow0, othC + 2)}-${ref(expectedRow, othC + 2)})` });

  const sheet = new Sheet('Daily Sales Report');
  sheet.rows = g.rows();
  sheet.merges = g.merges;
  sheet.widths = [
    ...blocks.flatMap(() => [9, 18, 7, 8, 8, 9, 10]),
    9, 9, 16, 9, 12,
    24, 24, 12,
  ];
  sheet.heights = { [R.title]: 30, [R.ledgerHead]: 30 };
  sheet.print = { landscape: true, fitWidth: true };

  // ---- A short notes sheet so nobody has to guess what the columns mean ----
  const notes = new Sheet('Notes');
  notes.widths = [120];
  const texts = [
    ['How this report is filled in', 'noteBold'],
    ['Filled in by the app from the orders of the day: date, time span, cashier, the ledger of each chicken type, heads sold, eggs and other products sold, and the sales totals.', 'note'],
    ['The page is the paper form: one block per chicken type side by side, then EGGS, DISCOUNTS and EXPENSES in one column, and OTHERS, COLLECTIONS and the CASH BREAKDOWN in the next. Every column ends on the same last row.', 'note'],
    ['Left empty on purpose, for the cashier to write or type in: Chicken Balance, Additional, TOTAL and LEFT for each chicken type; egg BEG and LEFT. The totals update by themselves when you type numbers in.', 'note'],
    ['EXPENSES are the ones typed in New order > Advanced > Expenses for this business day (the empty rows below them can still be written in). LESS EXPENSES takes their total off.', 'note'],
    ['CASH BREAKDOWN is the latest count saved in New order > Advanced > Cash breakdown: PIECES of each bill and coin, AMOUNT = pieces x value. OVERALL TOTAL adds them up. EXPECTED CASH = NET SALES - LESS NON-CASH PAYMENTS (GCash, Maya, bank and other payments are not in the drawer) + PLUS CASH ON HAND (the starting cash typed in New order > Advanced > Cash breakdown). EXCESS/LOSS = OVERALL TOTAL - EXPECTED CASH: above zero is extra cash, below zero is missing cash. It stays empty until the cash is counted.', 'note'],
    ['Katay and Dead chicken sold from the ref are listed inside the block of the chicken they came from (under a "B-CULL: KATAY (from the ref)" line), at the price per kg the cashier typed, with no service fee. At the bottom of each block LIVE, KATAY and DEAD have their own heads, kilos and amount; their heads and kilos are never added together, and SOLD (live) counts live chicken only. TOTAL AMOUNT adds the money of the three, and that is what goes into COLLECTIONS and GROSS SALES. A sale made before the chicken was recorded is listed under KATAY / DEAD (source not recorded).', 'note'],
    ['DISCOUNTS lists every discounted order of the day (customer, reason, discount); TOTAL DISCOUNTS adds them up and is what LESS DISCOUNTS takes off.', 'note'],
    ['', 'note'],
    ['What the ledger columns mean', 'noteBold'],
    ['# of HDS = number of chickens (heads) on that sale. KILOS = their combined weight.', 'note'],
    ['Price = price per kg. Service = the service fee for that line (charged per head, so 3 heads at ₱25 = ₱75). The second Price = kilos × price (before the service fee). AMOUNT = the line total.', 'note'],
    ['Each chicken product goes into the block chosen as its category on the Products screen (for example Brown Cull Chicken is in CULL). A product whose category is "Other chicken" gets its own block to the right of the Broiler block.', 'note'],
    ['The report date is the business day: the orders counted on that day of the Daily Inventory.', 'note'],
    ['', 'note'],
    ['Which orders are included', 'noteBold'],
    ['Only orders that were sold. Canceled orders and orders that were replaced by a changed order are not listed. A refunded order is listed and marked "(refunded)"; the refund is taken off under LESS REFUNDS.', 'note'],
    ['GROSS SALES is the sum of the sales before discounts. LESS DISCOUNTS and LESS REFUNDS are added lines that the paper form does not have. NET SALES = gross sales - discounts - refunds - expenses.', 'note'],
    ['Eggs: SOLD is shown in the units they were sold in (for example 2 dozen + 5 piece). Egg sizes come from the product name (Small, Medium, Large, XL). Assorted eggs (collected in the shop from different chickens) go on the Asst. row: name the product for example "Eggs Assorted". An egg product whose name gives no size is counted as Assorted too.', 'note'],
  ];
  texts.forEach(([t, st]) => notes.addRow([{ v: t, s: S[st] }]));

  return buildWorkbook([sheet, notes]);
}
