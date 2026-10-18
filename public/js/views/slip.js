// The itemised table used on the order slip and in the order details. Takes an order as sent by the API.
import { esc, label, formatPeso, formatKg, prepChips, otherQtyText } from '../util.js';
import { formatPercent } from '/shared/money.js';
import { discountReasonLabel, PAYMENT_METHODS } from '/shared/constants.js';

export function orderTable(order) {
  const chicken = order.items.map((i) => {
    const chips = prepChips({ feather: i.feather, dara: i.dara, cut: i.cut, slice_size: i.slice_size })
      .map((c) => `<span class="chip chip--prep">${esc(c)}</span>`).join('');   // chip--prep: on screen only; the printed receipt keeps just the prices and the fees
    const fees = i.fees.filter((f) => f.amount > 0)
      .map((f) => `<span class="chip chip--fee">+${formatPeso(f.amount)} ${esc(label(f.code))}${f.basis === 'per_head' && i.heads > 1 ? ` (${i.heads} × ${formatPeso(f.rate)})` : ''}</span>`).join('');
    return `<tr>
      <td><strong>${esc(i.product_name)}</strong><div class="chips">${chips}${fees}</div></td>
      <td>${i.heads > 1 ? `${i.heads} heads &middot; ` : ''}${formatKg(i.weight_g)} kg</td>
      <td class="num">${formatPeso(i.price_per_kg_centavos)}/kg</td>
      <td class="num">${formatPeso(i.line_total_centavos)}</td></tr>`;
  });
  const other = order.other_items.map((i) => `<tr>
      <td><strong>${esc(i.product_name)}</strong></td>
      <td>${esc(otherQtyText(i))}</td>
      <td class="num">${formatPeso(i.unit_price_centavos)}/${esc(i.unit)}</td>
      <td class="num">${formatPeso(i.line_total_centavos)}</td></tr>`);
  // Revision 12: Katay / Dead chicken from the ref (price per kg typed by the cashier, no service fee).
  const ref = (order.ref_items ?? []).map((i) => `<tr>
      <td><strong>${esc(i.product_name)}</strong><div class="chips"><span class="chip chip--ref">From the ref</span></div></td>
      <td>${i.heads > 1 ? `${i.heads} heads &middot; ` : ''}${formatKg(i.weight_g)} kg</td>
      <td class="num">${formatPeso(i.price_per_kg_centavos)}/kg</td>
      <td class="num">${formatPeso(i.line_total_centavos)}</td></tr>`);
  const d = order.discount;
  const discountRows = d && d.amount_centavos > 0 ? `
      <tr class="sub-row"><td colspan="3">Subtotal</td><td class="num">${formatPeso(order.subtotal_centavos)}</td></tr>
      <tr class="sub-row"><td colspan="3">Discount: ${esc(discountReasonLabel(d.reason_code))}${d.type === 'PERCENT' ? ` (${formatPercent(d.value)})` : ''}${d.note ? ` &mdash; ${esc(d.note)}` : ''}</td>
        <td class="num">&minus;${formatPeso(d.amount_centavos)}</td></tr>` : '';
  return `<table>
    <thead><tr><th>Item</th><th>Weight or quantity</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
    <tbody>${chicken.join('')}${other.join('')}${ref.join('')}${discountRows}
      <tr class="grand-row"><td colspan="3">Grand total</td><td class="num">${formatPeso(order.total_centavos)}</td></tr>
    </tbody></table>`;
}

/** The payment as it was saved, for the printed slip: method, Amount Paid and, for cash, Money Received and Change. Empty when nothing was recorded. */
export function slipPayment(order) {
  const p = order.payments?.[0];
  if (!p) return '';
  const rows = [['Paid by', PAYMENT_METHODS[p.method] ?? p.method], ['Amount Paid', formatPeso(p.amount_centavos)]];
  if (p.received_centavos) rows.push(['Money Received', formatPeso(p.received_centavos)], ['Change', formatPeso(p.change_centavos ?? 0)]);
  return `<dl class="slip-pay" data-slip-payment>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
}
