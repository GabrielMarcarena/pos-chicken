// Money, weight and quantity helpers.
//
// Rules that keep the numbers exact:
//   * Money is stored as whole centavos (₱58.00 = 5800).
//   * Weight is stored as whole grams (3.6 kg = 3600).
//   * Other-product quantity is stored in thousandths (1.5 kg = 1500).
//   * Rounding is always "half up to the centavo", applied once per amount.
// Floating point is never used for saved amounts.

const DECIMAL = /^(\d*)(?:\.(\d*))?$/;

/** Parse "3.6" into 3600 (decimals = 3). Returns null when the text is not a plain non-negative decimal. */
export function parseScaled(input, decimals) {
  if (input === null || input === undefined || typeof input === 'boolean') return null;
  const text = String(input).trim();
  const m = DECIMAL.exec(text);
  if (!m) return null;
  const whole = m[1] ?? '';
  const frac = m[2] ?? '';
  if (whole === '' && frac === '') return null;
  if (frac.length > decimals || whole.length > 9) return null;
  return Number(whole || '0') * 10 ** decimals + Number(frac.padEnd(decimals, '0') || '0');
}

/** Weight in kg (up to 3 decimals) to grams. Must be above 0 and at most 1,000 kg. */
export function parseWeightToGrams(input) {
  const g = parseScaled(input, 3);
  return g !== null && g > 0 && g <= 1_000_000 ? g : null;
}

/** Pesos (up to 2 decimals) to centavos. */
export function parsePesosToCentavos(input, max = 10_000_000_000) {
  const c = parseScaled(input, 2);
  return c !== null && c <= max ? c : null;
}

/** Quantity of an other product (up to 3 decimals) to thousandths. Must be above 0, at most 1,000 units. */
export function parseQuantityToMilli(input) {
  const q = parseScaled(input, 3);
  return q !== null && q > 0 && q <= 1_000_000 ? q : null;
}

/**
 * A stock count for the Daily Inventory: zero or more, up to 1,000,000. Chicken and fixed-price items are whole numbers
 * (whole: true); items sold by weight may have up to 3 decimals. Returns thousandths, or null when it is not valid.
 */
export const MAX_STOCK_MILLI = 1_000_000_000;
export function parseCountToMilli(input, { whole = true } = {}) {
  const q = parseScaled(input, 3);
  if (q === null || q > MAX_STOCK_MILLI) return null;
  if (whole && q % 1000 !== 0) return null;
  return q;
}

/** Number of heads (chickens) on one line: a whole number from 1 to 999. Returns null when it is not valid. */
export const MAX_HEADS = 999;
export function parseHeads(input) {
  if (typeof input === 'boolean' || input === null || input === undefined) return null;
  const text = String(input).trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= MAX_HEADS ? n : null;
}

/** Percentage (up to 2 decimals) to basis points: "20" -> 2000, "12.5" -> 1250. Must be above 0 and at most 100%. */
export function parsePercentToBp(input) {
  const bp = parseScaled(input, 2);
  return bp !== null && bp > 0 && bp <= 10_000 ? bp : null;
}

/** "5" -> 5000 thousandths. Whole numbers only (for things sold by the piece, dozen, pack or batch). */
export function parseWholeQuantityToMilli(input) {
  const q = parseQuantityToMilli(input);
  return q !== null && q % 1000 === 0 ? q : null;
}

/** round-half-up(a * b / d) using integers only. */
export function mulDivRound(a, b, d) {
  const product = a * b;
  if (!Number.isSafeInteger(product)) throw new RangeError('Amount too large');
  return Math.floor((product * 2 + d) / (2 * d));
}

export function formatPeso(centavos) {
  const negative = centavos < 0;
  const abs = Math.abs(centavos);
  const pesos = Math.floor(abs / 100).toLocaleString('en-US');
  return `${negative ? '-' : ''}₱${pesos}.${String(abs % 100).padStart(2, '0')}`;
}

/** 3600 -> "3.6", 2000 -> "2.0", 1250 -> "1.25" */
export function formatThousandths(n) {
  let s = (n / 1000).toFixed(3).replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  return s;
}

export const formatKg = formatThousandths;

/** 2000 -> "20%", 1250 -> "12.5%" */
export const formatPercent = (bp) => `${String(bp / 100)}%`;
