// Users (admin only): add staff, change roles, reset passwords, deactivate.
import { api } from '../api.js';
import { $, esc, toast, errorBox, openDialog } from '../util.js';

const ROLE_TEXT = { cashier: 'Cashier', manager: 'Manager', admin: 'Admin' };

export async function mountUsers(root) {
  root.innerHTML = `<div class="panel"><div class="panel-head"><h1>Users</h1><button type="button" class="btn btn--primary" id="addUser">Add user</button></div>
    <p class="muted">Cashiers take and cancel orders. Managers also refund, export and manage products. Admins also set chicken prices, service fees and users.</p>
    <div id="userList" class="mt-s"></div></div>`;
  $('#addUser').onclick = () => userDialog(null);
  let users = [];
  root.onclick = (e) => { const b = e.target.closest('[data-edit]'); if (b) userDialog(users.find((u) => u.id === Number(b.dataset.edit))); };
  await load();

  async function load() {
    try {
      ({ users } = await api('GET', '/api/users'));
      $('#userList').innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.display_name)}</td><td>${ROLE_TEXT[u.role]}</td>
          <td>${u.active ? '<span class="badge">Active</span>' : '<span class="badge badge--inactive">Inactive</span>'}</td>
          <td class="right"><button type="button" class="btn btn--small" data-edit="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>`;
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
}
