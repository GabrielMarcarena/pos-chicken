import { api } from '../api.js';
import { $, esc, errorBox } from '../util.js';

export function mountLogin(root, onSignedIn) {
  document.title = 'Sign in - Chicken POS';
  root.innerHTML = `
    <div class="login">
      <div class="panel">
        <div class="login-mark" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 32 32"><path d="M7 23h18l-2.5-11h-13z" fill="#f4b72a"/><rect x="13" y="7" width="6" height="4" rx="1" fill="#fff"/></svg></div>
        <h1>Chicken POS</h1>
        <p class="muted">Sign in to take orders.</p>
        <div id="loginError" class="stack"></div>
        <form id="loginForm" class="stack mt-l">
          <div class="field"><label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" required></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
          <button class="btn btn--primary btn--big" type="submit" id="loginBtn">Sign in</button>
        </form>
      </div>
    </div>`;
  $('#username').focus();
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn');
    btn.disabled = true; btn.textContent = 'Signing in...';
    $('#loginError').innerHTML = '';
    try {
      const { user } = await api('POST', '/api/login', { username: $('#username').value, password: $('#password').value });
      await onSignedIn(user);
    } catch (err) {
      $('#loginError').innerHTML = errorBox(err);
      btn.disabled = false; btn.textContent = 'Sign in';
      $('#password').select();
    }
  };
}
