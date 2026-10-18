// All settings come from environment variables (see .env.example). Nothing secret is stored in code.
import fs from 'node:fs';

function loadDotEnv() {
  // Tiny .env reader so a developer does not need a package for it.
  if (!fs.existsSync('.env')) return;
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export function loadConfig(overrides = {}) {
  loadDotEnv();
  const env = process.env;
  return {
    port: Number(env.PORT ?? 3000),
    // Which network address to listen on. Empty = all (the shop network). On a host behind Caddy use 127.0.0.1 so only Caddy can reach the app.
    host: env.HOST ?? '',
    dbPath: env.DB_PATH ?? 'data/pos.db',
    adminUsername: env.ADMIN_USERNAME ?? '',
    adminPassword: env.ADMIN_PASSWORD ?? '',
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 240),
    cookieSecure: env.COOKIE_SECURE ?? 'auto',
    // 1 when the app sits behind our own web server (Caddy): the visitor's real address is then the last X-Forwarded-For entry.
    trustProxy: ['1', 'true'].includes(String(env.TRUST_PROXY ?? '').toLowerCase()),
    largeWeightKg: Number(env.LARGE_WEIGHT_KG ?? 50),
    ...overrides,
  };
}
