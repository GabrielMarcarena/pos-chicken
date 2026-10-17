// Users, passwords and sessions.
import crypto from 'node:crypto';
import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { ROLES } from '../../shared/constants.js';

// display = the butcher TV account (Revision 15): rank 0, so it passes only the routes that name 'display' and is refused everything else.
export const ROLE_RANK = { display: 0, cashier: 1, manager: 2, admin: 3 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const publicUser = (u) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, active: !!u.active });

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Use a password with at least 8 characters.', 'WEAK_PASSWORD');
  }
}

export function createUser(db, { username, display_name, role, password }, now = new Date()) {
  const name = String(username ?? '').trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(name)) {
    throw new HttpError(400, 'Username must be 3 to 32 letters, numbers, dots, dashes or underscores.', 'BAD_USERNAME');
  }
  if (!ROLES.includes(role)) throw new HttpError(400, 'Choose cashier, manager, admin or display.', 'BAD_ROLE');
  checkPassword(password);
  const display = String(display_name ?? '').trim() || name;
  try {
    const r = db.prepare('INSERT INTO users (username, display_name, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)')
      .run(name, display.slice(0, 60), hashPassword(password), role, now.toISOString());
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      const old = db.prepare('SELECT deleted_at FROM users WHERE username = ?').get(name);
      throw new HttpError(409, old?.deleted_at ? 'That username belonged to a deleted account and is kept for the order history. Choose another one.' : 'That username is already taken.', 'DUPLICATE');
    }
    throw err;
  }
}

/** Accounts an admin has deleted (and that are kept only because old orders point at them) are never listed. */
export function listUsers(db, actor = null) {
  const rows = db.prepare('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY active DESC, username COLLATE NOCASE').all();
  // The admin screen also learns, per account, whether Delete Account is allowed (and why not). The server re-checks on delete.
  return rows.map((u) => (actor ? { ...publicUser(u), delete_blocked: deleteBlocker(db, actor, u) } : publicUser(u)));
}

export function updateUser(db, actor, id, body) {
  return tx(db, () => {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!user) throw new HttpError(404, 'User not found.', 'NOT_FOUND');
    const next = { display_name: user.display_name, role: user.role, active: user.active, password_hash: user.password_hash };
    if (body.display_name !== undefined) next.display_name = String(body.display_name).trim().slice(0, 60) || user.display_name;
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) throw new HttpError(400, 'Choose cashier, manager, admin or display.', 'BAD_ROLE');
      next.role = body.role;
    }
    if (body.active !== undefined) next.active = body.active ? 1 : 0;
    if (body.password) { checkPassword(body.password); next.password_hash = hashPassword(body.password); }

    // Never leave the shop without an active admin, and never let an admin lock themselves out.
    const losesAdmin = user.role === 'admin' && user.active && (next.role !== 'admin' || !next.active);
    if (losesAdmin) {
      if (actor.id === user.id) throw new HttpError(400, 'You cannot remove your own admin access or deactivate yourself.', 'SELF_LOCKOUT');
      const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
      if (admins <= 1) throw new HttpError(400, 'Keep at least one active admin.', 'LAST_ADMIN');
    }
    db.prepare('UPDATE users SET display_name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?')
      .run(next.display_name, next.role, next.active, next.password_hash, id);
    if (!next.active || body.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  });
}

// ---- Delete Account ---------------------------------------------------------------------------

/** True when the account appears in any order, payment, audit or price-history record. Those records must keep their names. */
function hasHistory(db, id) {
  return !!db.prepare(`SELECT (EXISTS (SELECT 1 FROM orders WHERE cashier_id = ?)
                           OR EXISTS (SELECT 1 FROM payments WHERE recorded_by = ?)
                           OR EXISTS (SELECT 1 FROM order_events WHERE user_id = ?)
                           OR EXISTS (SELECT 1 FROM price_history WHERE changed_by = ?)) AS used`).get(id, id, id, id).used;
}

/**
 * Why this account may not be deleted, or null when it may. The same function feeds the Users screen (so the button
 * explains itself) and the DELETE route (so a hand-made request is refused for the same reasons).
 *   * your own account            you could lock yourself out
 *   * the main owner account      the first account ever created, while it is still an admin
 *   * the last active admin       the shop must always keep one
 */
export function deleteBlocker(db, actor, user) {
  if (actor.id === user.id) return { code: 'SELF_DELETE', message: 'You cannot delete the account you are signed in with.' };
  const firstId = db.prepare('SELECT MIN(id) AS id FROM users').get().id;
  if (user.id === firstId && user.role === 'admin') {
    return { code: 'PROTECTED', message: 'This is the main owner account, so it is protected and cannot be deleted. If it is no longer needed, make another admin and deactivate it from Edit.' };
  }
  if (user.role === 'admin' && user.active) {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND deleted_at IS NULL").get().n;
    if (admins <= 1) return { code: 'LAST_ADMIN', message: 'Keep at least one active admin. Make another account an admin first.' };
  }
  return null;
}

/**
 * Delete an account (admin only; the route enforces the role). Past orders, payments and the audit trail are never touched.
 *   * An account nobody has used (no orders, payments, audit or price-change records) is removed completely: outcome "deleted".
 *   * An account that appears in those records cannot be erased without breaking them (every order names its cashier), so it is
 *     closed instead: sign-in is switched off, the password and open sessions are wiped, and it disappears from the Users list.
 *     Its name stays on the old records. Outcome "removed".
 * Asking again for an account that is already gone returns "not found", so a double click or a repeated request does nothing twice.
 */
export function deleteUser(db, actor, id, now = new Date()) {
  return tx(db, () => {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!user) throw new HttpError(404, 'That account was not found. It may already have been deleted.', 'NOT_FOUND');
    const blocked = deleteBlocker(db, actor, user);
    if (blocked) throw new HttpError(blocked.code === 'SELF_DELETE' ? 403 : 409, blocked.message, blocked.code);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    let outcome = 'removed';
    if (!hasHistory(db, id)) {
      try { db.prepare('DELETE FROM users WHERE id = ?').run(id); outcome = 'deleted'; } catch (err) {
        if (!/FOREIGN KEY/i.test(String(err.message))) throw err; // something else points at it: close it instead
      }
    }
    if (outcome === 'removed') {
      db.prepare("UPDATE users SET active = 0, password_hash = 'deleted', deleted_at = ? WHERE id = ?").run(now.toISOString(), id);
    }
    return { outcome, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } };
  });
}

/** On the very first start, create the admin named in the environment variables. */
export function bootstrapAdmin(db, config) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return false;
  if (!config.adminUsername || !config.adminPassword) return null;
  createUser(db, { username: config.adminUsername, display_name: 'Owner', role: 'admin', password: config.adminPassword });
  return true;
}

// ---- Sessions ---------------------------------------------------------------------------------

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

export function createSession(db, userId, now = new Date()) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?,?,?,?)')
    .run(sha256(token), userId, now.toISOString(), now.toISOString());
  return token;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/** Returns the signed-in user, or null if the token is unknown, idle for too long, or the user is inactive. */
export function userFromSession(db, token, idleMinutes, now = new Date()) {
  if (!token) return null;
  const row = db.prepare(`SELECT s.token_hash, s.last_seen_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
  if (!row || !row.active) return null;
  const idleMs = now.getTime() - new Date(row.last_seen_at).getTime();
  // The butcher TV stays signed in however long it is left on; every other account is signed out after being idle.
  if (row.role !== 'display' && idleMs > idleMinutes * 60_000) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  if (idleMs > 60_000) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now.toISOString(), row.token_hash);
  return publicUser(row);
}

export function authenticate(db, username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '').trim());
  // Always run a hash so a wrong username takes as long as a wrong password.
  const ok = verifyPassword(String(password ?? ''), user?.password_hash ?? 'scrypt:00:00');
  return user && user.active && !user.deleted_at && ok ? publicUser(user) : null;
}

// Slow down password guessing: 8 failures per username and address in 15 minutes.
const attempts = new Map();
export const loginLimiter = {
  blocked(key, now = Date.now()) {
    const list = (attempts.get(key) ?? []).filter((t) => now - t < 15 * 60_000);
    attempts.set(key, list);
    return list.length >= 8;
  },
  fail(key, now = Date.now()) { attempts.set(key, [...(attempts.get(key) ?? []), now]); },
  clear(key) { attempts.delete(key); },
};
