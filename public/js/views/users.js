// Users (admin only): add staff, change roles, reset passwords, deactivate, delete.
import { api } from '../api.js';
import { $, esc, howItWorks, toast, errorBox, openDialog } from '../util.js';

const ROLE_TEXT = { cashier: 'Cashier', assistant: 'Assistant Cashier', manager: 'Manager', admin: 'Admin', display: 'Butcher TV (screen only)' };
// Why an account has no Delete Account button. The server sends the full sentence; this is the short label shown in the row.
const PROTECTED_TEXT = { SELF_DELETE: 'This is you', PROTECTED: 'Main owner account', LAST_ADMIN: 'Last active admin' };

export async function mountUsers(root) {
  root.innerHTML = `<div class="panel"><div class="panel-head"><h1>Users</h1><button type="button" class="btn btn--primary" id="addUser">Add user</button></div>
    <p class="muted">Add the people who use the app and pick what each may do.</p>
    ${howItWorks(`<ul><li><strong>Assistant Cashier</strong>: only the Order List (moves orders, no prices) and the Butcher view.</li>
      <li><strong>Cashier</strong>: takes and cancels orders.</li><li><strong>Manager</strong>: also refunds, exports and manages products.</li>
      <li><strong>Admin</strong>: also sets chicken prices, service fees and users.</li>
      <li><strong>Butcher TV</strong>: can only open the Butcher screen; use it on the TV in the butcher area.</li></ul>`, 'What each role can do')}
    <div id="userList" class="mt-s"></div></div>`;
  $('#addUser').onclick = () => userDialog(null);
  let users = [];
  root.onclick = (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) return userDialog(users.find((u) => u.id === Number(edit.dataset.edit)));
    const remove = e.target.closest('[data-delete]');
    if (remove) return deleteDialog(users.find((u) => u.id === Number(remove.dataset.delete)));
    return undefined;
  };
  await load();

  async function load() {
    try {
      ({ users } = await api('GET', '/api/users'));
      $('#userList').innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.display_name)}</td><td>${ROLE_TEXT[u.role]}</td>
          <td>${u.active ? '<span class="badge">Active</span>' : '<span class="badge badge--inactive">Inactive</span>'}</td>
          <td class="right"><div class="row-actions"><button type="button" class="btn btn--small" data-edit="${u.id}">Edit</button>
            ${u.delete_blocked
    ? `<span class="muted nowrap" title="${esc(u.delete_blocked.message)}">${esc(PROTECTED_TEXT[u.delete_blocked.code] ?? 'Protected')}</span>`
    : `<button type="button" class="btn btn--small btn--danger" data-delete="${u.id}" aria-label="Delete Account: ${esc(u.username)}">Delete Account</button>`}</div></td></tr>`).join('')}</tbody></table></div>`;
    } catch (err) { $('#userList').innerHTML = errorBox(err); }
  }
  async function userDialog(user) {
    const editing = Boolean(user);
    const roles = Object.entries(ROLE_TEXT).map(([v, t]) => `<option value="${v}" ${user?.role === v ? 'selected' : ''}>${t}</option>`).join('');
    const saved = await openDialog({
      title: editing ? `Edit ${user.username}` : 'Add user',
      body: `<div id="uErr"></div><div class="form-grid">
        ${editing ? '' : '<div class="field"><label for="uName">Username</label><input id="uName" type="text" autocapitalize="none" autocomplete="off"><span class="hint">3 to 32 letters, numbers, dots, dashes or underscores.</span></div>'}
        <div class="field"><label for="uDisplay">Name shown on screen</label><input id="uDisplay" type="text" value="${esc(user?.display_name ?? '')}"></div>
        <div class="field"><label for="uRole">Role</label><select id="uRole">${roles}</select></div>
        <div class="field"><label for="uPass">${editing ? 'New password (leave empty to keep)' : 'Password'}</label><input id="uPass" type="password" autocomplete="new-password"><span class="hint">At least 8 characters.</span></div>
      </div>
      ${editing ? `<label class="check"><input type="checkbox" id="uActive" ${user.active ? 'checked' : ''}> Account is active</label>` : ''}`,
      actions: [
        { label: 'Cancel', value: false },
        {
          label: editing ? 'Save changes' : 'Add user', kind: 'primary',
          onClick: async (dlg) => {
            const body = { display_name: $('#uDisplay', dlg).value, role: $('#uRole', dlg).value };
            if ($('#uPass', dlg).value) body.password = $('#uPass', dlg).value;
            try {
              if (editing) { body.active = $('#uActive', dlg).checked; await api('PATCH', `/api/users/${user.id}`, body); }
              else { body.username = $('#uName', dlg).value; body.password = $('#uPass', dlg).value; await api('POST', '/api/users', body); }
              return true;
            } catch (err) { $('#uErr', dlg).innerHTML = errorBox(err); return false; }
          },
        },
      ],
    });
    if (saved === true) { toast(editing ? 'User saved.' : 'User added.', 'ok'); load(); }
  }

  /** Ask first, then delete. Nothing is sent until "Delete Account" in this dialog is pressed. */
  async function deleteDialog(user) {
    if (!user) return;
    let outcome = null;
    const done = await openDialog({
      title: 'Delete this user account?',
      body: `<div id="delErr"></div>
        <p>Delete this account? The person can no longer sign in.</p>
        <div class="del-who"><strong>${esc(user.display_name)}</strong>
          <span class="muted">Username: ${esc(user.username)} &middot; ${esc(ROLE_TEXT[user.role])} &middot; ${user.active ? 'Active' : 'Inactive'}</span></div>
        <p class="muted">Past orders keep this person's name.</p>`,
      actions: [
        { label: 'Cancel', value: false },
        {
          label: 'Delete Account', kind: 'danger',
          // The shared dialog switches this button off while the request runs, so a double click sends one request.
          onClick: async (dlg) => {
            try { outcome = (await api('DELETE', `/api/users/${user.id}`)).outcome; return true; } catch (err) {
              $('#delErr', dlg).innerHTML = errorBox(err);
              if (err.status === 404) load();   // it is already gone, so show the list as it is now
              return false;
            }
          },
        },
      ],
    });
    if (done === true) {
      toast(outcome === 'removed'
        ? `${user.display_name} was deleted. Their past orders and payment records were kept.`
        : `${user.display_name} was deleted.`, 'ok');
      load();
    }
  }
}
