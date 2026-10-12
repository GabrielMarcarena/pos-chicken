# Chicken POS

A cashier screen and order records for a shop that sells chicken by weight. Cashiers pick a product, enter the live weight in kg, choose the service (Live, Po-ur & Slice, Dressed & Slice), the cutting and Dara, add other products such as eggs and condiments, add an optional discount, record how the customer paid, review, and submit. An **Order List** board then tracks each order from Ongoing to Standby to Complete (picked up); its cards are compact, can be bookmarked and sorted. Every order is saved with a unique order number. Orders can be canceled, changed or refunded without losing the original record, and managers can download a spreadsheet.

Built with plain JavaScript on Node.js and SQLite. There is nothing to install except Node.

## What changed in this version (revision 7): compact Order List cards, bookmarks, sorting, Delete Account

**1. Compact, expandable cards on the Order List.**

- Every card is **folded** by default and shows only: the order number, the customer, the total, a one-line item summary (for example "Broiler Breeder Cull 4.0 kg + 2 more"), the Ongoing / Standby / Complete badge, the order date and time, the **star** (bookmark) and the **Move ▾** button. A folded card is about half as tall as the old card, so many more orders fit in a column. Long customer names and long item lists are cut off with "..." (the full text is shown when you open the card or hold the pointer over the item line), and nothing pushes the layout wider.
- **Tap or click a card (or the ▸ arrow next to the number) to open it.** The open card shows every item with its kilos or quantity and preparation, the customer, the order date and time, the discount, the total, the **payment** (method, amount, reference number) and the cashier, plus the existing **Details** button (opens the full order) and a **Show less** button. Tap again, or tap **Show less**, to fold it. Keyboard: Tab to a card and press Enter or Space.
- Opening or folding a card **never** changes a status. The star, **Move ▾**, **Details**, right-click and drag and drop work on their own and do not open or fold the card. Every column uses the same card. Cards you opened stay open while the board refreshes by itself, and everything starts folded again the next time you open the Order List.
- Payment on the open card shows the method, the amount and the reference number only. The account name and account or mobile number are not shown on the board; they are still in Orders > open an order, as before.

**2. Bookmarks (flags).**

- Every card has a **star**. Tap it to bookmark the order (gold star, gold edge on the card), tap again to remove the bookmark. It is also in the right-click menu (**Bookmark this order / Remove bookmark**) and in the Move menu on phones.
- A bookmark does **not** change the order's status. It is saved on the order itself (new column `orders.bookmarked`, tied to the order's id), so it stays with the right order when the order moves between Ongoing, Standby and Complete, and after you refresh or sign in again.
- Bookmarks are **shared by the whole shop** (one flag per order, not one per person): if the manager bookmarks an order, the cashier sees the star too.
- **Show: All orders / ★ Bookmarked** (with the number of bookmarks) sits above the board. With "Bookmarked" the columns show only bookmarked orders and a note says "Showing bookmarked orders only: 3 of 12 orders on the board" with a **Show all orders** button. Bookmarked orders are **not** forced to the top; they just have the star and the gold edge.
- Canceled and replaced orders are not on the board, so they cannot be bookmarked (the server refuses it).

**3. Sorting.** **Sort by** above the board: **Newest first** (default), **Oldest first**, **Customer A–Z**, **Customer Z–A**, **Order number**. The sort is applied **inside each column** and never moves a card to another column. It uses the stored order date and time, the customer name as typed at checkout, and the order number. It works together with the Bookmarked filter.

- An order with a **missing or invalid date** is put at the end of the column in both date sorts (it never breaks the list).
- **Walk-in** orders (no customer name) are placed after the named customers in both A–Z and Z–A. Orders with the same name show the newest first. Names ignore capital letters.
- **Order number** sorts ascending (ORD-20261011-009 before ORD-20261012-001); because the number starts with the date, this is also oldest to newest.
- Your sort choice is remembered in this browser. The Bookmarked filter is not: after a refresh you see all orders again, so no order ever looks like it is missing.

**4. Delete Account (Users tab, admin only).**

- Each user row has a red **Delete Account** button. Clicking it only opens the question **"Delete this user account?"** with the message "Are you sure you want to delete this account? This action may permanently remove the user's access and associated account data. Please confirm that you want to continue.", the person's name, username, role and status, and the buttons **Cancel** and **Delete Account**. Nothing is deleted on the first click. Cancel, Close or the Escape key leaves the account exactly as it was. The confirm button turns off after one click, and a second request for the same account is answered with "not found", so a double click cannot delete twice.
- **The server decides, not the button.** `DELETE /api/users/:id` requires the admin role like every other admin action, so a cashier or manager gets 403 (and a signed-out request gets 401), whatever they do in the browser.
- **Protected accounts** (the button is replaced by a label, and the server refuses a direct request too): **yourself** ("This is you"), the **main owner account** (the first admin created) and the **last active admin**.
- **Order history is never deleted.** Every order, payment and audit entry names the person who made it, so an account that appears in any of them is **closed instead of erased**: sign-in is switched off, the password is wiped, open sessions end, and it disappears from the Users list. The old records keep the person's name. An account nobody used yet (a mistake, a test account) is removed completely. The message after confirming tells you which: "Juan was deleted." or "Maria was deleted. Their past orders and payment records were kept."
- A closed account's **username stays reserved**, so a new person with the same username cannot be mistaken for the old one in the history. Pick another username for a new person.
- The Users list refreshes by itself afterwards. Errors (for example the account was already deleted by someone else) show a clear message in the dialog.

**Database change (automatic).** The database version goes from 5 to 6: two columns are added, `users.deleted_at` (empty for everyone) and `orders.bookmarked` (0 for every order). No table is recreated and no row is changed or removed. On the first start a safety copy is saved next to your data file (`pos.db.before-v6-<date>.bak`); keep it until you are happy. The upgrade runs once, is safe to repeat, and if any step fails nothing is changed. Tried on a real version 5 database (see section 5).

**Please confirm (assumptions I made):**
1. **Bookmarks are shared by all staff** and are stored on the order. If you want each person to have their own bookmarks, tell me.
2. Bookmarking is not written to the order's history (it is a marker, not a change to the sale). Tell me if you want it logged.
3. **Delete Account does not erase accounts that already appear in orders**: it closes them (as above) so the sales history, refunds and audit log stay complete. Accounts that never did anything are erased for good.
4. Protected accounts are: yourself, the **first admin** (main owner) and the **last active admin**. Other admins can be deleted by an admin.
5. **Walk-in** orders sort last in both customer sorts, and **Order number** sorts from oldest to newest.
6. **Clicking a card now opens or folds it** (before, clicking a card opened the full order details). The full order is still one tap away with **Details** on the open card or in the right-click menu.
7. The sort choice is remembered in the browser; the Bookmarked filter and the open cards are not remembered.
8. The **Move ▾** button stays on folded cards so phones and tablets can still move orders without opening them.

## Revision 6: Payments restored, Orders tab status fixed

**1. The Payments section is back exactly as it was in Version 4.** In revision 5 you asked only for a wording change, but I changed more than that: I removed the **Not recorded** choice, forced the cashier to pick a method from a "Choose how the customer paid" placeholder, hid the **Amount paid** box until a method was chosen, made the server refuse any order without a payment, and added red "(required)" tags. That was my mistake, and all of it is undone. I copied the Version 4 payment code back (from the revision 4 zip I gave you, which is the reference) and re-applied only your wording change:

- Heading: **Payment details (optional)** is now **Payment details (required)**. Nothing else about the section is different from Version 4 (same grey text style, same layout).
- Restored from Version 4: the explanation line ("This only records what you type for billing. It does not charge anyone and does not replace the official receipt."), **How did the customer pay?** with **Not recorded**, Cash, GCash, Maya, Bank transfer and Other (it starts on Not recorded), **Amount paid (₱)** that starts at the order total, and for GCash, Maya and Bank transfer the **Payment date and time**, **Account name**, **Account or mobile number** and **Reference number** (all optional). The warnings are back too: an amount of ₱0 is refused ("Enter the amount paid, for example 208.80."), and an amount different from the order total is flagged before submitting. **Change order** fills in the payment method of the original order again, and the server's payment checks are the Version 4 ones.
- **Heads-up, please read:** because the section is exactly Version 4, **Not recorded is still available, so the heading says "(required)" but an order can still be submitted without payment details.** I did not re-add any enforcement, because you asked for no changes beyond the wording. If you want it enforced, tell me exactly how (for example: remove Not recorded and block Submit until a method is chosen).

**2. The Orders tab now shows the same status as the Order List.**

- **Cause:** the app keeps two different statuses for an order. The Order List column (Ongoing, Standby, Complete) is the pickup status. The Orders tab showed the other one, the sale status, which says whether the sale stands (Completed, Canceled, Refunded, Replaced). Every normal order has the sale status "Completed", so an order in the Ongoing column was labeled "Completed" in the Orders tab, even though both screens were reading the same saved order. The two words also look alike (Completed and Complete). It was a display and naming bug, not a saving bug: the status was always saved correctly.
- **Fix:** the Orders tab list and the order details now show the saved Order List status for that exact order (found by its order id, never by name or position). An order in Ongoing shows **Ongoing**, in Standby shows **Standby**, in Complete shows **Complete**. A **refunded** order is still on the Order List, so it shows its column plus a Refunded badge. **Canceled** and **Replaced** orders are not on the Order List, so they show Canceled or Replaced.
- **Colours follow the Order List:** the status on the Orders tab (and in the order details) is **yellow** for Ongoing, **blue** for Standby and **green** for Complete, the same colours as the three columns on the Order List. An order that sits in the blue Standby column shows as a blue **Standby** on the Orders tab.
- The **Status filter** now lists the Order List words first (Ongoing, Standby, Complete) and the sale statuses under their own heading (Completed, Canceled, Refunded, Partially refunded, Replaced). Nothing was removed: the sale statuses are still saved, still used for sales totals, exports and the Daily Sales Report, and still filterable.
- While the Orders tab is open it asks for the saved statuses again every 20 seconds (and stops when you leave), so a status moved on another device shows up without pressing Search. The order details always load fresh when opened.
- There is no new table and no database change in this revision (the database version is still 5, so there is no upgrade step this time).

**Please confirm (assumptions I made):**
1. On the Orders tab, a normal order's **Status** column shows Ongoing / Standby / Complete instead of "Completed". The sale status "Completed" is still saved and still available in the filter under "Sale".
2. The Excel and CSV export still has its **Status** column with the sale status (Completed, Canceled ...) as before; I did not change the export. Tell me if you want a **Pickup status** column added to it.

## Revision 5: required payment, new discount reasons, Order List board

- **Payment details heading** now says **Payment details (required)**. (Revision 5 also forced a payment method and removed "Not recorded". That went beyond the wording change and was undone in revision 6; see above.)
- **Four new discount reasons:** **Bulk Order Discount**, **Reject**, **Employee Discount** and **VIP**, next to Senior citizen and Other. They appear in the Discount section of the review screen, on the slip, in the order details and in the spreadsheet export.
- **New tab: Order List** (right next to New order). A Kanban board with three side-by-side columns:
  - **Ongoing** (orange): orders being prepared. Every new order starts here.
  - **Standby** (blue): ready, waiting for the customer to pick up.
  - **Complete** (green): claimed by the customer. Moving a card to Complete asks "Has the customer picked up the order?" first, so Complete means the customer really has it.
  - Each card shows the order number, customer (Walk-in if none), the items with heads, kilos or quantity and the preparation, the order date and time, and the total. Refunded orders stay on the board with a "Refunded" badge.
  - **Drag and drop** a card to another column (the columns that can take it get a dashed outline and a "Drop here" label, the one under the card lights up). Or **right-click** a card for **Move to Ongoing / Move to Standby / Mark as Complete** (and View order details). On a phone or tablet, tap the **Move** button on the card. From the keyboard: focus a card and press **Alt + Left/Right arrow**, or the Menu key.
  - Every move is **saved immediately** and the screen shows it in the right column. If the server cannot save it, the card jumps back and a message says why. The board always loads the latest saved statuses when you open it, press Refresh, or come back from another tab, and it checks again by itself every 20 seconds, so two cashiers see the same board. A card can never appear twice.
  - **Completed orders stay visible** in the Complete column. It shows the last 7 days by default; the selector at the top widens it to Today, 30 days or All dates. Ongoing and Standby always show every open order, however old.
  - **Canceled and replaced orders are not on the board** (they will never be picked up). A refunded order stays, marked.
  - On a small screen the board scrolls sideways (the page itself does not).
- **Pickup status vs sale status.** The Order List only changes the **pickup status** (Ongoing / Standby / Complete). The sale (items, prices, discount, payment, Completed / Canceled / Refunded) is never touched, and canceling, refunding or changing an order works exactly as before. Every move is written to the order's history ("Moved on the Order List: Ongoing → Standby", who and when), visible in Orders > open an order > History. Moves are not counted as a "last action" in the spreadsheet; they appear in the Audit Log sheet.
- **Your orders are kept.** This version adds **one column** to the existing orders table (no new table). On the first start the database upgrades itself, saves a safety copy first (`pos.db.before-v5-....bak`), and changes nothing else: orders from **before today** are marked **Complete** (they were already handled), orders from **today** start in **Ongoing**. The upgrade was rehearsed on a real revision 4 database (see section 5).

**Please confirm (assumptions I made):**
1. *(Withdrawn in revision 6: payments are exactly as in Version 4.)*
2. When you upgrade, existing orders from earlier days go straight to **Complete**, and today's orders go to **Ongoing**. Otherwise the first screen would be full of old orders.
3. Any signed-in user (cashier, manager or admin) can move any card, in any direction, and every move is logged. Moving a card back out of Complete is allowed (to fix a mistake) and is logged.
4. A **Change order** creates a new replacement order, which starts in **Ongoing** (it has to be prepared again).
5. The Complete column shows the last 7 days unless you widen it, so it stays quick on a busy shop.
6. "Reject" is saved as a discount reason exactly as written. Its notes box is optional, like the other reasons except "Other".

## Revision 4: Daily Sales Report and per-head services

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

**Upgrading.** From version 2, 3, 4 or 5 (the previous zips): replace the app folder as described in the update steps, keep your `.env` and your data file, and start it. The database upgrades itself on the first start (2 → 3 → 4 → 5 → 6 in one go if needed) and one safety copy of your data file is saved next to it first (for example `pos.db.before-v6-202610121500.bak`). Keep that copy until you have checked your orders. A database made by the very first version of the app is refused with a clear message instead of being damaged; if you only ran the demo or tests, delete `data/*.db` and start again, and if you had real orders, do not delete anything and ask for a migration.

### Settings (`.env`)

| Setting | Meaning | Default |
|---|---|---|
| `PORT` | Port to listen on | 3000 |
| `DB_PATH` | Database file. Point this at a persistent disk when hosting | data/pos.db |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | First-run admin, used only when there are no users | none |
| `SESSION_IDLE_MINUTES` | Sign out after this much inactivity | 240 |
| `COOKIE_SECURE` | `auto` adds the Secure flag when the request came over HTTPS | auto |
| `LARGE_WEIGHT_KG` | Weights above this ask the cashier to confirm | 50 |

**Copying your data:** the database is the file `pos.db` plus, while the app is running, small companion files (`pos.db-wal` and `pos.db-shm`). Stop the app with Ctrl+C first (it saves everything into `pos.db`), or copy all the `pos.db*` files together. The safest copy is `npm run backup`, which works even while the app is running.

Other commands: `npm run create-user -- <username> <cashier|manager|admin>` adds a user. `npm run backup` saves a consistent copy of the database into `backups/` (safe while the server runs).

## 3. How the screens work

- **New order**: tap a product, type the weight with the number pad (or keyboard), choose the service and cutting, tap Add to order. The scale-style readout shows `₱58.00/kg × 3.6 kg = ₱208.80` plus the service fee, and updates as you change anything. **Other products**: tap a product, choose how it is sold (per dozen, per piece, per kg ...), type the quantity (whole numbers for fixed-price items, decimals for per-kg), add. Edit or remove any line. The unsent order survives a refresh.
- **Review**: the Order Slip with the double-check warning. Submit stays locked until the cashier ticks the confirmation box. **Discount** (optional: Senior citizen, Bulk Order Discount, Reject, Employee Discount, VIP or Other) and **Payment details** (the heading says required; the choices are Not recorded, Cash, GCash, Maya, Bank transfer or Other, then the amount, and for GCash/Maya/bank the optional date and time, account name, account or mobile number and reference number) are on this screen.
- **Order List**: the Kanban board (Ongoing, Standby, Complete) described above, with compact cards you tap to open, a star to bookmark, **Sort by** and **Show: All orders / Bookmarked** (revision 7). Drag a card, right-click it, or tap Move.
- **Orders**: search by order number or customer, filter by date and status, open any order to see exactly what was saved. The **Status** column shows the same status as the Order List for that order (Ongoing, Standby or Complete; Canceled or Replaced for orders that are not on the Order List; a Refunded badge on refunded ones). Cancel, change (void and replace) or refund (managers).
- **Products** (managers and admin) and **Users** (admin: add, edit, deactivate and delete accounts).

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
- **Pickup status** (Order List): every order is Ongoing, Standby or Complete. It is the one thing about a submitted order that can change besides the sale status, and each change is an audit event. The database only accepts those three values.
- The database refuses edits and deletes of submitted lines, discounts, payments and audit events.

### Who can do what

| | Cashier | Manager | Admin |
|---|---|---|---|
| Take orders, apply a discount, cancel/change orders | yes | yes | yes |
| Use the Order List (move orders between Ongoing, Standby, Complete), open cards, bookmark, sort | yes | yes | yes |
| Download the Daily Sales Report | own sales | all, or one cashier | all, or one cashier |
| Refund, export, add products and ways of selling them | | yes | yes |
| Set or change **any price** (chicken per kg, service fees, other products) | | | yes |
| Manage users (add, edit, deactivate, **delete**) | | | yes |

### Spreadsheet export (managers and admin)

Orders > Spreadsheet export downloads `.xlsx` or `.csv` for the date range. The Excel file has **Transactions** (one row per item), **Orders**, **Audit Log**, **By Product** (totals per product and unit), **By Day / Week / Month** (with discounts given) and **Definitions**. Canceled rows are red, refunded amber, replaced gray, and the Status column says it in words. Order Total, discount and payment columns appear only on the first line of each order, so totals never double-count.

## 4. What works now, and what does not exist yet

**Built and tested:** sign-in and roles, chicken products, services and fees, flexible other products with several ways of selling, the checkout and review flow, discounts with reasons, payment details, order numbers, duplicate-submit protection, order history, cancel/change/refund with audit log, the Order List board with compact cards, bookmarks and sorting, user management with Delete Account, XLSX and CSV export, backup command.

**Not built yet:**
- **Inventory counts on the Daily Sales Report** (balance, additional, left, egg beginning/left), **expenses, other collections and the cash count** are blank boxes to fill by hand; the app does not record them yet.
- **Offline checkout.** The app needs the server to be reachable. If the connection drops, the screen shows a clear error and keeps the unsent order on screen; nothing is saved until the server confirms.
- **Inventory**, a **dashboard**, **partial refunds**, **live Google Sheets sync**, and **receipt printer support** ("Print slip" uses the browser's print dialog; the slip says it is not an official receipt).

**Assumptions in this version (please confirm; the revision 5 ones are listed at the top):**
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
npm test                 # 95 tests: money, services, heads, discounts, daily report, sorting, database safeguards and upgrades (2→3→4→5→6), full API incl. payments, the Order List, bookmarks and Delete Account
npm install              # only for the browser test: installs Playwright
npx playwright install chromium
npm run test:e2e         # 54 checks driving the real screens in Chromium (drag and drop, right-click, folded and open cards, bookmarks, filter, sorting, Delete Account, Orders vs Order List status and colours, and phone-size screens)
```

Last results (Node 22.22): `npm test` **95 of 95 passed**; browser test **54 of 54 passed**; the preview page's own browser checks **28 of 28 passed**. Both suites were also run from the unzipped package and from a folder whose name contains a space, such as `POS device` (see the final report for the exact results).

What the revision 7 tests cover:

- **Cards:** folded by default; a click opens, another click folds; Move, the star and Details do not open or fold the card; opening a card never changes its status (checked in the saved data); long names and long item lists do not make a card or the page wider.
- **Bookmarks:** set and remove; saved after a page reload; the Bookmarked filter shows exactly the bookmarked orders; the bookmark stays with its order after moving it between columns; canceled orders cannot be bookmarked; no order data is changed by bookmarking.
- **Sorting:** all five options, in every column, on known orders (including a walk-in, equal names, a missing and an invalid date), together with the Bookmarked filter; the saved orders are identical before and after sorting.
- **Delete Account:** a cashier and a manager are refused (403) by a direct request, and signed-out requests get 401; an admin can delete an unused account; an account with orders and payments is closed and every order, payment and audit row is unchanged and still shows the person's name; Cancel leaves the account unchanged; you cannot delete yourself, the main owner or the last active admin (UI and direct request); two requests at once delete once; the username stays reserved.
- **Upgrade 5 → 6:** run on a database built by the real revision 6 app with real orders (see below).

The upgrade to version 6 was rehearsed on a real revision 5 database: it was created by the revision 6 app itself (orders including a canceled one, a refund, payments, users who had taken orders, 8+ audit rows), then opened with this version. The database version went 5 → 6, the safety copy was created and was identical to the original, every row in order_items, payments, products, fees and the other data tables came through unchanged, the audit rows were identical, the orders were identical apart from the new `bookmarked` column (0), integrity and foreign-key checks were clean, and a second start did nothing. Then a bookmark, a move and the deletion of an account with history were done on that copy, and the order readout was identical before and after the account was deleted. (Earlier revisions' upgrade rehearsals are described in their sections.)

The Excel exports, including the Daily Sales Report, were checked in revision 4 (openpyxl and LibreOffice recalculation, PDF layout); this revision does not change them. **Not tested:** printing on your actual printer and paper size; Microsoft Excel and Google Sheets themselves; Safari or Firefox; real tablets or phones (drag and drop, folding cards and the star were tested with a mouse in Chromium, and the phone-size layout in a resized Chromium window; real touch dragging varies by device, which is why the **Move** button exists); a real scale or printer; any internet host.

## 6. Folder guide

```
server.js            starts the server (and adds the starter data on first run)
src/db.js            tables, constraints and triggers
src/routes.js        the API and who may call each route
src/services/        users, catalog (products, other products, fees), orders, export, dailyReport
src/xlsx.js, zip.js  spreadsheet writer (no packages)
shared/              rules used by both browser and server: money, services, pricing, discounts, Order List sorting (boardSort.js)
public/              the screens: index.html, css/app.css, js/views/* (board.js is the Order List, users.js the Users tab)
scripts/             demo, create-user, backup
tests/               unit, api and browser tests (tests/fixtures/schema-v4.sql and schema-v5.sql are the revision 4 and 5 database layouts, used to test the upgrades)
```
