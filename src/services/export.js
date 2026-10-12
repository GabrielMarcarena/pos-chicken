// Spreadsheet export: .xlsx (with filters, formulas and red rows for canceled orders) and .csv.
//
// The database is the source of truth. The export is a copy made on request, so the two cannot drift apart.
// One row per line item; the order total and payment columns appear only on the first line of each order, so
// adding up the Order Total column never double-counts an order.
import { loadOrder } from './orders.js';
import { productCode } from './catalog.js';
import { LABELS, FEE_LABELS, REASONS, ACTION_LABELS, COUNTS_AS_SALE, DISCOUNT_REASONS } from '../../shared/constants.js';
import { PAYMENT_METHODS } from '../../shared/constants.js';
import { toPhtDateTime } from '../time.js';
import { Sheet, buildWorkbook, header, date, money, weight, formula, colName, dateSerial } from '../xlsx.js';

export const TX_HEADERS = [
  'Transaction Date', 'Transaction Time', 'Customer Number', 'Order Number', 'Line No.', 'Line Type', 'Product Name', 'Product ID',
  'Unit Price (₱)', 'Quantity (kg for chicken)', 'Unit', 'Service', 'Dara', 'Cutting Method', 'Igorot Slice Size',
  'Service Fees (₱)', 'Item Total (₱)', 'Order Total (₱)', 'Status', 'Action Type', 'Reason', 'Cashier or User', 'Replaced By',
  'Payment Method', 'Amount Paid (₱)', 'Payment Date', 'Payment Time', 'Payment Account Name', 'Payment Account Number', 'Payment Reference',
  'Counts as Sale', 'Order Subtotal (₱)', 'Discount (₱)', 'Discount Reason', 'Number of Heads',
];

const pesos = (c) => c / 100;
const countsAsSale = (status) => COUNTS_AS_SALE.includes(status);

/** Gather orders (and their lines) whose business date is within [from, to]. */
export function gatherExport(db, { from, to }) {
  const f = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from : '0000-01-01';
  const t = /^\d{4}-\d{2}-\d{2}$/.test(to ?? '') ? to : '9999-12-31';
  const ids = db.prepare('SELECT id FROM orders WHERE business_date >= ? AND business_date <= ? ORDER BY id').all(f, t).map((r) => r.id);
  const orders = ids.map((id) => loadOrder(db, id));

  const tx = [];
  const orderRows = [];
  const audit = [];
  for (const o of orders) {
    const lastAction = [...o.events].reverse().find((e) => e.action_type !== 'SUBMIT' && e.action_type !== 'MOVE'); // pickup moves are not sale actions
    const reason = lastAction ? `${REASONS[lastAction.reason_code] ?? lastAction.reason_code ?? ''}${lastAction.reason_note ? ': ' + lastAction.reason_note : ''}` : '';
    const when = toPhtDateTime(o.submitted_at);
    const discountReason = o.discount_centavos > 0
      ? `${DISCOUNT_REASONS[o.discount_reason] ?? o.discount_reason}${o.discount_note ? ': ' + o.discount_note : ''} (${o.discount_type === 'PERCENT' ? `${o.discount_value / 100}%` : 'fixed'})` : '';
    const pay = o.payments[0];
    orderRows.push({
      date: o.business_date, number: o.order_number, customer: o.customer_number, status: o.status, total: pesos(o.total_centavos),
      refunded: pesos(o.refund_centavos), cashier: o.cashier_name, submitted: when, replaces: o.replaces_number ?? '',
      replacedBy: o.replaced_by_number ?? '', action: lastAction?.action_type ?? '', reason,
      subtotal: pesos(o.subtotal_centavos), discount: pesos(o.discount_centavos), discountReason,
    });

    const common = (lineNo) => ({
      date: o.business_date, time: when.slice(11), customer: o.customer_number, number: o.order_number, lineNo, status: o.status,
      action: lastAction ? ACTION_LABELS[lastAction.action_type] : '', reason, cashier: o.cashier_name, replacedBy: o.replaced_by_number ?? '',
      orderTotal: lineNo === 1 ? pesos(o.total_centavos) : null,
      orderSubtotal: lineNo === 1 ? pesos(o.subtotal_centavos) : null, orderDiscount: lineNo === 1 && o.discount_centavos > 0 ? pesos(o.discount_centavos) : null,
      orderDiscountReason: lineNo === 1 ? discountReason : '',
      payMethod: lineNo === 1 && pay ? PAYMENT_METHODS[pay.method] : '', payAmount: lineNo === 1 && pay ? pesos(pay.amount_centavos) : null,
      payDate: lineNo === 1 && pay?.paid_at ? toPhtDateTime(pay.paid_at).slice(0, 10) : '', payTime: lineNo === 1 && pay?.paid_at ? toPhtDateTime(pay.paid_at).slice(11) : '',
      payName: lineNo === 1 ? pay?.account_name ?? '' : '', payNumber: lineNo === 1 ? pay?.account_number ?? '' : '', payRef: lineNo === 1 ? pay?.reference ?? '' : '',
    });
    for (const i of o.items) {
      tx.push({
        ...common(i.line_no), type: 'Chicken', product: i.product_name, productId: productCode(i.product_id), unitPrice: pesos(i.price_per_kg_centavos),
        qty: i.weight_g / 1000, unit: 'kg', feather: i.feather_prep === 'LIVE' ? 'Live' : FEE_LABELS[i.feather_prep], dara: i.dara ? 'Yes' : 'No', cut: i.cut_method === 'NONE' ? 'None' : LABELS[i.cut_method],
        slice: i.slice_size ? LABELS[i.slice_size] : '', fees: pesos(i.service_fee_centavos), itemTotal: pesos(i.line_total_centavos), heads: i.heads,
      });
    }
    for (const i of o.other_items) {
      tx.push({
        ...common(i.line_no), type: 'Other Product', product: i.product_name, productId: `OP-${String(i.other_product_id).padStart(3, '0')}`,
        unitPrice: pesos(i.unit_price_centavos), qty: i.quantity_milli / 1000, unit: i.unit, feather: '', dara: '', cut: '', slice: '', fees: 0, itemTotal: pesos(i.line_total_centavos), heads: null,
      });
    }
    for (const e of o.events) {
      audit.push({
        time: toPhtDateTime(e.created_at), number: o.order_number, action: ACTION_LABELS[e.action_type], reason: REASONS[e.reason_code] ?? '', note: e.reason_note ?? '',
        user: e.user_name, related: e.related_number ?? '', refund: e.refund_centavos === null ? null : pesos(e.refund_centavos),
        stock: e.stock_returnable === null ? '' : e.stock_returnable ? 'Yes' : 'No',
      });
    }
  }
  return { tx, orderRows, audit, from: f, to: t };
}

// ---- CSV ----------------------------------------------------------------------------------------

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Stop spreadsheet programs from running text that starts like a formula.
  if (/^[=+\-@]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function txRowValues(r) {
  return [r.date, r.time, r.customer, r.number, r.lineNo, r.type, r.product, r.productId, r.unitPrice, r.qty, r.unit, r.feather, r.dara, r.cut, r.slice,
    r.fees, r.itemTotal, r.orderTotal, r.status, r.action, r.reason, r.cashier, r.replacedBy, r.payMethod, r.payAmount, r.payDate, r.payTime,
    r.payName, r.payNumber, r.payRef, countsAsSale(r.status) ? 'Yes' : 'No', r.orderSubtotal, r.orderDiscount, r.orderDiscountReason, r.heads];
}

export function buildCsv(data) {
  const lines = [TX_HEADERS.map(csvCell).join(',')];
  for (const r of data.tx) lines.push(txRowValues(r).map(csvCell).join(','));
  return '\ufeff' + lines.join('\r\n') + '\r\n'; // BOM so Excel reads the peso sign correctly
}

// ---- XLSX ---------------------------------------------------------------------------------------

const statusRules = (sqref, col) => [
  { sqref, formula: `$${col}2="CANCELED"`, dxf: 'red' },
  { sqref, formula: `OR($${col}2="REFUNDED",$${col}2="PARTIALLY_REFUNDED")`, dxf: 'amber' },
  { sqref, formula: `$${col}2="REPLACED"`, dxf: 'gray' },
];

const mondayOf = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
const monthEnd = (iso) => { const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1, 0); return d.toISOString().slice(0, 10); };

export function buildXlsx(data) {
  const nTx = data.tx.length;
  const nOrd = data.orderRows.length;
  // Formula ranges leave room for rows people add by hand.
  const txEnd = Math.max(nTx + 1, 2) + 1000;
  const ordEnd = Math.max(nOrd + 1, 2) + 1000;
  const T = (col) => `Transactions!$${col}$2:$${col}$${txEnd}`;
  const O = (col) => `Orders!$${col}$2:$${col}$${ordEnd}`;

  // 1. Transactions: one row per line item
  const sheetTx = new Sheet('Transactions');
  sheetTx.freezeHeader = true; sheetTx.filter = true;
  sheetTx.widths = [12, 9, 14, 18, 8, 13, 22, 10, 12, 12, 8, 30, 7, 12, 15, 12, 13, 13, 18, 18, 36, 16, 18, 14, 14, 12, 10, 22, 20, 20, 10, 14, 12, 34, 10];
  sheetTx.addRow(TX_HEADERS.map(header));
  data.tx.forEach((r, i) => {
    const row = i + 2;
    const v = txRowValues(r);
    sheetTx.addRow([
      date(r.date), v[1], v[2], v[3], v[4], v[5], v[6], v[7], money(v[8]), weight(v[9]), v[10], v[11], v[12], v[13], v[14],
      money(v[15]), money(v[16]), money(v[17]), v[18], v[19], v[20], v[21], v[22], v[23], money(v[24]), v[25], v[26], v[27], v[28], v[29],
      formula(`IF(OR(S${row}="CANCELED",S${row}="REPLACED"),"No","Yes")`, v[30]), money(v[31]), money(v[32]), v[33], v[34],
    ]);
  });
  sheetTx.rules = statusRules(`A2:AI${txEnd}`, 'S');

  // 2. Orders: one row per order
  const sheetOrd = new Sheet('Orders');
  sheetOrd.freezeHeader = true; sheetOrd.filter = true;
  sheetOrd.widths = [12, 18, 14, 18, 13, 13, 16, 17, 18, 18, 14, 40, 10, 14, 12, 34];
  sheetOrd.addRow(['Business Date', 'Order Number', 'Customer Number', 'Status', 'Order Total (₱)', 'Refunded (₱)', 'Cashier or User', 'Submitted (PH time)',
    'Replaces Order', 'Replaced By', 'Last Action', 'Reason', 'Counts as Sale', 'Subtotal (₱)', 'Discount (₱)', 'Discount Reason'].map(header));
  data.orderRows.forEach((o, i) => {
    const row = i + 2;
    sheetOrd.addRow([date(o.date), o.number, o.customer, o.status, money(o.total), money(o.refunded), o.cashier, o.submitted, o.replaces, o.replacedBy,
      o.action ? ACTION_LABELS[o.action] : '', o.reason, formula(`IF(OR(D${row}="CANCELED",D${row}="REPLACED"),"No","Yes")`, countsAsSale(o.status) ? 'Yes' : 'No'),
      money(o.subtotal), money(o.discount), o.discountReason]);
  });
  sheetOrd.rules = statusRules(`A2:P${ordEnd}`, 'D');

  // 3. Audit log
  const sheetAudit = new Sheet('Audit Log');
  sheetAudit.freezeHeader = true; sheetAudit.filter = true;
  sheetAudit.widths = [18, 18, 18, 28, 40, 16, 18, 14, 16];
  sheetAudit.addRow(['Date and Time (PH)', 'Order Number', 'Action', 'Reason', 'Notes', 'User', 'Related Order', 'Refund (₱)', 'Stock Can Return'].map(header));
  for (const a of data.audit) sheetAudit.addRow([a.time, a.number, a.action, a.reason, a.note, a.user, a.related, money(a.refund), a.stock]);

  // 4. By product (formulas read the Transactions sheet, so they follow any edits)
  const sold = data.tx.filter((r) => countsAsSale(r.status));
  const products = [...new Map(sold.map((r) => [`${r.type}|${r.product}|${r.unit}`, { type: r.type, product: r.product, unit: r.unit }])).values()]
    .sort((a, b) => a.type.localeCompare(b.type) || a.product.localeCompare(b.product));
  const sheetProd = new Sheet('By Product');
  sheetProd.freezeHeader = true;
  sheetProd.widths = [24, 14, 8, 14, 16, 16, 16, 12];
  sheetProd.addRow(['Product', 'Line Type', 'Sold By (unit)', 'Quantity Sold', 'Sales excl. Fees (₱)', 'Service Fees (₱)', 'Total (₱)', 'Heads Sold'].map(header));
  products.forEach((p, i) => {
    const row = i + 2;
    const mine = sold.filter((r) => r.type === p.type && r.product === p.product && r.unit === p.unit);
    const qty = mine.reduce((s, r) => s + r.qty, 0);
    const total = mine.reduce((s, r) => s + r.itemTotal, 0);
    const fees = mine.reduce((s, r) => s + r.fees, 0);
    const headsSold = mine.reduce((s, r) => s + (r.heads ?? 0), 0);
    const crit = `${T('G')},$A${row},${T('F')},$B${row},${T('K')},$C${row},${T('AE')},"Yes"`;
    sheetProd.addRow([p.product, p.type, p.unit,
      formula(`SUMIFS(${T('J')},${crit})`, Number(qty.toFixed(3)), 'weight'),
      formula(`SUMIFS(${T('Q')},${crit})-SUMIFS(${T('P')},${crit})`, Number((total - fees).toFixed(2)), 'money'),
      formula(`SUMIFS(${T('P')},${crit})`, Number(fees.toFixed(2)), 'money'),
      formula(`SUMIFS(${T('Q')},${crit})`, Number(total.toFixed(2)), 'money'),
      formula(`SUMIFS(${T('AI')},${crit})`, headsSold)]);
  });

  // 5-7. Daily, weekly and monthly summaries
  const dates = [...new Set(data.orderRows.map((o) => o.date))].sort();
  const periodSheet = (name, label, periods) => {
    const s = new Sheet(name);
    s.freezeHeader = true;
    s.widths = [14, 14, 9, 14, 13, 14, 15, 17, 14, 16, 16, 12];
    s.addRow([label, 'Period End', 'Orders', 'Gross Sales (₱)', 'Refunds (₱)', 'Net Sales (₱)', 'Chicken Sold (kg)', 'Other-Product Sales (₱)', 'Canceled Orders', 'Canceled Amount (₱)', 'Discounts Given (₱)', 'Heads Sold'].map(header));
    periods.forEach(([start, end], i) => {
      const row = i + 2;
      const inRange = data.orderRows.filter((o) => o.date >= start && o.date <= end);
      const sale = inRange.filter((o) => countsAsSale(o.status));
      const gross = sale.reduce((x, o) => x + o.total, 0);
      const refunds = sale.reduce((x, o) => x + o.refunded, 0);
      const lines = data.tx.filter((r) => r.date >= start && r.date <= end && countsAsSale(r.status));
      const kg = lines.filter((r) => r.type === 'Chicken').reduce((x, r) => x + r.qty, 0);
      const other = lines.filter((r) => r.type === 'Other Product').reduce((x, r) => x + r.itemTotal, 0);
      const canceled = inRange.filter((o) => o.status === 'CANCELED');
      const discounts = sale.reduce((x, o) => x + o.discount, 0);
      const heads = lines.filter((r) => r.type === 'Chicken').reduce((x, r) => x + r.heads, 0);
      const oc = `${O('A')},">="&$A${row},${O('A')},"<="&$B${row}`;
      const tc = `${T('A')},">="&$A${row},${T('A')},"<="&$B${row},${T('AE')},"Yes"`;
      s.addRow([date(start), date(end),
        formula(`COUNTIFS(${oc},${O('M')},"Yes")`, sale.length),
        formula(`SUMIFS(${O('E')},${oc},${O('M')},"Yes")`, Number(gross.toFixed(2)), 'money'),
        formula(`SUMIFS(${O('F')},${oc},${O('M')},"Yes")`, Number(refunds.toFixed(2)), 'money'),
        formula(`D${row}-E${row}`, Number((gross - refunds).toFixed(2)), 'boldMoney'),
        formula(`SUMIFS(${T('J')},${tc},${T('F')},"Chicken")`, Number(kg.toFixed(3)), 'weight'),
        formula(`SUMIFS(${T('Q')},${tc},${T('F')},"Other Product")`, Number(other.toFixed(2)), 'money'),
        formula(`COUNTIFS(${oc},${O('D')},"CANCELED")`, canceled.length),
        formula(`SUMIFS(${O('E')},${oc},${O('D')},"CANCELED")`, Number(canceled.reduce((x, o) => x + o.total, 0).toFixed(2)), 'money'),
        formula(`SUMIFS(${O('O')},${oc},${O('M')},"Yes")`, Number(discounts.toFixed(2)), 'money'),
        formula(`SUMIFS(${T('AI')},${tc},${T('F')},"Chicken")`, heads)]);
    });
    return s;
  };
  const days = dates.map((d) => [d, d]);
  const weeks = [...new Set(dates.map(mondayOf))].map((m) => [m, addDays(m, 6)]);
  const months = [...new Set(dates.map(monthStart))].map((m) => [m, monthEnd(m)]);

  // 8. Definitions
  const sheetDef = new Sheet('Definitions');
  sheetDef.widths = [110];
  [
    'How the numbers are worked out',
    'Gross sales: order totals of orders that were sold (Completed, Refunded, Partially refunded), after any discount. Canceled and Replaced orders are never counted as sales.',
    'Discounts: the Order Subtotal is the sum of the item totals; the Order Total is the subtotal minus the discount. Discounts Given adds up the discounts on orders that were sold.',
    'Refunds: the refunded amount of those orders, shown on the order\'s original date.',
    'Net sales: gross sales minus refunds.',
    'Canceled: reported separately and never counted as sales. A replaced order is counted through the order that replaced it.',
    'Chicken sold (kg): live weight of chicken lines on orders that were sold. Other products are not counted as chicken kilograms.',
    'Heads sold: the Number of Heads on chicken lines on orders that were sold. The weight on a line is the combined weight of all its heads.',
    'Order Total and the payment columns appear only on the first line of each order, so summing them never double-counts.',
    'Rows turn red for Canceled orders, amber for Refunded and gray for Replaced. The Status column always spells it out, so the meaning survives in a CSV.',
    'The summary sheets use formulas that read the Transactions and Orders sheets, so they update if you correct a cell.',
    'Payment account names and numbers are personal data. Share this file only with people who need it.',
  ].forEach((t, i) => sheetDef.addRow([i === 0 ? { v: t, s: 'bold' } : { v: t, s: 'wrap' }]));

  return buildWorkbook([
    sheetTx, sheetOrd, sheetAudit, sheetProd,
    periodSheet('By Day', 'Period Start', days), periodSheet('By Week', 'Week Start (Mon)', weeks), periodSheet('By Month', 'Month Start', months),
    sheetDef,
  ]);
}
