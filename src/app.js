// The web server: static files for the browser app, and the JSON API under /api.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, HttpError, readJson, parseCookies, sendJson, serveFile } from './http.js';
import { registerRoutes, COOKIE_NAME } from './routes.js';
import { userFromSession, ROLE_RANK } from './services/users.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

export function createApp({ db, config, clock = () => new Date() }) {
  const router = new Router();
  registerRoutes(router);

  async function handleApi(req, res, url) {
    const found = router.match(req.method, url.pathname);
    if (found === null) throw new HttpError(404, 'Not found.', 'NOT_FOUND');
    if (found === 'METHOD') throw new HttpError(405, 'Method not allowed.', 'METHOD');
    const { route, params } = found;

    // State-changing calls must carry a header that other websites cannot add to a form post.
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'pos') {
      throw new HttpError(403, 'Request blocked.', 'CSRF');
    }
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    // Public routes may still look at who is signed in (the app asks /api/me before showing the sign-in screen).
    const user = userFromSession(db, token, config.sessionIdleMinutes, clock());
    if (route.role !== 'public') {
      if (!user) throw new HttpError(401, 'Please sign in.', 'UNAUTHENTICATED');
      if (ROLE_RANK[user.role] < ROLE_RANK[route.role]) throw new HttpError(403, 'Your account cannot do this.', 'FORBIDDEN');
    }
    const body = req.method === 'GET' ? {} : await readJson(req);
    const ctx = { req, res, db, config, user, token, params, query: Object.fromEntries(url.searchParams), body, now: clock };
    const result = await route.handler(ctx);

    if (result?.__raw) {
      res.writeHead(200, { 'Cache-Control': 'no-store', ...result.__raw.headers });
      res.end(result.__raw.body);
    } else if (result?.__status) {
      sendJson(res, result.__status, result.body);
    } else {
      sendJson(res, 200, result);
    }
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.', 'METHOD');
      if (url.pathname.startsWith('/shared/')) {
        if (serveFile(res, path.join(ROOT, 'shared'), url.pathname.slice('/shared/'.length))) return;
        throw new HttpError(404, 'Not found.', 'NOT_FOUND');
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (serveFile(res, path.join(ROOT, 'public'), rel)) return;
      if (!path.extname(rel) && serveFile(res, path.join(ROOT, 'public'), 'index.html')) return;
      throw new HttpError(404, 'Not found.', 'NOT_FOUND');
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
      }
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong on the server. Nothing was changed. Please try again.', code: 'SERVER' });
    }
  });
  return server;
}
