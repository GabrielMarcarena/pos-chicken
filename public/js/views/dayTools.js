// The Daily Inventory page's actions, shown below the inventory tables:
//   Submit Inventory Today                      saves today's inventory file on this computer and downloads a copy (nothing is reset)
//   Closed Inventory Today and Reset the Day    Revision 12: ONE step. It submits today's inventory (the same file) AND closes the day,
//                                               then downloads the file. The confirmation asks only: Cancel, or Close the day and reset.
//   Export (beside "Closed")                    Revision 12, in place of Export Inventory History: the inventory of one closed business
//                                               day, in the layout of the submitted file. Shown only for a closed day.
//
// All of them only talk to the server. Submitting and closing are each one request that the server runs as a single all-or-nothing
// step; this file only asks the person to confirm, and shows plainly what the server says.
import { api, download } from '../api.js';
import { $, esc, toast, errorBox, openDialog, fmtDateTime } from '../util.js';

// The names the shop asked for, word for word.
export const SUBMIT_BUTTON_TEXT = 'Submit Inventory Today';
export const CLOSE_BUTTON_TEXT = 'Closed Inventory Today and Reset the Day';
export const CLOSE_ACTION_TEXT = 'Close the day and reset';
export const EXPORT_BUTTON_TEXT = 'Export';

export const CLOSE_TITLE = 'Close the inventory for today?';
export const closeText = (date) => `You are about to close the inventory of ${date} and start the next business day. `
  + 'Closing also submits today\'s inventory: the Excel file is saved on this computer and downloaded, with the numbers as they are now. '
  + 'The next business day\'s Beginning Balance is carried forward from today\'s New Total; Additional, Sold, Reject, Katay, Dead and Pull Out start again at zero. '
  + 'Complete orders leave the Orders tab and the Order List (they stay saved and in every report). Standby orders stay until they are claimed. '
  + 'Historical inventory and order records are kept.';

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
 * The confirmation for Closed Inventory Today and Reset the Day (Revision 12). It shows what the server says first (an Ongoing order, a
 * count that does not add up). Then there are only two choices: Cancel changes nothing; "Close the day and reset" submits today's
 * inventory and closes the day in ONE request, then downloads the submitted file. `done` runs after a successful closing, with the
 * server's answer.
 */
export async function closeInventoryDay(date, done) {
  let closed = null;
  const showMsg = (dlg, h) => { const m = $('#ndMsg', dlg); if (m) m.innerHTML = h; };
  const check = async (dlg) => {
    const confirmBtn = dlg.querySelector('[data-dlg-action="1"]');
    confirmBtn.disabled = true;
    try {
      const c = await api('GET', '/api/inventory/close-check?submit=1');
      const blockers = c.blockers.map((b) => `<li data-blocker="${esc(b.code)}">${esc(b.message)}</li>`).join('');
      const notices = c.notices.map((n) => `<li data-notice="${esc(n.code)}">${esc(n.message)}</li>`).join('');
      $('#ndCheck', dlg).innerHTML = (blockers ? `<div class="error-box" role="alert"><strong>The day cannot be closed yet.</strong><ul>${blockers}</ul></div>` : '')
        + (notices ? `<div class="note-box"><ul>${notices}</ul></div>` : '')
        + (!blockers ? '<p class="ok-box">Everything is ready. Closing will submit today\'s inventory and start the next business day.</p>' : '');
      confirmBtn.disabled = !c.can_close;
      if (c.business_date !== date) {
        showMsg(dlg, errorBox({ message: `The open business day is ${c.business_date}, not ${date}. Close this window and try again.` }));
        confirmBtn.disabled = true;
      }
    } catch (err) {
      $('#ndCheck', dlg).innerHTML = errorBox(err);
    }
  };
  const result = await openDialog({
    title: CLOSE_TITLE,
    body: `<p data-new-day-text>${esc(closeText(date))}</p>
      <p class="muted">Business day being closed: <strong data-new-day-date>${esc(date)}</strong></p>
      <div id="ndCheck" role="status" aria-live="polite"><p class="muted">Checking...</p></div>
      <div id="ndMsg" role="status" aria-live="polite"></div>`,
    onOpen: (dlg) => { check(dlg); },
    actions: [
      { label: 'Cancel', value: false },
      {
        label: CLOSE_ACTION_TEXT, kind: 'danger',
        onClick: async (dlg) => {
          showMsg(dlg, '<p class="muted">Submitting today\'s inventory and closing the day...</p>');
          try {
            closed = await api('POST', '/api/inventory/close-day', { business_date: date, submit: true });
            return true;
          } catch (err) {
            showMsg(dlg, errorBox(err));
            await check(dlg);
            return false;
          }
        },
      },
    ],
  });
  if (result === true && closed) {
    let file = '';
    try { await downloadSubmission(closed.submission); file = ` The inventory file ${closed.submission.file_name} was downloaded.`; }
    catch { file = ` The inventory file ${closed.submission.file_name} is saved on this computer; download it from the closed day with Export.`; }
    const standby = closed.standby_orders ? ` ${closed.standby_orders} Standby order${closed.standby_orders === 1 ? ' stays' : 's stay'} on the Order List.` : '';
    const cleared = closed.complete_orders_cleared ? ` ${closed.complete_orders_cleared} Complete order${closed.complete_orders_cleared === 1 ? ' was' : 's were'} cleared from the Orders tab and the Order List (still saved).` : '';
    toast(`${closed.closed.business_date} (closed).${file} The new business day is ${closed.opened.business_date}.${standby}${cleared}`, 'ok');
    await done?.(closed);
  }
  return result === true;
}

/** "Submitted at 5:42 PM by Owner (inventory_2026-10-15_1742.xlsx)" */
export const submissionText = (s) => `Submitted ${fmtDateTime(s.submitted_at)} by ${s.by} (${s.file_name})`;
