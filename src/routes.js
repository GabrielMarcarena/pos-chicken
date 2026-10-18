// The API. Each route names the lowest role allowed to call it; the server enforces that, not the browser.
import { HttpError } from './http.js';
import { REASONS, PAYMENT_METHODS, DISCOUNT_REASONS, FULFILLMENT_LABELS } from '../shared/constants.js';
import {
  authenticate, createSession, destroySession, loginLimiter, createUser, listUsers, updateUser, deleteUser,
} from './services/users.js';
import {
  listProducts, createProduct, updateProduct, listOtherProducts, createOtherProduct, updateOtherProduct,
  createOption, updateOption, getFeeConfig, updateFee, listPriceHistory, setProductImage, removeProductImage, getProductImage,
} from './services/catalog.js';
import { createOrder, getOrder, listOrders, listBoard, listButcher, nextFreeTrackingNumber, moveOrder, setBookmark, cancelOrder, changeOrder, refundOrder } from './services/orders.js';
import { gatherExport, buildXlsx, buildCsv, buildSalesListXlsx } from './services/export.js';
import { gatherDaily, buildDailyXlsx } from './services/dailyReport.js';
import { getInventory, stockSummary, updateRecord, closeCheck, startNewDay, inventoryDir, storeInRef, saveDay, savedDay } from './services/inventory.js';
import { submitInventory, submissionFile, closeAndSubmit, closedDayExport } from './services/inventoryReport.js';
import { refSummary } from './services/refStock.js';
import { dayMoney, saveCashCount, saveCashOnHand, addExpenses, removeExpense } from './services/cashbook.js';
import { CHICKEN_CATEGORIES, REF_LABELS } from '../shared/constants.js';
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
/** The visitor's address. Only behind our own proxy (TRUST_PROXY=1) is the forwarded header believed, and then only its last entry (the one the proxy added). */
export function clientIp(ctx) {
  if (ctx.config?.trustProxy) {
    const last = String(ctx.req.headers['x-forwarded-for'] ?? '').split(',').pop().trim();
    if (last) return last;
  }
  return ctx.req.socket.remoteAddress;
}
const created = (body) => ({ __status: 201, body });

export function registerRoutes(r) {
  // ---- Session ----
  r.add('POST', '/api/login', 'public', (ctx) => {
    const { username, password } = ctx.body;
    const key = `${String(username ?? '').toLowerCase()}|${clientIp(ctx)}`;
    if (loginLimiter.blocked(key)) throw new HttpError(429, 'Too many tries. Wait 15 minutes, then try again.', 'RATE_LIMIT');
    const user = authenticate(ctx.db, username, password);
    if (!user) {
      loginLimiter.fail(key);
      throw new HttpError(401, 'Wrong username or password.', 'BAD_LOGIN');
    }
    loginLimiter.clear(key);
    // The butcher TV (display account) keeps its sign-in for a year; everyone else for 7 days.
    ctx.res.setHeader('Set-Cookie', sessionCookie(ctx, createSession(ctx.db, user.id, ctx.now()), (user.role === 'display' ? 365 : 7) * 86400));
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
    chicken_categories: CHICKEN_CATEGORIES,
    ref_labels: REF_LABELS,
    fulfillment_labels: FULFILLMENT_LABELS,
    products: listProducts(ctx.db),
    other_products: listOtherProducts(ctx.db),
    large_weight_kg: ctx.config.largeWeightKg,
    // How many heads / units can still be sold on the open business day. The server checks it again when the order is saved.
    stock: stockSummary(ctx.db, ctx.now()),
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
  // Product pictures for the New order cards (Revision 11). :kind is chicken or other. Everyone signed in sees them; managers and the admin change them.
  r.add('GET', '/api/product-images/:kind/:id', 'cashier', (ctx) => {
    const img = getProductImage(ctx.db, ctx.params.kind, idParam(ctx));
    return { __raw: { headers: { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=86400' }, body: img.body } };
  });
  r.add('PUT', '/api/product-images/:kind/:id', 'manager', (ctx) => setProductImage(ctx.db, ctx.user, ctx.params.kind, idParam(ctx), ctx.body, ctx.now()));
  r.add('DELETE', '/api/product-images/:kind/:id', 'manager', (ctx) => removeProductImage(ctx.db, ctx.user, ctx.params.kind, idParam(ctx)));
  r.add('GET', '/api/service-fees', 'manager', (ctx) => ({ fees: getFeeConfig(ctx.db) }));
  r.add('PUT', '/api/service-fees/:code', 'admin', (ctx) => ({ fees: updateFee(ctx.db, ctx.user, ctx.params.code, ctx.body, ctx.now()) }));
  r.add('GET', '/api/price-history', 'admin', (ctx) => ({ history: listPriceHistory(ctx.db) }));

  // ---- Daily Inventory ----
  // Everyone signed in can look and export. Typing numbers in and starting a new business day are for managers and the admin; the server checks it.
  const dateQuery = (ctx) => {
    const d = ctx.query.date;
    if (d === undefined || d === '') return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'The business date must look like 2026-10-12.', 'VALIDATION');
    return d;
  };
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const dir = (ctx) => ({ dir: inventoryDir(ctx.config) });
  r.add('GET', '/api/inventory', 'cashier', (ctx) => getInventory(ctx.db, ctx.user, { date: dateQuery(ctx) }, ctx.now()));
  r.add('PATCH', '/api/inventory/records/:id', 'manager', (ctx) => updateRecord(ctx.db, ctx.user, idParam(ctx), ctx.body, ctx.now()));
  // Submit Inventory Today (Revision 11): saves today's inventory file on this computer and records it; the screen then downloads it.
  r.add('POST', '/api/inventory/submit', 'manager', (ctx) => created(submitInventory(ctx.db, ctx.user, ctx.body, ctx.now(), dir(ctx))));
  r.add('GET', '/api/inventory/submissions/:id/file', 'cashier', (ctx) => {
    const file = submissionFile(ctx.db, idParam(ctx), dir(ctx).dir);
    return { __raw: { headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${file.name}"` }, body: file.body } };
  });
  // Save (Revision 13): keep the open day's numbers in the database, one row per day. Saving again replaces it.
  r.add('POST', '/api/inventory/save', 'manager', (ctx) => saveDay(ctx.db, ctx.user, ctx.now()));
  r.add('GET', '/api/inventory/saved', 'cashier', (ctx) => savedDay(ctx.db, dateQuery(ctx)));
  // Revision 13: the screen no longer has a close button (the day closes by itself at midnight). The close routes stay for the tests.
  // Closed Inventory Today and Reset the Day. Revision 12: with submit: true (what the screen sends) the inventory is submitted and the day
  // closed in ONE step. Without it, the Revision 11 rule applies: the day's inventory must already be submitted with its final numbers.
  r.add('GET', '/api/inventory/close-check', 'manager', (ctx) => closeCheck(ctx.db, ctx.user, ctx.now(), { ...dir(ctx), submitting: ctx.query.submit === '1' }));
  r.add('POST', '/api/inventory/close-day', 'manager', (ctx) => (ctx.body?.submit === true
    ? closeAndSubmit(ctx.db, ctx.user, ctx.body, ctx.now(), dir(ctx))
    : startNewDay(ctx.db, ctx.user, ctx.body, ctx.now(), dir(ctx))));
  // Export (Revision 12, beside "Closed"): one closed business day in the layout of the submitted file. Read-only; everyone signed in.
  r.add('GET', '/api/inventory/day.xlsx', 'cashier', (ctx) => {
    const file = closedDayExport(ctx.db, ctx.user, dateQuery(ctx), ctx.now());
    return { __raw: { headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${file.name}"` }, body: file.body } };
  });

  // ---- Advanced (Revision 12, on the New order screen): ref stock, cash breakdown, expenses. Everyone signed in. ----
  r.add('GET', '/api/advanced', 'cashier', (ctx) => ({ ref: refSummary(ctx.db), money: dayMoney(ctx.db, ctx.user, {}, ctx.now()) }));
  // Store a Katay or Dead chicken in the ref: it is also added to that chicken's Katay or Dead on the Daily Inventory.
  r.add('POST', '/api/ref/store', 'cashier', (ctx) => created(storeInRef(ctx.db, ctx.user, ctx.body, ctx.now())));
  r.add('POST', '/api/cash-on-hand', 'cashier', (ctx) => created(saveCashOnHand(ctx.db, ctx.user, ctx.body, ctx.now())));
  r.add('POST', '/api/cash-count', 'cashier', (ctx) => created(saveCashCount(ctx.db, ctx.user, ctx.body, ctx.now())));
  r.add('POST', '/api/expenses', 'cashier', (ctx) => created(addExpenses(ctx.db, ctx.user, ctx.body, ctx.now())));
  r.add('POST', '/api/expenses/:id/remove', 'cashier', (ctx) => removeExpense(ctx.db, ctx.user, idParam(ctx), ctx.body, ctx.now()));

  // ---- Users (admin) ----
  r.add('GET', '/api/users', 'admin', (ctx) => ({ users: listUsers(ctx.db, ctx.user) }));
  r.add('POST', '/api/users', 'admin', (ctx) => created({ user: createUser(ctx.db, ctx.body, ctx.now()) }));
  r.add('PATCH', '/api/users/:id', 'admin', (ctx) => ({ user: updateUser(ctx.db, ctx.user, idParam(ctx), ctx.body) }));
  // Delete Account. Admin only, checked here on the server; hiding the button is not the protection.
  r.add('DELETE', '/api/users/:id', 'admin', (ctx) => ({ ok: true, ...deleteUser(ctx.db, ctx.user, idParam(ctx), ctx.now()) }));

  // ---- Orders ----
  r.add('POST', '/api/orders', 'cashier', (ctx) => {
    const result = createOrder(ctx.db, ctx.user, ctx.body, { config: ctx.config, now: ctx.now() });
    return result.duplicate ? result : created(result);
  });
  r.add('GET', '/api/orders', 'cashier', (ctx) => ({ orders: listOrders(ctx.db, ctx.query) }));
  // Order List (Kanban board): the latest saved pickup status of every open order, and moving a card.
  r.add('GET', '/api/board', 'assistant', (ctx) => listBoard(ctx.db, ctx.user));
  // Tracking Number (Revision 15): the lowest free number, for the Auto button and for filling the box in on New order.
  r.add('GET', '/api/tracking-number/next', 'cashier', (ctx) => ({ tracking_number: nextFreeTrackingNumber(ctx.db) }));
  // Butcher screen (Revision 15): the open chicken orders with how to cut them, no prices. The display (TV) account may call only this one.
  r.add('GET', '/api/butcher', 'display', (ctx) => listButcher(ctx.db));
  r.add('POST', '/api/orders/:id/fulfillment', 'assistant', (ctx) => moveOrder(ctx.db, ctx.user, idParam(ctx), ctx.body?.status, { now: ctx.now() }));
  r.add('PUT', '/api/orders/:id/bookmark', 'assistant', (ctx) => setBookmark(ctx.db, idParam(ctx), ctx.body?.bookmarked));
  r.add('GET', '/api/orders/:id', 'cashier', (ctx) => ({ order: getOrder(ctx.db, idParam(ctx), ctx.user) }));
  r.add('POST', '/api/orders/:id/cancel', 'cashier', (ctx) => ({ order: cancelOrder(ctx.db, ctx.user, idParam(ctx), ctx.body, { now: ctx.now() }) }));
  r.add('POST', '/api/orders/:id/change', 'cashier', (ctx) => {
    const result = changeOrder(ctx.db, ctx.user, idParam(ctx), ctx.body, { config: ctx.config, now: ctx.now() });
    return result.duplicate ? result : created(result);
  });
  r.add('POST', '/api/orders/:id/refund', 'manager', (ctx) => ({ order: refundOrder(ctx.db, ctx.user, idParam(ctx), ctx.body, { now: ctx.now() }) }));

  // ---- Daily Sales Report, "Download Daily Report" (everyone; a cashier only ever gets their own sales) ----
  // The report copies the shop's paper form with what the app knows. Counted-by-hand boxes are left empty. Excel only (Revision 11).
  const dailyArgs = (ctx) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date ?? '') ? ctx.query.date : toBusinessDate(ctx.now());
    const wanted = Number(ctx.query.cashier);
    const cashierId = ctx.user.role === 'cashier' ? ctx.user.id : (Number.isInteger(wanted) && wanted > 0 ? wanted : null);
    return { date, cashierId };
  };
  const dailyName = (args, ext) => `daily-sales-report_${args.date}${args.cashierId ? `_cashier-${args.cashierId}` : ''}.${ext}`;
  r.add('GET', '/api/daily-report.xlsx', 'cashier', (ctx) => {
    const args = dailyArgs(ctx);
    const data = gatherDaily(ctx.db, args);
    // X-Order-Count lets the screen say so when the report has no sales in it.
    return { __raw: { headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${dailyName(args, 'xlsx')}"`, 'X-Order-Count': String(data.orderCount) }, body: buildDailyXlsx(data) } };
  });
  // Who can be picked in the report's cashier filter.
  r.add('GET', '/api/staff', 'manager', (ctx) => ({ staff: listUsers(ctx.db).filter((u) => u.active && u.role !== 'display' && u.role !== 'assistant').map((u) => ({ id: u.id, display_name: u.display_name, role: u.role })) }));

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
  // Revision 12: the same columns as the CSV, as an Excel file whose columns are wide enough to read (a CSV cannot store column widths).
  r.add('GET', '/api/export-sales.xlsx', 'manager', (ctx) => ({
    __raw: {
      headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${exportName(ctx, 'xlsx').replace('chicken-pos_', 'chicken-pos-sales-list_')}"` },
      body: buildSalesListXlsx(gatherExport(ctx.db, ctx.query)),
    },
  }));
  r.add('GET', '/api/export.csv', 'manager', (ctx) => ({
    __raw: {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${exportName(ctx, 'csv')}"` },
      body: buildCsv(gatherExport(ctx.db, ctx.query)),
    },
  }));
}
