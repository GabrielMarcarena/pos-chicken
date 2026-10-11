// The shop works in Philippine time (UTC+8, no daylight saving). Timestamps are stored in UTC.

const PHT_OFFSET_MS = 8 * 3600 * 1000;

/** "2026-10-09" for the Philippine calendar day that contains this moment. */
export function toBusinessDate(date) {
  return new Date(date.getTime() + PHT_OFFSET_MS).toISOString().slice(0, 10);
}

/** "2026-10-09 14:05" in Philippine time from a UTC ISO string. */
export function toPhtDateTime(iso) {
  if (!iso) return '';
  return new Date(new Date(iso).getTime() + PHT_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** Convert "2026-10-09T14:05" typed in Philippine time into a UTC ISO string, or null if invalid. */
export function phtLocalToIso(text) {
  if (!text) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:00+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
