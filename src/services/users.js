// Users, passwords and sessions.
import crypto from 'node:crypto';
import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { ROLES } from '../../shared/constants.js';

export const ROLE_RANK = { cashier: 1, manager: 2, admin: 3 };

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
  if (!ROLES.includes(role)) throw new HttpError(400, 'Choose cashier, manager or admin.', 'BAD_ROLE');
  checkPassword(password);
  const display = String(display_name ?? '').trim() || name;
  try {
    const r = db.prepare('INSERT INTO users (username, display_name, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)')
      .run(name, display.slice(0, 60), hashPassword(password), role, now.toISOString());
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'That username is already taken.', 'DUPLICATE');
    throw err;
  }
}

export function listUsers(db) {
  return db.prepare('SELECT * FROM users ORDER BY active DESC, username COLLATE NOCASE').all().map(publicUser);
}

export function updateUser(db, actor, id, body) {
  return tx(db, () => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new HttpError(404, 'User not found.', 'NOT_FOUND');
    const next = { display_name: user.display_name, role: user.role, active: user.active, password_hash: user.password_hash };
    if (body.display_name !== undefined) next.display_name = String(body.display_name).trim().slice(0, 60) || user.display_name;
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) throw new HttpError(400, 'Choose cashier, manager or admin.', 'BAD_ROLE');
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
  if (idleMs > idleMinutes * 60_000) {
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
  return user && user.active && ok ? publicUser(user) : null;
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
