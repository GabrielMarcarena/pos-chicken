// The inventory files of the Daily Inventory page.
//
//   Submit Inventory Today   (Revision 11) one Excel file with today's inventory: every chicken product and other product that has a
//                            number, with Beginning Balance, Additional, (Total,) Sold, Left, the chicken losses (Reject, Katay, Dead,
//                            Pull Out) and New Total. Products with 0 in every column are left out, and the file says so under the tables.
//                            The file is saved on this computer (backups/inventory) AND downloaded. The saved copy is checked byte for
//                            byte before it is recorded.
//   Closed Inventory Today and Reset the Day
//                            (Revision 12) ONE step: today's inventory is submitted (the same file as above, saved and recorded) and the
//                            day is closed, in a single transaction. Either both happen or neither does.
//   Export (closed day)      (Revision 12, in place of Export Inventory History) the inventory of one CLOSED business day, in the same
//                            layout as the submitted file: chicken products, then other products. Read-only.
//
// All of them read the saved records (the database is the source of truth). None changes stock or orders.
import fs from 'node:fs';
import path from 'node:path';
import { tx } from '../db.js';
import { HttpError } from '../http.js';
import {
  openDay, prepareOpenDay, inventoryRows, dayFingerprint, insertSubmission, canEditInventory, beginningEdits, sha256, submissionFileOk,
  dayToClose, closeOpenDay, shapeDay,
} from './inventory.js';
import { toPhtDateTime } from '../time.js';
import { Sheet, buildWorkbook, header, formula, date as dateCell } from '../xlsx.js';

const qty = (milli) => milli / 1000;
export const EDIT_COLUMNS = ['Product', 'Old Beginning Balance', 'New Beginning Balance', 'Reason', 'Note', 'Changed by', 'Changed (PH time)'];
const editRow = (e) => [e.name, qty(e.was), qty(e.now), e.reason, e.note, e.by, toPhtDateTime(e.at)];

// ---- The inventory file (submitted, or exported for a closed day) -------------------------------------------------

// The columns of the file, as the shop listed them. Other products have no Total column (it is Beginning + Additional).
export const SUBMIT_CHICKEN_COLUMNS = ['Chicken Product', 'Beginning Balance', 'Additional', 'Total', 'Sold', 'Left', 'Reject', 'Katay', 'Dead', 'Pull Out', 'New Total'];
export const SUBMIT_OTHER_COLUMNS = ['Other Product', 'Beginning Balance', 'Additional', 'Sold', 'Left', 'New Total'];
export const ZERO_NOTE = 'Products with 0 in every column are not included in this record.';

/** A row with 0 in every column: nothing at the start, nothing added, nothing sold and no losses. */
export const allZero = (r) => r.beginning === 0 && r.additional === 0 && r.sold === 0 && (r.kind !== 'CHICKEN' || (r.reject + r.katay + r.dead + r.pull_out) === 0);

/** The numbers of one row, as kept in a submission's snapshot and written to the file. */
const snapRow = (r) => ({
  kind: r.kind, item_id: r.item_id, name: r.name, beginning: r.beginning, additional: r.additional, total: r.total, sold: r.sold, left: r.left,
  ...(r.kind === 'CHICKEN' ? { reject: r.reject, katay: r.katay, dead: r.dead, pull_out: r.pull_out } : {}), new_total: r.new_total,
});

/**
 * The inventory workbook. data: { title, info: [[label, value], ...], business_date, chicken, other, edits }. The submitted file and the
 * closed-day export are the same layout; only the title and the lines under it differ.
 */
export function buildInventoryXlsx(data) {
  const sheet = new Sheet(data.sheetName ?? 'Inventory Today');
  const bold = (v) => ({ v, s: 'bold' });
  sheet.addRow([bold(data.title)]);
  sheet.addRow(['Business date', dateCell(data.business_date)]);
  for (const [label, value] of data.info) sheet.addRow([label, value]);
  sheet.addRow([]);

  sheet.addRow([bold('CHICKEN PRODUCTS (counted in heads)')]);
  sheet.addRow(SUBMIT_CHICKEN_COLUMNS.map(header));
  if (!data.chicken.length) sheet.addRow(['None']);
  for (const r of data.chicken) {
    const n = sheet.rows.length + 1;
    sheet.addRow([r.name, qty(r.beginning), qty(r.additional), formula(`B${n}+C${n}`, qty(r.total)), qty(r.sold), formula(`D${n}-E${n}`, qty(r.left)),
      qty(r.reject), qty(r.katay), qty(r.dead), qty(r.pull_out), formula(`F${n}-G${n}-H${n}-I${n}-J${n}`, qty(r.new_total))]);
  }
  sheet.addRow([]);

  sheet.addRow([bold('OTHER PRODUCTS (counted in pieces, or in the unit named after the product)')]);
  sheet.addRow(SUBMIT_OTHER_COLUMNS.map(header));
  if (!data.other.length) sheet.addRow(['None']);
  for (const r of data.other) {
    const n = sheet.rows.length + 1;
    sheet.addRow([r.name, qty(r.beginning), qty(r.additional), qty(r.sold), formula(`B${n}+C${n}-D${n}`, qty(r.left)), formula(`E${n}`, qty(r.new_total))]);
  }
  sheet.addRow([]);
  const noteRow = sheet.rows.length + 1;
  sheet.addRow([bold(`Note: ${ZERO_NOTE}`)]);
  sheet.addRow([{ v: 'Total = Beginning Balance + Additional. Left = Total - Sold. Chicken: New Total = Left - Reject - Katay - Dead - Pull Out. Other products: New Total = Left. Reject, Katay, Dead and Pull Out are inventory losses, not sales and not discounts.', s: 'wrap' }]);
  // Revision 12: every column wide enough for its heading and its numbers. The title and the two notes are left out of the measuring:
  // they are long single lines that may run across the empty cells beside them.
  sheet.fitColumns({ skipRows: [1, noteRow, noteRow + 1], min: 9, max: 42 });
  sheet.merges.push(`A${noteRow + 1}:K${noteRow + 1}`);
  sheet.heights[noteRow + 1] = 30;

  const edits = new Sheet('Beginning Balance Edits');
  edits.freezeHeader = true;
  edits.addRow(EDIT_COLUMNS.map(header));
  if (!data.edits.length) edits.addRow(['None']);
  for (const e of data.edits) edits.addRow(editRow(e));
  edits.fitColumns({ max: 50 });
  return buildWorkbook([sheet, edits]);
}

/** Kept under its Revision 11 name: the submitted file. */
export const buildSubmissionXlsx = (data) => buildInventoryXlsx({
  title: 'Chicken POS - Submitted Inventory', info: [['Submitted (PH time)', data.submitted_at_pht], ['Submitted by', data.submitted_by]], ...data,
});

/** "inventory_2026-10-15_1742.xlsx": the business date and the PH time of submission; never the name of an earlier file. */
function freeName(dir, date, now) {
  const stamp = toPhtDateTime(now.toISOString()).slice(11).replace(':', '');
  let name = `inventory_${date}_${stamp}.xlsx`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n += 1) name = `inventory_${date}_${stamp}-${n}.xlsx`;
  return name;
}

/**
 * Save the open day's inventory file and record the submission. Call inside tx(), so no order or typed number can slip in between the
 * numbers and the file:
 *   1. the open day's numbers are read (the same rows the Daily Inventory screen shows)
 *   2. the file is built and saved on this computer, then read back and compared byte for byte
 *   3. the submission is recorded with a fingerprint of every number of the day
 * If saving or checking the file fails, nothing is recorded and the half-written file is removed. Returns { result, file } where file
 * is the full path of the saved file (the caller removes it if its transaction fails later).
 */
function writeSubmission(db, user, day, now, dir) {
  const rows = inventoryRows(db, day);
  const negative = [...rows.chicken, ...rows.other].filter((r) => r.new_total < 0).map((r) => r.name);
  if (negative.length) {
    throw new HttpError(409, `The New Total is below zero for ${negative.join(', ')}. Fix the numbers first; a submitted inventory must add up.`, 'NEGATIVE_BALANCE');
  }
  const data = {
    business_date: day.business_date, submitted_at_pht: toPhtDateTime(now.toISOString()), submitted_by: `${user.display_name} (${user.role})`,
    chicken: rows.chicken.filter((r) => !allZero(r)).map(snapRow), other: rows.other.filter((r) => !allZero(r)).map(snapRow),
    left_out: [...rows.chicken, ...rows.other].filter(allZero).length,
    edits: beginningEdits(db, day.id),
  };
  const buffer = buildSubmissionXlsx(data);
  const fileSha = sha256(buffer);
  let fileName = '';
  let full = '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fileName = freeName(dir, day.business_date, now);
    full = path.join(dir, fileName);
    fs.writeFileSync(`${full}.part`, buffer);
    fs.renameSync(`${full}.part`, full);
    if (sha256(fs.readFileSync(full)) !== fileSha) throw new Error('the saved copy does not match');
  } catch (err) {
    if (full) try { fs.rmSync(`${full}.part`, { force: true }); fs.rmSync(full, { force: true }); } catch { /* nothing left to remove */ }
    throw new HttpError(500, `The inventory file could not be saved on this computer (${err.code ?? err.message}, folder ${dir}). Nothing was submitted; please try again.`, 'SAVE_FAILED');
  }
  try {
    const s = insertSubmission(db, { day, user, fileName, fileSha, fingerprint: dayFingerprint(db, day), snapshot: { chicken: data.chicken, other: data.other }, now });
    return {
      file: full,
      result: {
        submission: { id: s.id, file_name: s.file_name, submitted_at: s.submitted_at, by: user.display_name },
        business_date: day.business_date, rows_included: data.chicken.length + data.other.length, rows_left_out: data.left_out, saved_in: dir,
      },
    };
  } catch (err) {
    fs.rmSync(full, { force: true });   // the transaction is rolled back, so the file must not stay behind as if it were submitted
    throw err;
  }
}

/** Submit Inventory Today, on its own (nothing is reset). body.business_date must be the open day. */
export function submitInventory(db, user, body, now = new Date(), { dir }) {
  if (!canEditInventory(user)) throw new HttpError(403, 'Only a manager or the admin can submit the inventory.', 'FORBIDDEN');
  prepareOpenDay(db, now, user);
  return tx(db, () => {
    const day = openDay(db);
    const wanted = String(body?.business_date ?? '');
    if (!day || wanted !== day.business_date) {
      throw new HttpError(409, `The open business day is ${day?.business_date ?? 'not set'}, not ${wanted || '(none given)'}. Reload the page and try again.`, 'WRONG_DAY');
    }
    return writeSubmission(db, user, day, now, dir).result;
  });
}

/**
 * Closed Inventory Today and Reset the Day (Revision 12): submit today's inventory AND close the day, in ONE transaction. Every check of
 * closing still applies (no Ongoing order, no New Total below zero, the business date has started); the submission is made with the
 * numbers the day has at that very moment, so it can never be out of date. If anything fails, the day stays open, nothing is recorded
 * and the saved file is removed again. body.business_date must be the open day the person is looking at.
 */
export function closeAndSubmit(db, user, body, now = new Date(), { dir }) {
  if (!canEditInventory(user)) throw new HttpError(403, 'Only a manager or the admin can close the inventory and start a new business day.', 'FORBIDDEN');
  prepareOpenDay(db, now, user);
  let file = null;
  try {
    return tx(db, () => {
      const { day, notices } = dayToClose(db, user, body, now, { dir, submitting: true });
      const submitted = writeSubmission(db, user, day, now, dir);
      file = submitted.file;
      const closed = closeOpenDay(db, user, day, notices, now);
      return { ...closed, ...submitted.result };
    });
  } catch (err) {
    if (file) fs.rmSync(file, { force: true });   // rolled back: the day is still open, so its file must not look submitted
    throw err;
  }
}

/** The saved file of a submission, checked against what was submitted. */
export function submissionFile(db, id, dir) {
  const s = db.prepare('SELECT * FROM inventory_submissions WHERE id = ?').get(id);
  if (!s) throw new HttpError(404, 'That submitted inventory does not exist.', 'NOT_FOUND');
  if (!submissionFileOk(s, dir)) {
    throw new HttpError(410, `The saved inventory file (${s.file_name}) is missing or was changed on this computer. Press "Submit Inventory Today" again to make a new one.`, 'FILE_MISSING');
  }
  return { name: s.file_name, body: fs.readFileSync(path.join(dir, s.file_name)) };
}

// ---- Export: the inventory of one closed business day (Revision 12) -------------------------------------------------

/**
 * The Export button beside "Closed": one closed business day, in the layout of the submitted file (chicken products, then other
 * products; products with 0 in every column left out). The numbers are the ones the day was closed with. Read-only. An open day is
 * refused: it is still changing (use Submit Inventory Today for it).
 */
export function closedDayExport(db, viewer, date, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) throw new HttpError(400, 'Choose a business day.', 'VALIDATION');
  prepareOpenDay(db, now);
  const day = db.prepare('SELECT * FROM business_days WHERE business_date = ?').get(date);
  if (!day) throw new HttpError(404, 'There is no business day for that date.', 'NOT_FOUND');
  if (day.status !== 'CLOSED') throw new HttpError(409, `Business day ${date} is still open. Only a closed day can be exported here; for today, use "Submit Inventory Today".`, 'DAY_OPEN');
  const shaped = shapeDay(db, day, now);
  const rows = inventoryRows(db, day);
  const body = buildInventoryXlsx({
    title: 'Chicken POS - Closed Inventory', sheetName: 'Closed Inventory', business_date: day.business_date,
    info: [['Status', 'Closed'], ['Closed (PH time)', toPhtDateTime(day.closed_at)], ['Closed by', shaped.closed_by_name ?? ''],
      ['Exported (PH time)', toPhtDateTime(now.toISOString())], ['Exported by', `${viewer.display_name} (${viewer.role})`]],
    chicken: rows.chicken.filter((r) => !allZero(r)), other: rows.other.filter((r) => !allZero(r)), edits: beginningEdits(db, day.id),
  });
  return { name: `inventory_closed_${day.business_date}.xlsx`, body };
}
