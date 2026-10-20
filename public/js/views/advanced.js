// New order > Advanced (Revision 12): three things that are not a normal sale, in one place.
//   Ref stock       Katay and Dead chicken kept in the ref. Tap one: store it in the ref, or add it to the order (sold by the kilo).
//   Cash breakdown  how many of each bill and coin are in the drawer; the total, the expected cash and the excess or loss.
//   Expenses        what was paid out of the drawer today (Coke 75, Bread 35 ...).
// Everything is saved on the server, for the open business day, and goes on the Daily Report. This file only draws and asks.
import { keyBadge } from '../keys.js';
import { api } from '../api.js';
import { $, esc, toast, errorBox, openDialog, howItWorks, formatPeso, formatKg, fmtDateTime, fmtDate, todayPH } from '../util.js';
import { parsePesosToCentavos } from '/shared/money.js';
import { CASH_DENOMINATIONS, MAX_CASH_PIECES, REF_LABELS, cashCountTotal } from '/shared/constants.js';

const adv = { section: 'ref', data: null, error: null, counts: null, onHand: null, lines: [{ item: '', amount: '' }], busy: false, root: null, hooks: null };

export const ADVANCED_SECTIONS = { ref: 'Ref stock (Katay & Dead)', cash: 'Cash breakdown', expenses: 'Expenses' };

/** Draw the Advanced area into `root`. hooks.startRef(kind, mode) opens the store / sell screen of the New order page. */
export async function renderAdvanced(root, hooks, { reload = true } = {}) {
  adv.root = root;
  adv.hooks = hooks;
  if (reload || !adv.data) {
    root.innerHTML = '<p class="muted"><span class="spinner" aria-hidden="true"></span> Loading...</p>';
    try { adv.data = await api('GET', '/api/advanced'); adv.error = null; } catch (err) { adv.error = err; }
    if (!adv.root?.isConnected || adv.root !== root) return;
    adv.counts = null;   // start from the last saved count
    adv.onHand = null;
  }
  draw();
}

function draw() {
  const root = adv.root;
  if (!root?.isConnected) return;
  const tabs = Object.entries(ADVANCED_SECTIONS).map(([k, t]) => `<button type="button" class="subtab" role="tab" aria-selected="${adv.section === k}" data-adv="section" data-v="${k}">${esc(t)}</button>`).join('');
  let body = '';
  if (adv.error) body = errorBox(adv.error);
  else if (adv.section === 'ref') body = refHtml();
  else if (adv.section === 'cash') body = cashHtml();
  else body = expensesHtml();
  const day = adv.data?.money?.business_date;
  root.innerHTML = `<div class="adv">
      <div class="subtabs" role="tablist" aria-label="Advanced options">${tabs}</div>
      ${day ? `<p class="muted adv-day">Business day <strong>${esc(day)}</strong> (open). Everything here is saved for this day and goes on the Daily Report.</p>` : ''}
      <div id="advMsg" role="status" aria-live="polite"></div>
      ${body}
    </div>`;
  if (adv.section === 'cash') updateCash();
  if (adv.section === 'expenses') updateLines();
}

const showMsg = (html) => { const m = $('#advMsg'); if (m) m.innerHTML = html; };

// ---- Ref stock --------------------------------------------------------------------------------------------------------

function refHtml() {
  const ref = adv.data.ref;
  const cards = ref.kinds.map((k, i) => `
    <button type="button" class="product-card ref-card ref-card--${k.kind.toLowerCase()}" data-adv="ref-pick" data-v="${k.kind}">${keyBadge(String(i + 1))}
      <span class="ico" aria-hidden="true"><span class="ico-fallback">${k.kind === 'KATAY' ? '🔪' : '🧊'}</span></span>
      <span class="meta"><span class="name">${esc(k.name)}</span>
        <span class="stock${k.heads === 0 ? ' stock--out' : ''}" data-ref-stock="${k.kind}">In the ref: ${k.heads} ${k.heads === 1 ? 'head' : 'heads'}</span>
        ${(k.products ?? []).length ? `<span class="small muted" data-ref-split="${k.kind}">${k.products.map((p) => `${esc(p.product)} ${p.heads}`).join(' · ')}</span>` : ''}
        <span class="price">Store it, or sell it by the kilo</span></span>
    </button>`).join('');
  // Revision 14: the movements are grouped by day (Today, Yesterday, then the date), so yesterday's Katay / Dead is not mixed up with today's.
  const days = [];
  for (const m of ref.moves) {
    if (days.at(-1)?.date !== m.date) days.push({ date: m.date, rows: [] });
    days.at(-1).rows.push(m);
  }
  const moveRow = (m) => `<tr><td class="nowrap">${esc(timeOf(m.at_pht))}</td><td>${esc(REF_LABELS[m.kind])}: ${esc(m.what)}${m.note ? ` <span class="muted">(${esc(m.note)})</span>` : ''}</td>
        <td class="num ${m.heads > 0 ? 'adv-in' : m.heads < 0 ? 'adv-out' : ''}">${m.heads > 0 ? '+' : ''}${m.heads}</td><td class="num">${m.weight_g ? formatKg(m.weight_g) : ''}</td>
        <td>${esc(m.from)}</td><td>${esc(m.by)}</td></tr>`;
  const dayHead = (d) => {
    const inn = d.rows.filter((m) => m.heads > 0).reduce((s, m) => s + m.heads, 0);
    const out = d.rows.filter((m) => m.heads < 0).reduce((s, m) => s - m.heads, 0);
    return `<tr class="adv-day"><th colspan="6"><strong>${esc(dayName(d.date))}</strong> <span class="muted">${esc(fmtDate(d.date))}</span>
      <span class="adv-day-sum"><span class="adv-in">+${inn} in</span> · <span class="adv-out">&minus;${out} sold</span></span></th></tr>`;
  };
  const moves = days.length ? `<div class="table-wrap"><table class="data adv-table" data-ref-moves>
      <thead><tr><th>Time</th><th>What</th><th class="num">Heads</th><th class="num">Kg</th><th>From</th><th>By</th></tr></thead>
      <tbody>${days.map((d) => dayHead(d) + d.rows.map(moveRow).join('')).join('')}</tbody></table></div>`
    : '<p class="muted">Nothing has been put in the ref yet.</p>';
  return `<section class="adv-section" aria-label="Ref stock">
      <div class="product-grid ref-grid">${cards}</div>
      <p class="ref-short mt-s">Store Katay or Dead chicken in the ref, or sell it by the kilo.</p>
      ${howItWorks(`<p><strong>Store in the ref</strong> puts Katay or Dead chicken in the ref for preservation: choose which chicken it is, the heads and
        the kilos. It is also added to that chicken's <strong>Katay</strong> or <strong>Dead</strong> on today's Daily Inventory.</p>
        <p><strong>Add to order</strong> sells it by the kilo at the price per kg you type, with no service fee (add a discount on the review screen if you want one).</p>`, 'Read more')}
      <h3 class="mt-l">Latest ref movements</h3>
      ${moves}
    </section>`;
}

/** "Today", "Yesterday", or the weekday ("Wednesday") for an older day. */
function dayName(date) {
  const diff = Math.round((new Date(`${todayPH()}T00:00:00Z`) - new Date(`${date}T00:00:00Z`)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', weekday: 'long' });
}
/** "3:05 PM" from "2026-10-16 15:05" (PH time). */
function timeOf(pht) {
  const [h, m] = pht.slice(11, 16).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

async function pickRef(kind) {
  const heads = adv.data.ref.kinds.find((k) => k.kind === kind)?.heads ?? 0;
  const choice = await openDialog({
    title: REF_LABELS[kind],
    body: `<p>In the ref now: <strong>${heads} ${heads === 1 ? 'head' : 'heads'}</strong>.</p><p class="muted">What do you want to do?</p>`,
    actions: [
      { label: 'Cancel', value: false },
      { label: `Store ${REF_LABELS[kind]} in the ref`, value: 'store' },
      { label: `Add ${REF_LABELS[kind]} to the order`, kind: 'primary', value: 'sell' },
    ],
  });
  if (choice === 'sell' && heads === 0) { toast(`There is no ${REF_LABELS[kind]} in the ref to sell.`, 'error'); return; }
  if (choice === 'store' || choice === 'sell') adv.hooks.startRef(kind, choice);
}

// ---- Cash breakdown ---------------------------------------------------------------------------------------------------

function cashCounts() {
  if (!adv.counts) {
    const saved = adv.data.money.cash_count?.counts ?? {};
    adv.counts = Object.fromEntries(CASH_DENOMINATIONS.map((d) => [d.key, saved[d.key] ? String(saved[d.key]) : '']));
  }
  return adv.counts;
}

function cashHtml() {
  const m = adv.data.money;
  const counts = cashCounts();
  const row = (d) => `<tr><th scope="row">${esc(d.label)}</th>
      <td class="num">&times;</td>
      <td><input class="cash-input" type="text" inputmode="numeric" autocomplete="off" data-adv-count="${d.key}" value="${esc(counts[d.key])}" aria-label="How many ${esc(d.label)} ${d.type}s" placeholder="0"></td>
      <td class="num" data-cash-amount="${d.key}"></td></tr>`;
  const bills = CASH_DENOMINATIONS.filter((d) => d.type === 'bill');
  const coins = CASH_DENOMINATIONS.filter((d) => d.type === 'coin');
  const saved = m.cash_count ? `<p class="ok-box" data-cash-saved>Last saved by ${esc(m.cash_count.by)} at ${esc(fmtDateTime(m.cash_count.counted_at))}: <strong>${formatPeso(m.cash_count.total_centavos)}</strong>.</p>`
    : '<p class="muted" data-cash-saved>No cash count saved for today yet.</p>';
  const hand = m.cash_on_hand;
  if (adv.onHand === null) adv.onHand = hand ? pesoPlainText(hand.amount_centavos) : '';
  const steps = (n, t) => `<h3 class="cash-step"><span class="cash-n">${n}</span>${t}</h3>`;
  return `<section class="adv-section cash-steps" aria-label="Cash breakdown">
      ${howItWorks('<p>Type how many of each bill and coin. The amounts and the total add up as you type. Saving again replaces the count (the earlier one stays in the history).</p><p><strong>Cash on hand</strong> is the starting cash you put in the drawer for change (panukli). Type it once a day. The drawer should then hold: cash on hand + cash sales today &minus; expenses.</p>')}
      <div class="panel cash-hand mt-s" data-step="1">
        ${steps(1, 'Starting cash <span class="muted">(panukli)</span>')}
        <div class="field"><label for="cashOnHand" class="sr-only">Cash on hand, starting cash in pesos</label>
          <div class="tracking-row"><input id="cashOnHand" type="text" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(adv.onHand)}" data-adv-onhand>
            <button type="button" class="btn btn--small btn--primary" data-adv="onhand-save">Save</button></div></div>
        <p class="muted small" data-onhand-saved>${hand ? `Last set by ${esc(hand.by)} at ${esc(fmtDateTime(hand.set_at))}: <strong>${formatPeso(hand.amount_centavos)}</strong>.` : 'Not set for today yet.'}</p>
        <div id="onHandErr" role="alert"></div>
      </div>
      <div class="panel mt-s" data-step="2">
        ${steps(2, 'Count the drawer')}
        <div class="cash-cols">
          <div class="table-wrap"><table class="data cash-table"><thead><tr><th scope="col" colspan="4" class="cash-sub">Bills</th></tr></thead><tbody>${bills.map(row).join('')}</tbody></table></div>
          <div class="table-wrap"><table class="data cash-table"><thead><tr><th scope="col" colspan="4" class="cash-sub">Coins</th></tr></thead><tbody>${coins.map(row).join('')}</tbody></table></div>
        </div>
      </div>
      <div class="cash-sum panel mt-s" data-step="3">
        ${steps(3, 'Result')}
        <div class="cash-line"><span>Counted <small class="muted">(overall total)</small></span><output id="cashTotal"></output></div>
        <div class="cash-line"><span>Cash on hand <small class="muted">(start of day)</small></span><span>${formatPeso(m.cash_on_hand_centavos)}</span></div>
        <div class="cash-line"><span>Cash sales today <small class="muted">(after discounts and refunds)</small></span><span>${formatPeso(m.cash_sales_centavos)}</span></div>
        <div class="cash-line"><span>Less expenses</span><span>&minus;${formatPeso(m.expenses_total_centavos)}</span></div>
        <div class="cash-line"><span>Expected cash</span><strong id="cashExpected" data-expected="${m.expected_cash_centavos}">${formatPeso(m.expected_cash_centavos)}</strong></div>
        <div class="cash-result"><span>Excess / Loss</span><output id="cashExcess"></output></div>
        <div id="cashErr" role="alert"></div>
        <button type="button" class="btn btn--primary btn--big" data-adv="cash-save">Save cash count</button>
        <div class="cash-foot">${saved}
          <p class="muted cash-note">GCash, Maya, bank and other payments (${formatPeso(m.non_cash_centavos)} today) are not in the drawer, so they are not expected here.</p></div>
      </div>
    </section>`;
}

const pieces = (text) => (/^\d{1,5}$/.test(text) && Number(text) <= MAX_CASH_PIECES ? Number(text) : text === '' ? 0 : null);

function updateCash() {
  const counts = cashCounts();
  let bad = false;
  const numbers = {};
  for (const d of CASH_DENOMINATIONS) {
    const n = pieces(counts[d.key]);
    if (n === null) bad = true;
    numbers[d.key] = n ?? 0;
    const cell = $(`[data-cash-amount="${d.key}"]`);
    if (cell) cell.textContent = n ? formatPeso(n * d.centavos) : '';
    $(`[data-adv-count="${d.key}"]`)?.classList.toggle('inv-bad', n === null);
  }
  const total = cashCountTotal(numbers);
  const expected = Number($('#cashExpected')?.dataset.expected ?? 0);
  if ($('#cashTotal')) $('#cashTotal').textContent = formatPeso(total);
  const out = $('#cashExcess');
  if (out) {
    const diff = total - expected;
    out.textContent = diff === 0 ? formatPeso(0) : `${diff > 0 ? '+' : '−'}${formatPeso(Math.abs(diff))} ${diff > 0 ? '(excess)' : '(loss)'}`;
    out.className = diff > 0 ? 'cash-excess' : diff < 0 ? 'cash-loss' : '';
  }
  const err = $('#cashErr');
  if (err) err.innerHTML = bad ? errorBox({ message: `Type whole numbers only (0 to ${MAX_CASH_PIECES}).` }) : '';
  return !bad;
}

const pesoPlainText = (c) => `${Math.floor(c / 100)}${c % 100 ? `.${String(c % 100).padStart(2, '0')}` : ''}`;

async function saveOnHand(btn) {
  if (adv.busy) return;
  adv.busy = true; if (btn) btn.disabled = true;
  try {
    const money = await api('POST', '/api/cash-on-hand', { amount: adv.onHand === '' ? '0' : adv.onHand });
    adv.data.money = money;
    adv.onHand = null;
    toast(`Cash on hand saved: ${formatPeso(money.cash_on_hand_centavos)}.`, 'ok');
    draw();
  } catch (err) { const box = $('#onHandErr'); if (box) box.innerHTML = errorBox(err); } finally { adv.busy = false; if (btn) btn.disabled = false; }
}

async function saveCash(btn) {
  if (!updateCash() || adv.busy) return;
  adv.busy = true; btn.disabled = true;
  try {
    const money = await api('POST', '/api/cash-count', { counts: cashCounts() });
    adv.data.money = money;
    adv.counts = null;
    toast(`Cash count saved: ${formatPeso(money.cash_count.total_centavos)}.`, 'ok');
    draw();
  } catch (err) { $('#cashErr').innerHTML = errorBox(err); } finally { adv.busy = false; btn.disabled = false; }
}

// ---- Expenses ----------------------------------------------------------------------------------------------------------

function expensesHtml() {
  const m = adv.data.money;
  const kept = m.expenses.filter((e) => !e.removed);
  const list = m.expenses.length ? `<div class="table-wrap"><table class="data adv-table">
      <thead><tr><th>Expense</th><th class="num">Amount</th><th>Typed by</th><th>When</th><th></th></tr></thead>
      <tbody>${m.expenses.map((e) => `<tr class="${e.removed ? 'exp-removed' : ''}" data-expense="${e.id}"><td>${esc(e.item)}${e.removed ? ` <span class="badge badge--canceled">Removed${e.remove_note ? `: ${esc(e.remove_note)}` : ''}</span>` : ''}</td>
        <td class="num">${formatPeso(e.amount_centavos)}</td><td>${esc(e.by)}</td><td class="nowrap">${esc(fmtDateTime(e.created_at))}</td>
        <td>${e.removed ? '' : `<button type="button" class="btn btn--small btn--danger" data-adv="exp-remove" data-v="${e.id}" data-name="${esc(e.item)}">Remove</button>`}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th>Overall</th><th class="num" data-exp-total>${formatPeso(m.expenses_total_centavos)}</th><td colspan="3" class="muted">${kept.length} ${kept.length === 1 ? 'expense' : 'expenses'}</td></tr></tfoot>
    </table></div>` : '<p class="muted">No expenses saved for today yet.</p>';
  const lines = adv.lines.map((l, i) => `<div class="exp-line" data-line="${i}">
      <div class="field"><label for="expItem${i}">Expense</label><input id="expItem${i}" type="text" maxlength="80" autocomplete="off" placeholder="for example Coke" data-adv-line="item" data-i="${i}" value="${esc(l.item)}"></div>
      <div class="field"><label for="expAmt${i}">Amount (₱)</label><input id="expAmt${i}" type="text" inputmode="decimal" autocomplete="off" placeholder="75" data-adv-line="amount" data-i="${i}" value="${esc(l.amount)}"></div>
      <button type="button" class="btn btn--small" data-adv="line-del" data-v="${i}" aria-label="Remove line ${i + 1}" ${adv.lines.length === 1 ? 'disabled' : ''}>&times;</button>
    </div>`).join('');
  return `<section class="adv-section" aria-label="Expenses">
      <p class="muted">Money taken out of the drawer today.</p>
      ${howItWorks('<p>One line for each: what it was for and how much. They are taken off on the Daily Report (EXPENSES and LESS EXPENSES).</p>')}
      <div class="exp-form panel mt-s">
        ${lines}
        <div class="exp-foot">
          <button type="button" class="btn" data-adv="line-add">+ Add another line</button>
          <span class="exp-new-total">New lines: <output id="expNewTotal"></output></span>
        </div>
        <div id="expErr" role="alert"></div>
        <button type="button" class="btn btn--primary btn--big mt-s" data-adv="exp-save">Save expenses</button>
      </div>
      <h3 class="mt-l">Today's expenses</h3>
      ${list}
    </section>`;
}

function updateLines() {
  const total = adv.lines.reduce((s, l) => s + (parsePesosToCentavos(l.amount) ?? 0), 0);
  const out = $('#expNewTotal');
  if (out) out.textContent = formatPeso(total);
}

async function saveExpenses(btn) {
  const lines = adv.lines.filter((l) => l.item.trim() || l.amount.trim());
  if (!lines.length) { $('#expErr').innerHTML = errorBox({ message: 'Type at least one expense: what it was for and how much.' }); return; }
  if (adv.busy) return;
  adv.busy = true; btn.disabled = true;
  try {
    adv.data.money = await api('POST', '/api/expenses', { items: lines });
    adv.lines = [{ item: '', amount: '' }];
    toast(`${lines.length} ${lines.length === 1 ? 'expense' : 'expenses'} saved.`, 'ok');
    draw();
  } catch (err) { $('#expErr').innerHTML = errorBox(err); } finally { adv.busy = false; btn.disabled = false; }
}

async function removeExpense(id, name) {
  let note = '';
  const ok = await openDialog({
    title: 'Remove this expense?',
    body: `<p><strong>${esc(name)}</strong> will no longer count. It stays in the history, marked removed, with your name.</p>
      <div class="field"><label for="expNote">Why? <span class="muted">(optional)</span></label><input id="expNote" type="text" maxlength="200" autocomplete="off"></div>`,
    actions: [{ label: 'Keep it', value: false }, { label: 'Remove it', kind: 'danger', onClick: (dlg) => { note = $('#expNote', dlg).value; return true; } }],
  });
  if (ok !== true) return;
  try {
    adv.data.money = await api('POST', `/api/expenses/${id}/remove`, { note });
    toast(`${name} removed.`, 'ok');
    draw();
  } catch (err) { showMsg(errorBox(err)); }
}

// ---- Events (called by the New order screen's own handlers) -------------------------------------------------------------

/** Returns true when the click belonged to the Advanced area. */
export function advancedClick(e) {
  const btn = e.target.closest('[data-adv]');
  if (!btn || btn.disabled) return false;
  const { v } = btn.dataset;
  switch (btn.dataset.adv) {
    case 'section': adv.section = v; draw(); break;
    case 'ref-pick': pickRef(v); break;
    case 'cash-save': saveCash(btn); break;
    case 'onhand-save': saveOnHand(btn); break;
    case 'line-add': adv.lines.push({ item: '', amount: '' }); draw(); $(`#expItem${adv.lines.length - 1}`)?.focus(); break;
    case 'line-del': adv.lines.splice(Number(v), 1); draw(); break;
    case 'exp-save': saveExpenses(btn); break;
    case 'exp-remove': removeExpense(Number(v), btn.dataset.name); break;
    default: return false;
  }
  return true;
}

/** Returns true when the typing belonged to the Advanced area. */
export function advancedInput(e) {
  const t = e.target;
  if (t.dataset.advCount !== undefined) {
    const clean = t.value.replace(/\D/g, '').slice(0, 5);
    if (clean !== t.value) t.value = clean;
    cashCounts()[t.dataset.advCount] = clean;
    updateCash();
    return true;
  }
  if (t.dataset.advOnhand !== undefined) {
    const clean = t.value.replace(',', '.').replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1').replace(/(\.\d{2}).+$/, '$1').slice(0, 10);
    if (clean !== t.value) t.value = clean;
    adv.onHand = clean;
    return true;
  }
  if (t.dataset.advLine) {
    const line = adv.lines[Number(t.dataset.i)];
    if (!line) return true;
    if (t.dataset.advLine === 'amount') {
      const clean = t.value.replace(',', '.').replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1').replace(/(\.\d{2}).+$/, '$1').slice(0, 10);
      if (clean !== t.value) t.value = clean;
      line.amount = clean;
      updateLines();
    } else line.item = t.value;
    return true;
  }
  return false;
}

/** Enter in the Cash on hand box saves it. Enter in an expense amount adds the next line; Enter in a cash box moves to the next box. */
export function advancedKeyDown(e) {
  const t = e.target;
  if (e.key !== 'Enter') return false;
  if (t.dataset.advOnhand !== undefined) { e.preventDefault(); saveOnHand($('[data-adv="onhand-save"]')); return true; }
  if (t.dataset.advLine === 'amount') {
    e.preventDefault();
    const i = Number(t.dataset.i);
    if (i === adv.lines.length - 1) { adv.lines.push({ item: '', amount: '' }); draw(); }
    $(`#expItem${i + 1}`)?.focus();
    return true;
  }
  if (t.dataset.advCount !== undefined) {
    e.preventDefault();
    const boxes = [...document.querySelectorAll('[data-adv-count]')];
    boxes[boxes.indexOf(t) + 1]?.focus();
    return true;
  }
  return false;
}
