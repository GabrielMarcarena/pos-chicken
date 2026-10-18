// Revision 17 tests: the sign-in limit uses the visitor's real address only behind our own proxy (TRUST_PROXY).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/users.js';

async function shop(trustProxy) {
  const db = openDb(':memory:');
  createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  const config = loadConfig({ dbPath: ':memory:', trustProxy });
  const server = createApp({ db, config }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (ip, password, user = 'owner') => (await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'pos', ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: JSON.stringify({ username: user, password }),
  })).status;
  return { login, close: () => { server.closeAllConnections(); server.close(); } };
}

test('TRUST_PROXY on: wrong passwords from one visitor do not lock out another', async () => {
  const s = await shop(true);
  for (let i = 0; i < 8; i++) assert.equal(await s.login('9.9.9.9', 'wrong'), 401);
  assert.equal(await s.login('9.9.9.9', 'owner-pass-1'), 429, 'the guessing visitor is blocked');
  assert.equal(await s.login('1.2.3.4', 'owner-pass-1'), 200, 'the owner, from another address, is not');
  s.close();
});

test('TRUST_PROXY on: only the last forwarded address counts, so a faked first one does not help', async () => {
  const s = await shop(true);
  for (let i = 0; i < 8; i++) assert.equal(await s.login(`${i}.0.0.1, 8.8.8.8`, 'wrong'), 401);
  assert.equal(await s.login('55.5.5.5, 8.8.8.8', 'owner-pass-1'), 429, 'a new fake first entry does not reset the limit');
  s.close();
});

test('TRUST_PROXY off (default): the forwarded header is ignored, so it cannot be used to dodge the limit', async () => {
  const s = await shop(false);
  for (let i = 0; i < 8; i++) assert.equal(await s.login(`${i}.0.0.1`, 'wrong'), 401);
  assert.equal(await s.login('77.7.7.7', 'owner-pass-1'), 429);
  s.close();
});

test('TRUST_PROXY reads 1 and true from the environment, and is off otherwise', () => {
  const old = process.env.TRUST_PROXY;
  try {
    for (const [v, want] of [['1', true], ['true', true], ['0', false], ['', false], [undefined, false]]) {
      if (v === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = v;
      assert.equal(loadConfig().trustProxy, want, String(v));
    }
  } finally { if (old === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = old; }
});
