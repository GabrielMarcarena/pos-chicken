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
import { installFun } from './fun.js';
import { installShortcuts, setScreenKeys, showShortcuts, hasKeyboard } from './keys.js';

// Same order as the server (src/services/users.js). The Assistant Cashier (Revision 16) can only reach the screens marked 'assistant'.
const RANK = { display: 0, assistant: 1, cashier: 2, manager: 3, admin: 4 };
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', cashier: 'Cashier', assistant: 'Assistant Cashier', display: 'Butcher TV' };
const ROUTES = [
  { path: '#/new', label: 'New order', role: 'cashier', mount: mountCheckout },
  { path: '#/board', label: 'Order List', role: 'assistant', mount: mountBoard },
  { path: '#/orders', label: 'Orders', role: 'cashier', mount: mountOrders },
  { path: '#/products', label: 'Products', role: 'manager', mount: mountCatalog },
  { path: '#/inventory', label: 'Daily Inventory', role: 'cashier', mount: mountInventory },   // right beside Products
  { path: '#/users', label: 'Users', role: 'admin', mount: mountUsers },
];

const main = () => $('#main');

// Two screens that show only one job and never draw the top bar (no tabs). Each has its own plain address (Revision 16):
//   /butcher        the TV in the butcher area. Needs a sign-in (the Butcher TV account, or any staff to look at it).
//   /customerscreen the second monitor facing the customer. No sign-in: the cashier window sends it a summary of the order (customerLink.js).
// The older #/butcher and #/customer addresses keep working.
const atPath = (name) => location.pathname.replace(/\/+$/, '') === name;
const isCustomerScreen = () => atPath('/customerscreen') || location.hash === '#/customer';
const isButcherScreen = () => atPath('/butcher') || location.hash === '#/butcher';
function leaveDisplayScreens() { stopButcher(); unmountCustomer(); }

function drawTopbar(current) {
  const bar = $('#topbar');
  if (!state.user) { bar.hidden = true; delete document.body.dataset.role; return; }
  document.body.dataset.role = state.user.role;   // the mouse pointer takes the colour of this role (app.css)
  bar.hidden = false;
  const links = ROUTES.filter((r) => RANK[state.user.role] >= RANK[r.role])
    .map((r) => `<a href="${r.path}" ${r.path === current ? 'aria-current="page"' : ''}>${esc(r.label)}</a>`).join('');
  bar.innerHTML = `
    <span class="brand">Chicken POS</span>
    <nav class="nav" aria-label="Main">${links}</nav>
    <div class="who">${hasKeyboard() ? '<button type="button" class="btn btn--small btn--plain" id="keysHelp" title="Keyboard shortcuts (?)">⌨ Keys</button>' : ''}
      <span>${esc(state.user.display_name)} <span class="role-badge">(${esc(ROLE_LABEL[state.user.role] ?? state.user.role)})</span></span>
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
  if (state.user && (state.user.role === 'display' || isButcherScreen())) {
    // The butcher TV account can open this screen and nothing else. Staff may open it too, to see what the TV shows.
    unmountCustomer();
    if (state.user.role === 'display' && !isButcherScreen()) location.hash = '#/butcher';
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
  const open = ROUTES.filter((r) => RANK[state.user.role] >= RANK[r.role]);   // what this account may use (an Assistant Cashier has only the Order List)
  const wanted = ROUTES.find((r) => r.path === location.hash);
  const allowed = wanted && open.includes(wanted) ? wanted : open[0];
  drawTopbar(allowed.path);
  document.title = `${allowed.label} - Chicken POS`;
  main().innerHTML = '';
  setScreenKeys(null);   // the new screen sets its own keys, if it has any
  await allowed.mount(main());
  main().focus({ preventScroll: true });
}

async function startSession() {
  if (state.user.role === 'display') {   // the butcher TV: no price list, no order in progress
    if (!isButcherScreen()) location.hash = '#/butcher';
    return route();
  }
  if (state.user.role === 'assistant') {   // the Assistant Cashier: no price list and no order in progress, only the Order List
    if (!isButcherScreen()) location.hash = '#/board';
    return route();
  }
  await refreshConfig(api);
  loadDraft();
  startCustomerLink();   // from now on a Customer screen on the second monitor can follow this window
  saveDraft();
  if (!ROUTES.some((r) => r.path === location.hash) && !isButcherScreen()) location.hash = '#/new';
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
installFun();   // Revision 16: feathers on click, and a chicken that wanders when the computer is left alone

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
