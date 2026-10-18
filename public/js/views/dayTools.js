// The Daily Inventory page's actions, shown below the inventory tables:
//   Submit Inventory Today                      saves today's inventory file on this computer and downloads a copy (nothing is reset)
//   Save                                        Revision 13, in place of "Closed Inventory Today and Reset the Day": keeps today's numbers
//                                               in the database (one row per day). The day itself closes automatically at midnight.
//   Export (beside "Closed")                    Revision 12, in place of Export Inventory History: the inventory of one closed business
//                                               day, in the layout of the submitted file. Shown only for a closed day.
//
// All of them only talk to the server, and show plainly what it says.
import { api, download } from '../api.js';
import { esc, toast, errorBox, fmtDateTime } from '../util.js';

// The names the shop asked for, word for word.
export const SUBMIT_BUTTON_TEXT = 'Submit Inventory Today';
export const SAVE_BUTTON_TEXT = 'Save';
export const EXPORT_BUTTON_TEXT = 'Export';

/** Download the saved file of a submission. Returns the file name, or throws. */
const downloadSubmission = (s) => download(`/api/inventory/submissions/${s.id}/file`, s.file_name);

/**
 * Submit Inventory Today: the server saves the file and records the numbers in one step; then the same saved file is downloaded.
 * If saving fails nothing is submitted. If only the download fails, the file is still safe on this computer and can be downloaded again.
 * Returns the submission, or null when it failed.
 */
export async function submitInventoryToday(date, show) {
  let result;
  try {
    result = await api('POST', '/api/inventory/submit', { business_date: date });
  } catch (err) {
    show(`<div class="error-box" role="alert"><strong>The inventory was not submitted. ${esc(err.message)}</strong><br>Nothing was saved and nothing was reset.</div>`);
    return null;
  }
  const s = result.submission;
  const left = result.rows_left_out ? ` ${result.rows_left_out} product${result.rows_left_out === 1 ? '' : 's'} with 0 in every column ${result.rows_left_out === 1 ? 'is' : 'are'} not included (the file says so).` : '';
  try {
    await downloadSubmission(s);
    show(`<div class="ok-box" role="status"><strong>Inventory submitted: ${esc(s.file_name)}</strong><br>Saved on this computer in <code>${esc(result.saved_in)}</code> and downloaded to your Downloads folder.${esc(left)} Nothing was reset.</div>`);
  } catch (err) {
    show(`<div class="note-box" role="status"><strong>Inventory submitted and saved on this computer (${esc(s.file_name)} in <code>${esc(result.saved_in)}</code>), but the download did not start: ${esc(err.message)}</strong>
      <br><button type="button" class="btn btn--small mt-s" data-inv="redownload" data-id="${s.id}" data-name="${esc(s.file_name)}">Download it again</button></div>`);
  }
  return s;
}

/** Download a submission again by id (the "Download it again" and "Download the submitted file" buttons). */
export async function redownload(id, name, show) {
  try { await downloadSubmission({ id, file_name: name }); toast(`Downloaded ${name}.`, 'ok'); }
  catch (err) { show(errorBox(err)); }
}

/** Export (Revision 12): the inventory of one closed business day, as it was closed. Read-only. Returns the file name, or null. */
export async function exportClosedDay(date, show) {
  try {
    const name = await download(`/api/inventory/day.xlsx?date=${encodeURIComponent(date)}`, `inventory_closed_${date}.xlsx`);
    show(`<div class="ok-box" role="status"><strong>Exported: ${esc(name)}</strong><br>The inventory of ${esc(date)} as it was closed: chicken products, then other products. Nothing was changed.</div>`);
    return name;
  } catch (err) {
    show(`<div class="error-box" role="alert"><strong>The inventory of ${esc(date)} could not be exported. ${esc(err.message)}</strong><br>Nothing was changed.</div>`);
    return null;
  }
}

/**
 * Save (Revision 13): keep the open day's numbers in the database, one row per day; saving again replaces it. Nothing is downloaded.
 * Returns the server's answer, or null when it failed (the message is shown with `show`).
 */
export async function saveInventory(show) {
  try {
    const r = await api('POST', '/api/inventory/save', {});
    show(`<div class="ok-box" role="status"><strong>${esc(r.business_date)} is saved.</strong> ${esc(savedText(r.saved))}.</div>`);
    return r;
  } catch (err) {
    show(errorBox(err));
    return null;
  }
}

/** "Saved 3:15 PM by Owner", or "Saved and closed automatically at midnight" */
export const savedText = (s) => (s.how === 'AUTO_CLOSE' ? `Saved and closed automatically at midnight (${fmtDateTime(s.saved_at)})` : `Saved ${fmtDateTime(s.saved_at)} by ${s.by}`);

/** "Submitted at 5:42 PM by Owner (inventory_2026-10-15_1742.xlsx)" */
export const submissionText = (s) => `Submitted ${fmtDateTime(s.submitted_at)} by ${s.by} (${s.file_name})`;
