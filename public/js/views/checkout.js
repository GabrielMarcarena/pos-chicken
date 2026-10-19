// The cashier screen: pick a product, enter the weight, choose the service, add to the order, review, submit.
// Revision 12: the Advanced button (left of Chicken and Other products) opens the ref stock of Katay and Dead chicken, the cash breakdown
// and the expenses (see advanced.js). A Katay or Dead chicken from the ref is sold here by the kilo, at a price the cashier types.
import { api } from '../api.js';
import { setScreenKeys, keyBadge, typingIn, hasKeyboard, PRODUCT_KEYS } from '../keys.js';
import { state, saveDraft, clearDraft, onDraftSaved, findProduct, findOption, priceItem, priceOther, priceRef, draftTotals, draftLineCount, refreshConfig, hasStock, savedHeads, savedMilli, availableHeads, availableMilli, stockOptionOf, savedRefHeads, availableRefHeads, refProducts } from '../state.js';
import { $, esc, label, howItWorks, formatPeso, formatKg, formatThousandths, uuid, toast, errorBox, confirmDialog, prepChips, fmtDateTime, iconFor, productPicture, watchImages } from '../util.js';
import { emptyPrep, applyPrepChange, validatePrep, serviceOf, needsSliceSize } from '/shared/rules.js';
import { parseWeightToGrams, parseQuantityToMilli, parseWholeQuantityToMilli, parsePesosToCentavos, parseHeads, MAX_HEADS } from '/shared/money.js';
import { chickenLine, otherLine, refLine } from '/shared/pricing.js';
import { REASONS, PAYMENT_METHODS, DISCOUNT_REASONS, SERVICE_NOTES, SERVICE_LABELS, SERVICES, REF_LABELS } from '/shared/constants.js';
import { cashCheck, typedMoneyText, parseMoneyInput, pesoPlain } from '/shared/cash.js';
import { describeQty, insufficientStockMessage } from '/shared/inventory.js';
import { orderTable, slipPayment } from './slip.js';
import { renderAdvanced, advancedClick, advancedInput, advancedKeyDown } from './advanced.js';
import { startCustomerLink, publishToCustomer, openCustomerWindow } from '../customerLink.js';

const REF_ICON = { KATAY: '🔪', DEAD: '🧊' };

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
  setScreenKeys(checkoutKeys);   // Revision 13: the keyboard shortcuts of this screen (keys.js)
  watchImages(root);   // a product photo that cannot be loaded is replaced by its icon
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
    work.innerHTML = ui.cfg.kind === 'chicken' ? cfgChickenHtml() : ui.cfg.kind === 'ref' ? cfgRefHtml() : cfgOtherHtml();
    if (ui.cfg.kind === 'chicken') renderPrep();
    updateCfg();
    // On a touch screen, do not pop up the keyboard over the number pad.
    if (window.matchMedia('(pointer: fine)').matches) $('#amount')?.focus();
    return;
  }
  // Revision 12: Advanced sits in the same row, on the left, set apart from the two product tabs.
  const tabs = `<div class="tabs tabs--adv" role="tablist" aria-label="What is the customer buying?">
      <button type="button" class="tab tab--adv" role="tab" aria-selected="${ui.tab === 'advanced'}" data-action="tab" data-tab="advanced">⚙ Advanced</button>
      <span class="tab-sep" aria-hidden="true"></span>
      <button type="button" class="tab" role="tab" aria-selected="${ui.tab === 'chicken'}" data-action="tab" data-tab="chicken">🐔 Chicken</button>
      <button type="button" class="tab" role="tab" aria-selected="${ui.tab === 'other'}" data-action="tab" data-tab="other">🥚 Other products</button>
    </div>`;
  if (ui.tab === 'advanced') {
    work.innerHTML = `<div class="section-title"><h2>Advanced</h2></div>${tabs}<div id="advArea"></div>`;
    renderAdvanced($('#advArea'), { startRef: (kind, mode) => startRef(kind, mode) });
    return;
  }
  work.innerHTML = `<div class="section-title"><h2>${ui.tab === 'chicken' ? 'Choose the chicken' : 'Eggs, etag, condiments and more'}</h2>
      ${ui.tab === 'other' ? `<div class="field search"><label class="sr" for="otherSearch">Search products</label><input id="otherSearch" type="text" placeholder="Search products" value="${esc(ui.search)}" autocomplete="off"></div>` : ''}</div>
    ${tabs}<div id="grid"></div>`;
  renderGrid();
}

function renderGrid() {
  const grid = $('#grid');
  if (!grid || ui.tab === 'advanced') return;
  const { products, other_products: others } = state.config;
  if (ui.tab === 'chicken') {
    const totalHeads = products.reduce((n, p) => n + savedHeads(p.id), 0);
    grid.innerHTML = products.length
      ? `${staleNote()}${hasStock() ? `<p class="stock-total" id="stockTotal" data-stock="chicken-total">Number of Heads: <strong>${totalHeads}</strong></p>` : ''}
        <div class="product-grid">${products.map((p, i) => `
          <button type="button" class="product-card" data-action="pick-product" data-id="${p.id}">${PRODUCT_KEYS[i] ? keyBadge(PRODUCT_KEYS[i]) : ''}
            <span class="ico" aria-hidden="true">${productPicture('chicken', p)}</span>
            <span class="meta"><span class="name">${esc(p.name)}</span><span class="price">${formatPeso(p.price_per_kg_centavos)}/kg</span>
              ${hasStock() ? `<span class="stock${savedHeads(p.id) === 0 ? ' stock--out' : ''}" data-stock="chicken-${p.id}">Number of Heads: ${savedHeads(p.id)}</span>` : ''}</span>
          </button>`).join('')}</div>`
      : `<div class="empty"><p><strong>No chicken products are active.</strong></p><p>Ask a manager or the admin to add a product and set its price in Products.</p></div>`;
    return;
  }
  const q = ui.search.trim().toLowerCase();
  const shown = others.filter((p) => !q || p.name.toLowerCase().includes(q));
  grid.innerHTML = shown.length
    ? `${staleNote()}<div class="product-grid">${shown.map((p, i) => `
        <button type="button" class="product-card" data-action="pick-other" data-id="${p.id}">${PRODUCT_KEYS[i] ? keyBadge(PRODUCT_KEYS[i]) : ''}
          <span class="ico" aria-hidden="true">${productPicture('other', p)}</span>
          <span class="meta"><span class="name">${esc(p.name)}</span>
            <span class="opts">${p.options.map((o) => `<span class="price">${formatPeso(o.price_centavos)}/${esc(o.unit)}</span>`).join('')}</span>
            ${hasStock() ? `<span class="opts">${stockRows(p).map((s) => `<span class="stock${savedMilli(s.id) === 0 ? ' stock--out' : ''}" data-stock="other-${s.id}">${esc(describeQty('OTHER', s.unit, savedMilli(s.id)))}</span>`).join('')}</span>` : ''}</span>
        </button>`).join('')}</div>`
    : `<div class="empty"><p><strong>${others.length ? 'No product matches your search.' : 'No other products are ready to sell yet.'}</strong></p>
        ${others.length ? '' : '<p>The admin sets the price of each product in Products, Other products. Products without a price are not shown here.</p>'}</div>`;
}

/**
 * The stock rows a product's card shows, once each: a by-the-kilo option has no row of its own (its pieces come off the piece row),
 * so "Catfish" shows its pieces once, not once for piece and again for kg.
 */
function stockRows(p) {
  const rows = new Map();
  for (const o of p.options) {
    const id = stockOptionOf(o.id);
    if (!rows.has(id)) rows.set(id, { id, unit: id === o.id ? o.unit : 'piece' });
  }
  return [...rows.values()];
}

/** Shown above the products when the open business day is older than today: stock is still counted on that day. */
function staleNote() {
  const stock = state.config?.stock;
  if (!stock?.stale) return '';
  return `<div class="note-box stale-note" role="status" data-stale-day>Stock is being counted on the business day of <strong>${esc(stock.business_date)}</strong>, which is from an earlier date. It is saved and closed automatically within a minute; reload the page to sell on today's business day.</div>`;
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
        ${hasStock() ? '<p class="stock-line" id="stockLine" data-stock="selected" role="status"></p>' : ''}
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
  const options = product.options.map((o, i) => `<button type="button" class="choice" role="radio" aria-checked="${o.id === chosen.id}" data-action="pick-option" data-id="${o.id}">
      ${i < 9 ? keyBadge(`Alt+${i + 1}`) : ''}<span>${o.sold_by === 'PER_KG' ? 'Per kg' : `Per ${esc(o.unit)}`}<small>${formatPeso(o.price_centavos)}</small></span></button>`).join('');
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
        ${hasStock() ? '<p class="stock-line" id="stockLine" data-stock="selected" role="status"></p>' : ''}
        ${chosen.sold_by === 'PER_KG' ? `<div class="field heads-field"><label for="pieces">Number of pieces</label>
          <div class="stepper">
            <button type="button" class="btn" data-action="pieces-dec" aria-label="One less piece">&minus;</button>
            <input id="pieces" type="text" inputmode="numeric" autocomplete="off" value="${esc(ui.cfg.pieces)}" aria-label="Number of pieces">
            <button type="button" class="btn" data-action="pieces-inc" aria-label="One more piece">+</button>
          </div>
          <span class="hint">How many pieces are weighed together (for example 3 ducks). The price is by the kilo; the stock goes down by the number of pieces.</span></div>` : ''}
        <div class="field weight-input"><label for="amount" id="weightLabel">${esc(chosen.sold_by === 'PER_KG' && Number(ui.cfg.pieces) > 1 ? 'Total weight of all the pieces, in kg' : word)}</label>
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

/**
 * Revision 12: a Katay or Dead chicken from the ref. mode 'sell' adds it to the order (heads, kilos and a price per kg the cashier types;
 * no service fee). mode 'store' puts it in the ref (heads, kilos and which chicken it is) and adds it to that chicken's Katay or Dead on
 * the Daily Inventory.
 */
function cfgRefHtml() {
  const c = ui.cfg;
  const store = c.mode === 'store';
  const name = REF_LABELS[c.refKind];
  const products = state.config.products.map((p) => `<option value="${p.id}" ${p.id === c.productId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return `
    <div class="cfg-head">
      <button type="button" class="btn" data-action="cfg-back">Back to Advanced</button>
      <h2><span aria-hidden="true">${REF_ICON[c.refKind]}</span> ${esc(name)} <span class="chip ${store ? 'chip--ref' : 'chip--fee'}">${store ? 'Store in the ref' : 'Sell by the kilo'}</span></h2>
    </div>
    <div class="cfg-grid">
      <div>
        <div class="scale">
          <div class="tag" id="scaleTag">${store ? 'Weight going into the ref' : 'Weight'}</div>
          <div class="reading" id="reading"></div>
          <div class="sum" id="sum"></div>
          ${store ? '' : `<div class="grand"><span>Item total</span><output id="itemTotal" for="amount">${formatPeso(0)}</output></div>`}
        </div>
        <p class="stock-line" id="stockLine" data-stock="ref" role="status"></p>
        <div class="field heads-field"><label for="heads">Number of heads</label>
          <div class="stepper">
            <button type="button" class="btn" data-action="heads-dec" aria-label="One less head">&minus;</button>
            <input id="heads" type="text" inputmode="numeric" autocomplete="off" value="${esc(c.heads)}" aria-label="Number of heads">
            <button type="button" class="btn" data-action="heads-inc" aria-label="One more head">+</button>
          </div>
          <span class="hint">How many ${esc(name)} are weighed together.</span></div>
        <div class="field weight-input"><label for="amount" id="weightLabel">Weight in kg</label>
          <input id="amount" type="text" inputmode="decimal" autocomplete="off" value="${esc(c.value)}" placeholder="for example 1.8"></div>
        ${keypadHtml(true)}
      </div>
      <div>
        ${store ? `
          <div class="field"><label for="refProduct">Which chicken is it? <span class="req">required</span></label>
            <select id="refProduct"><option value="">Choose the chicken...</option>${products}</select>
            <span class="hint">The heads are added to this chicken's <strong>${c.refKind === 'KATAY' ? 'Katay' : 'Dead'}</strong> on today's Daily Inventory.</span></div>
          <div class="field"><label for="refNote">Note <span class="muted">(optional)</span></label>
            <input id="refNote" type="text" maxlength="200" autocomplete="off" value="${esc(c.note)}" placeholder="for example bottom shelf"></div>`
    : `
          ${refChooserHtml()}
          <div class="field"><label for="refPrice">Price per kg (₱) <span class="req">required</span></label>
            <input id="refPrice" type="text" inputmode="decimal" autocomplete="off" value="${esc(c.price)}" placeholder="for example 90"></div>
          <p class="muted">No service fee is added to Katay or Dead chicken. If the customer gets a discount, add it on the review screen.</p>`}
        <p class="cfg-hint" id="hint" role="status"></p>
        <div class="cfg-actions">
          <button type="button" class="btn btn--primary btn--big" id="addBtn" data-action="cfg-add" disabled>${store ? 'Store in the ref' : c.editKey ? 'Update item' : 'Add to order'}</button>
          <button type="button" class="btn btn--big" data-action="cfg-back">Cancel</button>
        </div>
      </div>
    </div>`;
}

/**
 * Revision 13: which chicken the Katay or Dead being sold came from (B-Cull, Cull, Broiler ...). One button per chicken that has heads
 * in the ref, with how many. The line being edited keeps its chicken even when the ref has none left of it.
 */
function refChooserHtml() {
  const c = ui.cfg;
  const list = refProducts(c.refKind);
  if (c.productId && !list.some((p) => p.id === c.productId)) list.push({ id: c.productId, name: findProduct(c.productId)?.name ?? c.productName ?? `Chicken #${c.productId}`, heads: 0 });
  const kind = c.refKind === 'KATAY' ? 'Katay' : 'Dead';
  if (!list.length) return `<p class="note-box" data-ref-empty>There is no ${kind} chicken in the ref. Store one first (Advanced &gt; ${esc(REF_LABELS[c.refKind])} &gt; Store in the ref).</p>`;
  const buttons = list.map((p, i) => `<button type="button" class="choice" role="radio" aria-checked="${p.id === c.productId}" data-action="ref-product" data-id="${p.id}">
      ${i < 9 ? keyBadge(`Alt+${i + 1}`) : ''}${esc(p.name)} <span class="muted">${p.heads} in the ref</span></button>`).join('');
  return `<div class="field"><span class="label" id="refFromLbl">Which chicken is it? <span class="req">required</span></span>
      <div class="choices" role="radiogroup" aria-labelledby="refFromLbl" data-ref-from>${buttons}</div></div>`;
}

/** The readout, hint and button of the ref screen (Revision 12). */
function updateRefCfg() {
  const c = ui.cfg;
  const store = c.mode === 'store';
  const name = REF_LABELS[c.refKind];
  const grams = parseWeightToGrams(c.value);
  const heads = parseHeads(c.heads);
  const many = heads !== null && heads > 1;
  $('#weightLabel').textContent = many ? 'Total weight of all the heads, in kg' : 'Weight in kg';
  let hint = '';
  if (heads === null) hint = `Enter the number of heads (1 to ${MAX_HEADS}).`;
  else if (grams === null) hint = c.value ? 'Enter a weight above 0 kg with up to 3 decimals.' : (many ? 'Enter the total weight of all the heads in kg.' : 'Enter the weight in kg.');
  const each = many && grams !== null ? `<div class="row fee"><span>${heads} heads &middot; about ${formatKg(Math.round(grams / heads))} kg each</span><span></span></div>` : '';
  let sum = '';
  if (store) {
    const inRef = savedRefHeads(c.refKind);
    $('#stockLine').innerHTML = `In the ref now: <strong>${inRef}</strong> ${inRef === 1 ? 'head' : 'heads'} of ${esc(name)}. Storing adds to it.`;
    if (!hint && !c.productId) hint = 'Choose which chicken it is.';
    if (heads !== null && grams !== null) sum = `${each}<div class="row"><span>${heads} ${heads === 1 ? 'head' : 'heads'} &middot; ${formatKg(grams)} kg into the ref</span><span></span></div>`;
  } else {
    const price = parsePesosToCentavos(c.price);
    const from = c.productId ? findProduct(c.productId)?.name ?? c.productName ?? '' : '';
    const avail = c.productId ? availableRefHeads(c.refKind, c.productId, c.editKey) : savedRefHeads(c.refKind);
    $('#stockLine').innerHTML = c.productId
      ? `In the ref: <strong>${avail}</strong> ${avail === 1 ? 'head' : 'heads'} of ${esc(name)} (${esc(from)}) available`
      : `In the ref: <strong>${avail}</strong> ${avail === 1 ? 'head' : 'heads'} of ${esc(name)}. Choose which chicken it is.`;
    if (!hint && !c.productId) hint = 'Choose which chicken it is (B-Cull, Cull, Broiler ...).';
    if (!hint && (price === null || price <= 0)) hint = c.price ? 'Enter a price per kg above ₱0.00 (for example 90 or 92.50).' : 'Enter the price per kg.';
    if (!hint && heads > avail) hint = `Insufficient stock. Only ${avail} ${avail === 1 ? 'head' : 'heads'} of ${name} (${from}) ${avail === 1 ? 'is' : 'are'} in the ref.`;
    let total = 0;
    if (grams !== null && price !== null && price > 0) {
      total = refLine({ pricePerKgCentavos: price, weightG: grams }).lineTotal;
      sum = `${each}<div class="row"><span>${formatPeso(price)}/kg &times; ${formatKg(grams)} kg</span><span>${formatPeso(total)}</span></div><div class="row fee"><span>No service fee</span><span></span></div>`;
    }
    $('#itemTotal').textContent = formatPeso(total);
  }
  $('#sum').innerHTML = sum;
  $('#hint').textContent = hint;
  $('#addBtn').disabled = hint !== '' || ui.busy === true;
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

/** What a service adds to the price: Pour and Dress (also when sliced or Dukot) carry their own fee, per head. Live, With Blood and Dukot add nothing. */
function serviceFeeText(service) {
  if (service === 'LIVE') return '';
  return feeText(service.startsWith('POUR') ? 'POUR' : 'NOT_POUR');
}

function renderPrep() {
  const prep = ui.cfg.prep;
  const live = prep.feather === 'LIVE';
  const current = serviceOf(prep);
  const slicing = needsSliceSize(current);
  const service = (v, i) => {
    const fee = serviceFeeText(v);
    return `<button type="button" class="choice service ${!fee ? 'free' : ''}" role="radio" aria-checked="${current === v}" data-action="prep-service" data-v="${v}">
      ${i < 9 ? keyBadge(`Alt+${i + 1}`) : ''}<span class="svc-text"><span class="svc-name">${esc(SERVICE_LABELS[v])}</span><small>${esc(SERVICE_NOTES[v])}</small></span><span class="svc-fee">${fee || 'No fee'}</span></button>`;
  };
  // The slice size is only asked for by the two Slice services; every other service has nothing to choose here.
  const cutChoice = (v, checked) => `<button type="button" class="choice" role="radio" aria-checked="${checked}" data-action="prep-cut" data-v="${v}" ${slicing ? '' : 'disabled'}><span>${esc(label(v))}</span></button>`;
  const cutNote = live ? 'Live chickens get no cutting.'
    : slicing ? 'Choose small, medium or large pieces.'
      : current ? 'This service needs no slice size. Choose Po-ur & Slice or Dress & Slice above to pick one.' : 'Choose a service first.';

  $('#prep').innerHTML = `
    <fieldset class="group" role="radiogroup" aria-label="Service">
      <legend>Service<span class="req">required</span></legend>
      <div class="service-grid">${SERVICES.map(service).join('')}</div>
      ${live ? '<p class="live-note">Live chickens get no other preparation, so With Blood and cutting are off.</p>' : ''}
    </fieldset>
    <fieldset class="group"><legend>With Blood</legend>
      <div class="choices"><button type="button" class="choice" role="switch" aria-checked="${prep.dara}" data-action="prep-dara" ${live ? 'disabled' : ''}><span>With Blood</span></button></div>
    </fieldset>
    <fieldset class="group" role="radiogroup" aria-label="Slice size" id="cutting">
      <legend>Slice size${slicing ? '<span class="req">required</span>' : ''}</legend>
      <div class="choices cut-grid">
        ${cutChoice('SMALL', prep.sliceSize === 'SMALL')}
        ${cutChoice('MEDIUM', prep.sliceSize === 'MEDIUM')}
        ${cutChoice('LARGE', prep.sliceSize === 'LARGE')}
      </div>
      <p class="live-note">${esc(cutNote)}</p>
    </fieldset>`;
}

/** Refresh the readout, the price, the hint and the Add button without redrawing the whole screen. */
function updateCfg() {
  const c = ui.cfg;
  if (!c) return;
  const reading = $('#reading');
  const isChicken = c.kind === 'chicken';
  const found = isChicken || c.kind === 'ref' ? null : findOption(c.optionId);
  const unit = found ? found.option.unit : 'kg';
  reading.innerHTML = c.value ? `${esc(c.value)}<span class="unit">${esc(unit)}</span>` : `0<span class="unit">${esc(unit)}</span>`;
  reading.classList.toggle('idle', !c.value);

  if (c.kind === 'ref') return updateRefCfg();
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
    if (hasStock()) {
      const avail = availableHeads(c.productId, c.editKey);
      const line = $('#stockLine');
      if (line) line.innerHTML = `Number of Heads: <strong>${avail}</strong> available for ${esc(product.name)}${savedHeads(c.productId) !== avail ? ` <span class="muted">(${savedHeads(c.productId)} in stock, the rest is in this order already)</span>` : ''}`;
      if (!hint && heads !== null && heads > avail) hint = insufficientStockMessage('CHICKEN', product.name, 'heads', avail * 1000);
    }
  } else {
    const { option } = found;
    const perKg = option.sold_by === 'PER_KG';
    const qty = perKg ? parseQuantityToMilli(c.value) : parseWholeQuantityToMilli(c.value);
    // Revision 11: by the kilo, the stock is counted in pieces, so the pieces are asked for too (1 to 999)
    const pieces = perKg ? parseHeads(c.pieces) : null;
    if (perKg && $('#weightLabel')) $('#weightLabel').textContent = pieces > 1 ? 'Total weight of all the pieces, in kg' : 'Weight in kg';
    if (perKg && pieces === null) hint = `Enter the number of pieces (1 to ${MAX_HEADS}).`;
    else if (qty === null) hint = c.value ? (perKg ? 'Enter a weight above 0 kg with up to 3 decimals.' : 'Enter a whole number.') : (perKg ? (pieces > 1 ? 'Enter the total weight of all the pieces in kg.' : 'Enter the weight in kg.') : `Enter how many ${option.unit}.`);
    else {
      total = otherLine({ unitPriceCentavos: option.price_centavos, quantityMilli: qty }).lineTotal;
      const each = perKg && pieces > 1 ? `<div class="row fee"><span>${pieces} pieces &middot; about ${formatKg(Math.round(qty / pieces))} kg each</span><span></span></div>` : '';
      sumHtml = `${each}<div class="row"><span>${formatPeso(option.price_centavos)}/${esc(option.unit)} &times; ${formatThousandths(qty).replace(/\.0$/, '')} ${esc(option.unit)}</span><span>${formatPeso(total)}</span></div>`;
    }
    if (hasStock()) {
      const avail = availableMilli(c.optionId, c.editKey);
      const stockUnit = stockOptionOf(c.optionId) === c.optionId ? option.unit : 'piece';
      const line = $('#stockLine');
      if (line) line.innerHTML = `Available: <strong>${esc(describeQty('OTHER', stockUnit, avail))}</strong> of ${esc(found.product.name)}`;
      const wanted = perKg ? (pieces ?? 0) * 1000 : qty;
      if (!hint && wanted !== null && wanted > avail) hint = insufficientStockMessage('OTHER', found.product.name, stockUnit, avail);
    }
  }
  $('#sum').innerHTML = sumHtml;
  $('#itemTotal').textContent = formatPeso(total);
  $('#hint').textContent = hint;
  $('#addBtn').disabled = hint !== '';
}

// ---- Right side: the current order -----------------------------------------------------------------

const qtyText = (milli, option) => (option.sold_by === 'PER_KG' ? formatThousandths(milli) : String(milli / 1000));
/** "2 pcs · " in front of a by-the-kilo line's weight, so the cashier sees the pieces that come off the stock. */
const piecesText = (priced) => (priced.pieces ? `${priced.pieces} pc${priced.pieces === 1 ? '' : 's'} &middot; ` : '');

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
        <div class="detail">${piecesText(priced)}${qtyText(priced.quantityMilli, priced.option)} ${esc(priced.option.unit)} &times; ${formatPeso(priced.option.price_centavos)}/${esc(priced.option.unit)}</div>
        <div class="actions"><button type="button" class="btn btn--small" data-action="edit-line" data-kind="other" data-key="${item.key}">Edit</button>
        <button type="button" class="btn btn--small btn--danger" data-action="remove-line" data-kind="other" data-key="${item.key}">Remove</button></div></div>`;
  });
  // Revision 12: Katay / Dead chicken from the ref, priced at the typed price per kg, no service fee.
  const refLines = (d.refItems ?? []).map((item) => {
    const priced = priceRef(item);
    if (!priced) return `<div class="line"><div class="top"><span>${esc(item.name ?? REF_LABELS[item.kind])}</span><span class="badge badge--canceled">Unavailable</span></div>
        <div class="detail">This line is not complete. Remove it to continue.</div>
        <div class="actions"><button type="button" class="btn btn--small btn--danger" data-action="remove-line" data-kind="ref" data-key="${item.key}">Remove</button></div></div>`;
    return `<div class="line"><div class="top"><span>${REF_ICON[priced.kind]} ${esc(priced.name)}</span><span>${formatPeso(priced.lineTotal)}</span></div>
        <div class="detail">${priced.heads > 1 ? `${priced.heads} heads &middot; ` : ''}${formatKg(priced.weightG)} kg &times; ${formatPeso(priced.price)}/kg</div>
        <div class="chips"><span class="chip chip--ref">From the ref</span><span class="chip">No service fee</span></div>
        <div class="actions"><button type="button" class="btn btn--small" data-action="edit-line" data-kind="ref" data-key="${item.key}">Edit</button>
        <button type="button" class="btn btn--small btn--danger" data-action="remove-line" data-kind="ref" data-key="${item.key}">Remove</button></div></div>`;
  });
  const unavailable = d.items.some((i) => !priceItem(i)) || d.otherItems.some((i) => !priceOther(i)) || (d.refItems ?? []).some((i) => !priceRef(i));
  panel.innerHTML = `
    <div class="panel-head"><h2>Current order</h2><span class="muted">${count} ${count === 1 ? 'item' : 'items'}</span></div>
    ${d.changeOf ? `<div class="change-banner">Changing ${esc(d.changeOf.number)}. Submitting will replace it with a new order.</div>` : ''}
    ${count ? `<div>${chickenLines.join('')}${otherLines.join('')}${refLines.join('')}</div>` : '<div class="empty">Nothing added yet. Tap a product to start.</div>'}
    <div class="field mt-m"><label for="customer">Customer number <span class="muted">(optional)</span></label>
      <input id="customer" type="text" maxlength="40" value="${esc(d.customerNumber)}" placeholder="Walk-in" autocomplete="off"></div>
    ${needsTag() ? `<div class="field mt-s"><label for="tracking">Tracking No. <span class="muted">(tag on the chicken)</span></label>
      <div class="tracking-row"><input id="tracking" type="text" inputmode="numeric" maxlength="3" value="${esc(d.trackingNumber)}" placeholder="Auto" autocomplete="off" aria-describedby="trackingHint">
        <button type="button" class="btn btn--small" data-action="tracking-auto" title="Pick the lowest number that is free">Auto</button></div>
      <span class="hint" id="trackingHint">1 to 100. The number stays with this order until it is Complete.</span></div>` : ''}
    <div class="total-plate"><span>Total</span><output id="orderTotal">${formatPeso(t.total)}</output></div>
    ${t.discount > 0 ? `<p class="plate-note">Subtotal ${formatPeso(t.subtotal)} &minus; discount ${formatPeso(t.discount)}</p>` : ''}
    <div class="btn-row mt-m">
      <button type="button" class="btn btn--primary btn--big" data-action="go-review" ${count === 0 || unavailable ? 'disabled' : ''}>Review order</button>
      <button type="button" class="btn" data-action="clear-order" ${count === 0 && !d.changeOf ? 'disabled' : ''}>Cancel current order</button>
    </div>
    <div class="mt-s"><button type="button" class="btn btn--small btn--plain" data-action="open-customer" title="Opens the screen the customer looks at. Drag it to the second monitor, then press F11.">Open customer screen</button></div>`;
  if (!needsTag()) { if (d.trackingNumber) { d.trackingNumber = ''; saveDraft(); } } else if (!d.trackingNumber) autoTracking();
}

// ---- Tracking number (Revision 15) -------------------------------------------------------------------
// A chicken order carries a tag number from 1 to 100. The box is filled in with the lowest free number as soon as there is chicken in the order;
// the cashier can type another one. The server checks it again when the order is saved, so two cashiers can never end up with the same number.
/** Chicken sold Live is not butchered, so only an order with chicken to be prepared gets a tracking number. */
const needsTag = () => state.draft.items.some((i) => i.prep.feather !== 'LIVE');
let trackingBusy = false;
async function autoTracking() {
  if (trackingBusy) return;
  trackingBusy = true;
  try {
    const { tracking_number: next } = await api('GET', '/api/tracking-number/next');
    const d = state.draft;
    if (next === null) { toast('All tracking numbers 1 to 100 are in use. Mark finished orders as Complete first.', 'error'); return; }
    if (d && needsTag()) {
      d.trackingNumber = String(next); saveDraft();
      const box = $('#tracking'); if (box) box.value = d.trackingNumber;
    }
  } catch { /* the server picks a number when the order is saved */ } finally { trackingBusy = false; }
}

// ---- Customer screen (Revision 15) -------------------------------------------------------------------
// Tells the second monitor what is on the order and how much cash was handed over. Only this summary leaves this window.
function customerSummary() {
  const d = state.draft;
  if (!d || draftLineCount(d) === 0) return { type: 'idle' };
  const lines = [];
  for (const i of d.items) {
    const p = priceItem(i); if (!p) continue;
    lines.push({ name: p.product.name, detail: [`${p.heads > 1 ? `${p.heads} heads, ` : ''}${formatKg(p.weightG)} kg`, ...prepChips({ feather: i.prep.feather, dara: i.prep.dara, cut: i.prep.cut, sliceSize: i.prep.sliceSize })].join(' · '), total: p.lineTotal });
  }
  for (const i of d.otherItems) {
    const p = priceOther(i); if (!p) continue;
    lines.push({ name: p.product.name, detail: `${p.option.unit}`, total: p.lineTotal });
  }
  for (const i of d.refItems ?? []) {
    const p = priceRef(i); if (!p) continue;
    lines.push({ name: p.name, detail: `${formatKg(p.weightG)} kg`, total: p.lineTotal });
  }
  const t = draftTotals(d);
  const msg = { type: 'order', lines, subtotal: t.subtotal, discount: t.discount, total: t.total };
  const pay = d.payment;
  if (pay.method === 'CASH' && pay.received.trim()) {
    const s = payState();
    msg.cash = { received: parseMoneyInput(pay.received).value ?? 0, change: s.cash?.change ?? null };
  } else if (pay.method !== 'NONE' && pay.method !== 'CASH') msg.method = PAYMENT_METHODS[pay.method] ?? pay.method;
  return msg;
}
function pushToCustomer() { publishToCustomer(customerSummary()); }
onDraftSaved(pushToCustomer);   // every change to the order is sent to the Customer screen

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
    const chips = prepChips(item.prep).map((c) => `<span class="chip chip--prep">${esc(c)}</span>`).join('')   // chip--prep: not printed on the receipt
      + p.fees.filter((f) => f.amount > 0).map((f) => `<span class="chip chip--fee">+${formatPeso(f.amount)} ${esc(label(f.code))}${f.basis === 'per_head' && p.heads > 1 ? ` (${p.heads} × ${formatPeso(f.rate)})` : ''}</span>`).join('');
    return `<tr><td><strong>${esc(p.product.name)}</strong><div class="chips">${chips}</div></td>
      <td>${p.heads > 1 ? `${p.heads} heads &middot; ` : ''}${formatKg(p.weightG)} kg</td><td class="num">${formatPeso(p.product.price_per_kg_centavos)}/kg</td><td class="num">${formatPeso(p.lineTotal)}</td>
      <td class="no-print nowrap"><button type="button" class="btn btn--small" data-action="edit-line" data-kind="chicken" data-key="${item.key}">Edit</button>
        <button type="button" class="btn btn--small btn--danger" data-action="remove-line" data-kind="chicken" data-key="${item.key}">Remove</button></td></tr>`;
  });
  const otherRows = d.otherItems.map((item) => {
    const p = priceOther(item);
    return `<tr><td><strong>${esc(p.product.name)}</strong></td><td>${piecesText(p)}${qtyText(p.quantityMilli, p.option)} ${esc(p.option.unit)}</td>
      <td class="num">${formatPeso(p.option.price_centavos)}/${esc(p.option.unit)}</td><td class="num">${formatPeso(p.lineTotal)}</td>
      <td class="no-print nowrap"><button type="button" class="btn btn--small" data-action="edit-line" data-kind="other" data-key="${item.key}">Edit</button>
        <button type="button" class="btn btn--small btn--danger" data-action="remove-line" data-kind="other" data-key="${item.key}">Remove</button></td></tr>`;
  });
  const refRows = (d.refItems ?? []).map((item) => {
    const p = priceRef(item);
    return `<tr><td><strong>${esc(p.name)}</strong><div class="chips"><span class="chip chip--ref">From the ref</span><span class="chip">No service fee</span></div></td>
      <td>${p.heads > 1 ? `${p.heads} heads &middot; ` : ''}${formatKg(p.weightG)} kg</td><td class="num">${formatPeso(p.price)}/kg</td><td class="num">${formatPeso(p.lineTotal)}</td>
      <td class="no-print nowrap"><button type="button" class="btn btn--small" data-action="edit-line" data-kind="ref" data-key="${item.key}">Edit</button>
        <button type="button" class="btn btn--small btn--danger" data-action="remove-line" data-kind="ref" data-key="${item.key}">Remove</button></td></tr>`;
  });
  const reasonOptions = Object.entries(REASONS).map(([code, text]) => `<option value="${code}" ${d.reason.code === code ? 'selected' : ''}>${esc(text)}</option>`).join('');
  ui.root.innerHTML = `
    <div class="review">
      <div class="warning" role="alert">PLEASE DOUBLE-CHECK THE ORDER. Verify every chicken type, weight, preparation option, and price before submitting.</div>
      ${d.changeOf ? `<div class="change-banner">Changing ${esc(d.changeOf.number)}. The original stays on record and is marked Replaced.</div>` : ''}
      <div id="submitError">${ui.error ? errorBox(ui.error) : ''}</div>
      <div class="slip">
        <div class="slip-head">
          <div><div class="muted" data-slip-kind>Order Slip. Official Receipt.</div><div class="no">Order number is assigned when you submit</div></div>
          <div class="right"><div>${esc(fmtDateTime(new Date().toISOString()))}</div><div>Customer: <strong>${esc(d.customerNumber.trim() || 'Walk-in')}</strong></div>${needsTag() ? `<div>Tracking No.: <strong class="slip-tracking">${d.trackingNumber.trim() ? `#${esc(d.trackingNumber.trim())}` : 'Auto'}</strong></div>` : ''}</div>
        </div>
        <table>
          <thead><tr><th>Item</th><th>Weight or quantity</th><th class="num">Price</th><th class="num">Total</th><th class="no-print"></th></tr></thead>
          <tbody id="slipRows">${rows.join('')}${otherRows.join('')}${refRows.join('')}</tbody>
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
    <p class="muted">Comes off the whole order. Pick a reason.</p>
    ${howItWorks('<p>For example a bulk order, wholesale, employee, Dead or Katay discount. Type the amount or the percentage; it comes off the whole order, and the reason is saved on the order. A Dead or Katay discount is about the price only: it does not change the Daily Inventory.</p>')}
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

/** What the payment panel currently says: Amount Paid text, and the cash check when the method is Cash. */
function payState() {
  const p = state.draft.payment;
  const total = draftTotals().total;
  const paidText = p.amountEdited ? p.amount : pesoText(total);
  if (p.method === 'CASH') return { total, paidText, cash: cashCheck({ totalCentavos: total, paidText, receivedText: p.received }) };
  const paid = parseMoneyInput(paidText);
  return { total, paidText, cash: null, paid: paid.value };
}

function renderPayment() {
  const d = state.draft;
  const p = d.payment;
  const total = draftTotals().total;
  const card = p.method !== 'NONE' && p.method !== 'CASH';
  const cash = p.method === 'CASH';
  const amount = p.amountEdited ? p.amount : pesoText(total);
  const methods = [['NONE', 'Not recorded'], ...Object.entries(PAYMENT_METHODS)]
    .map(([v, t]) => `<option value="${v}" ${p.method === v ? 'selected' : ''}>${esc(t)}</option>`).join('');
  $('#payPanel').innerHTML = `
    <div class="panel-head"><h3>Payment details <span class="muted">(required)</span></h3></div>
    <p class="muted">This only records what you type for billing. It does not charge anyone.</p>
    <div class="form-grid mt-s">
      <div class="field"><label for="payMethod">How did the customer pay?</label><select id="payMethod">${methods}</select></div>
      ${p.method !== 'NONE' ? `<div class="field"><label for="payAmount">Amount Paid (₱)</label><input id="payAmount" type="text" inputmode="decimal" value="${esc(amount)}" autocomplete="off"></div>` : ''}
      ${cash ? `
        <div class="field"><label for="payReceived">Money Received (₱)</label><input id="payReceived" type="text" inputmode="decimal" value="${esc(p.received)}" placeholder="for example 1000" autocomplete="off" aria-describedby="payWarn"></div>
        <div class="field"><label for="payChange">Change (₱)</label><output id="payChange" class="change-out" for="payAmount payReceived" aria-live="polite"></output></div>` : ''}
      ${card ? `
        <div class="field"><label for="payWhen">Payment date and time <span class="muted">(optional)</span></label><input id="payWhen" type="datetime-local" value="${esc(p.paidAt)}"></div>
        <div class="field"><label for="payName">Account name <span class="muted">(optional)</span></label><input id="payName" type="text" maxlength="100" value="${esc(p.accountName)}" autocomplete="off"></div>
        <div class="field"><label for="payNumber">Account or mobile number <span class="muted">(optional)</span></label><input id="payNumber" type="text" inputmode="tel" maxlength="40" value="${esc(p.accountNumber)}" autocomplete="off"></div>
        <div class="field"><label for="payRef">Reference number <span class="muted">(optional)</span></label><input id="payRef" type="text" maxlength="60" value="${esc(p.reference)}" autocomplete="off"></div>` : ''}
    </div>
    <p class="cfg-hint" id="payWarn" role="status"></p>`;
  updatePayWarn();
}

/** Redraw the Change box and the message under the payment fields. */
function updatePayWarn() {
  const warn = $('#payWarn');
  if (!warn) return;
  const p = state.draft.payment;
  if (p.method === 'NONE') { warn.textContent = ''; return; }
  const s = payState();
  const out = $('#payChange');
  if (s.cash) {
    if (out) {
      out.textContent = s.cash.change === null ? '—' : formatPeso(s.cash.change);
      out.dataset.change = s.cash.change === null ? '' : String(s.cash.change);
      out.classList.toggle('change-out--bad', s.cash.change === null && s.cash.problems.length > 0);
    }
    // The first problem is enough: fix it, and the next one (if any) shows. A blank Money Received is a prompt, not an error.
    warn.textContent = s.cash.problems[0]?.message ?? '';
    warn.classList.toggle('cfg-hint--bad', s.cash.insufficient);
    return;
  }
  warn.classList.remove('cfg-hint--bad');
  const paid = parseMoneyInput(s.paidText);
  if (paid.error === 'negative') warn.textContent = 'Amount Paid cannot be negative.';
  else if (paid.value === null || paid.value <= 0) warn.textContent = 'Enter the Amount Paid, for example 208.80.';
  else if (paid.value < s.total) { warn.textContent = `Insufficient payment. Amount Paid (${formatPeso(paid.value)}) is less than the order total (${formatPeso(s.total)}). The order cannot be finished as fully paid.`; warn.classList.add('cfg-hint--bad'); }
  else if (paid.value > s.total) warn.textContent = `Amount Paid (${formatPeso(paid.value)}) is more than the order total (${formatPeso(s.total)}). Amount Paid must match the order total.`;
  else warn.textContent = '';
}

/** True while the payment typed cannot be saved: the Submit button stays off. */
function paymentProblem() {
  const p = state.draft.payment;
  if (p.method === 'NONE') return false;
  const s = payState();
  if (s.cash) return !s.cash.ok;
  return s.paid === null || s.paid !== s.total;
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
    ...(needsTag() ? { tracking_number: d.trackingNumber.trim() } : {}),   // empty = the server picks the lowest free number
    expected_total_centavos: t.total,
    items: d.items.map((i) => ({
      product_id: i.productId, weight: i.weight, heads: i.heads ?? '1', feather: i.prep.feather, dara: i.prep.dara, cut: i.prep.cut,
      slice_size: i.prep.sliceSize, confirm_large: i.confirmLarge === true,
    })),
    other_items: d.otherItems.map((i) => ({
      other_product_id: findOption(i.optionId)?.product.id ?? i.productId, option_id: i.optionId, quantity: i.quantity,
      ...(findOption(i.optionId)?.option.sold_by === 'PER_KG' ? { pieces: i.pieces ?? '1' } : {}),
    })),
    ref_items: (d.refItems ?? []).map((i) => ({ kind: i.kind, product_id: i.productId ?? null, heads: i.heads, weight: i.weight, price_per_kg: i.price })),
    discount: d.discount.type === 'NONE' ? undefined : { type: d.discount.type, value: d.discount.value, reason_code: d.discount.reason, note: d.discount.note },
    payment: p.method === 'NONE' ? null : {
      method: p.method, amount: pesoPlain(parseMoneyInput(p.amountEdited ? p.amount : pesoText(t.total)).value ?? 0),
      ...(p.method === 'CASH' ? { received: pesoPlain(parseMoneyInput(p.received).value ?? 0) } : {}),
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
    const paidRow = result.order.payments?.[0];
    clearDraft();
    publishToCustomer({ type: 'done', orderNumber: result.order.order_number, tracking: result.order.tracking_number, total: result.order.total_centavos, change: paidRow?.change_centavos ?? 0 });
    await refreshConfig(api).catch(() => {});   // the stock on the product cards changed with this sale
    render();
  } catch (err) {
    ui.submitting = false;
    ui.error = err;
    if (err.code === 'TRACKING_TAKEN' || err.code === 'TRACKING_FULL') { d.trackingNumber = ''; saveDraft(); }   // going Back fills in a free number
    if (err.code === 'PRICE_CHANGED' || err.code === 'INSUFFICIENT_STOCK') {
      // Prices or stock changed since this screen was opened (another cashier sold something). Show the new numbers and ask for a fresh review.
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
      ${o.tracking_number != null ? `<div class="tracking-big" data-tracking-big>Tracking No. <strong>#${esc(o.tracking_number)}</strong></div><p class="no-print"><strong>Put tag #${esc(o.tracking_number)} on the chicken.</strong></p>` : ''}
      <p class="no-print mt-s"><strong>Write this order number on the bag or give it to the customer.</strong></p>
      <div class="slip">
        <div class="slip-head"><div><div class="muted" data-slip-kind>Order Slip. Official Receipt.</div><div class="no">${esc(o.order_number)}</div></div>
          <div class="right"><div>${esc(fmtDateTime(o.submitted_at))}</div><div>Customer: <strong>${esc(o.customer_number === 'WALK-IN' ? 'Walk-in' : o.customer_number)}</strong></div>${o.tracking_number != null ? `<div>Tracking No.: <strong class="slip-tracking">#${esc(o.tracking_number)}</strong></div>` : ''}</div></div>
        ${orderTable(o)}
        ${slipPayment(o)}
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
    value: existing?.quantity ?? '', pieces: existing?.pieces ?? '1', returnTo: existing && ui.step === 'review' ? 'review' : 'pick',
  };
  ui.step = 'configure';
  render();
}

/** Open the ref screen (Revision 12): mode 'sell' (add to the order) or 'store' (put in the ref). existing = a ref line being edited. */
function startRef(kind, mode, existing) {
  ui.cfg = existing
    ? {
      kind: 'ref', refKind: existing.kind, mode: 'sell', editKey: existing.key, value: existing.weight, heads: existing.heads ?? '1', price: existing.price ?? '',
      productId: existing.productId ?? null, productName: existing.productName ?? '', returnTo: ui.step === 'review' ? 'review' : 'pick',
    }
    : { kind: 'ref', refKind: kind, mode, editKey: null, value: '', heads: '1', price: '', productId: null, note: '', returnTo: 'pick' };
  // Selling, and only one chicken has heads of this kind in the ref: it is chosen already.
  if (!existing && mode === 'sell') { const list = refProducts(kind); if (list.length === 1) ui.cfg.productId = list[0].id; }
  ui.tab = 'advanced';
  ui.step = 'configure';
  render();
}

/** Store in the ref: the server adds the heads to the ref AND to the chicken's Katay or Dead on the Daily Inventory, in one step. */
async function storeRef() {
  const c = ui.cfg;
  if (ui.busy) return;
  ui.busy = true;
  $('#addBtn').disabled = true;
  $('#hint').textContent = 'Saving...';
  try {
    const r = await api('POST', '/api/ref/store', { kind: c.refKind, product_id: c.productId, heads: c.heads, weight: c.value, note: c.note });
    ui.busy = false;
    ui.step = 'pick';
    ui.cfg = null;
    await refreshConfig(api).catch(() => {});
    render();
    toast(`Stored in the ref: ${r.stored.heads} ${r.stored.name} (${formatKg(r.stored.weight_g)} kg). Daily Inventory ${r.inventory.business_date}: ${r.inventory.product} ${r.inventory.field} ${r.inventory.was} → ${r.inventory.now}.`, 'ok');
  } catch (err) {
    ui.busy = false;
    if (!ui.cfg) return;
    $('#hint').textContent = err.message;
    $('#addBtn').disabled = false;
  }
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
  if (c.kind === 'ref') {
    if (parseWeightToGrams(c.value) === null || parseHeads(c.heads) === null) return undefined;
    if (c.mode === 'store') return storeRef();
    if (!(parsePesosToCentavos(c.price) > 0) || !c.productId) return undefined;
    d.refItems = d.refItems ?? [];
    const productName = findProduct(c.productId)?.name ?? c.productName ?? '';
    const item = {
      key: c.editKey ?? uuid(), kind: c.refKind, name: `${REF_LABELS[c.refKind]} - ${productName}`, productId: c.productId, productName,
      heads: String(parseHeads(c.heads)), weight: c.value, price: c.price,
    };
    const at = d.refItems.findIndex((i) => i.key === c.editKey);
    if (at >= 0) d.refItems[at] = item; else d.refItems.push(item);
    return finishCfg(`${item.name} ${at >= 0 ? 'updated' : 'added'}`);
  }
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
  const perKg = option.sold_by === 'PER_KG';
  const qty = perKg ? parseQuantityToMilli(c.value) : parseWholeQuantityToMilli(c.value);
  const pieces = perKg ? parseHeads(c.pieces) : null;
  if (qty === null || (perKg && pieces === null)) return;
  const item = { key: c.editKey ?? uuid(), productId: product.id, optionId: option.id, name: product.name, unit: option.unit, quantity: c.value, ...(perKg ? { pieces: String(pieces) } : {}) };
  const at = d.otherItems.findIndex((i) => i.key === c.editKey);
  if (at >= 0) d.otherItems[at] = item; else d.otherItems.push(item);
  return finishCfg(`${product.name} (${option.unit}) ${at >= 0 ? 'updated' : 'added'}`);
}

async function onClick(e) {
  if (advancedClick(e)) return;
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
    case 'pieces-inc':
    case 'pieces-dec': {
      const n = parseHeads(ui.cfg.pieces) ?? 1;
      ui.cfg.pieces = String(Math.min(MAX_HEADS, Math.max(1, n + (action === 'pieces-inc' ? 1 : -1))));
      $('#pieces').value = ui.cfg.pieces;
      return updateCfg();
    }
    case 'ref-product':
      ui.cfg.productId = Number(btn.dataset.id);
      document.querySelectorAll('#work [data-action="ref-product"]').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
      return updateCfg();
    case 'prep-service': ui.cfg.prep = applyPrepChange(ui.cfg.prep, { service: v }); break;
    case 'prep-dara': ui.cfg.prep = applyPrepChange(ui.cfg.prep, { dara: !ui.cfg.prep.dara }); break;
    case 'prep-cut': ui.cfg.prep = applyPrepChange(ui.cfg.prep, { cut: v }); break;
    case 'edit-line': {
      if (kind === 'chicken') { const item = d.items.find((i) => i.key === key); return startChicken(item.productId, item); }
      if (kind === 'ref') { const item = d.refItems.find((i) => i.key === key); return startRef(item.kind, 'sell', item); }
      const item = d.otherItems.find((i) => i.key === key);
      return startOther(findOption(item.optionId)?.product.id ?? item.productId, item);
    }
    case 'remove-line': {
      if (kind === 'chicken') d.items = d.items.filter((i) => i.key !== key);
      else if (kind === 'ref') d.refItems = d.refItems.filter((i) => i.key !== key);
      else d.otherItems = d.otherItems.filter((i) => i.key !== key);
      d.reviewed = false; saveDraft();
      if (ui.step === 'review' && draftLineCount() === 0) ui.step = 'pick';
      return render();
    }
    case 'clear-order': {
      const ok = await confirmDialog(d.changeOf ? 'Stop changing this order? The original order stays as it was.' : 'Remove every item and start over?', { confirmLabel: 'Yes, cancel this order', cancelLabel: 'Keep it', danger: true, title: 'Cancel current order' });
      if (!ok) return;
      clearDraft(); ui.step = 'pick'; ui.error = null; return render();
    }
    case 'tracking-auto': { d.trackingNumber = ''; await autoTracking(); $('#tracking')?.focus(); return; }
    case 'open-customer': openCustomerWindow(); pushToCustomer(); return;
    case 'go-review': if (draftLineCount()) { ui.step = 'review'; ui.error = null; render(); window.scrollTo({ top: 0 }); } return;
    case 'review-back': ui.step = 'pick'; ui.error = null; return render();
    case 'review-submit': return submit();
    case 'new-order': ui.step = 'pick'; ui.done = null; ui.error = null; return render();
    case 'print': return window.print();
    default: return;
  }
  // The prep cases above fall through to here: redraw only the choices and the price.
  renderPrep();
  updateCfg();
}

function onInput(e) {
  const t = e.target;
  const d = state.draft;
  if (advancedInput(e)) return undefined;
  if (t.id === 'refPrice' && ui.cfg) {
    const v = cleanDecimal(t.value, 2);
    if (v !== t.value) t.value = v;
    ui.cfg.price = v;
    return updateCfg();
  }
  if (t.id === 'refNote' && ui.cfg) { ui.cfg.note = t.value; return undefined; }
  if ((t.id === 'heads' || t.id === 'pieces') && ui.cfg) {
    const v = t.value.replace(/\D/g, '').slice(0, 3);
    if (v !== t.value) t.value = v;
    ui.cfg[t.id] = v;
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
  if (t.id === 'tracking') { const v = t.value.replace(/\D/g, '').slice(0, 3); if (v !== t.value) t.value = v; d.trackingNumber = v; saveDraft(); return; }
  if (t.id === 'reasonNote') { d.reason.note = t.value; saveDraft(); return updateSubmitState(); }
  if (t.id === 'discValue') { d.discount.value = cleanDecimal(t.value, 2); if (d.discount.value !== t.value) t.value = d.discount.value; saveDraft(); return refreshTotals(); }
  if (t.id === 'discNote') { d.discount.note = t.value; saveDraft(); return refreshTotals(); }
  const pay = d.payment;
  if (t.id === 'payAmount') { pay.amount = typedMoneyText(t.value); if (pay.amount !== t.value) t.value = pay.amount; pay.amountEdited = true; }
  else if (t.id === 'payReceived') { pay.received = typedMoneyText(t.value); if (pay.received !== t.value) t.value = pay.received; }
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
  if (t.id === 'refProduct' && ui.cfg) { ui.cfg.productId = Number(t.value) || null; return updateCfg(); }
  if (t.id === 'reviewed') { d.reviewed = t.checked; saveDraft(); return updateSubmitState(); }
  if (t.id === 'reasonCode') { d.reason.code = t.value; saveDraft(); return updateSubmitState(); }
  if (t.id === 'discType') {
    d.discount.type = t.value;
    if (t.value === 'NONE') d.discount = { type: 'NONE', value: '', reason: '', note: '' };
    saveDraft(); renderDiscount(); return refreshTotals();
  }
  if (t.id === 'discReason') { d.discount.reason = t.value; saveDraft(); renderDiscount(); return refreshTotals(); }
  if (t.id === 'payAmount' || t.id === 'payReceived') {
    // Leaving the box: show what was understood ("1,000" becomes 1000.00). Anything that is not a number stays as typed, with its message.
    const read = parseMoneyInput(t.value);
    if (read.value !== null) {
      const plain = pesoPlain(read.value);
      t.value = plain;
      if (t.id === 'payAmount') { d.payment.amount = plain; d.payment.amountEdited = true; } else d.payment.received = plain;
      saveDraft(); updatePayWarn(); updateSubmitState();
    }
    return;
  }
  if (t.id === 'payMethod') {
    d.payment.method = t.value;
    if (t.value === 'NONE') { d.payment.amountEdited = false; d.payment.received = ''; }
    if (t.value !== 'CASH') d.payment.received = '';
    saveDraft();
    renderPayment();
    updateSubmitState();
    if (t.value === 'CASH' && hasKeyboard()) $('#payReceived')?.focus();   // Revision 13: type the money received next
  }
}

const press = (selector) => { const b = $(selector); if (!b || b.disabled) return false; b.click(); return true; };
const TABS = ['advanced', 'chicken', 'other'];

/**
 * Revision 13: the keyboard shortcuts of the New order screen (the full list is in keys.js and behind the "?" key). Returns true when the
 * key was used. Letters and digits are left alone while the cashier types in a text box (a name, a note, the search).
 */
function checkoutKeys(e) {
  const typing = typingIn();
  const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
  const onButton = !!e.target.closest?.('button, a, textarea');
  if (e.key === 'Escape' && plain) {
    if (ui.step === 'configure') return press('#work [data-action="cfg-back"]');
    if (ui.step === 'review') return press('[data-action="review-back"]');
    return false;
  }
  if (ui.step === 'pick') {
    if (typing || !plain) return false;
    const at = e.key.length === 1 ? PRODUCT_KEYS.indexOf(e.key.toUpperCase()) : -1;   // 1-9, 0, then Q W E R T Y U I O P
    if (at !== -1) {
      const card = [...document.querySelectorAll('#work .product-card')][at];
      if (!card) return false;
      card.click();
      return true;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      ui.tab = TABS[(TABS.indexOf(ui.tab) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
      renderWork();
      return true;
    }
    if (e.key === '/') { ui.tab = 'other'; renderWork(); $('#otherSearch')?.focus(); return true; }
    if (e.key === 'Enter' && !onButton) return draftLineCount() > 0 && press('[data-action="go-review"]');
    return false;
  }
  if (ui.step === 'configure') {
    // Alt+1 ... Alt+9: the service (chicken), the selling option (other products) or which chicken (Katay / Dead)
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^(Digit|Numpad)[1-9]$/.test(e.code)) {
      const list = { chicken: '#prep [data-action="prep-service"]', ref: '#work [data-action="ref-product"]', other: '#work [data-action="pick-option"]' }[ui.cfg.kind];
      const btn = [...document.querySelectorAll(list)][Number(e.code.slice(-1)) - 1];
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    }
    if (!plain) return false;
    const numberBox = !typing || ['amount', 'heads', 'pieces'].includes(document.activeElement?.id);
    if ((e.key === '+' || e.key === '-') && numberBox) {
      const which = $('#work [data-action="heads-inc"]') ? 'heads' : $('#work [data-action="pieces-inc"]') ? 'pieces' : null;
      return which ? press(`#work [data-action="${which}-${e.key === '+' ? 'inc' : 'dec'}"]`) : false;
    }
    if (typing) return false;
    // Not in a box: digits, the point and Backspace go to the weight, like the keypad on the screen.
    if (/^[0-9.]$/.test(e.key)) return press(`#work [data-key="${e.key}"]`);
    if (e.key === 'Backspace') return press('#work [data-key="back"]');
    if (e.key === 'Enter' && !onButton) return press('#addBtn');
    return false;
  }
  if (ui.step === 'review') {
    const moneyBox = ['payReceived', 'payAmount', 'discValue'].includes(document.activeElement?.id);
    if (e.key === 'Enter' && !onButton && (e.ctrlKey || (plain && (!typing || moneyBox)))) {
      if (press('#submitBtn')) return true;
      if (!$('#reviewed')?.checked) { $('#reviewed')?.focus(); return true; }   // the one thing left: tick "I have reviewed"
      return false;
    }
    if (typing || !plain) return false;
    if (e.key === ' ' && !onButton && document.activeElement?.id !== 'reviewed') return press('#reviewed');
    if (e.key === 'd' || e.key === 'D') { $('#discType')?.focus(); return true; }
    if (e.key === 'p' || e.key === 'P') {
      const select = $('#payMethod');
      if (!select) return false;
      select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }
  if (ui.step === 'done' && (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'p' || e.key === 'P')) return press('[data-action="print"]');
  return false;
}

function onKeyDown(e) {
  if (advancedKeyDown(e)) return;
  if (e.key === 'Enter' && (e.target.id === 'amount' || e.target.id === 'refPrice') && !$('#addBtn').disabled) { e.preventDefault(); addFromCfg(); }
}
