// Customer screen: what the customer facing the cashier sees. It shows only the order being rung up and the money, nothing else.
//   * While the cashier works: the items, the total, the cash received and the change.
//   * After the order is saved: a thank-you with the tracking number.
//   * Between orders: a welcome.
// It needs no sign-in and no server: the cashier window sends it a summary (see customerLink.js). Nothing here can be changed from this screen.
import { esc, formatPeso } from '../util.js';
import { listenAsCustomer } from '../customerLink.js';

const THANKS_MS = 12_000;
let stop = null;
let thanksTimer = null;

export function mountCustomer(root) {
  document.title = 'Customer - Chicken POS';
  document.body.classList.add('display-mode', 'display-customer');
  stop?.();
  const draw = (msg) => { root.innerHTML = html(msg); };
  draw({ type: 'idle' });
  stop = listenAsCustomer((msg) => {
    clearTimeout(thanksTimer);
    draw(msg);
    if (msg.type === 'done') thanksTimer = setTimeout(() => draw({ type: 'idle' }), THANKS_MS);
  });
}

function html(msg) {
  if (msg.type === 'order' && msg.lines?.length) return orderHtml(msg);
  if (msg.type === 'done') return doneHtml(msg);
  return `<div class="cs cs--idle"><div class="cs-welcome"><div class="cs-logo" aria-hidden="true">🐔</div><h1>Welcome</h1><p>Your order will show here.</p></div></div>`;
}

function orderHtml(m) {
  const money = (c) => formatPeso(c);
  const rows = m.lines.map((l) => `<li class="cs-line"><div class="cs-line-main"><span class="cs-name">${esc(l.name)}</span><span class="cs-amt">${money(l.total)}</span></div>
      ${l.detail ? `<div class="cs-detail">${esc(l.detail)}</div>` : ''}</li>`).join('');
  const paid = m.cash ? `<div class="cs-pay"><div><span>Cash received</span><strong>${money(m.cash.received)}</strong></div>
      <div class="cs-change"><span>Change</span><strong>${m.cash.change === null ? '—' : money(m.cash.change)}</strong></div></div>`
    : m.method ? `<div class="cs-pay"><div><span>Paid by</span><strong>${esc(m.method)}</strong></div></div>` : '';
  return `<div class="cs">
    <h1 class="cs-title">Your order</h1>
    <ul class="cs-lines">${rows}</ul>
    <div class="cs-totals">
      ${m.discount > 0 ? `<div class="cs-sub"><span>Subtotal</span><span>${money(m.subtotal)}</span></div><div class="cs-sub"><span>Discount</span><span>&minus;${money(m.discount)}</span></div>` : ''}
      <div class="cs-total"><span>Total</span><strong>${money(m.total)}</strong></div>
      ${paid}
    </div>
  </div>`;
}

function doneHtml(m) {
  return `<div class="cs cs--done"><div class="cs-welcome"><div class="cs-logo" aria-hidden="true">✅</div><h1>Thank you!</h1>
    ${m.tracking ? `<p class="cs-tracking-label">Your tracking number</p><div class="cs-tracking">#${esc(m.tracking)}</div>` : ''}
    <p>Total paid <strong>${formatPeso(m.total)}</strong>${m.change > 0 ? ` &middot; Change <strong>${formatPeso(m.change)}</strong>` : ''}</p>
    <p class="cs-order-no">${esc(m.orderNumber)}</p></div></div>`;
}

export function unmountCustomer() {
  stop?.(); stop = null; clearTimeout(thanksTimer);
  document.body.classList.remove('display-mode', 'display-customer');
}
