// The cash change calculator on the payment panel. The browser shows its answer; the server (src/services/orders.js) repeats the same
// rules before anything is saved, so a wrong number can never be stored even if this screen were bypassed.
//
//   Change = Money Received - Amount Paid
//   Amount Paid must be the order total (no part payments are recorded), so a payment below it is "Insufficient payment".
//   Money Received must cover Amount Paid; below that it is "Insufficient payment" too.
//
// Everything is whole centavos. Blank, negative, text and zero values give a plain message and never a number.

import { parsePesosToCentavos, formatPeso } from './money.js';

/**
 * Read an amount a person typed: "1000", "1,000", "1,000.50", "12,5" (a decimal comma), "₱ 456".
 * Returns { value } in centavos, or { value: null, error: 'blank' | 'negative' | 'invalid' }.
 */
export function parseMoneyInput(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { value: null, error: 'blank' };
  if (raw.includes('-')) return { value: null, error: 'negative' };
  let s = raw.replace(/^₱/, '').replace(/\s/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');   // 1,000 and 12,345.50 are thousands commas
  else if (/^\d*,\d{1,2}$/.test(s)) s = s.replace(',', '.');           // 12,5 is a decimal comma
  const value = parsePesosToCentavos(s);
  return value === null ? { value: null, error: 'invalid' } : { value };
}

/** What a money box keeps while someone types: digits, one kind of separator and a minus sign (kept so a negative can be reported, never hidden). */
export const typedMoneyText = (text) => String(text ?? '').replace(/[^\d.,-]/g, '').slice(0, 16);

/** 45600 -> "456.00" (the plain form the server reads). */
export const pesoPlain = (centavos) => `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, '0')}`;

/**
 * Check a cash payment.
 *   totalCentavos   the order total
 *   paidText        Amount Paid as typed (the screen fills in the total until the cashier changes it)
 *   receivedText    Money Received as typed
 * Returns { paid, received, change, problems, insufficient, ok }:
 *   change is a number only when Money Received covers Amount Paid, otherwise null;
 *   problems is a list of { code, field, message } in plain words (empty when ok);
 *   insufficient is true when a payment is below what is due, so the order must not be finished as fully paid.
 */
export function cashCheck({ totalCentavos, paidText, receivedText }) {
  const problems = [];
  const add = (code, field, message) => problems.push({ code, field, message });
  let insufficient = false;

  const paidRead = parseMoneyInput(paidText);
  const paid = paidRead.value;
  if (paidRead.error === 'negative') add('NEGATIVE', 'paid', 'Amount Paid cannot be negative.');
  else if (paidRead.error) add('INVALID', 'paid', 'Enter the Amount Paid, for example 208.80.');
  else if (paid <= 0) add('ZERO', 'paid', 'Amount Paid must be above ₱0.00.');
  else if (paid < totalCentavos) {
    insufficient = true;
    add('INSUFFICIENT', 'paid', `Insufficient payment. Amount Paid (${formatPeso(paid)}) is less than the order total (${formatPeso(totalCentavos)}). The order cannot be finished as fully paid.`);
  } else if (paid > totalCentavos) {
    add('OVERPAID', 'paid', `Amount Paid (${formatPeso(paid)}) is more than the order total (${formatPeso(totalCentavos)}). Amount Paid must match the order total. Type the cash handed over in Money Received.`);
  }

  const receivedRead = parseMoneyInput(receivedText);
  const received = receivedRead.value;
  if (receivedRead.error === 'blank') add('BLANK', 'received', 'Enter the Money Received from the customer.');
  else if (receivedRead.error === 'negative') add('NEGATIVE', 'received', 'Money Received cannot be negative.');
  else if (receivedRead.error) add('INVALID', 'received', 'Money Received must be an amount such as 1000 or 1000.50.');
  else if (received <= 0) add('ZERO', 'received', 'Money Received must be above ₱0.00.');

  let change = null;
  if (paid !== null && paid > 0 && received !== null && received > 0) {
    if (received < paid) {
      insufficient = true;
      add('INSUFFICIENT', 'received', `Insufficient payment. Money Received (${formatPeso(received)}) is less than Amount Paid (${formatPeso(paid)}).`);
    } else change = received - paid;
  }
  // A payment below the amount due shows no change at all: the order cannot be finished as fully paid, so there is nothing to hand back.
  if (insufficient) change = null;
  return { paid, received, change, problems, insufficient, ok: problems.length === 0 };
}
