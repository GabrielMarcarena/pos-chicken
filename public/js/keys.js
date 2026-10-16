// Keyboard shortcuts (Revision 13), so a cashier can take an order without the mouse.
//
// Anywhere:   F2 New order · F4 Order List · F8 Orders · F9 Daily Inventory · ? this list · Esc back / cancel
// The screen that is showing can add its own keys with setScreenKeys(fn): fn(event) returns true when it used the key. A screen's own
// handlers on #main run first; a key they already used (event.defaultPrevented) is left alone here.
// Keys are never taken from someone typing a word (a name, a note, a search), except F-keys and Esc.
import { openDialog } from './util.js';

/** Is this a device with a keyboard and a mouse (a till), not a phone or tablet? The key badges are only shown there. */
export const hasKeyboard = () => window.matchMedia?.('(pointer: fine)').matches ?? false;

/** A small key label on a button, e.g. keyBadge('1') or keyBadge('Alt+2'). Nothing on touch screens. */
export const keyBadge = (text) => (hasKeyboard() ? `<kbd class="key-badge" aria-hidden="true">${text}</kbd>` : '');

const SCREENS = { F2: '#/new', F4: '#/board', F8: '#/orders', F9: '#/inventory' };
let screenKeys = null;

/** The keys of the screen that is showing (null when it has none). Called by main.js on every screen change. */
export function setScreenKeys(fn) { screenKeys = fn; }

/** Is the person typing text right now (so letters and digits belong to the box)? */
export function typingIn(el = document.activeElement) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(el.type);
}

export const SHORTCUTS = [
  ['Anywhere', [['F2', 'New order'], ['F4', 'Order List'], ['F8', 'Orders'], ['F9', 'Daily Inventory'], ['?', 'This list of keys'], ['Esc', 'Back, or cancel']]],
  ['New order: choosing', [['1 to 9', 'Choose the product with that number (top row or number pad)'], ['← →', 'Chicken / Other products / Advanced'],
    ['/', 'Search other products'], ['Enter', 'Review order']]],
  ['New order: one product', [['Numbers and .', 'Type the weight (or quantity)'], ['+ / −', 'One more / one less head (or piece)'],
    ['Alt+1 to Alt+9', 'Choose the service, the selling option, or which chicken (the number is on the button)'], ['Backspace', 'Delete the last number'],
    ['Enter', 'Add to order'], ['Esc', 'Cancel']]],
  ['Review', [['D', 'Discount'], ['P', 'Next payment method (Cash, GCash ...)'], ['Space', 'Tick "I have reviewed this order"'],
    ['Enter', 'Submit the order (when everything is filled in)'], ['Esc', 'Back to the order']]],
  ['Order saved', [['Enter', 'New order'], ['Ctrl+P', 'Print slip']]],
  ['Any question box', [['Enter', 'The main button'], ['Esc', 'Cancel']]],
];

export function showShortcuts() {
  const body = SHORTCUTS.map(([title, keys]) => `<h3 class="keys-title">${title}</h3>
    <table class="data keys-table"><tbody>${keys.map(([k, what]) => `<tr><td class="nowrap"><kbd>${k}</kbd></td><td>${what}</td></tr>`).join('')}</tbody></table>`).join('');
  return openDialog({ title: 'Keyboard shortcuts', body, actions: [{ label: 'Close', kind: 'primary', value: true }] });
}

function onKey(e) {
  if (e.defaultPrevented || e.isComposing) return;
  if (document.getElementById('dialog')?.open) return;   // a question box handles its own keys (util.js)
  const bare = !e.altKey && !e.ctrlKey && !e.metaKey;
  if (bare && SCREENS[e.key] && !document.getElementById('topbar')?.hidden) {
    const link = document.querySelector(`#topbar a[href="${SCREENS[e.key]}"]`);
    if (!link) return;   // not allowed for this account
    e.preventDefault();
    link.click();
    return;
  }
  if (screenKeys?.(e)) { e.preventDefault(); return; }
  if (e.key === '?' && !typingIn() && !e.ctrlKey && !e.metaKey && document.getElementById('topbar') && !document.getElementById('topbar').hidden) {
    e.preventDefault();
    showShortcuts();
  }
}

export function installShortcuts() {
  document.addEventListener('keydown', onKey);
}
