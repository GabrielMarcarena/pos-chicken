// Daily Sales Report ("Download Daily Report"): the shop's paper form, filled in with what the app knows.
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
import { expensesOf, latestCashCount, cashSales } from './cashbook.js';
import { toPhtDateTime } from '../time.js';
import { Sheet, buildWorkbook, style, colName } from '../xlsx.js';

// ---- Which block of the form does a product belong to? ----------------------------------------------

const BLOCKS = { BCULL: 'B-CULL', CULL: 'CULL', BROILER: 'BROILER', REF: 'KATAY / DEAD (REF)' };

/**
 * B-CULL, CULL and BROILER are the form's three blocks, chosen by the product's category. Any other chicken product gets a block of its own.
 * Revision 12: Katay and Dead chicken sold from the ref (category REF) share one block, KATAY / DEAD (REF).
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
    for (const i of db.prepare('SELECT * FROM order_ref_items WHERE order_id = ? ORDER BY line_no').all(o.id)) {
      chicken.push({
        ...base, product: i.product_name, category: 'REF', heads: i.heads, kilos: i.weight_g / 1000, price: i.price_per_kg_centavos,
        service: 0, weightAmount: i.line_total_centavos, amount: i.line_total_centavos,
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
  return {
    date, cashierLabel, orderCount: orders.length,
    expenses, expensesTotal: expenses.reduce((sum, e) => sum + e.amount, 0), cashCount, nonCash: money.non_cash,
    timeLabel: times.length ? `${fmt12(times[0])} - ${fmt12(times[times.length - 1])}` : '',
    chicken, other, discounts,
    discount: orders.reduce((s, o) => s + o.discount_centavos, 0),
    refunds: orders.reduce((s, o) => s + o.refund_centavos, 0),
  };
}

/** Group the lines into the form's blocks, egg sizes and "others" rows. */
export function buildModel(data) {
  const blocks = [{ key: 'BCULL', title: 'B-CULL', lines: [] }, { key: 'CULL', title: 'CULL', lines: [] }, { key: 'BROILER', title: 'BROILER', lines: [] }];
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  for (const line of data.chicken) {
    const { key, title } = blockFor(line.category, line.product);
    let block = byKey.get(key);
    if (!block) { block = { key, title, lines: [] }; blocks.push(block); byKey.set(key, block); }
    block.lines.push(line);
  }
  for (const b of blocks) {
    const prices = new Set(b.lines.map((l) => l.price));
    b.price = prices.size === 1 ? [...prices][0] : null;       // one price that day, or null when it varied
    b.heads = b.lines.reduce((s, l) => s + l.heads, 0);
    b.kilos = b.lines.reduce((s, l) => s + l.kilos, 0);
    b.amount = b.lines.reduce((s, l) => s + l.amount, 0);
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

// ---- The Excel sheet that looks like the paper form ----------------------------------------------------

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

const BLOCK_COLS = 7;
const MIN_LEDGER_ROWS = 20;
const ref = (r, c) => `${colName(c)}${r}`;
const range = (r1, r2, c) => `${ref(r1, c)}:${ref(r2, c)}`;
const pesoNum = (c) => c / 100;
const round2 = (n) => Number(n.toFixed(2));

export function buildDailyXlsx(data) {
  const m = buildModel(data);
  const N = m.blocks.length;
  const ledgerRows = Math.max(MIN_LEDGER_ROWS, ...m.blocks.map((b) => b.lines.length));
  const R = { title: 1, info: 2, blockHead: 3, stockLabel: 4, stockBox: 5, sold: 6, left: 7, ledgerHead: 8, ledger0: 9 };
  R.totLabel = R.ledger0 + ledgerRows;
  R.totValue = R.totLabel + 1;
  const eggC = 1 + BLOCK_COLS * N;      // eggs table: 5 columns
  const othC = eggC + 5;                // others and the summary: 3 columns
  const totalCols = othC + 2;
  const g = new Grid();

  g.box(R.title, 1, R.title, totalCols, 'DAILY SALES REPORT', S.title);

  // The three header boxes: DATE, TIME, CASHIER
  const dateText = new Date(`${data.date}T00:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
  g.box(R.info, 1, R.info, BLOCK_COLS, `DATE: ${dateText}`, S.info);
  g.box(R.info, 1 + BLOCK_COLS, R.info, 2 * BLOCK_COLS, `TIME: ${data.timeLabel}`, S.info);
  g.box(R.info, 1 + 2 * BLOCK_COLS, R.info, 3 * BLOCK_COLS, `CASHIER: ${data.cashierLabel}`, S.info);

  // ---- One block per chicken type ----
  const amountCell = []; // where each block's total amount sits, for the collections summary
  m.blocks.forEach((b, bi) => {
    const c0 = 1 + BLOCK_COLS * bi;
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
    // SOLD is known (heads sold); LEFT is counted by hand
    g.box(R.sold, c0, R.sold, c0 + 1, 'SOLD', S.label);
    g.box(R.sold, c0 + 2, R.sold, c0 + 6, b.heads, S.count, { f: ref(R.totValue, c0) });
    g.box(R.left, c0, R.left, c0 + 1, 'LEFT', S.label);
    g.box(R.left, c0 + 2, R.left, c0 + 6, null, S.blank);
    ['# of HDS', "Customer's #/NAME", 'KILOS', 'Price', 'Service', 'Price', 'AMOUNT'].forEach((h, i) => g.put(R.ledgerHead, c0 + i, h, S.head));
    for (let i = 0; i < ledgerRows; i++) {
      const r = R.ledger0 + i;
      const l = b.lines[i];
      if (!l) { for (let k = 0; k < BLOCK_COLS; k++) g.put(r, c0 + k, null, k === 0 ? S.count : k === 1 ? S.text : k === 2 ? S.kg : S.peso); continue; }
      g.put(r, c0, l.heads, S.count);
      g.put(r, c0 + 1, l.refunded ? `${l.customer} (refunded)` : l.customer, S.text);
      g.put(r, c0 + 2, l.kilos, S.kg);
      g.put(r, c0 + 3, pesoNum(l.price), S.peso);
      g.put(r, c0 + 4, pesoNum(l.service), S.peso);
      g.put(r, c0 + 5, pesoNum(l.weightAmount), S.peso);
      g.put(r, c0 + 6, pesoNum(l.amount), S.peso);
    }
    const last = R.ledger0 + ledgerRows - 1;
    g.put(R.totLabel, c0, '# OF HDS', S.totalLabel);
    g.box(R.totLabel, c0 + 1, R.totLabel, c0 + 2, 'KILOS', S.totalLabel);
    g.box(R.totLabel, c0 + 3, R.totLabel, c0 + 6, 'TOTAL AMOUNT', S.totalLabel);
    g.put(R.totValue, c0, b.heads, S.totalCount, { f: `SUM(${range(R.ledger0, last, c0)})` });
    g.box(R.totValue, c0 + 1, R.totValue, c0 + 2, round2(b.kilos * 1000) / 1000, S.totalKg, { f: `SUM(${range(R.ledger0, last, c0 + 2)})` });
    g.box(R.totValue, c0 + 3, R.totValue, c0 + 6, pesoNum(b.amount), S.totalPeso, { f: `SUM(${range(R.ledger0, last, c0 + 6)})` });
    amountCell.push({ title: b.title, cell: ref(R.totValue, c0 + 3), value: pesoNum(b.amount) });
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
  const eggTotalRow = 5 + m.eggRows.length;
  g.box(eggTotalRow, eggC, eggTotalRow, eggC + 3, 'TOTAL AMOUNT', S.totalLabel);
  g.put(eggTotalRow, eggC + 4, pesoNum(m.eggAmount), S.totalPeso, { f: `SUM(${range(5, eggTotalRow - 1, eggC + 4)})` });

  // ---- Expenses (counted by hand: empty boxes that add up if filled in) ----
  const expTitle = eggTotalRow + 2;
  g.box(expTitle, eggC, expTitle, eggC + 4, 'EXPENSES', S.section);
  g.box(expTitle + 1, eggC, expTitle + 1, eggC + 3, 'EXPENSE ITEMS', S.head);
  g.put(expTitle + 1, eggC + 4, 'AMOUNT', S.head);
  // Revision 12: the expenses typed in New order > Advanced fill the rows; the rest stay empty to write in by hand.
  const expenses = data.expenses ?? [];
  const EXPENSE_ROWS = Math.max(10, expenses.length);
  for (let i = 0; i < EXPENSE_ROWS; i++) {
    const e = expenses[i];
    g.box(expTitle + 2 + i, eggC, expTitle + 2 + i, eggC + 3, e ? e.item : null, e ? S.text : S.blank);
    g.put(expTitle + 2 + i, eggC + 4, e ? pesoNum(e.amount) : null, S.blankPeso);
  }
  const expTotalRow = expTitle + 2 + EXPENSE_ROWS;
  const expensesTotal = pesoNum(data.expensesTotal ?? 0);
  g.box(expTotalRow, eggC, expTotalRow, eggC + 3, 'TOTAL AMOUNT', S.totalLabel);
  g.put(expTotalRow, eggC + 4, expensesTotal, S.totalPeso, { f: `SUM(${range(expTitle + 2, expTotalRow - 1, eggC + 4)})` });
  const expenseCell = ref(expTotalRow, eggC + 4);

  // ---- Others ----
  g.box(3, othC, 3, othC + 2, 'OTHERS', S.section);
  ['PRODUCTS', 'SOLD', 'AMOUNT'].forEach((h, i) => g.put(4, othC + i, h, S.head));
  const otherRows = Math.max(5, m.otherRows.length);
  for (let i = 0; i < otherRows; i++) {
    const o = m.otherRows[i];
    g.put(5 + i, othC, o ? o.product : null, S.text);
    g.put(5 + i, othC + 1, o ? o.sold : null, S.center);
    g.put(5 + i, othC + 2, o ? pesoNum(o.amount) : null, S.peso);
  }
  const othTotalRow = 5 + otherRows;
  g.box(othTotalRow, othC, othTotalRow, othC + 1, 'TOTAL AMOUNT', S.totalLabel);
  g.put(othTotalRow, othC + 2, pesoNum(m.otherAmount), S.totalPeso, { f: `SUM(${range(5, othTotalRow - 1, othC + 2)})` });

  // ---- Discounts (Revision 11, in place of "Other collections"): one row per discounted order, then the total of all discounts ----
  let r = othTotalRow + 2;
  g.box(r, othC, r, othC + 2, 'DISCOUNTS', S.section);
  ['CUSTOMER NAME', 'REASON', 'DISCOUNT'].forEach((h, i) => g.put(r + 1, othC + i, h, S.head));
  const discRows = Math.max(3, data.discounts.length);
  for (let i = 0; i < discRows; i++) {
    const d = data.discounts[i];
    g.put(r + 2 + i, othC, d ? d.customer : null, S.text);
    g.put(r + 2 + i, othC + 1, d ? d.reason : null, S.text);
    g.put(r + 2 + i, othC + 2, d ? pesoNum(d.amount) : null, S.peso);
  }
  const discTotalRow = r + 2 + discRows;
  g.box(discTotalRow, othC, discTotalRow, othC + 1, 'TOTAL DISCOUNTS', S.totalLabel);
  g.put(discTotalRow, othC + 2, pesoNum(data.discount), S.totalPeso, { f: `SUM(${range(r + 2, discTotalRow - 1, othC + 2)})` });
  const discountCell = ref(discTotalRow, othC + 2);
  r = discTotalRow + 2;

  // ---- Collections, gross sales, net sales ----
  g.box(r, othC, r, othC + 2, 'COLLECTIONS', S.section);
  const first = r + 1;
  const lines = [...amountCell.map((a) => ({ title: a.title, f: a.cell, value: a.value })),
    { title: 'EGGS', f: ref(eggTotalRow, eggC + 4), value: pesoNum(m.eggAmount) },
    { title: 'OTHERS', f: ref(othTotalRow, othC + 2), value: pesoNum(m.otherAmount) }];
  lines.forEach((l, i) => { g.box(first + i, othC, first + i, othC + 1, l.title, S.label); g.put(first + i, othC + 2, l.value, S.peso, { f: l.f }); });
  const gross = lines.reduce((s, l) => s + l.value, 0);
  const grossRow = first + lines.length;
  g.box(grossRow, othC, grossRow, othC + 1, 'GROSS SALES', S.grand);
  g.put(grossRow, othC + 2, round2(gross), S.totalPeso, { f: `SUM(${range(first, grossRow - 1, othC + 2)})` });
  const discRow = grossRow + 1;
  g.box(discRow, othC, discRow, othC + 1, 'LESS DISCOUNTS', S.label);
  g.put(discRow, othC + 2, pesoNum(data.discount), S.peso, { f: discountCell });
  const refRow = discRow + 1;
  g.box(refRow, othC, refRow, othC + 1, 'LESS REFUNDS', S.label);
  g.put(refRow, othC + 2, pesoNum(data.refunds), S.peso);
  const expRow = refRow + 1;
  g.box(expRow, othC, expRow, othC + 1, 'LESS EXPENSES', S.label);
  g.put(expRow, othC + 2, expensesTotal, S.peso, { f: expenseCell });
  const netRow = expRow + 1;
  const net = round2(gross - pesoNum(data.discount) - pesoNum(data.refunds) - expensesTotal);
  g.box(netRow, othC, netRow, othC + 1, 'NET SALES', S.grand);
  g.put(netRow, othC + 2, net, S.totalPeso,
    { f: `${ref(grossRow, othC + 2)}-${ref(discRow, othC + 2)}-${ref(refRow, othC + 2)}-${ref(expRow, othC + 2)}` });

  // ---- Cash breakdown (Revision 12: every bill and coin, from the count saved in New order > Advanced) ----
  // PIECES is how many of each; AMOUNT = pieces x the bill or coin (a formula, so a number typed in by hand adds up too).
  const cash = netRow + 2;
  const counts = data.cashCount?.counts ?? null;
  g.box(cash, othC, cash, othC + 2, 'CASH BREAKDOWN', S.section);
  ['BILLS AND COINS', 'PIECES', 'AMOUNT'].forEach((h, i) => g.put(cash + 1, othC + i, h, S.head));
  const first0 = cash + 2;
  CASH_DENOMINATIONS.forEach((d, i) => {
    const r = first0 + i;
    const n = counts ? Number(counts[d.key]) || 0 : null;
    g.put(r, othC, `${d.label} ${d.type}`, S.label);
    g.put(r, othC + 1, n, S.count);
    g.put(r, othC + 2, n === null ? 0 : round2((n * d.centavos) / 100), S.peso, { f: `${ref(r, othC + 1)}*${d.centavos / 100}` });
  });
  const totalRow0 = first0 + CASH_DENOMINATIONS.length;
  const overall = counts ? pesoNum(data.cashCount.total_centavos) : 0;
  g.box(totalRow0, othC, totalRow0, othC + 1, 'OVERALL TOTAL', S.grand);
  g.put(totalRow0, othC + 2, overall, S.totalPeso, { f: `SUM(${range(first0, totalRow0 - 1, othC + 2)})` });
  // What the drawer should hold: net sales, less what was paid by GCash, Maya, bank or other (that money is not in the drawer).
  const nonCashRow = totalRow0 + 1;
  g.box(nonCashRow, othC, nonCashRow, othC + 1, 'LESS NON-CASH PAYMENTS', S.label);
  g.put(nonCashRow, othC + 2, pesoNum(data.nonCash ?? 0), S.peso);
  const expectedRow = nonCashRow + 1;
  const expected = round2(net - pesoNum(data.nonCash ?? 0));
  g.box(expectedRow, othC, expectedRow, othC + 1, 'EXPECTED CASH', S.label);
  g.put(expectedRow, othC + 2, expected, S.peso, { f: `${ref(netRow, othC + 2)}-${ref(nonCashRow, othC + 2)}` });
  const excessRow = expectedRow + 1;
  g.box(excessRow, othC, excessRow, othC + 1, 'EXCESS/LOSS', S.grand);
  g.put(excessRow, othC + 2, counts ? round2(overall - expected) : '', S.totalPeso,
    { f: `IF(${ref(totalRow0, othC + 2)}=0,"",${ref(totalRow0, othC + 2)}-${ref(expectedRow, othC + 2)})` });
  if (data.cashCount) {
    g.box(excessRow + 1, othC, excessRow + 1, othC + 2, `Counted by ${data.cashCount.by} at ${toPhtDateTime(data.cashCount.counted_at).slice(11)}`, S.note);
  }

  const sheet = new Sheet('Daily Sales Report');
  sheet.rows = g.rows();
  sheet.merges = g.merges;
  sheet.widths = [
    ...m.blocks.flatMap(() => [9, 18, 7, 8, 8, 9, 10]),
    7, 6, 18, 6, 10,
    22, 24, 12,
  ];
  sheet.heights = { [R.title]: 30, [R.ledgerHead]: 30 };
  sheet.print = { landscape: true, fitWidth: true };

  // ---- A short notes sheet so nobody has to guess what the columns mean ----
  const notes = new Sheet('Notes');
  notes.widths = [120];
  const texts = [
    ['How this report is filled in', 'noteBold'],
    ['Filled in by the app from the orders of the day: date, time span, cashier, the ledger of each chicken type, heads sold, eggs and other products sold, and the sales totals.', 'note'],
    ['Left empty on purpose, for the cashier to write or type in: Chicken Balance, Additional, TOTAL and LEFT for each chicken type; egg BEG and LEFT. The totals update by themselves when you type numbers in.', 'note'],
    ['EXPENSES are the ones typed in New order > Advanced > Expenses for this business day (the empty rows below them can still be written in). LESS EXPENSES takes their total off.', 'note'],
    ['CASH BREAKDOWN is the latest count saved in New order > Advanced > Cash breakdown: PIECES of each bill and coin, AMOUNT = pieces x value. OVERALL TOTAL adds them up. EXPECTED CASH = NET SALES - LESS NON-CASH PAYMENTS (GCash, Maya, bank and other payments are not in the drawer). EXCESS/LOSS = OVERALL TOTAL - EXPECTED CASH: above zero is extra cash, below zero is missing cash. It stays empty until the cash is counted.', 'note'],
    ['KATAY / DEAD (REF) lists the Katay and Dead chicken sold from the ref, at the price per kg the cashier typed (no service fee). It is shown only on a day that sold some.', 'note'],
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
