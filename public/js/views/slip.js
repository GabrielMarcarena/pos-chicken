// The itemised table used on the order slip and in the order details. Takes an order as sent by the API.
import { esc, label, formatPeso, formatKg, formatThousandths, prepChips } from '../util.js';
import { formatPercent } from '/shared/money.js';
import { DISCOUNT_REASONS } from '/shared/constants.js';

export function orderTable(order) {
  const chicken = order.items.map((i) => {
    const chips = prepChips({ feather: i.feather, dara: i.dara, cut: i.cut, slice_size: i.slice_size })
      .map((c) => `<span class="chip">${esc(c)}</span>`).join('');
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
      <td>${i.sold_by === 'PER_KG' ? formatThousandths(i.quantity_milli) : String(i.quantity_milli / 1000)} ${esc(i.unit)}</td>
      <td class="num">${formatPeso(i.unit_price_centavos)}/${esc(i.unit)}</td>
      <td class="num">${formatPeso(i.line_total_centavos)}</td></tr>`);
  const d = order.discount;
  const discountRows = d && d.amount_centavos > 0 ? `
      <tr class="sub-row"><td colspan="3">Subtotal</td><td class="num">${formatPeso(order.subtotal_centavos)}</td></tr>
      <tr class="sub-row"><td colspan="3">Discount: ${esc(DISCOUNT_REASONS[d.reason_code] ?? d.reason_code)}${d.type === 'PERCENT' ? ` (${formatPercent(d.value)})` : ''}${d.note ? ` &mdash; ${esc(d.note)}` : ''}</td>
        <td class="num">&minus;${formatPeso(d.amount_centavos)}</td></tr>` : '';
  return `<table>
    <thead><tr><th>Item</th><th>Weight or quantity</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
    <tbody>${chicken.join('')}${other.join('')}${discountRows}
      <tr class="grand-row"><td colspan="3">Grand total</td><td class="num">${formatPeso(order.total_centavos)}</td></tr>
    </tbody></table>`;
}
