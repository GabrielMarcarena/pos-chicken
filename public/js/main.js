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
import { mountButcher, stopButcher } from './views/butcher.js';
import { mountCustomer, unmountCustomer } from './views/customer.js';
import { startCustomerLink } from './customerLink.js';
import { installShortcuts, setScreenKeys, showShortcuts, hasKeyboard } from './keys.js';

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

// Revision 15: two screens that show only one job and never draw the top bar (no tabs):
//   #/butcher   the TV in the butcher area. Needs a sign-in (the "display" account, or any staff to look at it).
//   #/customer  the second monitor facing the customer. No sign-in: the cashier window sends it a summary of the order (customerLink.js).
const isCustomerScreen = () => location.hash === '#/customer';
function leaveDisplayScreens() { stopButcher(); unmountCustomer(); }

function drawTopbar(current) {
  const bar = $('#topbar');
  if (!state.user) { bar.hidden = true; return; }
  bar.hidden = false;
  const links = ROUTES.filter((r) => RANK[state.user.role] >= RANK[r.role])
    .map((r) => `<a href="${r.path}" ${r.path === current ? 'aria-current="page"' : ''}>${esc(r.label)}</a>`).join('');
  bar.innerHTML = `
    <span class="brand">Chicken POS</span>
    <nav class="nav" aria-label="Main">${links}</nav>
    <div class="who">${hasKeyboard() ? '<button type="button" class="btn btn--small btn--plain" id="keysHelp" title="Keyboard shortcuts (?)">⌨ Keys</button>' : ''}
      <span>${esc(state.user.display_name)} <span class="muted">(${esc(state.user.role)})</span></span>
      <button type="button" class="btn btn--small" id="logout">Sign out</button></div>`;
  // Tapping the tab you are already on starts that screen fresh (for example a new order after "Order saved").
  bar.querySelectorAll('.nav a').forEach((a) => { a.onclick = () => { if (location.hash === a.getAttribute('href')) route(); }; });
  if ($('#keysHelp')) $('#keysHelp').onclick = () => showShortcuts();
  $('#logout').onclick = async () => {
    try { await api('POST', '/api/logout', {}); } catch { /* signing out locally anyway */ }
    sessionStorage.removeItem('pos-draft');
    state.user = null; state.config = null; state.draft = null;
    route();
  };
}

export async function route() {
  if (isCustomerScreen()) {
    stopButcher();
    $('#topbar').hidden = true;
    main().innerHTML = '';
    mountCustomer(main());
    return;
  }
  if (state.user && (state.user.role === 'display' || location.hash === '#/butcher')) {
    // The butcher TV account can open this screen and nothing else. Staff may open it too, to see what the TV shows.
    unmountCustomer();
    if (state.user.role === 'display' && location.hash !== '#/butcher') location.hash = '#/butcher';
    $('#topbar').hidden = true;
    main().innerHTML = '';
    setScreenKeys(null);
    await mountButcher(main());
    return;
  }
  leaveDisplayScreens();
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
  setScreenKeys(null);   // the new screen sets its own keys, if it has any
  await allowed.mount(main());
  main().focus({ preventScroll: true });
}

async function startSession() {
  if (state.user.role === 'display') {   // the butcher TV: no price list, no order in progress
    location.hash = '#/butcher';
    return route();
  }
  await refreshConfig(api);
  loadDraft();
  startCustomerLink();   // from now on a Customer screen on the second monitor can follow this window
  saveDraft();
  if (!ROUTES.some((r) => r.path === location.hash) && location.hash !== '#/butcher') location.hash = '#/new';
  route();
}

setUnauthorizedHandler(() => {
  if (!state.user) return;
  toast('You were signed out. Sign in again; your unsent order is still here.', 'error');
  state.user = null;
  route();
});

window.addEventListener('hashchange', () => { if (state.user || isCustomerScreen()) route(); });
installShortcuts();

(async () => {
  if (isCustomerScreen()) { route(); return; }   // the customer window never asks the server anything
  try {
    const { user } = await api('GET', '/api/me');
    state.user = user; // null when nobody is signed in
    if (user) await startSession(); else route();
  } catch {
    route();
  }
})();
