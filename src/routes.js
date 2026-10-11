// The API. Each route names the lowest role allowed to call it; the server enforces that, not the browser.
import { HttpError } from './http.js';
import { REASONS, PAYMENT_METHODS, DISCOUNT_REASONS } from '../shared/constants.js';
import {
  authenticate, createSession, destroySession, loginLimiter, createUser, listUsers, updateUser,
} from './services/users.js';
import {
  listProducts, createProduct, updateProduct, listOtherProducts, createOtherProduct, updateOtherProduct,
  createOption, updateOption, getFeeConfig, updateFee, listPriceHistory,
} from './services/catalog.js';
import { createOrder, getOrder, listOrders, cancelOrder, changeOrder, refundOrder } from './services/orders.js';
import { gatherExport, buildXlsx, buildCsv } from './services/export.js';
import { gatherDaily, buildDailyXlsx, buildDailyCsv } from './services/dailyReport.js';
import { toBusinessDate } from './time.js';

export const COOKIE_NAME = 'pos_session';

function sessionCookie(ctx, value, maxAgeSeconds) {
  const mode = ctx.config.cookieSecure;
  const secure = mode === 'true' || (mode === 'auto' && ctx.req.headers['x-forwarded-proto'] === 'https');
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

const idParam = (ctx) => {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'Not found.', 'NOT_FOUND');
  return id;
};
const created = (body) => ({ __status: 201, body });

export function registerRoutes(r) {
  // ---- Session ----
  r.add('POST', '/api/login', 'public', (ctx) => {
    const { username, password } = ctx.body;
    const key = `${String(username ?? '').toLowerCase()}|${ctx.req.socket.remoteAddress}`;
    if (loginLimiter.blocked(key)) throw new HttpError(429, 'Too many tries. Wait 15 minutes, then try again.', 'RATE_LIMIT');
    const user = authenticate(ctx.db, username, password);
    if (!user) {
      loginLimiter.fail(key);
      throw new HttpError(401, 'Wrong username or password.', 'BAD_LOGIN');
    }
    loginLimiter.clear(key);
    ctx.res.setHeader('Set-Cookie', sessionCookie(ctx, createSession(ctx.db, user.id, ctx.now()), 7 * 86400));
    return { user };
  });
  r.add('POST', '/api/logout', 'public', (ctx) => {
    destroySession(ctx.db, ctx.token);
    ctx.res.setHeader('Set-Cookie', sessionCookie(ctx, '', 0));
    return { ok: true };
  });
  r.add('GET', '/api/me', 'public', (ctx) => ({ user: ctx.user })); // user is null when signed out

  // Everything the checkout screen needs in one call.
  r.add('GET', '/api/config', 'cashier', (ctx) => ({
    fees: getFeeConfig(ctx.db),
    reasons: REASONS,
    payment_methods: PAYMENT_METHODS,
    discount_reasons: DISCOUNT_REASONS,
    products: listProducts(ctx.db),
    other_products: listOtherProducts(ctx.db),
    large_weight_kg: ctx.config.largeWeightKg,
  }));

  // ---- Catalog (manager and admin) ----
  r.add('GET', '/api/products', 'manager', (ctx) => ({ products: listProducts(ctx.db, { includeInactive: true }) }));
  r.add('POST', '/api/products', 'manager', (ctx) => created({ product: createProduct(ctx.db, ctx.user, ctx.body, ctx.now()) }));
  r.add('PATCH', '/api/products/:id', 'manager', (ctx) => ({ product: updateProduct(ctx.db, ctx.user, idParam(ctx), ctx.body, ctx.now()) }));
  r.add('GET', '/api/other-products', 'manager', (ctx) => ({ other_products: listOtherProducts(ctx.db, { includeInactive: true }) }));
  r.add('POST', '/api/other-products', 'manager', (ctx) => created({ other_product: createOtherProduct(ctx.db, ctx.user, ctx.body, ctx.now()) }));
  r.add('PATCH', '/api/other-products/:id', 'manager', (ctx) => ({ other_product: updateOtherProduct(ctx.db, ctx.user, idParam(ctx), ctx.body, ctx.now()) }));
  // A product can be sold in several ways (per piece, per dozen, per kg ...). Managers add them; only the admin sets prices.
  r.add('POST', '/api/other-products/:id/options', 'manager', (ctx) => created({ other_product: createOption(ctx.db, ctx.user, idParam(ctx), ctx.body, ctx.now()) }));
  r.add('PATCH', '/api/other-product-options/:id', 'manager', (ctx) => ({ other_product: updateOption(ctx.db, ctx.user, idParam(ctx), ctx.body, ctx.now()) }));
  r.add('GET', '/api/service-fees', 'manager', (ctx) => ({ fees: getFeeConfig(ctx.db) }));
  r.add('PUT', '/api/service-fees/:code', 'admin', (ctx) => ({ fees: updateFee(ctx.db, ctx.user, ctx.params.code, ctx.body, ctx.now()) }));
  r.add('GET', '/api/price-history', 'admin', (ctx) => ({ history: listPriceHistory(ctx.db) }));

  // ---- Users (admin) ----
  r.add('GET', '/api/users', 'admin', (ctx) => ({ users: listUsers(ctx.db) }));
  r.add('POST', '/api/users', 'admin', (ctx) => created({ user: createUser(ctx.db, ctx.body, ctx.now()) }));
  r.add('PATCH', '/api/users/:id', 'admin', (ctx) => ({ user: updateUser(ctx.db, ctx.user, idParam(ctx), ctx.body) }));

  // ---- Orders ----
  r.add('POST', '/api/orders', 'cashier', (ctx) => {
    const result = createOrder(ctx.db, ctx.user, ctx.body, { config: ctx.config, now: ctx.now() });
    return result.duplicate ? result : created(result);
  });
  r.add('GET', '/api/orders', 'cashier', (ctx) => ({ orders: listOrders(ctx.db, ctx.query) }));
  r.add('GET', '/api/orders/:id', 'cashier', (ctx) => ({ order: getOrder(ctx.db, idParam(ctx), ctx.user) }));
  r.add('POST', '/api/orders/:id/cancel', 'cashier', (ctx) => ({ order: cancelOrder(ctx.db, ctx.user, idParam(ctx), ctx.body, { now: ctx.now() }) }));
  r.add('POST', '/api/orders/:id/change', 'cashier', (ctx) => {
    const result = changeOrder(ctx.db, ctx.user, idParam(ctx), ctx.body, { config: ctx.config, now: ctx.now() });
    return result.duplicate ? result : created(result);
  });
  r.add('POST', '/api/orders/:id/refund', 'manager', (ctx) => ({ order: refundOrder(ctx.db, ctx.user, idParam(ctx), ctx.body, { now: ctx.now() }) }));

  // ---- Daily Sales Report (everyone; a cashier only ever gets their own sales) ----
  // The report copies the shop's paper form with what the app knows. Counted-by-hand boxes are left empty.
  const dailyArgs = (ctx) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date ?? '') ? ctx.query.date : toBusinessDate(ctx.now());
    const wanted = Number(ctx.query.cashier);
    const cashierId = ctx.user.role === 'cashier' ? ctx.user.id : (Number.isInteger(wanted) && wanted > 0 ? wanted : null);
    return { date, cashierId };
  };
  const dailyName = (args, ext) => `daily-sales-report_${args.date}${args.cashierId ? `_cashier-${args.cashierId}` : ''}.${ext}`;
  r.add('GET', '/api/daily-report.xlsx', 'cashier', (ctx) => {
    const args = dailyArgs(ctx);
    return { __raw: { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${dailyName(args, 'xlsx')}"` }, body: buildDailyXlsx(gatherDaily(ctx.db, args)) } };
  });
  r.add('GET', '/api/daily-report.csv', 'cashier', (ctx) => {
    const args = dailyArgs(ctx);
    return { __raw: { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${dailyName(args, 'csv')}"` }, body: buildDailyCsv(gatherDaily(ctx.db, args)) } };
  });
  // Who can be picked in the report's cashier filter.
  r.add('GET', '/api/staff', 'manager', (ctx) => ({ staff: listUsers(ctx.db).filter((u) => u.active).map((u) => ({ id: u.id, display_name: u.display_name, role: u.role })) }));

  // ---- Export (manager and admin) ----
  const exportName = (ctx, ext) => `chicken-pos_${ctx.query.from || 'start'}_to_${ctx.query.to || 'latest'}.${ext}`.replace(/[^A-Za-z0-9._-]/g, '');
  r.add('GET', '/api/export.xlsx', 'manager', (ctx) => ({
    __raw: {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${exportName(ctx, 'xlsx')}"`,
      },
      body: buildXlsx(gatherExport(ctx.db, ctx.query)),
    },
  }));
  r.add('GET', '/api/export.csv', 'manager', (ctx) => ({
    __raw: {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${exportName(ctx, 'csv')}"` },
      body: buildCsv(gatherExport(ctx.db, ctx.query)),
    },
  }));
}
