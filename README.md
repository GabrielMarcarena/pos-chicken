# Chicken POS

A cashier screen and order records for a shop that sells chicken by weight. Cashiers pick a product, enter the live weight in kg, choose the service (Live, Po-ur & Slice, Dressed & Slice), the cutting and Dara, add other products such as eggs and condiments, add an optional discount, review, and submit. Every order is saved with a unique order number. Orders can be canceled, changed or refunded without losing the original record, and managers can download a spreadsheet.

Built with plain JavaScript on Node.js and SQLite. There is nothing to install except Node.

## What changed in this version (revision 4): Daily Sales Report and per-head services

- **Daily Sales Report** (Orders screen, top panel). Pick a date and download **Excel (like the paper form)** or a **CSV with one row per sale line**. The Excel sheet copies your paper form: a block for B-CULL, CULL and BROILER (price, SOLD heads, and a ledger of # of HDS, customer #/name, kilos, price, service, price and amount with totals), EGGS by size, OTHERS, and the COLLECTIONS, GROSS SALES, NET SALES summary. It prints landscape, fitted to one page wide.
- **Filled in by the app:** date, time span (first to last sale), cashier, every ledger line, block totals, heads sold, eggs and other products sold and their amounts, collections by type, gross sales, discounts, refunds and net sales.
- **Left empty for the cashier to write or type in:** Chicken Balance, Additional, TOTAL and LEFT; egg BEG and LEFT; EXPENSES; OTHER COLLECTIONS; CASH BREAKDOWN and EXCESS/LOSS. The totals under them (expenses total, overall total, less expenses, net sales) update by themselves when numbers are typed in. A second sheet, **Notes**, explains every column.
- **Rules:** a cashier gets only their own sales; a manager or admin can choose one cashier or all. Only sold orders are listed (canceled and replaced orders are not; a refunded order is listed, marked "(refunded)", and taken off under LESS REFUNDS). No payment details appear in this report. A chicken product that is not B-cull, Cull or Broiler gets its own block to the right of the Broiler block, so nothing is lost. Eggs are shown in the units they were sold in (for example "2 dozen + 5 piece"), so no tray size is needed.
- **Service fees are now charged per head** by default: 3 heads with a ₱25 service is 3 × ₱25 = ₱75. A new install starts this way. On the first start, an existing database is upgraded: any service fee still set to "per line (flat)" is switched to "per head" (amounts and saved orders are not touched; each change is written to the price history, and a safety copy of your data file is saved first). The admin can change any fee back in Products > Service fees.

**Please confirm:** the prices I have are Po-ur & Slice ₱45 and Dressed & Slice ₱25. Your note about per-head fees used ₱25 for burning chicken. If burning is now ₱25, the admin changes Po-ur & Slice to 25 in Service fees.

## Revision 3: Number of Heads

- **New field on the New order screen: Number of heads.** After you tap a chicken product, set how many chickens the customer is buying (1, 2, 3 or more, with − and + buttons or by typing), then enter the **combined weight of all of them in one entry**. Example: B-cull, 3 heads, 5.4 kg together at ₱52.00/kg = **₱280.80**. The price always follows the total weight; the number of heads never changes the weight charge.
- The heads and the total weight are saved on that line, shown on the order panel, the review slip, the order details and the spreadsheet (new **Number of Heads** column, plus **Heads Sold** on the summary sheets). A single chicken (1 head) looks exactly as before.
- **Service fees can be charged three ways** (admin, Products > Service fees): **per line (flat)**, **per head**, or **per kg**. Per head multiplies the fee by the number of heads (3 heads at ₱45 = ₱135). Per head became the default in revision 4.
- **Your orders are kept.** This version changes the database, so the first start upgrades it automatically, saves a safety copy of your data file first (`pos.db.before-v3-....bak`), and keeps every order. Existing chicken lines count as 1 head.
- Small fix: tapping the "New order" tab while the "Order saved" screen is showing now starts a fresh order.

## Earlier changes (revision 2)

- **Services.** The choices are now **Live** (no fee), **Po-ur & Slice** (burn chicken, ₱45.00) and **Dressed & Slice** (dress chicken, ₱25.00). Po-ur and Dressed are always sliced, so there is no separate slice fee. The cutting row is one choice: **Small pieces, Medium pieces, Large pieces, or Dukot** (last).
- **Prices are flexible and admin-only.** Service fees, chicken prices per kg and other-product prices can be changed only by the admin (Products screen). Managers can add products but cannot set prices.
- **Other products.** The starter list is Eggs (Small, Medium, Large), Etag (Sun-Dried), Etag (Smoked), Garlic, Onions and Laya. Each product can be sold in several ways, each with its own price: a **fixed price** per piece, dozen, pack or batch (whole numbers), or a **price per kg**. You can add any product and any way of selling it without touching the code.
- **Discounts.** On the review screen, an optional **fixed (₱)** or **percentage (%)** discount with a reason (for example Senior citizen). It comes off the whole order and is saved and exported.
- **Look.** Product cards have pictures, services are full-width rows with their fee, and other products have a search box.

## 1. Try it in two minutes (demo mode)

You need **Node.js 22.13 or newer** (https://nodejs.org, choose the LTS or newer). Open a terminal in this folder and run:

```
npm run demo
```

Open http://localhost:3000 and sign in with one of:

| Username | Password | Can do |
|---|---|---|
| demo-cashier | demo-cashier-1 | Take orders, discounts, search orders, cancel and change orders |
| demo-manager | demo-manager-1 | Also refunds, spreadsheet export, add products and ways of selling them |
| demo-admin | demo-admin-1 | Also all prices, service fees, users, price history |

Demo mode uses its own file (`data/demo.db`). The chicken products and the **other-product prices are samples only**. Never copy them into your real data.

## 2. Set it up for real

1. Copy `.env.example` to `.env` and set `ADMIN_USERNAME` and `ADMIN_PASSWORD` (at least 8 characters). Never share or commit `.env`.
2. Run `npm start`. The first start creates the admin account and the **starter data**: service prices (Po-ur & Slice ₱45, Dressed & Slice ₱25) and your list of other products.
3. Sign in as the admin, then in **Products**:
   - **Chicken products**: add your chicken types and set each price per kg.
   - **Other products**: open **Sold by & prices** for each starter product and set its prices (they start with no price, so cashiers do not see them until you do). Typing a price turns that way of selling on.
   - **Service fees**: check the service prices, set Dara or Dukot fees if you want them (both start at ₱0.00).
   - **Users** (admin only): add your cashiers and managers.
4. Real data is stored in `data/pos.db`.

To use it on tablets in the shop, run it on one computer that stays on, find that computer's address on the shop network (for example `192.168.1.20`), and open `http://192.168.1.20:3000` on each tablet.

**Upgrading.** From version 2 (the previous zip): replace the app folder as described in the update steps, keep your `.env` and your data file, and start it. The database upgrades itself on the first start and a safety copy is saved next to it. A database made by the very first version of the app is refused with a clear message instead of being damaged; if you only ran the demo or tests, delete `data/*.db` and start again, and if you had real orders, do not delete anything and ask for a migration.

### Settings (`.env`)

| Setting | Meaning | Default |
|---|---|---|
| `PORT` | Port to listen on | 3000 |
| `DB_PATH` | Database file. Point this at a persistent disk when hosting | data/pos.db |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | First-run admin, used only when there are no users | none |
| `SESSION_IDLE_MINUTES` | Sign out after this much inactivity | 240 |
| `COOKIE_SECURE` | `auto` adds the Secure flag when the request came over HTTPS | auto |
| `LARGE_WEIGHT_KG` | Weights above this ask the cashier to confirm | 50 |

Other commands: `npm run create-user -- <username> <cashier|manager|admin>` adds a user. `npm run backup` saves a consistent copy of the database into `backups/` (safe while the server runs).

## 3. How the screens work

- **New order**: tap a product, type the weight with the number pad (or keyboard), choose the service and cutting, tap Add to order. The scale-style readout shows `₱58.00/kg × 3.6 kg = ₱208.80` plus the service fee, and updates as you change anything. **Other products**: tap a product, choose how it is sold (per dozen, per piece, per kg ...), type the quantity (whole numbers for fixed-price items, decimals for per-kg), add. Edit or remove any line. The unsent order survives a refresh.
- **Review**: the Order Slip with the double-check warning. Submit stays locked until the cashier ticks the confirmation box. **Discount** (optional) and **Payment details** (optional: method, amount, and for GCash/Maya/bank the date and time, account name, account or mobile number, reference) are on this screen.
- **Orders**: search by order number or customer, filter by date and status, open any order to see exactly what was saved. Cancel, change (void and replace) or refund (managers).
- **Products** (managers and admin) and **Users** (admin).

**Number of heads:** on a chicken product, set the heads first (default 1), then type the total weight. Example: 3 heads, 5.4 kg together. The heads must be a whole number from 1 to 999. The "more than 50 kg" check looks at the total weight.

### The service and cutting rules (enforced on screen, on the server and in the database)

1. A service is required: **Live**, **Po-ur & Slice** (burn chicken) or **Dressed & Slice** (dress chicken).
2. **Live** clears and switches off Dara and cutting, and has no fee.
3. **Po-ur & Slice** and **Dressed & Slice** always need one cutting choice: **small, medium or large pieces, or Dukot**. Only one at a time. Dukot keeps no slice size.
4. **Dara** is optional (not for Live) and independent of the others. Changing one choice never resets another.
5. Everything is saved on the specific chicken line, not on the whole order.

### Money rules

- Chicken line = price per kg × **total** live weight (all the heads weighed together), plus the service fee. A service fee is a flat amount per line, a rate per head (× the number of heads), or a rate per kg (the admin chooses). **Example:** 3.6 kg Cull Chicken at ₱58.00/kg is ₱208.80; as Po-ur & Slice it is ₱253.80, as Dressed & Slice ₱233.80, as Live ₱208.80.
- Other products: **fixed price** items = price × a whole quantity (2 dozen at ₱120 = ₱240.00); **per-kg** items = price per kg × weight (1.5 kg at ₱80 = ₱120.00).
- **Subtotal** = sum of all lines. **Discount** (optional) is a fixed amount or a percentage of the subtotal, rounded half up to the centavo, and must be more than ₱0 and less than the subtotal. **Total** = subtotal − discount. Example: ₱253.80 with 20% off is ₱203.04.
- The server recalculates every price from the database. Prices sent by the browser are ignored, and an order is refused if a price changed while it was open. Past orders keep the prices, fees and discount they were sold with.

### Order lifecycle

- Order numbers look like `ORD-20261009-001`, use the Philippine date, come from an atomic counter in the database, and are never reused, even after a cancellation. Submitting twice (double tap, slow network) saves one order.
- **Cancel**: status Canceled, the order stays. A reason is required ("Other" needs an explanation). **Change**: the original becomes Replaced and a new linked order is created (the discount is carried over so you can adjust it). **Refund** (managers): full refund of the discounted total. It records the refund only; stock is never returned automatically.
- Gross sales count Completed, Refunded and Partially refunded orders, after discounts. Canceled and Replaced orders are never sales. Net sales = gross sales − refunds.
- The database refuses edits and deletes of submitted lines, discounts, payments and audit events.

### Who can do what

| | Cashier | Manager | Admin |
|---|---|---|---|
| Take orders, apply a discount, cancel/change orders | yes | yes | yes |
| Download the Daily Sales Report | own sales | all, or one cashier | all, or one cashier |
| Refund, export, add products and ways of selling them | | yes | yes |
| Set or change **any price** (chicken per kg, service fees, other products) | | | yes |
| Manage users | | | yes |

### Spreadsheet export (managers and admin)

Orders > Spreadsheet export downloads `.xlsx` or `.csv` for the date range. The Excel file has **Transactions** (one row per item), **Orders**, **Audit Log**, **By Product** (totals per product and unit), **By Day / Week / Month** (with discounts given) and **Definitions**. Canceled rows are red, refunded amber, replaced gray, and the Status column says it in words. Order Total, discount and payment columns appear only on the first line of each order, so totals never double-count.

## 4. What works now, and what does not exist yet

**Built and tested:** sign-in and roles, chicken products, services and fees, flexible other products with several ways of selling, the checkout and review flow, discounts, order numbers, duplicate-submit protection, order history, cancel/change/refund with audit log, optional payment details, XLSX and CSV export, backup command.

**Not built yet:**
- **Inventory counts on the Daily Sales Report** (balance, additional, left, egg beginning/left), **expenses, other collections and the cash count** are blank boxes to fill by hand; the app does not record them yet.
- **Offline checkout.** The app needs the server to be reachable. If the connection drops, the screen shows a clear error and keeps the unsent order on screen; nothing is saved until the server confirms.
- **Inventory**, a **dashboard**, **partial refunds**, **live Google Sheets sync**, and **receipt printer support** ("Print slip" uses the browser's print dialog; the slip says it is not an official receipt).

**Assumptions in this version (please confirm):**
1. Service fees are charged per head (3 heads at ₱25 = ₱75). The admin can switch a fee to per line (flat) or per kg.
2. Po-ur and Dressed are always sliced or Dukot; there is no "uncut" choice. Dukot costs the same service price; a separate Dukot fee exists but starts at ₱0.00.
3. Dara stays as an optional extra with a fee that starts at ₱0.00.
4. "Authorized person" means the **admin**: only the admin can set prices. Managers can add products and ways of selling them, but those stay hidden until the admin prices them.
5. Eggs: the size of a "batch" is not stored (it is just a label). Laya starts as a per-kg product; add a "pack" way of selling if you sell it that way.
6. Discounts apply to the whole order (other products included) and any cashier can apply one with a reason. If you want a manager to approve discounts, ask for it.
7. Your request said "Try to make the appearance more" and was cut off; I read it as more modern and easier to scan (pictures, clearer cards).
8. Other-product starter prices are unknown, so none were invented.

**Hosting.** The app needs a computer that runs Node 22.13+ and keeps a file on disk (a shop PC, a small VPS, or a host with a persistent disk). Static hosts such as Netlify cannot run it. This was not deployed to any host during development.

## 5. Running the tests

```
npm test                 # 62 tests: money, services, heads, discounts, daily report, database safeguards and upgrades, full API
npm install              # only for the browser test: installs Playwright
npx playwright install chromium
npm run test:e2e         # 32 checks driving the real screens in Chromium
```

Last results (Node 22.22): `npm test` 62 of 62 passed; browser test 32 of 32 passed (run twice). The upgrades were also tried on databases created by the real earlier versions: every existing order came through unchanged. The Excel exports, including the Daily Sales Report, were opened with openpyxl and recalculated in LibreOffice (0 formula errors, values identical to the app's, checked against a hand calculation of a sample day) and rendered to PDF to check the printed layout. **Not tested:** printing on your actual printer and paper size (it is set to A4 landscape; change it in Excel's Page Layout if you print on long bond). **Not tested:** Microsoft Excel and Google Sheets themselves, Safari or Firefox, real tablets, a real scale, a printer, or any internet host.

## 6. Folder guide

```
server.js            starts the server (and adds the starter data on first run)
src/db.js            tables, constraints and triggers
src/routes.js        the API and who may call each route
src/services/        users, catalog (products, other products, fees), orders, export, dailyReport
src/xlsx.js, zip.js  spreadsheet writer (no packages)
shared/              rules used by both browser and server: money, services, pricing, discounts
public/              the screens: index.html, css/app.css, js/views/*
scripts/             demo, create-user, backup
tests/               unit, api and browser tests
```
