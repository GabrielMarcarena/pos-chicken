// Small HTTP helpers: errors, a router, JSON bodies, cookies and static files.
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, code = 'ERROR', details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class Router {
  constructor() { this.routes = []; }
  /** role: 'public' | 'cashier' | 'manager' | 'admin' (the lowest role allowed) */
  add(method, pattern, role, handler) {
    const keys = [];
    const source = pattern.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; });
    this.routes.push({ method, re: new RegExp(`^${source}$`), keys, role, handler });
  }
  match(method, pathname) {
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (m && r.method === method) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
    }
    const pathExists = this.routes.some((r) => r.re.test(pathname));
    return pathExists ? 'METHOD' : null;
  }
}

export async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request is too large.', 'TOO_LARGE');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request was not valid JSON.', 'BAD_JSON');
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** Serve a file from root. Returns false when there is no such file. Never leaves root. */
export function serveFile(res, root, relative) {
  const full = path.resolve(root, '.' + path.posix.normalize('/' + relative));
  if (!full.startsWith(path.resolve(root))) return false;
  let stat;
  try { stat = fs.statSync(full); } catch { return false; }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
  return true;
}
