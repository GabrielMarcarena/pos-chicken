// Daily Inventory: the stock of every product for one business day, and (below the tables) what the shop does with it:
// Save (Revision 13: keeps today's numbers in the database, one row per day) and Submit Inventory Today (the Excel file). The day closes
// by itself at midnight (Revision 13, in place of "Closed Inventory Today and Reset the Day"). A closed day has an Export button beside
// its "Closed" status (Revision 12, in place of Export Inventory History).
//
// The numbers come from the server (src/services/inventory.js), the same ones the New order screen uses for "Number of Heads".
// Sold is counted from the saved orders and cannot be typed. A manager or the admin types Beginning Balance, Additional and, for
// chicken, the inventory losses Reject, Katay, Dead and Pull Out. Each number is saved as soon as it is entered. Changing a Beginning
// Balance that already has a number is a correction: the screen asks for a reason, and the server keeps it in the history.
import { api } from '../api.js';
import { $, esc, toast, errorBox, openDialog, fmtDateTime } from '../util.js';
import { CHICKEN_COLUMNS, OTHER_COLUMNS, formatQty, previousBeginningText } from '/shared/inventory.js';
import { INVENTORY_REASONS, REF_LABELS } from '/shared/constants.js';
import {
  SUBMIT_BUTTON_TEXT, SAVE_BUTTON_TEXT, EXPORT_BUTTON_TEXT, saveInventory, savedText, submitInventoryToday, exportClosedDay, redownload, submissionText,
} from './dayTools.js';

const REFRESH_MS = 15_000;
// pinned: rows with nothing in them that the person chose to show so a first number can be typed.
const view = { root: null, date: null, data: null, timer: null, saving: false, pinned: new Set() };

const CHICKEN_FIELDS = [null, 'beginning', 'additional', null, null, null, 'reject', 'katay', 'dead', 'pull_out', null];  // which columns are typed in
const CHICKEN_KEYS = ['name', 'beginning', 'additional', 'total', 'sold', 'left', 'reject', 'katay', 'dead', 'pull_out', 'new_total'];
const LOSS_KEYS = new Set(['reject', 'katay', 'dead', 'pull_out']);
const OTHER_FIELDS = [null, 'beginning', 'additional', null, null, null, null];
const OTHER_KEYS = ['name', 'beginning', 'additional', 'total', 'sold', 'left', 'new_total'];

export async function mountInventory(root) {
  view.root = root;
  view.date = null;
  view.pinned = new Set();
  root.onchange = onChange;
  root.onkeydown = onKeyDown;
  root.onclick = (e) => { const b = tipBox(e); if (b) showTip(b); else hideTip(); return onClick(e); };   // a tap shows the note; a tap elsewhere hides it
  root.onmouseover = (e) => { const b = tipBox(e); if (b) showTip(b); };
  root.onmouseout = (e) => { if (tipBox(e) && !tipBox(e).contains(e.relatedTarget)) hideTip(); };
  root.onscroll = hideTip;
  hideTip();
  root.innerHTML = '<p class="muted">Loading the inventory...</p>';
  await load();
  startPolling();
}

async function load({ quiet = false } = {}) {
  try {
    view.data = await api('GET', `/api/inventory${view.date ? `?date=${encodeURIComponent(view.date)}` : ''}`);
    if (!view.date) view.date = view.data.day.business_date;
    render();
  } catch (err) {
    if (!quiet || !view.data) view.root.innerHTML = errorBox(err);
  }
}

function startPolling() {
  stopPolling();
  view.timer = setInterval(() => {
    if (!view.root?.isConnected || location.hash !== '#/inventory') return stopPolling();
    // Do not redraw under someone who is typing a number or answering a question.
    if (document.hidden || view.saving || $('#dialog')?.open || document.activeElement?.classList?.contains('inv-input') || view.data?.day.status !== 'OPEN') return undefined;
    return load({ quiet: true });
  }, REFRESH_MS);
}
function stopPolling() { if (view.timer) clearInterval(view.timer); view.timer = null; }

// ---- Drawing -----------------------------------------------------------------------------------

const num = (milli) => formatQty(milli);

function editable(row, field) {
  if (!view.data.can_edit) return false;
  return field === 'beginning' ? row.beginning_editable : true;
}

const inputMode = (row) => (row.kind === 'OTHER' && row.sold_by === 'PER_KG' ? 'decimal' : 'numeric');

/** "Incorrect inventory", or the person's own words when the reason was "Other". */
const whyText = (e) => (e.reason_code === 'OTHER' && e.note ? e.note : e.reason);
/** The note of an edited Beginning Balance, one fact per line (shown in the bubble when the box is hovered or tapped). */
const whyLines = (e) => [`Edited: ${whyText(e)}`, `Was ${num(e.was)} before this correction`, `Changed by ${e.by}`, fmtDateTime(e.at), ...(e.reason_code === 'OTHER' || !e.note ? [] : [`Note: ${e.note}`])];

/**
 * Beginning Balance: the number (typed, or carried over) and the small italic previous-day note. A corrected Beginning Balance glows and
 * has a small pen mark; its reason, note, who and when appear in a bubble on hover or tap (Revision 14), so nothing is printed under
 * the number and the rows stay level.
 */
function beginningCell(row) {
  const prev = previousBeginningText(row);
  const edit = row.beginning_edit;
  const label = `${esc(row.name)} Beginning Balance${edit ? ` (edited: ${esc(whyText(edit))})` : ''}`;
  const input = editable(row, 'beginning')
    ? `<input class="inv-input" type="text" inputmode="${inputMode(row)}" autocomplete="off" data-field="beginning" value="${esc(num(row.beginning))}" aria-label="${label}">`
    : `<span data-col="beginning" ${row.beginning_carried ? 'title="Carried over from the previous day\'s New Total"' : ''}>${esc(num(row.beginning))}</span>`;
  const box = edit
    ? `<span class="inv-box inv-box--edited" data-edited data-edit-tip="${esc(whyLines(edit).join('\n'))}">${input}<span class="inv-pen" aria-hidden="true">✎</span></span>`
    : input;
  const note = prev ? ` <i class="inv-prev" data-prev title="The previous business day's Beginning Balance and its date (month/day/year)">${esc(prev)}</i>` : '';
  return `<td class="num inv-begin">${box}${note}</td>`;
}

// ---- The note bubble of an edited Beginning Balance: one bubble for the page, placed beside the box that is hovered or tapped ----
let tipEl = null;
function hideTip() { if (tipEl) tipEl.hidden = true; }
function showTip(box) {
  if (!tipEl?.isConnected) {
    tipEl = document.createElement('div');
    tipEl.className = 'inv-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.append(tipEl);
  }
  tipEl.textContent = box.dataset.editTip;
  tipEl.hidden = false;
  const r = box.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  const gap = 8;
  let left = Math.min(Math.max(8, r.right - t.width), window.innerWidth - t.width - 8);   // right edges line up, kept on the screen
  let top = r.bottom + gap;
  if (top + t.height > window.innerHeight - 8) top = Math.max(8, r.top - t.height - gap);   // no room below: above the box
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}
const tipBox = (e) => e.target.closest?.('[data-edit-tip]');

function cell(row, key, field) {
  if (key === 'beginning') return beginningCell(row);
  const value = row[key];
  const loss = LOSS_KEYS.has(key) ? ' inv-loss' : '';
  if (value === null || value === undefined) return `<td class="num${loss}">&ndash;</td>`;
  if (field && editable(row, field)) {
    const label = `${row.name} ${field === 'pull_out' ? 'Pull Out' : field[0].toUpperCase() + field.slice(1)}`;
    return `<td class="num${loss}"><input class="inv-input" type="text" inputmode="${inputMode(row)}" autocomplete="off"
      data-field="${field}" value="${esc(num(value))}" aria-label="${esc(label)}"></td>`;
  }
  return `<td class="num${loss}" data-col="${key}">${esc(num(value))}</td>`;
}

function rowHtml(row) {
  const chicken = row.kind === 'CHICKEN';
  const keys = chicken ? CHICKEN_KEYS : OTHER_KEYS;
  const fields = chicken ? CHICKEN_FIELDS : OTHER_FIELDS;
  const cells = keys.map((key, i) => {
    if (i === 0) return `<th scope="row">${esc(row.name)}</th>`;
    const c = cell(row, key, fields[i]);
    if (key === 'new_total') return c.replace('class="num"', `class="num inv-new${row.new_total < 0 ? ' inv-neg' : ''}"`);
    return c;
  });
  return `<tr data-row="${row.id}" data-kind="${row.kind}">${cells.join('')}</tr>`;
}

/** Rows with nothing in them (no Beginning Balance, nothing added, nothing sold) are left out of the list unless the person asked to see one. */
const shown = (rows) => rows.filter((r) => !r.empty || view.pinned.has(r.id));

/** Fixed column widths, so the headings, the input boxes and the numbers line up in their columns (Revision 11). */
const colgroup = (kind) => (kind === 'chicken'
  ? '<colgroup><col class="c-name"><col class="c-begin"><col class="c-in"><col class="c-calc"><col class="c-calc"><col class="c-calc"><col class="c-in"><col class="c-in"><col class="c-in"><col class="c-in"><col class="c-new"></colgroup>'
  : '<colgroup><col class="c-name"><col class="c-begin"><col class="c-in"><col class="c-calc"><col class="c-calc"><col class="c-calc"><col class="c-new"></colgroup>');

function tableHtml(kind, columns, rows) {
  // Chicken: a heading over Reject, Katay, Dead and Pull Out says what they are (inventory losses, not sales and not discounts).
  const group = kind === 'chicken'
    ? '<tr class="inv-group"><th colspan="6"></th><th colspan="4" scope="colgroup" class="inv-loss-head">Inventory losses (not sales, not discounts)</th><th></th></tr>'
    : '';
  return `<div class="table-wrap"><table class="data inv" data-table="${kind}">${colgroup(kind)}
      <thead>${group}<tr>${columns.map((c, i) => `<th scope="col" class="${i > 0 ? 'num' : ''}${['Reject', 'Katay', 'Dead', 'Pull Out'].includes(c) && kind === 'chicken' ? ' inv-loss' : ''}">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.map(rowHtml).join('') : `<tr><td colspan="${columns.length}" class="muted">Nothing to show here yet. Products with nothing in stock are hidden; products appear when they are added on the Products screen.</td></tr>`}</tbody>
    </table></div>`;
}

function hiddenNote(hidden, canAdd) {
  if (!hidden.length) return '';
  const picker = canAdd
    ? `<div class="field inv-add"><label for="invAddRow">Type stock for a product that is not listed</label>
        <select id="invAddRow"><option value="">Choose a product...</option>${hidden.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>`
    : '';
  return `<div class="inv-hidden" data-inv-hidden>
      <p class="muted"><strong data-hidden-count>${hidden.length}</strong> other-product ${hidden.length === 1 ? 'row is' : 'rows are'} hidden because ${hidden.length === 1 ? 'it has' : 'they have'} nothing in stock and nothing sold.</p>
      ${picker}
    </div>`;
}

/** Where today's submission stands: not yet, done with the final numbers, or done but the numbers have changed since. */
function submissionHtml(d, open) {
  const s = d.submission?.latest;
  if (!s) return open ? '<p class="inv-sub inv-sub--none" data-submission="none">Today\'s inventory has not been submitted yet.</p>' : '';
  const again = `<button type="button" class="btn btn--small btn--plain" data-inv="redownload" data-id="${s.id}" data-name="${esc(s.file_name)}">Download the submitted file</button>`;
  if (d.submission.current) return `<p class="inv-sub inv-sub--ok" data-submission="current">${esc(submissionText(s))}. ${again}</p>`;
  return `<p class="inv-sub inv-sub--stale" data-submission="stale">${esc(submissionText(s))}, but the numbers have changed since (an order, a cancellation or a typed number). Submit it again for a file with the latest numbers. ${again}</p>`;
}

/** Where today's Save stands (Revision 13): not yet, saved with the numbers of now, or saved but the numbers have changed since. */
function savedHtml(d, open) {
  const s = d.saved;
  if (!s) return open ? '<p class="inv-sub inv-sub--none" data-saved="none">Not saved yet. Press Save to keep today\'s numbers. At midnight the day is saved and closed by itself.</p>' : '';
  if (s.current) return `<p class="inv-sub inv-sub--ok" data-saved="current">${esc(savedText(s))}.</p>`;
  return `<p class="inv-sub inv-sub--stale" data-saved="stale">${esc(savedText(s))}, but the numbers have changed since. Press Save again to keep the latest numbers.</p>`;
}

/** The actions, in their own section below the inventory tables (Revision 11). */
function actionsHtml(d, open) {
  const canAct = d.can_close;   // managers and the admin, on the open day
  let hint = '';
  if (!open) hint = `This business day is closed. To save or submit, choose the open business day (${d.open_day.business_date}) above. To download this closed day, press ${EXPORT_BUTTON_TEXT} beside "Closed" at the top.`;
  else if (!canAct) hint = 'Only a manager or the admin can save and submit the inventory.';
  return `<section class="panel inv-actions" aria-labelledby="invActionsTitle">
      <div class="panel-head"><h3 id="invActionsTitle">Inventory actions</h3></div>
      ${savedHtml(d, open)}
      ${submissionHtml(d, open)}
      <div class="inv-buttons">
        <button type="button" class="btn btn--primary" data-inv="save" ${canAct ? '' : 'disabled'}>${esc(SAVE_BUTTON_TEXT)}</button>
        <button type="button" class="btn" data-inv="submit" ${canAct ? '' : 'disabled'}>${esc(SUBMIT_BUTTON_TEXT)}</button>
      </div>
      ${hint ? `<p class="muted mt-s" data-inv-hint>${esc(hint)}</p>` : ''}
      <dl class="inv-help">
        <div><dt>${esc(SAVE_BUTTON_TEXT)}</dt>
          <dd>Keeps today's numbers in the database: <strong>one saved record per day</strong>. Press it again any time; the newer numbers replace the older ones. Nothing is downloaded and nothing is reset.</dd></div>
        <div><dt>At midnight <span class="muted">(automatic)</span></dt>
          <dd>At 12:00 midnight the app <strong>saves and closes ${esc(d.open_day.business_date)} by itself</strong>, even if nobody pressed Save, and starts the new day. Each New Total becomes the new day's Beginning Balance; Additional, Reject, Katay, Dead and Pull Out start at 0. The Excel file of the closed day is saved on this computer (backups/inventory). Ongoing and Standby orders stay on the Order List; Complete orders leave it (they stay saved). Closed days are kept and can be opened under <strong>Business day</strong>.</dd></div>
        <div><dt>${esc(SUBMIT_BUTTON_TEXT)}</dt>
          <dd>Saves today's inventory as an Excel file on this computer and downloads a copy: every chicken product (Beginning Balance, Additional, Total, Sold, Left, Reject, Katay, Dead, Pull Out, New Total) and every other product (Beginning Balance, Additional, Sold, Left, New Total). Products with 0 in every column are left out, and the file says so. It changes nothing; use it whenever you want a copy during the day.</dd></div>
        <div><dt>${esc(EXPORT_BUTTON_TEXT)} <span class="muted">(closed days)</span></dt>
          <dd>Choose a closed day under <strong>Business day</strong> above: an <strong>${esc(EXPORT_BUTTON_TEXT)}</strong> button appears beside "Closed". It downloads that day's inventory as it was closed, laid out like the submitted file (chicken products, then other products). It changes nothing.</dd></div>
      </dl>
      <div id="invMsg" role="status" aria-live="polite"></div>
    </section>`;
}

/** "How the numbers are worked out", as a notebook page with the important words highlighted (Revision 12). */
function notebookHtml() {
  const hl = (t) => `<mark class="hl">${t}</mark>`;
  return `<section class="panel notebook" aria-labelledby="invRules">
      <div class="notebook-head"><h3 id="invRules"><span aria-hidden="true">📒</span> How the numbers are worked out</h3></div>
      <ol class="notebook-lines">
        <li>${hl('Total')} = Beginning Balance + Additional.</li>
        <li>${hl('Sold')} is counted from the orders sold on this business day: <b>Ongoing</b>, <b>Standby</b> and <b>Complete</b> orders count on the day they were sold. <mark class="hl hl--red">Canceled</mark> orders do not count. A Standby order picked up on a later day is not counted again.</li>
        <li>${hl('Left')} = Total &minus; Sold.</li>
        <li>Chicken: ${hl('New Total')} = Left &minus; Reject &minus; Katay &minus; Dead &minus; Pull Out. Other products: ${hl('New Total')} = Left.</li>
        <li><mark class="hl hl--amber">Reject, Katay, Dead and Pull Out</mark> are inventory losses, not sales and not discounts. <b>Katay</b> is a dying chicken slaughtered and bled at once so the meat is not damaged. A Dead or Katay <em>discount</em> on an order changes the price only, never these numbers.</li>
        <li>Katay and Dead chicken kept ${hl('in the ref')}: storing one from <b>New order &gt; Advanced</b> adds it here too. When you type a higher Katay or Dead here, the screen asks whether it went into the ref; only a "yes" adds it to the ref stock.</li>
        <li>The small <i>italic</i> number beside a Beginning Balance is the ${hl('previous business day\'s Beginning Balance')} and its date (month/day/year), for reference.</li>
        <li>A manager or the admin can ${hl('correct a Beginning Balance')} that already has a number; the screen asks for a reason and the correction is kept in the history. The submitted file lists each correction as a note: who, the reason and the note.</li>
        <li>At ${hl('12:00 midnight')} the day is <mark class="hl hl--amber">saved and closed by itself</mark>, and today's ${hl('New Total')} becomes tomorrow's ${hl('Beginning Balance')}.</li>
      </ol>
    </section>`;
}

function render() {
  const d = view.data;
  const open = d.day.status === 'OPEN';
  const days = d.days.map((x) => `<option value="${esc(x.business_date)}" ${x.business_date === d.day.business_date ? 'selected' : ''}>${esc(x.business_date)}${x.status === 'OPEN' ? ' (open)' : ' (closed)'}</option>`).join('');
  const all = [...d.chicken, ...d.other];
  const fresh = open && d.can_edit && !all.some((r) => r.beginning > 0);
  const hidden = d.other.filter((r) => r.empty && !view.pinned.has(r.id));
  let banner = '';
  if (!open) banner = '<div class="note-box" data-inv-note="closed">This business day is <strong>closed</strong>. Its numbers are saved history and cannot be changed.</div>';
  else if (d.day.stale) banner = `<div class="note-box stale-note" role="status" data-inv-note="stale">This business day (<strong>${esc(d.day.business_date)}</strong>) is from an earlier date. It is saved and closed automatically within a minute.</div>`;
  else if (!d.can_edit) banner = '<div class="note-box" data-inv-note="readonly">You can look at these numbers. A manager or the admin types them in.</div>';
  view.root.innerHTML = `
    <div class="section-title"><h2>Daily Inventory</h2></div>
    <div class="inv-bar">
      <div class="field"><label for="invDate">Business day</label><select id="invDate">${days}</select></div>
      <span class="badge badge--${open ? 'open' : 'closed'}" data-inv-status>${open ? 'Open' : 'Closed'}</span>
      ${open ? '' : `<button type="button" class="btn btn--small inv-export" data-inv="export" title="Download the inventory of ${esc(d.day.business_date)} as it was closed">⬇ ${esc(EXPORT_BUTTON_TEXT)}</button>`}
    </div>
    ${open ? '' : '<div id="invExportMsg" role="status" aria-live="polite"></div>'}
    ${banner}
    ${fresh ? '<div class="note-box" data-inv-note="first">Type the <strong>Beginning Balance</strong> of each product you have in stock now. Numbers are saved as soon as you leave the box. From the next business day it is carried over from the previous day\'s New Total.</div>' : ''}
    <section class="panel" aria-labelledby="invChicken"><div class="panel-head"><h3 id="invChicken">Chicken Inventory</h3><span class="muted">counted in heads</span></div>
      ${tableHtml('chicken', CHICKEN_COLUMNS, d.chicken)}</section>
    <section class="panel" aria-labelledby="invOther"><div class="panel-head"><h3 id="invOther">Other Products</h3><span class="muted">counted in pieces (or packs, sacks, cartons, trays); things sold by the kilo are counted in pieces too</span></div>
      ${tableHtml('other', OTHER_COLUMNS, shown(d.other))}
      ${hiddenNote(hidden, open && d.can_edit)}</section>
    ${notebookHtml()}
    ${actionsHtml(d, open)}`;
}

// ---- Saving ------------------------------------------------------------------------------------

const findRow = (id) => [...view.data.chicken, ...view.data.other].find((r) => r.id === Number(id));

function showMessage(html) { const box = $('#invMsg'); if (box) box.innerHTML = html; }

/** Put the server's answer for one row on the screen without redrawing (so the keyboard stays where it is). */
function applyRow(fresh) {
  const old = findRow(fresh.id);
  Object.assign(old, fresh);
  const tr = $(`tr[data-row="${fresh.id}"]`);
  if (!tr) return;
  for (const [key, value] of Object.entries(fresh)) {
    const c = tr.querySelector(`[data-col="${key}"]`);
    if (c) c.textContent = num(value);
    const input = tr.querySelector(`input[data-field="${key}"]`);
    if (input && document.activeElement !== input) input.value = num(value);
  }
  const nt = tr.querySelector('.inv-new');
  if (nt) { nt.textContent = num(fresh.new_total); nt.classList.toggle('inv-neg', fresh.new_total < 0); }
}

/**
 * Ask why a Beginning Balance is being corrected. Resolves with { code, note } or null when the person cancels.
 * The reason has to be chosen (nothing is pre-selected), and "Other" needs a few words of explanation.
 */
function askReason(row, newText) {
  let chosen = null;
  const options = Object.entries(INVENTORY_REASONS).map(([code, text]) => `<option value="${esc(code)}">${esc(text)}</option>`).join('');
  return openDialog({
    title: 'Why is the Beginning Balance changing?',
    body: `<p><strong data-reason-name>${esc(row.name)}</strong>: Beginning Balance <strong>${esc(num(row.beginning))}</strong> &rarr; <strong>${esc(newText)}</strong></p>
      <p class="muted">Every correction is kept in the history with the reason, who changed it and when. Only a manager or the admin can do this.</p>
      <div class="field"><label for="reasonCode">Reason (required)</label>
        <select id="reasonCode"><option value="">Choose a reason...</option>${options}</select></div>
      <div class="field"><label for="reasonNote">Note <span class="muted">(required for Other, optional otherwise)</span></label>
        <textarea id="reasonNote" rows="2" maxlength="200"></textarea></div>
      <div id="reasonMsg" role="alert"></div>`,
    actions: [
      { label: 'Cancel, keep the old number', value: false },
      {
        label: 'Save the correction', kind: 'primary',
        onClick: (dlg) => {
          const code = $('#reasonCode', dlg).value;
          const note = $('#reasonNote', dlg).value.replace(/\s+/g, ' ').trim();
          const problem = !code ? 'Choose a reason first.' : (code === 'OTHER' && note.length < 3 ? 'Please explain the reason in the note.' : '');
          if (problem) { $('#reasonMsg', dlg).innerHTML = errorBox({ message: problem }); return false; }
          chosen = { code, note };
          return true;
        },
      },
    ],
  }).then((ok) => (ok === true ? chosen : null));
}

/**
 * Revision 12: Katay or Dead typed higher. Did the chicken go into the ref? Resolves true (yes: the ref stock goes up too), false (no: only
 * the Daily Inventory changes) or null (cancel: nothing is saved).
 */
function askRef(row, field, from, to) {
  const kind = field === 'katay' ? 'KATAY' : 'DEAD';
  const more = to - from;
  return openDialog({
    title: `Did ${more === 1 ? 'it' : 'they'} go into the ref?`,
    body: `<p><strong>${esc(row.name)}</strong>: ${field === 'katay' ? 'Katay' : 'Dead'} <strong>${esc(num(from))}</strong> &rarr; <strong>${esc(num(to))}</strong> (${esc(num(more))} more).</p>
      <p>Were ${more === 1 ? 'this chicken' : 'these chickens'} put in the ref (refrigerator) to be sold later as <strong>${esc(REF_LABELS[kind])}</strong>?</p>
      <p class="muted">Yes: the ${esc(REF_LABELS[kind])} stock in New order &gt; Advanced goes up by ${esc(num(more))} too. No: only this Daily Inventory number changes.</p>`,
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'No, not in the ref', value: 'no' },
      { label: 'Yes, it went into the ref', kind: 'primary', value: 'yes' },
    ],
  }).then((v) => (v === 'yes' ? true : v === 'no' ? false : null));
}

/** "155", "1.5" -> thousandths; anything else -> null (the server gives the proper message). */
const typedMilli = (text) => (/^\d+(\.\d{1,3})?$/.test(text) ? Math.round(Number(text) * 1000) : null);

async function onChange(e) {
  const t = e.target;
  if (t.id === 'invDate') { view.date = t.value; view.pinned = new Set(); return load(); }
  if (t.id === 'invAddRow') {
    const id = Number(t.value);
    if (!id) return undefined;
    view.pinned.add(id);
    render();
    $(`tr[data-row="${id}"] input[data-field="beginning"]`)?.focus();
    return undefined;
  }
  if (!t.classList.contains('inv-input')) return undefined;
  const tr = t.closest('tr');
  const row = findRow(tr.dataset.row);
  const field = t.dataset.field;
  const text = t.value.trim();
  if (text === num(row[field]) || typedMilli(text) === row[field]) { t.value = num(row[field]); return undefined; }   // nothing changed

  view.saving = true;
  t.disabled = true;
  try {
    let reason = null;
    // Changing a Beginning Balance that already has a number is a correction, and a correction needs a reason.
    if (field === 'beginning' && row.beginning_needs_reason && typedMilli(text) !== null) {
      reason = await askReason(row, text);
      if (!reason) { t.disabled = false; t.value = num(row[field]); t.classList.remove('inv-bad'); return undefined; }
    }
    // Revision 12: a higher Katay or Dead asks whether the chicken went into the ref.
    let toRef;
    if ((field === 'katay' || field === 'dead') && typedMilli(text) !== null && typedMilli(text) > row[field]) {
      toRef = await askRef(row, field, row[field], typedMilli(text));
      if (toRef === null) { t.disabled = false; t.value = num(row[field]); return undefined; }
    }
    const send = (why) => api('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, [field]: text, ...(why ? { reason: why.code, reason_note: why.note } : {}), ...(toRef !== undefined ? { to_ref: toRef } : {}) });
    let r;
    try { r = await send(reason); } catch (err) {
      // The server decides whether a reason is needed; if the screen did not know, ask now and try once more.
      if (err.code !== 'REASON_REQUIRED' || reason) throw err;
      reason = await askReason(row, text);
      if (!reason) { t.disabled = false; t.value = num(row[field]); return undefined; }
      r = await send(reason);
    }
    t.disabled = false;
    applyRow(r.row);
    t.value = num(r.row[field]);
    t.classList.remove('inv-bad');
    if (field === 'beginning') {
      const fresh = tr.isConnected ? tr : $(`tr[data-row="${row.id}"]`);
      if (fresh) fresh.outerHTML = rowHtml(findRow(row.id));   // show the new "Edited" reason
    }
    const refText = (r.ref_moves ?? []).map((m) => ` ${m.heads > 0 ? `${m.heads} put in the ref` : `${-m.heads} taken out of the ref`} (${REF_LABELS[m.kind]}: ${r.ref_heads?.[m.kind] ?? '?'} now).`).join('');
    showMessage(r.changed ? `<div class="ok-box" role="status">Saved: ${esc(row.name)}${reason ? ` (Beginning Balance corrected: ${esc(reason.code === 'OTHER' ? reason.note : INVENTORY_REASONS[reason.code])})` : ''}.${esc(refText)}</div>` : '');
  } catch (err) {
    t.disabled = false;
    t.classList.add('inv-bad');
    showMessage(errorBox(err));
    if (err.code === 'CONFLICT') await load({ quiet: true }); else t.value = num(row[field]);
    toast(err.message, 'error');
  } finally { view.saving = false; }
  return undefined;
}

function onKeyDown(e) {
  if (e.key === 'Enter' && e.target.classList?.contains('inv-input')) { e.preventDefault(); e.target.blur(); }
  if (e.key === 'Escape' && e.target.classList?.contains('inv-input')) {
    const row = findRow(e.target.closest('tr').dataset.row);
    e.target.value = num(row[e.target.dataset.field]);
    e.target.blur();
  }
}

// ---- Closing and exporting ---------------------------------------------------------------------

async function onClick(e) {
  const btn = e.target.closest('[data-inv]');
  if (!btn || btn.disabled) return undefined;
  const date = view.data.day.business_date;
  const buttons = [...view.root.querySelectorAll('[data-inv]')];
  const lock = (on) => buttons.forEach((b) => { if (on) { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true; } else b.disabled = b.dataset.wasDisabled === '1'; });
  switch (btn.dataset.inv) {
    case 'submit': {
      lock(true);
      showMessage('<p class="muted">Saving today\'s inventory...</p>');
      const s = await submitInventoryToday(date, (h) => { view.lastMessage = h; });
      if (s) toast('Inventory submitted.', 'ok'); else toast('The inventory was not submitted.', 'error');
      await load({ quiet: true });   // show the new submission status
      showMessage(view.lastMessage ?? '');
      lock(false);
      return undefined;
    }
    case 'save': {
      lock(true);
      showMessage('<p class="muted">Saving...</p>');
      const r = await saveInventory((h) => { view.lastMessage = h; });
      if (r) toast('Inventory saved.', 'ok'); else toast('The inventory was not saved.', 'error');
      await load({ quiet: true });   // show the new saved status
      showMessage(view.lastMessage ?? '');
      lock(false);
      return undefined;
    }
    case 'export': {
      lock(true);
      const box = $('#invExportMsg');
      const show = (h) => { if (box) box.innerHTML = h; };
      show('<p class="muted">Preparing the file...</p>');
      const name = await exportClosedDay(date, show);
      if (name) toast(`Exported ${name}.`, 'ok');
      lock(false);
      return undefined;
    }
    case 'redownload':
      return redownload(Number(btn.dataset.id), btn.dataset.name, showMessage);
    default:
      return undefined;
  }
}
