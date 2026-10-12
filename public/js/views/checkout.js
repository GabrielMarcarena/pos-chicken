// The cashier screen: pick a product, enter the weight, choose the service, add to the order, review, submit.
import { api } from '../api.js';
import { state, saveDraft, clearDraft, findProduct, findOption, priceItem, priceOther, draftTotals, draftLineCount, refreshConfig } from '../state.js';
import { $, esc, label, formatPeso, formatKg, formatThousandths, uuid, toast, errorBox, confirmDialog, prepChips, fmtDateTime, iconFor } from '../util.js';
import { emptyPrep, applyPrepChange, validatePrep } from '/shared/rules.js';
import { parseWeightToGrams, parseQuantityToMilli, parseWholeQuantityToMilli, parsePesosToCentavos, parseHeads, MAX_HEADS } from '/shared/money.js';
import { chickenLine, otherLine } from '/shared/pricing.js';
import { REASONS, PAYMENT_METHODS, DISCOUNT_REASONS, SERVICE_NOTES } from '/shared/constants.js';
import { orderTable } from './slip.js';

// What is on screen right now. The order itself lives in state.draft (saved in sessionStorage).
const ui = { root: null, step: 'pick', tab: 'chicken', search: '', cfg: null, done: null, submitting: false, error: null };

const pesoText = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

/** Keep only digits and one decimal point, with at most `decimals` digits after it (0 = whole numbers only). */
function cleanDecimal(text, decimals = 3) {
  let s = String(text).replace(',', '.').replace(/[^\d.]/g, '');
  if (decimals === 0) s = s.replace(/\./g, '');
  const dot = s.indexOf('.');
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '').slice(0, decimals);
  const [whole, frac] = s.split('.');
  return frac === undefined ? whole.slice(0, 4) : `${whole.slice(0, 4)}.${frac}`;
}

/** Whole numbers for fixed-price items; decimals for per-kg items and chicken weights. */
const decimalsFor = (cfg) => (cfg.kind === 'other' && findOption(cfg.optionId)?.option.sold_by === 'FIXED' ? 0 : 3);

export async function mountCheckout(root) {
  ui.root = root;
  if (ui.step === 'configure') ui.step = 'pick';
  if (ui.step === 'done') { ui.step = 'pick'; ui.done = null; } // coming back later: start a fresh order screen
  if (ui.step !== 'done' && ui.step !== 'review') await refreshConfig(api).catch(() => {});
  if (draftLineCount() === 0 && ui.step === 'review') ui.step = 'pick';
  root.onclick = onClick;
  root.oninput = onInput;
  root.onchange = onChange;
  root.onkeydown = onKeyDown;
  render();
}

/** Used by the Orders screen before it hands an order over for changing. */
export function resetCheckoutUi() {
  ui.step = 'pick'; ui.cfg = null; ui.error = null; ui.done = null; ui.submitting = false;
}

function render() {
  const root = ui.root;
  if (ui.step === 'done') return renderDone();
  if (ui.step === 'review') return renderReview();
  root.innerHTML = `<div class="checkout">
      <section id="work" aria-label="Add an item"></section>
      <aside class="order-panel panel" id="orderPanel" aria-label="Current order"></aside>
    </div>`;
  renderWork();
  renderOrderPanel();
}

// ---- Left side: products, weight, service ----------------------------------------------------------

function renderWork() {
  const work = $('#work');
  if (!work) return;
  if (ui.step === 'configure' && ui.cfg) {
    work.innerHTML = ui.cfg.kind === 'chicken' ? cfgChickenHtml() : cfgOtherHtml();
    if (ui.cfg.kind === 'chicken') renderPrep();
    updateCfg();
    // On a touch screen, do not pop up the keyboard over the number pad.
    if (window.matchMedia('(pointer: fine)').matches) $('#amount')?.focus();
    return;
  }
  const tabs = `<div class="tabs" role="tablist" aria-label="What is the customer buying?">
      <button type="button" class="tab" role="tab" aria-selected="${ui.tab === 'chicken'}" data-action="tab" data-tab="chicken">🐔 Chicken</button>
      <button type="button" class="tab" role="tab" aria-selected="${ui.tab === 'other'}" data-action="tab" data-tab="other">🥚 Other products</button>
    </div>`;
  work.innerHTML = `<div class="section-title"><h2>${ui.tab === 'chicken' ? 'Choose the chicken' : 'Eggs, etag, condiments and more'}</h2>
      ${ui.tab === 'other' ? `<div class="field search"><label class="sr" for="otherSearch">Search products</label><input id="otherSearch" type="text" placeholder="Search products" value="${esc(ui.search)}" autocomplete="off"></div>` : ''}</div>
    ${tabs}<div id="grid"></div>`;
  renderGrid();
}

function renderGrid() {
  const grid = $('#grid');
  if (!grid) return;
  const { products, other_products: others } = state.config;
  if (ui.tab === 'chicken') {
    grid.innerHTML = products.length
      ? `<div class="product-grid">${products.map((p) => `
          <button type="button" class="product-card" data-action="pick-product" data-id="${p.id}">
            <span class="ico" aria-hidden="true">${iconFor(p.name)}</span>
            <span class="meta"><span class="name">${esc(p.name)}</span><span class="price">${formatPeso(p.price_per_kg_centavos)}/kg</span></span>
          </button>`).join('')}</div>`
      : `<div class="empty"><p><strong>No chicken products are active.</strong></p><p>Ask a manager or the admin to add a product and set its price in Products.</p></div>`;
    return;
  }
  const q = ui.search.trim().toLowerCase();
  const shown = others.filter((p) => !q || p.name.toLowerCase().includes(q));
  grid.innerHTML = shown.length
    ? `<div class="product-grid">${shown.map((p) => `
        <button type="button" class="product-card" data-action="pick-other" data-id="${p.id}">
          <span class="ico" aria-hidden="true">${iconFor(p.name)}</span>
          <span class="meta"><span class="name">${esc(p.name)}</span>
            <span class="opts">${p.options.map((o) => `<span class="price">${formatPeso(o.price_centavos)}/${esc(o.unit)}</span>`).join('')}</span></span>
        </button>`).join('')}</div>`
    : `<div class="empty"><p><strong>${others.length ? 'No product matches your search.' : 'No other products are ready to sell yet.'}</strong></p>
        ${others.length ? '' : '<p>The admin sets the price of each product in Products, Other products. Products without a price are not shown here.</p>'}</div>`;
}

function cfgChickenHtml() {
  const p = findProduct(ui.cfg.productId);
  return `
    <div class="cfg-head">
      <button type="button" class="btn" data-action="cfg-back">Back to products</button>
      <h2><span aria-hidden="true">${iconFor(p.name)}</span> ${esc(p.name)} <span class="chip chip--fee">${formatPeso(p.price_per_kg_centavos)}/kg</span></h2>
    </div>
    <div class="cfg-grid">
      <div>
        <div class="scale">
          <div class="tag" id="scaleTag">Live weight</div>
          <div class="reading" id="reading"></div>
          <div class="sum" id="sum"></div>
          <div class="grand"><span>Item total</span><output id="itemTotal" for="amount">${formatPeso(0)}</output></div>
        </div>
        <div class="field heads-field"><label for="heads">Number of heads</label>
          <div class="stepper">
            <button type="button" class="btn" data-action="heads-dec" aria-label="One less head">&minus;</button>
            <input id="heads" type="text" inputmode="numeric" autocomplete="off" value="${esc(ui.cfg.heads)}" aria-label="Number of heads">
            <button type="button" class="btn" data-action="heads-inc" aria-label="One more head">+</button>
          </div>
          <span class="hint">How many chickens are weighed together. Weigh them all at once and enter the total weight below.</span></div>
        <div class="field weight-input"><label for="amount" id="weightLabel">Weight in kg</label>
          <input id="amount" type="text" inputmode="decimal" autocomplete="off" value="${esc(ui.cfg.value)}" placeholder="for example 3.6"></div>
        ${keypadHtml(true)}
      </div>
      <div>
        <div id="prep"></div>
        <p class="cfg-hint" id="hint" role="status"></p>
        <div class="cfg-actions">
          <button type="button" class="btn btn--primary btn--big" id="addBtn" data-action="cfg-add" disabled>${ui.cfg.editKey ? 'Update item' : 'Add to order'}</button>
          <button type="button" class="btn btn--big" data-action="cfg-back">Cancel</button>
        </div>
      </div>
    </div>`;
}

function cfgOtherHtml() {
  const product = state.config.other_products.find((p) => p.id === ui.cfg.productId);
  const chosen = findOption(ui.cfg.optionId).option;
  const options = product.options.map((o) => `<button type="button" class="choice" role="radio" aria-checked="${o.id === chosen.id}" data-action="pick-option" data-id="${o.id}">
      <span>${o.sold_by === 'PER_KG' ? 'Per kg' : `Per ${esc(o.unit)}`}<small>${formatPeso(o.price_centavos)}</small></span></button>`).join('');
  const word = chosen.sold_by === 'PER_KG' ? 'Weight in kg' : `How many ${chosen.unit}?`;
  return `
    <div class="cfg-head">
      <button type="button" class="btn" data-action="cfg-back">Back to products</button>
      <h2><span aria-hidden="true">${iconFor(product.name)}</span> ${esc(product.name)}</h2>
    </div>
    <div class="cfg-grid">
      <div>
        <div class="scale">
          <div class="tag">${chosen.sold_by === 'PER_KG' ? 'Weight' : 'Quantity'}</div>
          <div class="reading" id="reading"></div>
          <div class="sum" id="sum"></div>
          <div class="grand"><span>Item total</span><output id="itemTotal" for="amount">${formatPeso(0)}</output></div>
        </div>
        <div class="field weight-input"><label for="amount">${esc(word)}</label>
          <input id="amount" type="text" inputmode="${chosen.sold_by === 'PER_KG' ? 'decimal' : 'numeric'}" autocomplete="off" value="${esc(ui.cfg.value)}" placeholder="${chosen.sold_by === 'PER_KG' ? 'for example 1.5' : 'for example 2'}"></div>
        ${keypadHtml(chosen.sold_by === 'PER_KG')}
      </div>
      <div>
        <fieldset class="group option-row" role="radiogroup" aria-label="How is it sold?"><legend>Sold by</legend><div class="choices">${options}</div></fieldset>
        <p class="cfg-hint" id="hint" role="status"></p>
        <div class="cfg-actions">
          <button type="button" class="btn btn--primary btn--big" id="addBtn" data-action="cfg-add" disabled>${ui.cfg.editKey ? 'Update item' : 'Add to order'}</button>
          <button type="button" class="btn btn--big" data-action="cfg-back">Cancel</button>
        </div>
      </div>
    </div>`;
}

function keypadHtml(decimal) {
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', 'back'];
  return `<div class="keypad" role="group" aria-label="Number pad">
    ${keys.map((k) => `<button type="button" data-key="${k}" ${k === '.' && !decimal ? 'disabled' : ''} aria-label="${k === 'back' ? 'Delete last digit' : k === '.' ? 'Decimal point' : k}">${k === 'back' ? '&#9003;' : k}</button>`).join('')}
    <button type="button" class="clear" data-key="clear">Clear</button>
  </div>`;
}

function feeText(code) {
  const fee = state.config.fees[code];
  return fee && fee.amount > 0 ? `+${formatPeso(fee.amount)}${fee.basis === 'per_kg' ? '/kg' : fee.basis === 'per_head' ? ' per head' : ''}` : '';
}

function renderPrep() {
  const prep = ui.cfg.prep;
  const live = prep.feather === 'LIVE';
  const service = (v) => {
    const fee = v === 'LIVE' ? '' : feeText(v);
    return `<button type="button" class="choice service ${v === 'LIVE' || !fee ? 'free' : ''}" role="radio" aria-checked="${prep.feather === v}" data-action="prep-feather" data-v="${v}">
      <span class="svc-text"><span class="svc-name">${esc(label(v))}</span><small>${esc(SERVICE_NOTES[v])}</small></span><span class="svc-fee">${fee || 'No fee'}</span></button>`;
  };
  const cutChoice = (v, text, checked, note = '') => `<button type="button" class="choice" role="radio" aria-checked="${checked}" data-action="prep-cut" data-v="${v}" ${live ? 'disabled' : ''}><span>${esc(text)}${note ? `<small>${note}</small>` : ''}</span></button>`;

  $('#prep').innerHTML = `
    <fieldset class="group" role="radiogroup" aria-label="Service">
      <legend>Service<span class="req">required</span></legend>
      <div class="service-grid">${service('LIVE')}${service('POUR')}${service('NOT_POUR')}</div>
      ${live ? '<p class="live-note">Live chickens get no other preparation, so Dara and cutting are off.</p>' : ''}
    </fieldset>
    <fieldset class="group"><legend>Dara <span class="muted">(gathering the blood)</span></legend>
      <div class="choices"><button type="button" class="choice" role="switch" aria-checked="${prep.dara}" data-action="prep-dara" ${live ? 'disabled' : ''}><span>Dara${feeText('DARA') ? `<small>${feeText('DARA')}</small>` : ''}</span></button></div>
    </fieldset>
    <fieldset class="group" role="radiogroup" aria-label="Cutting">
      <legend>Cutting${live ? '' : '<span class="req">required</span>'}</legend>
      <div class="choices cut-grid">
        ${cutChoice('SMALL', label('SMALL'), prep.sliceSize === 'SMALL')}
        ${cutChoice('MEDIUM', label('MEDIUM'), prep.sliceSize === 'MEDIUM')}
        ${cutChoice('LARGE', label('LARGE'), prep.sliceSize === 'LARGE')}
        ${cutChoice('DUKOT', label('DUKOT'), prep.cut === 'DUKOT', feeText('DUKOT'))}
      </div>
      <p class="live-note">Choose a slice size, or Dukot to leave it whole with the inside removed. Po-ur and Dressed are always one or the other.</p>
    </fieldset>`;
}

/** Refresh the readout, the price, the hint and the Add button without redrawing the whole screen. */
function updateCfg() {
  const c = ui.cfg;
  if (!c) return;
  const reading = $('#reading');
  const isChicken = c.kind === 'chicken';
  const found = isChicken ? null : findOption(c.optionId);
  const unit = isChicken ? 'kg' : found.option.unit;
  reading.innerHTML = c.value ? `${esc(c.value)}<span class="unit">${esc(unit)}</span>` : `0<span class="unit">${esc(unit)}</span>`;
  reading.classList.toggle('idle', !c.value);

  let sumHtml = '';
  let total = 0;
  let hint = '';
  if (isChicken) {
    const product = findProduct(c.productId);
    const grams = parseWeightToGrams(c.value);
    const heads = parseHeads(c.heads);
    const many = heads !== null && heads > 1;
    $('#weightLabel').textContent = many ? 'Total weight of all the heads, in kg' : 'Weight in kg';
    $('#scaleTag').textContent = many ? 'Total weight' : 'Live weight';
    if (heads === null) hint = `Enter the number of heads (1 to ${MAX_HEADS}).`;
    else if (grams === null) hint = c.value ? 'Enter a weight above 0 kg with up to 3 decimals.' : (many ? 'Enter the total weight of all the heads in kg.' : 'Enter the weight in kg.');
    else {
      const calc = chickenLine({ pricePerKgCentavos: product.price_per_kg_centavos, weightG: grams, heads, prep: c.prep, fees: state.config.fees });
      total = calc.lineTotal;
      const each = many ? `<div class="row fee"><span>${heads} heads &middot; about ${formatKg(Math.round(grams / heads))} kg each</span><span></span></div>` : '';
      sumHtml = `${each}<div class="row"><span>${formatPeso(product.price_per_kg_centavos)}/kg &times; ${formatKg(grams)} kg</span><span>${formatPeso(calc.weightAmount)}</span></div>`
        + calc.fees.filter((f) => f.amount > 0).map((f) => `<div class="row fee"><span>${esc(label(f.code))}${f.basis === 'per_head' && heads > 1 ? ` (${heads} heads)` : ''}</span><span>+${formatPeso(f.amount)}</span></div>`).join('');
    }
    const prepErrors = validatePrep(c.prep);
    if (!hint && prepErrors.length) hint = prepErrors[0];
  } else {
    const { option } = found;
    const perKg = option.sold_by === 'PER_KG';
    const qty = perKg ? parseQuantityToMilli(c.value) : parseWholeQuantityToMilli(c.value);
    if (qty === null) hint = c.value ? (perKg ? 'Enter a weight above 0 kg with up to 3 decimals.' : 'Enter a whole number.') : (perKg ? 'Enter the weight in kg.' : `Enter how many ${option.unit}.`);
    else {
      total = otherLine({ unitPriceCentavos: option.price_centavos, quantityMilli: qty }).lineTotal;
      sumHtml = `<div class="row"><span>${formatPeso(option.price_centavos)}/${esc(option.unit)} &times; ${formatThousandths(qty).replace(/\.0$/, '')} ${esc(option.unit)}</span><span>${formatPeso(total)}</span></div>`;
    }
  }
  $('#sum').innerHTML = sumHtml;
  $('#itemTotal').textContent = formatPeso(total);
  $('#hint').textContent = hint;
  $('#addBtn').disabled = hint !== '';
}

// ---- Right side: the current order -----------------------------------------------------------------

const qtyText = (milli, option) => (option.sold_by === 'PER_KG' ? formatThousandths(milli) : String(milli / 1000));

function renderOrderPanel() {
  const panel = $('#orderPanel');
  if (!panel) return;
  const d = state.draft;
  const count = draftLineCount();
  const t = draftTotals();
  const chickenLines = d.items.map((item) => {
    const priced = priceItem(item);
    if (!priced) return `<div class="line"><div class="top"><span>${esc(item.name)}</span><span class="badge badge--canceled">Unavailable</span></div>
        <div class="detail">This product is no longer active or has no price. Remove it to continue.</div>
        <div class="actions"><button type="button" class="btn btn--small btn--danger" data-action="remove-line" data-kind="chicken" data-key="${item.key}">Remove</button></div></div>`;
    const chips = prepChips(item.prep).map((c) => `<span class="chip">${esc(c)}</span>`).join('')
      + priced.fees.filter((f) => f.amount > 0).map((f) => `<span class="chip chip--fee">+${formatPeso(f.amount)} ${esc(label(f.code))}${f.basis === 'per_head' && priced.heads > 1 ? ` (${priced.heads} × ${formatPeso(f.rate)})` : ''}</span>`).join('');
    return `<div class="line"><div class="top"><span>${iconFor(priced.product.name)} ${esc(priced.product.name)}</span><span>${formatPeso(priced.lineTotal)}</span></div>
        <div class="detail">${priced.heads > 1 ? `${priced.heads} heads &middot; ` : ''}${formatKg(priced.weightG)} kg &times; ${formatPeso(priced.product.price_per_kg_centavos)}/kg</div>
        <div class="chips">${chips}</div>
        <div class="actions"><button type="button" class="btn btn--small" data-action="edit-line" data-kind="chicken" data-key="${item.key}">Edit</button>
        <button type="button" class="btn btn--small btn--danger" data-action="remove-line" data-kind="chicken" data-key="${item.key}">Remove</button></div></div>`;
  });
  const otherLines = d.otherItems.map((item) => {
    const priced = priceOther(item);
    if (!priced) return `<div class="line"><div class="top"><span>${esc(item.name)}</span><span class="badge badge--canceled">Unavailable</span></div>
        <div class="detail">This item is no longer sold this way. Remove it to continue.</div>
        <div class="actions"><button type="button" class="btn btn--small btn--danger" data-action="remove-line" data-kind="other" data-key="${item.key}">Remove</button></div></div>`;
    return `<div class="line"><div class="top"><span>${iconFor(priced.product.name)} ${esc(priced.product.name)}</span><span>${formatPeso(priced.lineTotal)}</span></div>
        <div class="detail">${qtyText(priced.quantityMilli, priced.option)} ${esc(priced.option.unit)} &times; ${formatPeso(priced.option.price_centavos)}/${esc(priced.option.unit)}</div>
        <div class="actions"><button type="button" class="btn btn--small" data-action="edit-line" data-kind="other" data-key="${item.key}">Edit</button>
        <button type="button" class="btn btn--small btn--danger" data-action="remove-line" data-kind="other" data-key="${item.key}">Remove</button></div></div>`;
  });
  const unavailable = d.items.some((i) => !priceItem(i)) || d.otherItems.some((i) => !priceOther(i));
  panel.innerHTML = `
    <div class="panel-head"><h2>Current order</h2><span class="muted">${count} ${count === 1 ? 'item' : 'items'}</span></div>
    ${d.changeOf ? `<div class="change-banner">Changing ${esc(d.changeOf.number)}. Submitting will replace it with a new order.</div>` : ''}
    ${count ? `<div>${chickenLines.join('')}${otherLines.join('')}</div>` : '<div class="empty">Nothing added yet. Tap a product to start.</div>'}
    <div class="field mt-m"><label for="customer">Customer number <span class="muted">(optional)</span></label>
      <input id="customer" type="text" maxlength="40" value="${esc(d.customerNumber)}" placeholder="Walk-in" autocomplete="off"></div>
    <div class="total-plate"><span>Total</span><output id="orderTotal">${formatPeso(t.total)}</output></div>
    ${t.discount > 0 ? `<p class="plate-note">Subtotal ${formatPeso(t.subtotal)} &minus; discount ${formatPeso(t.discount)}</p>` : ''}
    <div class="btn-row mt-m">
      <button type="button" class="btn btn--primary btn--big" data-action="go-review" ${count === 0 || unavailable ? 'disabled' : ''}>Review order</button>
      <button type="button" class="btn" data-action="clear-order" ${count === 0 && !d.changeOf ? 'disabled' : ''}>Cancel current order</button>
    </div>`;
}

// ---- Review ----------------------------------------------------------------------------------------

function totalsRows() {
  const t = draftTotals();
  const d = state.draft.discount;
  const reason = DISCOUNT_REASONS[d.reason];
  const rows = t.discount > 0 ? `
    <tr class="sub-row"><td colspan="3">Subtotal</td><td class="num">${formatPeso(t.subtotal)}</td><td class="no-print"></td></tr>
    <tr class="sub-row"><td colspan="3">Discount${reason ? `: ${esc(reason)}` : ''}${d.type === 'PERCENT' ? ` (${esc(d.value)}%)` : ''}</td><td class="num">&minus;${formatPeso(t.discount)}</td><td class="no-print"></td></tr>` : '';
  return `${rows}<tr class="grand-row"><td colspan="3">Grand total</td><td class="num">${formatPeso(t.total)}</td><td class="no-print"></td></tr>`;
}

function renderReview() {
  const d = state.draft;
  const rows = d.items.map((item) => {
    const p = priceItem(item);
    const chips = prepChips(item.prep).map((c) => `<span class="chip">${esc(c)}</span>`).join('')
      + p.fees.filter((f) => f.amount > 0).map((f) => `<span class="chip chip--fee">+${formatPeso(f.amount)} ${esc(label(f.code))}${f.basis === 'per_head' && p.heads > 1 ? ` (${p.heads} × ${formatPeso(f.rate)})` : ''}</span>`).join('');
    return `<tr><td><strong>${esc(p.product.name)}</strong><div class="chips">${chips}</div></td>
      <td>${p.heads > 1 ? `${p.heads} heads &middot; ` : ''}${formatKg(p.weightG)} kg</td><td class="num">${formatPeso(p.product.price_per_kg_centavos)}/kg</td><td class="num">${formatPeso(p.lineTotal)}</td>
      <td class="no-print nowrap"><button type="button" class="btn btn--small" data-action="edit-line" data-kind="chicken" data-key="${item.key}">Edit</button>
        <button type="button" class="btn btn--small btn--danger" data-action="remove-line" data-kind="chicken" data-key="${item.key}">Remove</button></td></tr>`;
  });
  const otherRows = d.otherItems.map((item) => {
    const p = priceOther(item);
    return `<tr><td><strong>${esc(p.product.name)}</strong></td><td>${qtyText(p.quantityMilli, p.option)} ${esc(p.option.unit)}</td>
      <td class="num">${formatPeso(p.option.price_centavos)}/${esc(p.option.unit)}</td><td class="num">${formatPeso(p.lineTotal)}</td>
      <td class="no-print nowrap"><button type="button" class="btn btn--small" data-action="edit-line" data-kind="other" data-key="${item.key}">Edit</button>
        <button type="button" class="btn btn--small btn--danger" data-action="remove-line" data-kind="other" data-key="${item.key}">Remove</button></td></tr>`;
  });
  const reasonOptions = Object.entries(REASONS).map(([code, text]) => `<option value="${code}" ${d.reason.code === code ? 'selected' : ''}>${esc(text)}</option>`).join('');
  ui.root.innerHTML = `
    <div class="review">
      <div class="warning" role="alert">PLEASE DOUBLE-CHECK THE ORDER. Verify every chicken type, weight, preparation option, and price before submitting.</div>
      ${d.changeOf ? `<div class="change-banner">Changing ${esc(d.changeOf.number)}. The original stays on record and is marked Replaced.</div>` : ''}
      <div id="submitError">${ui.error ? errorBox(ui.error) : ''}</div>
      <div class="slip">
        <div class="slip-head">
          <div><div class="muted">Order Slip. Not an official receipt.</div><div class="no">Order number is assigned when you submit</div></div>
          <div class="right"><div>${esc(fmtDateTime(new Date().toISOString()))}</div><div>Customer: <strong>${esc(d.customerNumber.trim() || 'Walk-in')}</strong></div></div>
        </div>
        <table>
          <thead><tr><th>Item</th><th>Weight or quantity</th><th class="num">Price</th><th class="num">Total</th><th class="no-print"></th></tr></thead>
          <tbody id="slipRows">${rows.join('')}${otherRows.join('')}</tbody>
          <tbody id="totalsBody">${totalsRows()}</tbody>
        </table>
      </div>
      <div class="panel" id="discPanel"></div>
      <div class="panel" id="payPanel"></div>
      ${d.changeOf ? `<div class="panel stack"><h3>Why is this order being changed?</h3>
          <div class="field"><label for="reasonCode">Reason</label><select id="reasonCode"><option value="">Choose a reason</option>${reasonOptions}</select></div>
          <div class="field"><label for="reasonNote">Notes <span class="muted">(required for Other)</span></label><textarea id="reasonNote">${esc(d.reason.note)}</textarea></div></div>` : ''}
      <div class="panel stack">
        <label class="check"><input type="checkbox" id="reviewed" ${d.reviewed ? 'checked' : ''}> I have reviewed the complete order: every chicken type, weight, preparation and price.</label>
        <div class="btn-row">
          <button type="button" class="btn btn--big" data-action="review-back">Back to Edit Order</button>
          <button type="button" class="btn btn--big btn--danger" data-action="clear-order">Cancel Current Order</button>
          <button type="button" class="btn btn--primary btn--big" id="submitBtn" data-action="review-submit" disabled>Confirm and Submit Order</button>
        </div>
      </div>
    </div>`;
  renderDiscount();
  renderPayment();
  updateSubmitState();
}

function renderDiscount() {
  const d = state.draft.discount;
  const on = d.type !== 'NONE';
  const types = [['NONE', 'No discount'], ['FIXED', 'Fixed amount (₱)'], ['PERCENT', 'Percentage (%)']]
    .map(([v, t]) => `<option value="${v}" ${d.type === v ? 'selected' : ''}>${t}</option>`).join('');
  const reasons = Object.entries(DISCOUNT_REASONS).map(([v, t]) => `<option value="${v}" ${d.reason === v ? 'selected' : ''}>${esc(t)}</option>`).join('');
  $('#discPanel').innerHTML = `
    <div class="panel-head"><h3>Discount <span class="muted">(optional)</span></h3></div>
    <p class="muted">For example a senior citizen, bulk order, employee or VIP discount. It comes off the whole order, and the reason is saved on the order.</p>
    <div class="discount-fields">
      <div class="field"><label for="discType">Discount</label><select id="discType">${types}</select></div>
      ${on ? `<div class="field"><label for="discValue">${d.type === 'FIXED' ? 'Amount (₱)' : 'Percent (%)'}</label><input id="discValue" type="text" inputmode="decimal" value="${esc(d.value)}" placeholder="${d.type === 'FIXED' ? 'for example 50' : 'for example 20'}" autocomplete="off"></div>
        <div class="field"><label for="discReason">Reason</label><select id="discReason"><option value="">Choose a reason</option>${reasons}</select></div>
        <div class="field"><label for="discNote">Notes ${d.reason === 'OTHER' ? '<span class="muted">(required)</span>' : '<span class="muted">(optional)</span>'}</label><input id="discNote" type="text" maxlength="200" value="${esc(d.note)}" autocomplete="off"></div>` : ''}
    </div>
    <p class="cfg-hint" id="discWarn" role="status"></p>`;
  updateDiscountWarn();
}

function updateDiscountWarn() {
  const warn = $('#discWarn');
  if (!warn) return;
  const t = draftTotals();
  warn.textContent = state.draft.discount.type !== 'NONE' && t.discountError ? t.discountError : '';
}

/** Totals changed (discount typed): refresh the slip totals, the payment default and the submit button. */
function refreshTotals() {
  $('#totalsBody').innerHTML = totalsRows();
  updateDiscountWarn();
  const p = state.draft.payment;
  if ($('#payAmount') && !p.amountEdited) $('#payAmount').value = pesoText(draftTotals().total);
  updatePayWarn();
  updateSubmitState();
}

function renderPayment() {
  const d = state.draft;
  const p = d.payment;
  const total = draftTotals().total;
  const card = p.method !== 'NONE' && p.method !== 'CASH';
  const amount = p.amountEdited ? p.amount : pesoText(total);
  const methods = [['NONE', 'Not recorded'], ...Object.entries(PAYMENT_METHODS)]
    .map(([v, t]) => `<option value="${v}" ${p.method === v ? 'selected' : ''}>${esc(t)}</option>`).join('');
  $('#payPanel').innerHTML = `
    <div class="panel-head"><h3>Payment details <span class="muted">(required)</span></h3></div>
    <p class="muted">This only records what you type for billing. It does not charge anyone and does not replace the official receipt.</p>
    <div class="form-grid mt-s">
      <div class="field"><label for="payMethod">How did the customer pay?</label><select id="payMethod">${methods}</select></div>
      ${p.method !== 'NONE' ? `<div class="field"><label for="payAmount">Amount paid (₱)</label><input id="payAmount" type="text" inputmode="decimal" value="${esc(amount)}"></div>` : ''}
      ${card ? `
        <div class="field"><label for="payWhen">Payment date and time <span class="muted">(optional)</span></label><input id="payWhen" type="datetime-local" value="${esc(p.paidAt)}"></div>
        <div class="field"><label for="payName">Account name <span class="muted">(optional)</span></label><input id="payName" type="text" maxlength="100" value="${esc(p.accountName)}" autocomplete="off"></div>
        <div class="field"><label for="payNumber">Account or mobile number <span class="muted">(optional)</span></label><input id="payNumber" type="text" inputmode="tel" maxlength="40" value="${esc(p.accountNumber)}" autocomplete="off"></div>
        <div class="field"><label for="payRef">Reference number <span class="muted">(optional)</span></label><input id="payRef" type="text" maxlength="60" value="${esc(p.reference)}" autocomplete="off"></div>` : ''}
    </div>
    <p class="cfg-hint" id="payWarn" role="status"></p>`;
  updatePayWarn();
}

function updatePayWarn() {
  const warn = $('#payWarn');
  if (!warn) return;
  const p = state.draft.payment;
  if (p.method === 'NONE') { warn.textContent = ''; return; }
  const total = draftTotals().total;
  const paid = parsePesosToCentavos(p.amountEdited ? p.amount : pesoText(total));
  if (paid === null || paid <= 0) warn.textContent = 'Enter the amount paid, for example 208.80.';
  else if (paid !== total) warn.textContent = `The amount paid (${formatPeso(paid)}) is different from the order total (${formatPeso(total)}). Check it before submitting.`;
  else warn.textContent = '';
}

function paymentProblem() {
  const p = state.draft.payment;
  if (p.method === 'NONE') return false;
  const paid = parsePesosToCentavos(p.amountEdited ? p.amount : pesoText(draftTotals().total));
  return paid === null || paid <= 0;
}

function updateSubmitState() {
  const btn = $('#submitBtn');
  if (!btn) return;
  const d = state.draft;
  const reasonOk = !d.changeOf || (d.reason.code && (d.reason.code !== 'OTHER' || d.reason.note.trim().length >= 3));
  const discountOk = d.discount.type === 'NONE' || !draftTotals().discountError;
  btn.disabled = ui.submitting || !d.reviewed || !reasonOk || paymentProblem() || !discountOk;
  btn.innerHTML = ui.submitting ? '<span class="spinner" aria-hidden="true"></span> Saving...' : 'Confirm and Submit Order';
}

function buildPayload() {
  const d = state.draft;
  const p = d.payment;
  const t = draftTotals();
  const payload = {
    submission_key: d.submissionKey,
    customer_number: d.customerNumber.trim(),
    expected_total_centavos: t.total,
    items: d.items.map((i) => ({
      product_id: i.productId, weight: i.weight, heads: i.heads ?? '1', feather: i.prep.feather, dara: i.prep.dara, cut: i.prep.cut,
      slice_size: i.prep.sliceSize, confirm_large: i.confirmLarge === true,
    })),
    other_items: d.otherItems.map((i) => ({ other_product_id: findOption(i.optionId)?.product.id ?? i.productId, option_id: i.optionId, quantity: i.quantity })),
    discount: d.discount.type === 'NONE' ? undefined : { type: d.discount.type, value: d.discount.value, reason_code: d.discount.reason, note: d.discount.note },
    payment: p.method === 'NONE' ? null : {
      method: p.method, amount: p.amountEdited ? p.amount : pesoText(t.total),
      paid_at: p.paidAt || undefined, account_name: p.accountName, account_number: p.accountNumber, reference: p.reference,
    },
  };
  if (d.changeOf) { payload.reason_code = d.reason.code; payload.reason_note = d.reason.note; }
  return payload;
}

async function submit() {
  if (ui.submitting) return; // blocks a second tap while the first one is still saving
  ui.submitting = true;
  ui.error = null;
  updateSubmitState();
  const d = state.draft;
  try {
    const path = d.changeOf ? `/api/orders/${d.changeOf.id}/change` : '/api/orders';
    const result = await api('POST', path, buildPayload());
    ui.done = result.order;
    ui.step = 'done';
    ui.submitting = false;
    clearDraft();
    render();
  } catch (err) {
    ui.submitting = false;
    ui.error = err;
    if (err.code === 'PRICE_CHANGED') {
      await refreshConfig(api).catch(() => {});
      d.reviewed = false;
      saveDraft();
    }
    renderReview();
    window.scrollTo({ top: 0 });
  }
}

// ---- Done ------------------------------------------------------------------------------------------

function renderDone() {
  const o = ui.done;
  ui.root.innerHTML = `
    <div class="done">
      <p class="muted no-print" role="status">Order saved. Thank you.</p>
      <div class="order-no-big">${esc(o.order_number)}</div>
      <p class="no-print mt-s"><strong>Write this order number on the bag or give it to the customer.</strong></p>
      <div class="slip">
        <div class="slip-head"><div><div class="muted">Order Slip. Not an official receipt.</div><div class="no">${esc(o.order_number)}</div></div>
          <div class="right"><div>${esc(fmtDateTime(o.submitted_at))}</div><div>Customer: <strong>${esc(o.customer_number === 'WALK-IN' ? 'Walk-in' : o.customer_number)}</strong></div></div></div>
        ${orderTable(o)}
        ${o.replaces_number ? `<p class="muted">Replaces ${esc(o.replaces_number)}.</p>` : ''}
      </div>
      <div class="btn-row no-print mt-l center-row">
        <button type="button" class="btn btn--big" data-action="print">Print slip</button>
        <button type="button" class="btn btn--primary btn--big" data-action="new-order">New order</button>
      </div>
    </div>`;
  $('[data-action="new-order"]').focus();
}

// ---- Events ----------------------------------------------------------------------------------------

function startChicken(productId, existing) {
  ui.cfg = existing
    ? { kind: 'chicken', productId, editKey: existing.key, value: existing.weight, heads: existing.heads ?? '1', prep: { ...existing.prep }, returnTo: ui.step === 'review' ? 'review' : 'pick' }
    : { kind: 'chicken', productId, editKey: null, value: '', heads: '1', prep: emptyPrep(), returnTo: 'pick' };
  ui.step = 'configure';
  render();
}

function startOther(productId, existing) {
  const product = state.config.other_products.find((p) => p.id === productId);
  ui.cfg = {
    kind: 'other', productId, optionId: existing?.optionId ?? product.options[0].id, editKey: existing?.key ?? null,
    value: existing?.quantity ?? '', returnTo: existing && ui.step === 'review' ? 'review' : 'pick',
  };
  ui.step = 'configure';
  render();
}

function finishCfg(message) {
  ui.step = ui.cfg.returnTo === 'review' ? 'review' : 'pick';
  ui.cfg = null;
  ui.search = ''; // start the next search fresh
  state.draft.reviewed = false;
  saveDraft();
  render();
  if (message) toast(message, 'ok');
}

async function addFromCfg() {
  const c = ui.cfg;
  const d = state.draft;
  if (c.kind === 'chicken') {
    const grams = parseWeightToGrams(c.value);
    const heads = parseHeads(c.heads);
    if (grams === null || heads === null || validatePrep(c.prep).length) return;
    let confirmLarge = false;
    if (grams > state.config.large_weight_kg * 1000) {
      const ok = await confirmDialog(`${formatKg(grams)} kg is more than ${state.config.large_weight_kg} kg. Is this weight correct?`, { confirmLabel: 'Yes, the weight is correct', title: 'Check the weight' });
      if (!ok) return;
      confirmLarge = true;
    }
    const product = findProduct(c.productId);
    const item = { key: c.editKey ?? uuid(), productId: c.productId, name: product.name, weight: c.value, heads: String(heads), prep: { ...c.prep }, confirmLarge };
    const at = d.items.findIndex((i) => i.key === c.editKey);
    if (at >= 0) d.items[at] = item; else d.items.push(item);
    return finishCfg(`${product.name} ${at >= 0 ? 'updated' : 'added'}`);
  }
  const { product, option } = findOption(c.optionId);
  const qty = option.sold_by === 'PER_KG' ? parseQuantityToMilli(c.value) : parseWholeQuantityToMilli(c.value);
  if (qty === null) return;
  const item = { key: c.editKey ?? uuid(), productId: product.id, optionId: option.id, name: product.name, unit: option.unit, quantity: c.value };
  const at = d.otherItems.findIndex((i) => i.key === c.editKey);
  if (at >= 0) d.otherItems[at] = item; else d.otherItems.push(item);
  return finishCfg(`${product.name} (${option.unit}) ${at >= 0 ? 'updated' : 'added'}`);
}

async function onClick(e) {
  const keyBtn = e.target.closest('[data-key]:not([data-action])');
  if (keyBtn && ui.cfg) {
    const k = keyBtn.dataset.key;
    let v = ui.cfg.value;
    if (k === 'back') v = v.slice(0, -1);
    else if (k === 'clear') v = '';
    else v = cleanDecimal(v + k, decimalsFor(ui.cfg));
    ui.cfg.value = v;
    $('#amount').value = v;
    return updateCfg();
  }
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const d = state.draft;
  const { action, id, v, key, kind } = btn.dataset;
  switch (action) {
    case 'tab': ui.tab = btn.dataset.tab; return renderWork();
    case 'pick-product': return startChicken(Number(id));
    case 'pick-other': return startOther(Number(id));
    case 'pick-option': {
      ui.cfg.optionId = Number(id);
      ui.cfg.value = cleanDecimal(ui.cfg.value, decimalsFor(ui.cfg)); // switching to a fixed-price option drops any decimals
      return renderWork();
    }
    case 'cfg-back': ui.step = ui.cfg?.returnTo === 'review' ? 'review' : 'pick'; ui.cfg = null; return render();
    case 'cfg-add': return addFromCfg();
    case 'heads-inc':
    case 'heads-dec': {
      const n = parseHeads(ui.cfg.heads) ?? 1;
      ui.cfg.heads = String(Math.min(MAX_HEADS, Math.max(1, n + (action === 'heads-inc' ? 1 : -1))));
      $('#heads').value = ui.cfg.heads;
      return updateCfg();
    }
    case 'prep-feather': ui.cfg.prep = applyPrepChange(ui.cfg.prep, { feather: v }); break;
    case 'prep-dara': ui.cfg.prep = applyPrepChange(ui.cfg.prep, { dara: !ui.cfg.prep.dara }); break;
    case 'prep-cut': ui.cfg.prep = applyPrepChange(ui.cfg.prep, { cut: v }); break;
    case 'edit-line': {
      if (kind === 'chicken') { const item = d.items.find((i) => i.key === key); return startChicken(item.productId, item); }
      const item = d.otherItems.find((i) => i.key === key);
      return startOther(findOption(item.optionId)?.product.id ?? item.productId, item);
    }
    case 'remove-line': {
      if (kind === 'chicken') d.items = d.items.filter((i) => i.key !== key); else d.otherItems = d.otherItems.filter((i) => i.key !== key);
      d.reviewed = false; saveDraft();
      if (ui.step === 'review' && draftLineCount() === 0) ui.step = 'pick';
      return render();
    }
    case 'clear-order': {
      const ok = await confirmDialog(d.changeOf ? 'Stop changing this order? The original order stays as it was.' : 'Remove every item and start over?', { confirmLabel: 'Yes, cancel this order', cancelLabel: 'Keep it', danger: true, title: 'Cancel current order' });
      if (!ok) return;
      clearDraft(); ui.step = 'pick'; ui.error = null; return render();
    }
    case 'go-review': if (draftLineCount()) { ui.step = 'review'; ui.error = null; render(); window.scrollTo({ top: 0 }); } return;
    case 'review-back': ui.step = 'pick'; ui.error = null; return render();
    case 'review-submit': return submit();
    case 'new-order': ui.step = 'pick'; ui.done = null; ui.error = null; return render();
    case 'print': return window.print();
    default: return;
  }
  // The three prep cases above fall through to here: redraw only the choices and the price.
  renderPrep();
  updateCfg();
}

function onInput(e) {
  const t = e.target;
  const d = state.draft;
  if (t.id === 'heads' && ui.cfg) {
    const v = t.value.replace(/\D/g, '').slice(0, 3);
    if (v !== t.value) t.value = v;
    ui.cfg.heads = v;
    return updateCfg();
  }
  if (t.id === 'amount' && ui.cfg) {
    const v = cleanDecimal(t.value, decimalsFor(ui.cfg));
    if (v !== t.value) t.value = v;
    ui.cfg.value = v;
    return updateCfg();
  }
  if (t.id === 'otherSearch') { ui.search = t.value; return renderGrid(); }
  if (t.id === 'customer') { d.customerNumber = t.value; saveDraft(); return; }
  if (t.id === 'reasonNote') { d.reason.note = t.value; saveDraft(); return updateSubmitState(); }
  if (t.id === 'discValue') { d.discount.value = cleanDecimal(t.value, 2); if (d.discount.value !== t.value) t.value = d.discount.value; saveDraft(); return refreshTotals(); }
  if (t.id === 'discNote') { d.discount.note = t.value; saveDraft(); return refreshTotals(); }
  const pay = d.payment;
  if (t.id === 'payAmount') { pay.amount = cleanDecimal(t.value, 2); if (pay.amount !== t.value) t.value = pay.amount; pay.amountEdited = true; }
  else if (t.id === 'payWhen') pay.paidAt = t.value;
  else if (t.id === 'payName') pay.accountName = t.value;
  else if (t.id === 'payNumber') pay.accountNumber = t.value;
  else if (t.id === 'payRef') pay.reference = t.value;
  else return;
  saveDraft();
  updatePayWarn();
  updateSubmitState();
}

function onChange(e) {
  const t = e.target;
  const d = state.draft;
  if (t.id === 'reviewed') { d.reviewed = t.checked; saveDraft(); return updateSubmitState(); }
  if (t.id === 'reasonCode') { d.reason.code = t.value; saveDraft(); return updateSubmitState(); }
  if (t.id === 'discType') {
    d.discount.type = t.value;
    if (t.value === 'NONE') d.discount = { type: 'NONE', value: '', reason: '', note: '' };
    saveDraft(); renderDiscount(); return refreshTotals();
  }
  if (t.id === 'discReason') { d.discount.reason = t.value; saveDraft(); renderDiscount(); return refreshTotals(); }
  if (t.id === 'payMethod') {
    d.payment.method = t.value;
    if (t.value === 'NONE') d.payment.amountEdited = false;
    saveDraft();
    renderPayment();
    updateSubmitState();
  }
}

function onKeyDown(e) {
  if (e.key === 'Enter' && e.target.id === 'amount' && !$('#addBtn').disabled) { e.preventDefault(); addFromCfg(); }
}
