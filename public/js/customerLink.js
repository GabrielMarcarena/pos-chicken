// The link between the cashier window and the Customer screen (the second monitor). Both windows are on the same computer and the same site,
// so the browser's BroadcastChannel carries a small summary of the order from one to the other. Nothing goes through the server, so it works
// with no internet and updates as the cashier types. The Customer screen only receives what the cashier window chooses to send.
const NAME = 'pos-customer';
let channel = null;
let last = { type: 'idle' };

/** Cashier side: start answering. A Customer window that opens late sends 'hello' and is sent the latest summary at once. */
export function startCustomerLink() {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel(NAME);
  channel.onmessage = (e) => { if (e.data?.type === 'hello') channel.postMessage(last); };
}

/** Cashier side: send a new summary: { type: 'idle' } | { type: 'order', ... } | { type: 'done', ... }. */
export function publishToCustomer(message) {
  last = message;
  channel?.postMessage(message);
}

/** Customer side: listen. Returns a function that stops listening. */
export function listenAsCustomer(onMessage) {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel(NAME);
  ch.onmessage = (e) => { if (e.data && typeof e.data.type === 'string') onMessage(e.data); };
  ch.postMessage({ type: 'hello' });
  return () => ch.close();
}

/** Cashier side: open the Customer screen in its own clean window (no tabs, no address bar controls in most browsers). */
export function openCustomerWindow() {
  const w = window.open('/#/customer', 'pos-customer', 'popup,width=1024,height=768');
  return w;
}
