// Starts the app, draws the top bar, and shows the screen that matches the address (#/new, #/orders ...).
import { api, setUnauthorizedHandler } from './api.js';
import { $, esc, toast } from './util.js';
import { state, loadDraft, saveDraft, refreshConfig } from './state.js';
import { mountLogin } from './views/login.js';
import { mountCheckout } from './views/checkout.js';
import { mountBoard } from './views/board.js';
import { mountOrders } from './views/orders.js';
import { mountCatalog } from './views/catalog.js';
import { mountInventory } from './views/inventory.js';
import { mountUsers } from './views/users.js';

const RANK = { cashier: 1, manager: 2, admin: 3 };
const ROUTES = [
  { path: '#/new', label: 'New order', role: 'cashier', mount: mountCheckout },
  { path: '#/board', label: 'Order List', role: 'cashier', mount: mountBoard },
  { path: '#/orders', label: 'Orders', role: 'cashier', mount: mountOrders },
  { path: '#/products', label: 'Products', role: 'manager', mount: mountCatalog },
  { path: '#/inventory', label: 'Daily Inventory', role: 'cashier', mount: mountInventory },   // right beside Products
  { path: '#/users', label: 'Users', role: 'admin', mount: mountUsers },
];

const main = () => $('#main');

function drawTopbar(current) {
  const bar = $('#topbar');
  if (!state.user) { bar.hidden = true; return; }
  bar.hidden = false;
  const links = ROUTES.filter((r) => RANK[state.user.role] >= RANK[r.role])
    .map((r) => `<a href="${r.path}" ${r.path === current ? 'aria-current="page"' : ''}>${esc(r.label)}</a>`).join('');
  bar.innerHTML = `
    <span class="brand">Chicken POS</span>
    <nav class="nav" aria-label="Main">${links}</nav>
    <div class="who"><span>${esc(state.user.display_name)} <span class="muted">(${esc(state.user.role)})</span></span>
      <button type="button" class="btn btn--small" id="logout">Sign out</button></div>`;
  // Tapping the tab you are already on starts that screen fresh (for example a new order after "Order saved").
  bar.querySelectorAll('.nav a').forEach((a) => { a.onclick = () => { if (location.hash === a.getAttribute('href')) route(); }; });
  $('#logout').onclick = async () => {
    try { await api('POST', '/api/logout', {}); } catch { /* signing out locally anyway */ }
    sessionStorage.removeItem('pos-draft');
    state.user = null; state.config = null; state.draft = null;
    route();
  };
}

export async function route() {
  if (!state.user) {
    drawTopbar('');
    mountLogin(main(), async (user) => { state.user = user; await startSession(); });
    return;
  }
  const wanted = ROUTES.find((r) => r.path === location.hash) ?? ROUTES[0];
  const allowed = RANK[state.user.role] >= RANK[wanted.role] ? wanted : ROUTES[0];
  drawTopbar(allowed.path);
  document.title = `${allowed.label} - Chicken POS`;
  main().innerHTML = '';
  await allowed.mount(main());
  main().focus({ preventScroll: true });
}

async function startSession() {
  await refreshConfig(api);
  loadDraft();
  saveDraft();
  if (!ROUTES.some((r) => r.path === location.hash)) location.hash = '#/new';
  route();
}

setUnauthorizedHandler(() => {
  if (!state.user) return;
  toast('You were signed out. Sign in again; your unsent order is still here.', 'error');
  state.user = null;
  route();
});

window.addEventListener('hashchange', () => { if (state.user) route(); });

(async () => {
  try {
    const { user } = await api('GET', '/api/me');
    state.user = user; // null when nobody is signed in
    if (user) await startSession(); else route();
  } catch {
    route();
  }
})();
