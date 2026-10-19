// Products screen: chicken products, other products, services and their fees (admin edits) and the price history (admin).
import { api } from '../api.js';
import { state, refreshConfig } from '../state.js';
import { $, esc, formatPeso, toast, errorBox, openDialog, fmtDateTime, productPicture, watchImages } from '../util.js';
import { FEE_LABELS, SOLD_BY, FEE_BASIS, FEE_BASIS_LABELS, PRODUCT_KINDS, UNITS, CHICKEN_CATEGORIES, eggSizeOf } from '/shared/constants.js';

const isAdmin = () => state.user.role === 'admin';
const pesoInput = (c) => (c ? `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}` : '');
let tab = 'chicken';

export async function mountCatalog(root) {
  const tabs = [['chicken', 'Chicken products'], ['other', 'Other products'], ['fees', 'Services'], ...(isAdmin() ? [['history', 'Price history']] : [])];
  root.innerHTML = `<div class="panel"><div class="panel-head"><h1>Products</h1></div>
    <div class="tabs" role="tablist">${tabs.map(([id, text]) => `<button type="button" class="tab" role="tab" aria-selected="${tab === id}" data-tab="${id}">${esc(text)}</button>`).join('')}</div>
    <div id="tabBody"></div></div>`;
  root.onclick = (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; mountCatalog(root); }
  };
  watchImages(root);
  const body = $('#tabBody');
  try {
    if (tab === 'chicken') await chickenTab(body);
    else if (tab === 'other') await otherTab(body);
    else if (tab === 'fees') await feesTab(body);
    else await historyTab(body);
  } catch (err) { body.innerHTML = errorBox(err); }
}

const reload = async () => { await refreshConfig(api).catch(() => {}); mountCatalog($('#main')); };

// ---- Chicken products ----------------------------------------------------------------------------

async function chickenTab(body) {
  const { products } = await api('GET', '/api/products');
  body.innerHTML = `
    <div class="note-box">${isAdmin()
      ? 'Prices are per kilogram of live weight. Past orders keep the price they were sold at.'
      : 'Only the admin can set or change the price per kg. A product you add stays inactive until the admin sets its price.'}</div>
    <div class="btn-row mt-s"><button type="button" class="btn btn--primary" id="addProduct">Add product</button></div>
    ${products.length ? `<div class="table-wrap mt-s"><table class="data"><thead><tr><th>ID</th><th>Picture</th><th>Name</th><th>Report block</th><th class="num">Price per kg</th><th>Status</th><th></th></tr></thead><tbody>
      ${products.map((p) => `<tr><td>${esc(p.code)}</td><td><span class="ico ico--small" aria-hidden="true">${productPicture('chicken', p)}</span></td>
        <td><strong>${esc(p.name)}</strong>${p.description ? `<div class="muted">${esc(p.description)}</div>` : ''}</td>
        <td>${esc(p.category_label ?? '')}</td>
        <td class="num">${p.price_per_kg_centavos ? formatPeso(p.price_per_kg_centavos) : '<span class="muted">Not set</span>'}</td>
        <td>${p.active ? '<span class="badge">Active</span>' : '<span class="badge badge--inactive">Inactive</span>'}</td>
        <td class="right nowrap"><button type="button" class="btn btn--small" data-edit="${p.id}">Edit</button>
          <button type="button" class="btn btn--small" data-picture="${p.id}">Picture</button>
          <button type="button" class="btn btn--small" data-toggle="${p.id}">${p.active ? 'Deactivate' : 'Reactivate'}</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty mt-s">No products yet. Add the first one.</div>'}`;
  $('#addProduct').onclick = () => productDialog(null);
  body.onclick = async (e) => {
    const edit = e.target.closest('[data-edit]');
    const toggle = e.target.closest('[data-toggle]');
    const pic = e.target.closest('[data-picture]');
    if (edit) return productDialog(products.find((p) => p.id === Number(edit.dataset.edit)));
    if (pic) return pictureDialog('chicken', products.find((p) => p.id === Number(pic.dataset.picture)));
    if (toggle) {
      const p = products.find((x) => x.id === Number(toggle.dataset.toggle));
      try { await api('PATCH', `/api/products/${p.id}`, { active: !p.active }); toast(`${p.name} ${p.active ? 'deactivated' : 'reactivated'}.`, 'ok'); reload(); }
      catch (err) { toast(err.message, 'error'); }
    }
  };
}

async function productDialog(p) {
  const editing = Boolean(p);
  const priceLocked = !isAdmin();
  const saved = await openDialog({
    title: editing ? `Edit ${p.name}` : 'Add chicken product',
    body: `<div id="pErr"></div><div class="form-grid">
        <div class="field"><label for="pName">Product name</label><input id="pName" type="text" maxlength="80" value="${esc(p?.name ?? '')}"></div>
        <div class="field"><label for="pPrice">Price per kg (₱)</label><input id="pPrice" type="text" inputmode="decimal" value="${esc(pesoInput(p?.price_per_kg_centavos))}" ${priceLocked ? 'disabled' : ''}>
          <span class="hint">${priceLocked ? 'Only the admin can set this.' : 'For example 58 or 58.50.'}</span></div>
        <div class="field"><label for="pDesc">Description <span class="muted">(optional)</span></label><input id="pDesc" type="text" maxlength="200" value="${esc(p?.description ?? '')}"></div>
        <div class="field"><label for="pCat">Report block (Daily Report)</label><select id="pCat">
          ${editing ? '' : '<option value="">Choose from the name</option>'}
          ${Object.entries(CHICKEN_CATEGORIES).map(([v, t]) => `<option value="${v}" ${p?.category === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
          <span class="hint">Which block of the paper Daily Sales Report this chicken is written in. "Other chicken" gets a block of its own.</span></div>
      </div>`,
    actions: [
      { label: 'Cancel', value: false },
      {
        label: editing ? 'Save changes' : 'Add product', kind: 'primary',
        onClick: async (dlg) => {
          const body = { name: $('#pName', dlg).value, description: $('#pDesc', dlg).value };
          if ($('#pCat', dlg).value) body.category = $('#pCat', dlg).value;
          if (!priceLocked) body.price = $('#pPrice', dlg).value;
          try {
            if (editing) await api('PATCH', `/api/products/${p.id}`, body); else await api('POST', '/api/products', body);
            return true;
          } catch (err) { $('#pErr', dlg).innerHTML = errorBox(err); return false; }
        },
      },
    ],
  });
  if (saved === true) { toast('Product saved.', 'ok'); reload(); }
}

// ---- Other products ------------------------------------------------------------------------------
// Every other product is created with the same fixed units, so each one has its own stock row on the Daily Inventory:
//   Other product: piece, pack, sack, kg (kg is weighed at the counter)      Eggs: piece, carton, tray
// A unit is sold on the New order screen only once it has a price. Managers add products; only the admin sets prices.

const optionLabel = (o) => (o.sold_by === 'PER_KG' ? 'per kg' : `per ${o.unit}`);
const unitsText = (kind) => UNITS[kind].join(', ');
/** Revision 12: the row of the Daily Report's EGGS table an egg product is reported on (from its name; "Assorted" goes on Asst.). */
const eggRowText = (name, kind) => { const size = eggSizeOf(name) ?? (kind === 'EGGS' ? 'Asst.' : null); return size ? `Daily Report: EGGS, ${size} row` : ''; };

async function otherTab(body) {
  const { other_products: items } = await api('GET', '/api/other-products');
  body.innerHTML = `
    <div class="note-box">${isAdmin()
      ? `Things the store sells besides chicken. Every product gets the same units. <strong>Other product:</strong> ${esc(unitsText('OTHER'))}. <strong>Eggs:</strong> ${esc(unitsText('EGGS'))}. A price you set here is added to the order total; a unit with no price is not sold at the counter. Stock is counted in pieces, packs, sacks, cartons and trays on the Daily Inventory; something sold <strong>per kg</strong> is counted in pieces (the cashier enters the pieces and their weight).`
      : `Things the store sells besides chicken. You can add products. Every product gets the same units (Other product: ${esc(unitsText('OTHER'))}. Eggs: ${esc(unitsText('EGGS'))}). Only the admin can set or change prices, and a unit stays hidden from cashiers until it has a price. Something sold per kg is counted in pieces on the Daily Inventory.`}</div>
    <div class="btn-row mt-s"><button type="button" class="btn btn--primary" id="addOther">Add product</button></div>
    ${items.length ? `<div class="table-wrap mt-s"><table class="data"><thead><tr><th>Product</th><th>Type</th><th>Units and prices</th><th>Status</th><th></th></tr></thead><tbody>
      ${items.map((p) => `<tr><td><span class="ico ico--small" aria-hidden="true">${productPicture('other', p)}</span> <strong>${esc(p.name)}</strong><div class="muted">${esc(p.code)}</div></td>
        <td>${esc(p.kind_label ?? PRODUCT_KINDS[p.kind] ?? '')}${eggRowText(p.name, p.kind) ? `<div class="muted small" data-egg-row>${esc(eggRowText(p.name, p.kind))}</div>` : ''}</td>
        <td>${p.options.length ? p.options.map((o) => `<span class="chip ${o.active ? '' : 'chip--fee'}">${esc(optionLabel(o))}: ${o.price_centavos ? formatPeso(o.price_centavos) : 'price not set'}${o.active ? '' : ' (hidden)'}</span>`).join(' ') : '<span class="muted">No units</span>'}</td>
        <td>${p.active ? '<span class="badge">Active</span>' : '<span class="badge badge--inactive">Inactive</span>'}</td>
        <td class="right nowrap"><button type="button" class="btn btn--small btn--primary" data-options="${p.id}">Units &amp; prices</button>
          <button type="button" class="btn btn--small" data-picture="${p.id}">Picture</button>
          <button type="button" class="btn btn--small" data-rename="${p.id}">Rename</button>
          <button type="button" class="btn btn--small" data-toggle="${p.id}">${p.active ? 'Deactivate' : 'Reactivate'}</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty mt-s">No other products yet. Add things like eggs, etag or garlic.</div>'}`;
  $('#addOther').onclick = async () => {
    const created = await addOtherDialog();
    if (created) {
      toast(`${created.name} added with ${unitsText(created.kind)}. Its stock rows are on the Daily Inventory (by the kilo is counted in pieces).`, 'ok');
      reload();
    }
  };
  body.onclick = async (e) => {
    const find = (attr) => items.find((p) => p.id === Number(e.target.closest(`[${attr}]`)?.getAttribute(attr)));
    if (e.target.closest('[data-options]')) return optionsDialog(find('data-options').id);
    if (e.target.closest('[data-picture]')) return pictureDialog('other', find('data-picture'));
    if (e.target.closest('[data-rename]')) { const p = find('data-rename'); const done = await renameDialog(p); if (done) reload(); return; }
    if (e.target.closest('[data-toggle]')) {
      const p = find('data-toggle');
      try { await api('PATCH', `/api/other-products/${p.id}`, { active: !p.active }); toast(`${p.name} ${p.active ? 'deactivated' : 'reactivated'}.`, 'ok'); reload(); }
      catch (err) { toast(err.message, 'error'); }
    }
  };
}

/** Add an other product: its name, its type (which decides the units) and, for the admin, a price for each unit that will be sold. Returns the saved product, or null. */
async function addOtherDialog() {
  let saved = null;
  const priceFields = (kind, keep = {}) => UNITS[kind].map((u) => `<div class="field"><label for="pp-${u}">Price per ${esc(u)} (₱)</label>
      <input id="pp-${u}" data-unit="${esc(u)}" type="text" inputmode="decimal" autocomplete="off" value="${esc(keep[u] ?? '')}" ${isAdmin() ? '' : 'disabled'} placeholder="${isAdmin() ? 'optional' : 'admin sets price'}"></div>`).join('');
  const eggHint = (name, kind) => (eggRowText(name, kind) ? `${eggRowText(name, kind)}.` : 'Egg products go on the EGGS table of the Daily Report by size: Small, Medium, Large, XL. Assorted eggs (collected in the shop from different chickens): name it for example "Eggs Assorted".');
  await openDialog({
    title: 'Add other product',
    body: `<div id="nErr"></div><div class="form-grid">
        <div class="field"><label for="nName">Product name</label><input id="nName" type="text" maxlength="80" placeholder="for example Eggs Assorted, Eggs (Large) or Etag (Sun-Dried)">
          <span class="hint" id="nEggHint" hidden></span></div>
        <div class="field"><label for="nKind">Type</label>
          <select id="nKind">${Object.entries(PRODUCT_KINDS).map(([v, t]) => `<option value="${v}" ${v === 'OTHER' ? 'selected' : ''}>${esc(t)} (${esc(unitsText(v))})</option>`).join('')}</select></div>
      </div>
      <fieldset class="group"><legend>Units and prices <span class="muted">(${isAdmin() ? 'leave a price empty if that unit is not sold yet' : 'only the admin can set prices'})</span></legend>
        <div class="form-grid" id="nPrices">${priceFields('OTHER')}</div></fieldset>`,
    onOpen: (dlg) => {
      // Revision 12: say which egg row of the Daily Report the name goes on, while it is typed.
      const hint = () => { const h = $('#nEggHint', dlg); const n = $('#nName', dlg).value; const eggs = $('#nKind', dlg).value === 'EGGS' || /egg|itlog/i.test(n); h.hidden = !eggs; h.textContent = eggs ? eggHint(n, $('#nKind', dlg).value) : ''; };
      $('#nName', dlg).addEventListener('input', hint);
      $('#nKind', dlg).addEventListener('change', hint);
      $('#nKind', dlg).onchange = (e) => {
        const keep = {};
        dlg.querySelectorAll('#nPrices [data-unit]').forEach((i) => { keep[i.dataset.unit] = i.value; });
        $('#nPrices', dlg).innerHTML = priceFields(e.target.value, keep);
      };
    },
    actions: [{ label: 'Cancel', value: false }, {
      label: 'Add product', kind: 'primary',
      onClick: async (dlg) => {
        const payload = { name: $('#nName', dlg).value, kind: $('#nKind', dlg).value };
        if (isAdmin()) {
          payload.prices = {};
          dlg.querySelectorAll('#nPrices [data-unit]').forEach((i) => { if (i.value.trim() !== '') payload.prices[i.dataset.unit] = i.value; });
        }
        try { saved = (await api('POST', '/api/other-products', payload)).other_product; return true; }
        catch (err) { $('#nErr', dlg).innerHTML = errorBox(err); return false; }
      },
    }],
  });
  return saved;
}

async function renameDialog(p) {
  let saved = null;
  await openDialog({
    title: 'Rename product',
    body: `<div id="nErr"></div><div class="field"><label for="nName">Product name</label><input id="nName" type="text" maxlength="80" value="${esc(p.name)}"></div>`,
    actions: [{ label: 'Cancel', value: false }, {
      label: 'Save name', kind: 'primary',
      onClick: async (dlg) => {
        try { saved = (await api('PATCH', `/api/other-products/${p.id}`, { name: $('#nName', dlg).value })).other_product; return true; }
        catch (err) { $('#nErr', dlg).innerHTML = errorBox(err); return false; }
      },
    }],
  });
  return saved;
}

/** One unit of a product. The unit itself never changes (stock and saved orders are counted in it); the price and on/off can. */
function optionRow(o, unit) {
  const u = o?.unit ?? unit;
  const perKg = (o?.sold_by ?? (u === 'kg' ? 'PER_KG' : 'FIXED')) === 'PER_KG';
  return `<div class="price-opt" ${o ? `data-opt="${o.id}"` : `data-new="${esc(u)}"`} data-priced="${o?.price_centavos ? 1 : 0}">
    <strong class="opt-unit">${esc(u)}</strong>
    <span class="muted">${perKg ? SOLD_BY.PER_KG : SOLD_BY.FIXED}</span>
    <input type="text" data-f="price" inputmode="decimal" aria-label="Price per ${esc(u)} in pesos" value="${esc(pesoInput(o?.price_centavos))}" placeholder="${isAdmin() ? 'price in pesos' : 'admin sets price'}" ${isAdmin() ? '' : 'disabled'}>
    <label class="check"><input type="checkbox" data-f="active" ${o && o.active ? 'checked' : ''}> Active</label>
    <button type="button" class="btn btn--small btn--primary" data-save="${o ? o.id : `new:${esc(u)}`}">${o ? 'Save' : 'Add'}</button></div>`;
}

async function optionsDialog(productId) {
  const { other_products: all } = await api('GET', '/api/other-products');
  let product = all.find((p) => p.id === productId);
  const render = () => {
    const have = new Set(product.options.map((o) => o.unit));
    const missing = (product.units ?? []).filter((u) => !have.has(u));
    return `<div id="optErr"></div>
    <p class="muted">${esc(product.kind_label ?? '')}: ${esc(unitsText(product.kind))}. A unit with a price and ticked <strong>Active</strong> is sold at the counter. <strong>Fixed price</strong> units are whole numbers; <strong>Per kg</strong> is weighed.${isAdmin() ? '' : ' Only the admin can set prices.'}</p>
    <div class="price-opt head"><span>Unit</span><span>Sold by</span><span>Price (₱)</span><span></span><span></span></div>
    ${product.options.map((o) => optionRow(o)).join('')}
    ${missing.length ? `<h3>Units this product does not have yet</h3>${missing.map((u) => optionRow(null, u)).join('')}` : ''}`;
  };
  await openDialog({
    title: `${product.name}: units and prices`, body: render(),
    actions: [{ label: 'Done', kind: 'primary', value: true }],
    onOpen: (dlg) => {
      const bodyEl = dlg.querySelector('.dlg-body');
      // Giving a price to a unit that had none turns it on (it can still be unticked before saving).
      bodyEl.addEventListener('input', (e) => {
        if (e.target.dataset.f !== 'price') return;
        const row = e.target.closest('.price-opt');
        if (row.dataset.priced === '0' && e.target.value.trim() !== '') row.querySelector('[data-f="active"]').checked = true;
      });
      bodyEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-save]');
        if (!btn) return;
        const row = btn.closest('.price-opt');
        const field = (f) => row.querySelector(`[data-f="${f}"]`);
        const payload = { active: field('active').checked };
        if (isAdmin() && field('price').value.trim() !== '') payload.price = field('price').value;
        try {
          const isNew = btn.dataset.save.startsWith('new:');
          const r = isNew
            ? await api('POST', `/api/other-products/${product.id}/options`, { ...payload, unit: btn.dataset.save.slice(4) })
            : await api('PATCH', `/api/other-product-options/${btn.dataset.save}`, payload);
          product = r.other_product;
          bodyEl.innerHTML = render();
          toast('Saved.', 'ok');
        } catch (err) { $('#optErr', dlg).innerHTML = errorBox(err); }
      });
    },
  });
  reload();
}

// ---- Product pictures (Revision 11) -----------------------------------------------------------------
// One picture per product for the New order cards. The photo is made smaller here (at most 480 pixels, as a JPEG) before it is sent, so it
// loads fast on the counter. Without a picture the card shows an icon.

const MAX_SIDE = 480;

/** Read a chosen photo and shrink it. Resolves with a "data:image/jpeg;base64,..." text. */
function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { reject(new Error('Choose a JPEG, PNG or WebP photo.')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The photo could not be read.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a photo the app can show.'));
      img.onload = () => {
        const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';   // a transparent PNG gets a white background, as on a printed price list
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function pictureDialog(kind, product) {
  let changed = false;
  let pending = null;   // the shrunk photo waiting to be saved
  const url = `/api/product-images/${kind}/${product.id}`;
  await openDialog({
    title: `${product.name}: picture`,
    body: `<div id="picErr"></div>
      <div class="pic-preview"><span class="ico ico--large" id="picNow" aria-hidden="true">${productPicture(kind, product)}</span></div>
      <p class="muted">Shown on the New order card.</p>
      <div class="field"><label for="picFile">Choose a photo (JPEG, PNG or WebP)</label><input id="picFile" type="file" accept="image/jpeg,image/png,image/webp"></div>`,
    onOpen: (dlg) => {
      watchImages(dlg);
      $('#picFile', dlg).onchange = async (e) => {
        $('#picErr', dlg).innerHTML = '';
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          pending = await shrinkPhoto(file);
          $('#picNow', dlg).innerHTML = `<img class="pic" src="${pending}" alt="">`;
        } catch (err) { pending = null; $('#picErr', dlg).innerHTML = errorBox(err); }
      };
    },
    actions: [
      { label: 'Close', value: false },
      ...(product.image_version ? [{
        label: 'Remove picture', kind: 'danger',
        onClick: async (dlg) => {
          try { await api('DELETE', url); changed = true; return true; } catch (err) { $('#picErr', dlg).innerHTML = errorBox(err); return false; }
        },
      }] : []),
      {
        label: 'Save picture', kind: 'primary',
        onClick: async (dlg) => {
          if (!pending) { $('#picErr', dlg).innerHTML = errorBox({ message: 'Choose a photo first.' }); return false; }
          try { await api('PUT', url, { data_url: pending }); changed = true; return true; } catch (err) { $('#picErr', dlg).innerHTML = errorBox(err); return false; }
        },
      },
    ],
  });
  if (changed) { toast('Picture saved.', 'ok'); reload(); }
}

// ---- Services (Revision 19) ----------------------------------------------------------------------
// Every service the cashier can pick has its own name, note and fee. The admin adds services, renames and prices them, and can hide
// one (it is never deleted, so old orders keep reading correctly). Live never has a fee.

const KIND_TEXT = { LIVE: 'Live chicken', POUR: 'Pour (burned)', NOT_POUR: 'Dress (dressed)' };
const CUT_TEXT = { NONE: 'whole', SLICE: 'sliced, asks the size', DUKOT: 'Dukot' };
const serviceAbout = (s) => (s.kind === 'LIVE' ? KIND_TEXT.LIVE : `${KIND_TEXT[s.kind]}, ${CUT_TEXT[s.cut]}`);

async function feesTab(body) {
  const { services } = await api('GET', '/api/services');
  const admin = isAdmin();
  const rows = services.map((s) => {
    const free = s.kind === 'LIVE';
    if (!admin) {
      return `<tr class="${s.active ? '' : 'muted'}"><td><strong>${esc(s.label)}</strong>${s.active ? '' : ' <span class="chip">hidden</span>'}<div class="hint">${esc(serviceAbout(s))}</div></td>
        <td>${free ? 'No fee' : formatPeso(s.fee_centavos)}</td><td>${free ? '' : FEE_BASIS_LABELS[s.fee_basis]}</td><td></td></tr>`;
    }
    return `<tr class="${s.active ? '' : 'muted'}" data-row="${esc(s.code)}">
      <td><input type="text" maxlength="40" aria-label="Name of ${esc(s.label)}" data-f="label" value="${esc(s.label)}">
        <input type="text" maxlength="80" class="mt-s" aria-label="Note under ${esc(s.label)}" data-f="note" placeholder="Short note under the button" value="${esc(s.note)}">
        <div class="hint">${esc(serviceAbout(s))}${s.builtin ? '' : ' · added by you'}${s.active ? '' : ' · <strong>hidden</strong>'}</div></td>
      <td>${free ? '<span class="muted">No fee</span>' : `<input type="text" inputmode="decimal" aria-label="${esc(s.label)} fee in pesos" data-f="fee" value="${esc(pesoInput(s.fee_centavos) || '0')}">`}</td>
      <td>${free ? '' : `<select aria-label="${esc(s.label)} fee basis" data-f="basis">${FEE_BASIS.map((b) => `<option value="${b}" ${s.fee_basis === b ? 'selected' : ''}>${FEE_BASIS_LABELS[b]}</option>`).join('')}</select>`}</td>
      <td class="right"><button type="button" class="btn btn--small btn--primary" data-save="${esc(s.code)}">Save</button>
        <button type="button" class="btn btn--small" data-toggle="${esc(s.code)}" data-active="${s.active ? 1 : 0}">${s.active ? 'Hide' : 'Show'}</button></td></tr>`;
  });
  body.innerHTML = `
    <div class="note-box">Each service has its own fee, charged on top of the chicken price. <strong>Live</strong> never has a fee. ${admin ? '<strong>Per line (flat)</strong> charges the fee once for each line on the order, whatever the number of heads. <strong>Per head</strong> multiplies it by the number of heads (3 heads at ₱45 = ₱135). <strong>Per kg</strong> charges by the total weight. <strong>Hide</strong> takes a service off the New order screen; old orders keep it.' : 'Only the admin can change these.'}</div>
    ${admin ? '<div class="mt-s"><button type="button" class="btn btn--primary" data-add="1">+ Add service</button></div>' : ''}
    <div id="feeMsg"></div>
    <div class="table-wrap mt-s"><table class="data"><thead><tr><th>Service</th><th>Fee (₱)</th><th>Charged</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  if (!admin) return;
  const done = async (text) => { $('#feeMsg').innerHTML = ''; toast(text, 'ok'); await refreshConfig(api).catch(() => {}); mountCatalog($('#main')); };
  body.onclick = async (e) => {
    try {
      if (e.target.closest('[data-add]')) { await serviceDialog(); return; }
      const save = e.target.closest('[data-save]');
      if (save) {
        const row = save.closest('tr');
        const f = (k) => row.querySelector(`[data-f="${k}"]`);
        const payload = { label: f('label').value, note: f('note').value };
        if (f('fee')) { payload.fee = f('fee').value; payload.basis = f('basis').value; }
        await api('PUT', `/api/services/${save.dataset.save}`, payload);
        await done(`${f('label').value.trim()} saved.`);
        return;
      }
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        const hide = toggle.dataset.active === '1';
        await api('PUT', `/api/services/${toggle.dataset.toggle}`, { active: !hide });
        await done(hide ? 'Service hidden from New order.' : 'Service shown on New order.');
      }
    } catch (err) { $('#feeMsg').innerHTML = errorBox(err); }
  };
}

/** The Add service form: a name, what it is (so the butcher and the reports know), and its own fee. */
async function serviceDialog() {
  const saved = await openDialog({
    title: 'Add service',
    body: `<div id="sErr"></div><div class="form-grid">
        <div class="field"><label for="sLabel">Name (the button on New order)</label><input id="sLabel" type="text" maxlength="40" placeholder="For example Deboned"></div>
        <div class="field"><label for="sNote">Short note <span class="muted">(optional)</span></label><input id="sNote" type="text" maxlength="80" placeholder="Shown under the name"></div>
        <div class="field"><label for="sKind">Is it a Pour or a Dress service?</label><select id="sKind"><option value="NOT_POUR">Dress (dressed chicken)</option><option value="POUR">Pour (burned chicken)</option></select>
          <span class="hint">The butcher screen and the reports group it this way.</span></div>
        <div class="field"><label for="sCut">Cutting</label><select id="sCut"><option value="NONE">Whole (no cutting)</option><option value="SLICE">Sliced (the cashier picks small, medium or large)</option><option value="DUKOT">Dukot (inside removed, not sliced)</option></select></div>
        <div class="field"><label for="sFee">Fee (₱)</label><input id="sFee" type="text" inputmode="decimal" value="0"><span class="hint">0 means no fee.</span></div>
        <div class="field"><label for="sBasis">Charged</label><select id="sBasis">${FEE_BASIS.map((b) => `<option value="${b}" ${b === 'per_head' ? 'selected' : ''}>${FEE_BASIS_LABELS[b]}</option>`).join('')}</select></div>
      </div>`,
    actions: [
      { label: 'Cancel', value: false },
      {
        label: 'Add service', kind: 'primary',
        onClick: async (dlg) => {
          try {
            await api('POST', '/api/services', { label: $('#sLabel', dlg).value, note: $('#sNote', dlg).value, kind: $('#sKind', dlg).value, cut: $('#sCut', dlg).value, fee: $('#sFee', dlg).value, basis: $('#sBasis', dlg).value });
            return true;
          } catch (err) { $('#sErr', dlg).innerHTML = errorBox(err); return false; }
        },
      },
    ],
  });
  if (saved === true) { toast('Service added. It is on New order now.', 'ok'); await reload(); }
}

// ---- Price history (admin) -----------------------------------------------------------------------

async function historyTab(body) {
  const { history } = await api('GET', '/api/price-history');
  const kind = { CHICKEN_PRICE: 'Chicken price per kg', SERVICE_FEE: 'Service fee', OTHER_PRICE: 'Other product price' };
  body.innerHTML = history.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>What</th><th>Item</th><th class="num">Old</th><th class="num">New</th><th>Changed by</th></tr></thead><tbody>
    ${history.map((h) => `<tr><td class="nowrap">${esc(fmtDateTime(h.changed_at))}</td><td>${esc(kind[h.kind])}</td>
      <td>${esc(h.kind === 'SERVICE_FEE' ? (FEE_LABELS[h.subject] ?? h.subject_name ?? h.subject) : h.subject_name)}</td>
      <td class="num">${h.old_value === null ? '' : formatPeso(h.old_value)}${h.old_basis ? ` ${h.old_basis === 'per_kg' ? '/kg' : ''}` : ''}</td>
      <td class="num">${formatPeso(h.new_value)}${h.new_basis === 'per_kg' ? ' /kg' : ''}</td><td>${esc(h.changed_by_name)}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">No price changes recorded yet.</div>';
}
