# Chicken POS

A cashier screen and order records for a shop that sells chicken by weight. Cashiers pick a product, enter the live weight in kg, choose the service (Live, Pour, Dress, Po-ur & Slice, Dress & Slice, Pour & Dukot or Dress & Dukot, or any service the admin has added), the slice size where one is asked, and With Blood, add other products such as eggs and condiments, add an optional discount, record how the customer paid (with a change calculator for cash), review, and submit. Orders are checked against a **Daily Inventory** of stock; the day's numbers are kept with **Save**, the Excel file is made with **Submit Inventory Today**, and the day closes by itself at midnight. An **Order List** board then tracks each order from Ongoing to Standby to Complete (picked up); its cards are compact, can be bookmarked and sorted. Every order is saved with a unique order number. Orders can be canceled, changed or refunded without losing the original record, and managers can download a spreadsheet.

Built with plain JavaScript on Node.js and SQLite. There is nothing to install except Node.

## What changed in this version (revision 20): the old Service fees look, with every service and Add service

- **Products, Service fees** keeps its old look (name in bold, Fee, Charged, Save), now with **one row for every paid service** the cashier sees on New order (Pour, Dress, Po-ur & Slice, Dress & Slice, Pour & Dukot, Dress & Dukot and any you add). Live never has a fee, so it is not listed.
- **+ Add service** adds a new service (name, note, Pour or Dress, whole / sliced / Dukot, fee). It becomes a button on New order.
- **Edit** (next to Save) renames a service, changes its short note, or hides it from New order. Hidden services are never deleted; old orders keep their name.
- Underneath it is Revision 19 (below): each service has its own fee, and a sold line keeps the service name and fee it was sold with. Revision 19's separate "Services" table design was not kept.

## Earlier: revision 19: every service has its own price, and an Add service button

- **Products, Services** (renamed back to "Service fees" with the old look in revision 20). Every service the cashier can pick is listed with its own **name, note, fee and how it is charged** (per line, per head or per kg). Before, Pour, Po-ur & Slice and Pour & Dukot all shared one "Pour" fee, and the three Dress services shared one "Dress" fee, so only two rows showed. Live never has a fee (the database enforces it).
- **Nothing changes in the money on upgrade.** Each service starts with the fee it effectively had (the three Pour services with the Pour fee, the three Dress services with the Dress fee), so every price and total is the same until the admin edits one.
- **Add service** (admin). A new service is a new button on New order. The admin gives it a name, an optional note, whether it is a **Pour or Dress** service (the butcher screen and the reports group by this), the **cutting** (whole, sliced with a size, or Dukot) and its own fee. The admin can also rename a service, change its note or fee, and **Hide** it (hidden services leave New order but are never deleted, so old orders keep reading).
- **A sold line keeps the name it was sold under.** The service code and name are saved on each new order line, and the receipt's fee line carries its fee name (built-in ones keep "Pour" / "Dress", as in Revision 16). Renaming or hiding a service later never changes an old order.
- **Everything else follows the service:** the Order List, Orders, receipt, Butcher screen (big words), Customer screen and the spreadsheet exports show the service name.
- **Safe upgrade.** The database goes from version 13 to 14 with a safety copy first (`pos.db.before-v14-<time>.bak`). The upgrade adds a `services` table and two empty columns on order lines; nothing is rewritten. Older lines are read as before. A test upgrades a version 13 file and compares every order, line, fee and total.
- **Old callers still work:** an order that only says feather + cut (as older screens and tests do) gets the built-in service those mean; `updateFee('POUR' | 'NOT_POUR')` remains as a shortcut that sets all three services of that family.
- **Setup file.** `npm run export-setup` and `SETUP_FILE` now carry the services too (older setup files with only the Pour and Dress fees still load).
- **Tests:** `npm test` runs 236 automated tests (9 new in `tests/revision19.test.js`); `npm run test:browser` runs 35 browser checks (8 new). Two older browser checks that waited for a one-moment animation class were made reliable.

## Earlier: revision 18: start a hosted copy with the shop's products

- **`INVENTORY_DIR`** moves the saved daily inventory files (normally `backups/inventory`) onto a persistent disk, next to the database. Needed on a host such as Railway, where only the mounted disk survives a restart.
- **`npm run export-setup`** writes `deploy/setup.json`: chicken products, other products with their ways of selling, prices and the service fees. It holds **no users, passwords or orders**, so it is safe to keep in the public repo.
- **`SETUP_FILE=deploy/setup.json`** makes a brand-new database load that file once at start (through the normal product and price rules, so the price history records it). A restart never loads it again, so prices changed later are not overwritten.
- Railway settings for a presentation copy: a Volume at `/data`, `DB_PATH=/data/pos.db`, `INVENTORY_DIR=/data/inventory`, `SETUP_FILE=deploy/setup.json`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`, `TZ=Asia/Manila`.
- **Tests:** `npm test` runs 227 automated tests (6 new in `tests/revision18.test.js`).

## Earlier: revision 17: ready to go online, records cleared, new browser tests

- **Going online.** A step-by-step guide for a free server (Oracle Cloud, Singapore), a free address (DuckDNS), the padlock (Caddy) and nightly backups to Google Drive: [docs/deploy/online-hosting-guide.md](docs/deploy/online-hosting-guide.md). The ready-made files are in `deploy/` (auto-start service, Caddy settings, daily backup, update and address scripts). New settings in `.env.example`: `HOST` (listen only on this computer, for use behind Caddy) and `TRUST_PROXY` (use each visitor's real address for the sign-in limit; off by default, so nobody can fake it). Without them the app behaves exactly as before in the shop.
- **Clearing records now works on every table.** `npm run clear-records` failed since revision 16, because the new Cash on hand table pointed at the days it deletes. Fixed, with a test. New option `npm run clear-records -- --everything`: also deletes the open business day (every stock number, cash count, expense and cash on hand) and all sign-ins, and keeps users, products, prices and fees. The app opens a fresh day the first time someone uses it.
- **This shop's database was cleared with it** (12 test orders, 4 inventory days, 14 price changes). Kept: the admin account, 4 chicken products, 12 other products with their ways of selling, the prices and the service fees. The old backups, upgrade copies and saved inventory files of the test days were deleted.
- **Browser tests replaced.** The old `tests/e2e.mjs` checked screens that were redesigned in revision 13 (43 of its 67 checks could not pass). It was moved to `tests/old/` for reference and replaced by two current suites, `npm run test:browser` (27 checks: tracking number, customer and butcher screens, pointers, Assistant Cashier, receipt, cash on hand, product keys, feathers, chicken).
- **Smaller fixes:** `npm run create-user` now lists the Assistant and Butcher TV roles; the old hand-over notes moved to `docs/history/`.
- **Tests:** `npm test` runs 221 automated tests (6 new), on both UTC and Asia/Manila clocks.

## Earlier: revision 16: colour pointers, Assistant Cashier, cleaner receipt, shorter texts, Cash on hand, more product keys

The database is upgraded in place (version 12 → 13) with a safety copy first (`data/pos.db.before-v13-<time>.bak`). The users table is rebuilt so it accepts the new role (every account, id and sign-in is kept) and one table is added (`cash_on_hand`). Where this section and the sections below disagree, **this section is the current behaviour**.

**Each role has its own mouse pointer.** The pointer is a plain arrow (and a hand on buttons and links) in the colour of whoever is signed in: **Admin red, Manager yellow, Cashier green, Assistant Cashier blue**. Buttons and links show a hand version of the same pointer. **Only the pointer is coloured; the top bar looks the same for everyone.** The sign-in page, the Butcher screen and the Customer screen keep the normal pointer.

**Click feathers (admin only) and the Pitik chicken** (computers with a mouse only).
- When the **admin** clicks, a tiny burst of red feathers pops out. Other roles get none.
- If nobody touches the mouse or keyboard for **1 minute**, one chicken (drawn after your Pitik animation) wanders around the screen. It **pecks the screen and leaves a small crack that fades in about 10 seconds**, and bits of feed fly up. Now and then it stops, **stares out at you and blinks**, and its **eye follows the mouse pointer**. The moment you move the mouse or press a key, it hurries off and its cracks disappear.
- Neither can ever block a click, and neither shows on the sign-in page, the Butcher screen, the Customer screen or a touch screen. If the computer is set to "reduce motion", there are no feathers, and the chicken just stands still (it still blinks and watches the pointer).

**New role: Assistant Cashier.** For a helper who only updates order status.
- Sees the **Order List** and the **Butcher view** button, nothing else (no New order, Orders, Inventory, Products, Users, exports).
- Can move cards between Ongoing / Standby / Complete and bookmark them.
- **No prices anywhere:** the server does not even send totals, payments, discounts or cashier names to this role, and there is no Details button.
- Add one in **Users > Add user** and pick **Assistant Cashier**.

**Butcher and Customer screens have their own addresses.**
- `yourdomain/butcher`: the Butcher screen. It **asks for a sign-in** (the Butcher TV account, or any staff account), then shows the orders. The **Back to POS link is gone**; a staff member closes the preview tab instead. Names stay on the TV.
- `yourdomain/customerscreen`: the Customer screen. **No sign-in.** It works only on the **same computer** as the cashier window (the second monitor): the two windows talk inside that computer, so opened on another device it only shows "Welcome".
- When the app is online, use **HTTPS** so passwords are protected on the way.
- The old addresses `#/butcher` and `#/customer` still work.

**Receipt.** On paper only: the service name (for example Po-ur & Slice), **With Blood** and the slice size (Medium pieces) are not printed. The prices stay, and so does the fee line (for example **+₱135.00 Dress (3 × ₱45.00)**). On the screen the cashier still sees everything while checking the order.

**Shorter texts.** The long explanations are now one short line, with the full text folded under **How it works** (click to open): Order List, Orders (Daily Report and Export), Daily Inventory (what each button does, and "How the numbers are worked out"), Cash breakdown, Expenses, Discount, Users (what each role can do) and the picture box in Products. Nothing was deleted, only moved. The delete-account question is shorter too.

**Cash on hand (New order > Advanced > Cash breakdown).** The starting cash (panukli) put in the drawer for change.
- Type it once a day and press **Save** (saving again adds a new amount; the latest one counts and the earlier ones stay in the history).
- The summary now reads: **Overall total** (counted) · **Cash on hand** · **Cash sales today** (on its own line, cash only, after discounts and refunds) · **Less expenses** · **Expected cash** · **Excess / Loss**.
- **Expected cash = Cash on hand + Cash sales today − Expenses.**
- The **Daily Report** has a new row **PLUS CASH ON HAND** just above EXPECTED CASH, and EXPECTED CASH adds it (as a formula too). Without a cash on hand the report is the same as before.

**More product keys.** On New order the product cards are chosen with **1 to 9, then 0 (10th), then Q W E R T Y U I O P (11th to 20th)**. Each card shows its key, and the `?` key list was updated.

**Please confirm (decisions I made).**
1. The Assistant Cashier's colour is **blue** (you named red, yellow and green only).
2. The Assistant Cashier **cannot** save the Cash on hand or anything else on New order, and cannot open order Details.
3. The fee line on the receipt keeps its own fee name (**Pour** or **Dress**), as it did before, not the long service name.
4. Cash on hand can be set by any cashier, manager or admin (not by the Assistant). Only the open business day can be set.
5. Products beyond the 20th have no key; tap them.

**Tests:** `npm test` runs 215 automated tests (7 are new: the Assistant sees no money and is refused everything else, the Assistant role can be created and edited, Cash on hand and Expected cash, the locked history and the open-day rule, the Daily Report row, and the 12 → 13 upgrade). The screens were driven in headless Chromium (15 checks: the pointer of every role, the plain top bar, the click feathers, the wandering chicken, the Assistant's Order List, `/butcher` with sign-in and no Back link, `/customerscreen` with no sign-in, the printed receipt, keys 0 / Q / W with 12 products, the folded texts and Cash on hand): all passed. The old browser test (`npm run test:e2e`) is unchanged: 24 of 67 pass, the same 43 that already failed in revision 13.

## Earlier: revision 15: Tracking Number, Butcher screen, Customer screen

The database is upgraded in place (version 11 → 12) with a safety copy first (`data/pos.db.before-v12-<time>.bak`). Old orders keep every value; they simply have no tracking number. Where this section and the sections below disagree, **this section is the current behaviour**.

**Tracking Number (Change Request 1).** A tag number from **1 to 100** that marks the chicken of one order, so the butcher and the cashier never mix up two customers' chicken.
- On **New order**, a **Tracking No.** box appears as soon as there is chicken in the order. It is filled in with the **lowest free number** by itself. Type another number if you prefer, or press **Auto** to get the lowest free one again.
- A number belongs to **one active order at a time**. "Active" means the order is still **Ongoing or Standby**. If you use a number that is taken, the order is not saved and you see: *"Tracking number 5 is already taken. Please select a different number."* Going Back then fills in a free number.
- The number is free again when its order is **Complete**, **canceled**, or **replaced by a change** (the replacement keeps the same number unless you pick another).
- Once an order is saved its number **cannot be edited** (the database itself refuses it). To fix a wrong number, use **Change order** on the Orders screen.
- Two cashiers saving at the same moment can never get the same number: the server checks inside the same step that saves the order, and the database has a rule of its own as a second lock.
- Moving a Complete order back to Ongoing or Standby is refused if another order is using its number now. The message says which order.
- Only orders with chicken **that is prepared** get a number. Orders with only **Live** chicken, or only eggs, garlic and other products, have none (a Live chicken is not butchered). In an order that has both, the number is for the prepared chicken.
- It is shown **big** on the "Order saved" screen and on the printed slip, on the review slip, in the order details, on every card of the **Order List** (`#5`), and in the **Orders** list (its own column; the search box also finds `#5`). The spreadsheet exports are unchanged.

**Butcher screen** (for the TV in the butcher area). It shows only what the butcher needs: no tabs, no prices, no buttons.
- **Ongoing** orders are the screen: big cards on the left with the **tracking number**, the customer name, the order number, how long ago, and each chicken with its weight and **how to cut it** in big words (for example **DRESS & SLICE**, **MEDIUM PIECES**, **WITH BLOOD**). A new order glows yellow with "NEW" for a minute.
- **Standby** orders (ready, waiting for the customer) are a small, dim list on the right, so they never compete with Ongoing.
- **Complete** orders disappear. Canceled and replaced orders never show. Orders with no prepared chicken never show, and a **Live** line inside a mixed order is not listed.
- Changes are **smooth**: when an order moves to Standby its card shrinks and fades out of Ongoing while a row slides into the Standby list; when it becomes Complete the row fades away; the cards below glide up into the gap. A card that did not change is left alone, so nothing flickers.
- It checks the server every 3 seconds. If the server cannot be reached it shows "Not connected - trying again" and keeps the last orders on screen.
- It is only for looking. The cashier still moves orders to Standby or Complete on the **Order List**.
- To preview it, press **Butcher view** at the top of the **Order List** (it opens in a new tab), or go to `/#/butcher` while signed in as staff. Staff get a small **Back to POS** link; the TV account does not.

**Customer screen** (the second monitor facing the customer).
- On **New order**, press **Open customer screen**. A clean window opens. Drag it to the second monitor and press **F11** for full screen.
- It follows the cashier as they type: the items, the total, **Cash received** and **Change**. After the order is saved it says **Thank you** with the tracking number for 12 seconds. Between orders it shows a welcome.
- It needs no internet and no sign-in. The two windows talk to each other inside the same computer, and only a small summary of the order is sent.

**The Butcher TV account.** In **Users > Add user**, choose the role **Butcher TV (screen only)**, for example the username `butcher-tv`.
- It opens the Butcher screen right after sign-in and **nothing else**: the server refuses every other page and every action. It cannot see prices, sales or products.
- It **never signs itself out** when idle (other accounts are signed out after 4 hours) and its sign-in lasts a year, so the TV can stay on.
- Sign in once on the TV, then leave it. To keep the screen clean, open the page full screen (kiosk mode), for example `chrome --kiosk http://<this-computer>:3000/#/butcher`.

**Setting up the TV (one time).** The app runs inside WSL, which the TV cannot reach by default.
1. Windows 11: create the file `C:\Users\<you>\.wslconfig` with these two lines, then run `wsl --shutdown` in PowerShell and start the app again:
   ```
   [wsl2]
   networkingMode=mirrored
   ```
2. Allow the app through the Windows firewall (PowerShell as administrator): `New-NetFirewallRule -DisplayName "Chicken POS" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private`
3. On the TV, open `http://<this computer's Wi-Fi address>:3000/#/butcher` and sign in with the Butcher TV account. (Find the address with `ipconfig`.)
Anyone on the shop Wi-Fi can reach the sign-in page, so keep strong passwords and keep the Wi-Fi private.

**Please confirm (decisions I made).**
1. Numbers go from **1 to 100** and the lowest free one is picked, so a number comes back quickly after its order is Complete (for example #1 again). *(You confirmed this.)*
2. **Live** chicken gets no tracking number and is not shown to the butcher. *(You confirmed this.)*
3. The box fills in by itself; the cashier does not have to type anything. If the box is left empty, the server picks the lowest free number.
4. A **refunded** order that is still Ongoing or Standby keeps its number and still shows on the Butcher screen, the same as on the Order List.
5. The Butcher screen has **no Done button**; it only animates when an order changes. Orders move on the Order List as before. *(You confirmed this.)*

**Tests:** `npm test` runs 208 automated tests (14 are new: the duplicate rule, reuse after Complete / cancel / change, the 100 limit, two cashiers at once, the locked number, the Butcher feed with no prices, the TV account's limits and no idle sign-out, and the 11 → 12 upgrade including the rebuilt users table). The new screens were also driven in headless Chromium (cashier, customer window and butcher TV side by side, including the move animation and the Live rule): all 12 checks passed.
**Known problem (fixed in revision 17):** the old browser test `npm run test:e2e` was out of date; it was replaced by `npm run test:browser`.

## Earlier: revision 14

No database change (still version 11).

**Daily Sales Report: the paper form again, with Katay / Dead per chicken.** Landscape, the chicken blocks side by side as in revision 12. Inside each block, under the live sales: a "B-CULL: KATAY (from the ref)" part and a "B-CULL: DEAD (from the ref)" part (no service fee). At the bottom of each block **LIVE, KATAY and DEAD have their own heads, kilos and amount** (never added together), then **TOTAL AMOUNT** (the money of the three). **DISCOUNTS moved out of the Others column to sit above EXPENSES.** The sheet is a **rectangle**: every column ends on the same last row, where the TOTAL AMOUNT of each block, the TOTAL AMOUNT of the expenses and **EXCESS/LOSS** all sit. Blank rows take up the slack. The top-to-bottom layout of revision 13 is gone.

**Daily Inventory: an edited Beginning Balance glows.** Nothing is printed under the number any more (it pushed the rows out of line). The box has an amber glow and a small ✎; **hover it (or tap it on a phone)** to see a bubble with the reason, the note, who changed it, when, and the old number. The submitted file still lists the edits as notes.

**Latest ref movements** (New order > Advanced) are grouped by day: **Today**, **Yesterday**, then the weekday, each with "+ in · − sold" for that day and only the time on each row.

**Alignment pass** on every screen at desktop and phone width: the service buttons (names and fees now line up whatever the key label), the "which chicken" buttons, the product-card key numbers (they no longer squeeze the price and stock), the ref cards, table headings that were cut off ("Chicken Category"), the ref movements table on a phone. Key labels are hidden on narrow windows and touch screens.

**Tests:** `npm test` runs 194 automated tests. The screens were checked in headless Chromium at 1280 px and 375 px (no sideways scroll, no page errors, the bubble, the day groups).

## Earlier: revision 13

The database is upgraded in place (version 10 → 11) with a safety copy first (`data/pos.db.before-v11-<time>.bak`). One table is added (`inventory_saves`) and Katay / Dead sale lines get the chicken they came from (`order_ref_items.product_id`; an older sale gets it only when every head of that kind ever stored came from one chicken). Where this section and the older sections below disagree, **this section is the current behaviour**.

**Daily Inventory: Save, and the midnight close**
- *Closed Inventory Today and Reset the Day* is gone. **Save** keeps the open day's numbers in the database, **one row per day**; pressing it again replaces that row. The screen says "Saved … by …", "changed since" or "Not saved yet". *Submit Inventory Today* stays (the Excel file).
- At **12:00 midnight (PH time)** the open day is saved one last time and **closed by itself**, and today opens with every New Total as its Beginning Balance. The server checks every minute and at start; any request after midnight also triggers it first, so a sale never lands on yesterday. Nothing stops it: Ongoing orders stay on the Order List (like Standby), and a New Total below zero starts the next day at 0. If the app was off for some days, the old day is closed once and today opens (no empty days). Its file is saved as `backups/inventory/inventory_<date>_closed-at-midnight.xlsx`; closed days stay listed as Closed with their Export button.
- Because a day now always closes after its date, the business date no longer runs a day ahead (the reason the 15 Oct report looked empty).
- Beginning Balance edits are now **notes under the tables** of the submitted / exported file (who, when, reason, note), only when there was an edit. The separate "Beginning Balance Edits" sheet is gone.

**Katay / Dead from the ref, per chicken.** Selling Katay or Dead asks **which chicken it is** (B-Cull, Cull, Broiler …, with how many of each are in the ref; chosen already when there is only one). The ref is counted per kind and chicken, so "Insufficient stock" names the chicken. The line reads e.g. "Katay Chicken - B-Cull". The Advanced cards show the split (e.g. "B-Cull 2 · Broiler 1").

**Daily Sales Report, redesigned (replaced in revision 14 by the paper-form layout above):** one page wide, A4 portrait, top to bottom. **SUMMARY** first (each chicken type with separate Live, Katay and Dead rows: heads, kilos, amount; then eggs, others, GROSS SALES, less discounts / refunds / expenses, NET SALES), then one section per chicken type (price, the paper-form balance boxes, SOLD = live heads, the ledger with its live total, and under it that chicken's Katay and Dead from the ref, each with its own totals), then EGGS, OTHERS, DISCOUNTS, EXPENSES and the CASH BREAKDOWN. **Heads and kilos of live, Katay and Dead are never added together**; only the amounts are, in GROSS SALES. A sale from before this revision whose chicken is unknown is listed last under "KATAY / DEAD (source not recorded)".

**Keyboard shortcuts** (badges on the buttons on a computer with a keyboard; hidden on touch screens; **?** or the ⌨ Keys button lists them):
- Anywhere: **F2** New order, **F4** Order List, **F8** Orders, **F9** Daily Inventory, **Esc** back / cancel.
- Choosing: **1–9** (top row or number pad) picks the numbered product, **← →** switch Chicken / Other products / Advanced, **/** searches other products, **Enter** reviews the order.
- One product: digits and **.** type the weight, **+ / −** (number pad too) change the heads or pieces, **Alt+1…9** pick the service / selling option / which chicken, **Enter** adds, **Esc** cancels.
- Review: **P** next payment method (Cash puts the cursor in Money Received), **D** discount, **Space** ticks "I have reviewed", **Enter** submits when everything is filled in (or jumps to the review tick box when that is the only thing left).
- Order saved: **Enter** new order, **Ctrl+P** print slip. Question boxes: **Enter** = the main button, **Esc** = cancel; a dangerous question (cancel an order …) starts on the safe button.

**Tests:** `npm test` runs 192 automated tests (11 new in `tests/revision13.test.js`). The screens were driven in headless Chromium (a full order with the keyboard only, the Katay chicken chooser, Save, the shortcut list, phone width 375 px). `tests/e2e.mjs` is still from an older revision and was not updated.

## Earlier: revision 12

The database is upgraded in place (version 9 → 10) with a safety copy first (`data/pos.db.before-v10-<time>.bak`); only new tables are added, so no order, payment, price or stock number changes. Where this section and the older sections below disagree, **this section is the current behaviour**.

**New order > Advanced** (a button at the left end of the Chicken / Other products tabs, set apart by a divider). It has three parts:
- **Ref stock.** Katay and Dead chickens kept in the ref (refrigerator), counted in heads. *Store in the ref* asks which chicken it came from, the heads and the kilos; the heads are also added to that chicken's Katay or Dead on today's Daily Inventory. *Add to order* sells them by the kilo at a price per kg the cashier types: no service fee and no automatic discount. Heads in the ref = heads put in − heads on sold orders, so a canceled or changed order returns its heads and a refund does not. The ref is not reset when the day is closed.
- **Cash breakdown.** Count of ₱1,000, 500, 200, 100, 50, 20, 10, 5, 1 and 25 centavos. The latest count of the day is used; earlier counts stay in the history.
- **Expenses.** Lines such as Coke 75, Bread 35, Meal 200 with an overall total. A mistake is removed (kept and marked, never deleted); a cashier can remove only their own.

**Daily Inventory**
- Typing Katay or Dead higher asks *Yes / No / Cancel*: was it put in the ref? Yes also adds the heads to the ref. Typing it lower takes back out of the ref only the heads that came in from that row, and is refused (`REF_SOLD`) if they were already sold.
- *Closed Inventory Today and Reset the Day* now submits and closes in one step; its dialog has only **Cancel** and **Close the day and reset**. *Submit Inventory Today* stays as its own button.
- *Export Inventory History* is gone. A closed day has an **Export** button beside "Closed" (the same layout as the submitted file; not offered for an open day).
- "How the numbers are worked out" is a notebook with highlighted keywords, and both help sections use the whole width.

**Daily Report:** a KATAY / DEAD (REF) block; the EXPENSES rows are filled and LESS EXPENSES uses them; CASH BREAKDOWN lists every bill and coin with OVERALL TOTAL, LESS NON-CASH PAYMENTS, EXPECTED CASH and EXCESS/LOSS (counted − expected; empty until cash is counted). Expected cash = cash (or unrecorded) payments after discounts − refunds − expenses.

**Exports:** new **Download Sales List (Excel)**: the same 18 columns as the CSV with fitted widths, a frozen header row and filters. The plain CSV stays as a small link, and every sheet of the main Excel export is width-fitted.

**Assorted eggs:** an Eggs product, a name with "assorted" / "asst", or an egg name without a size (including "Itlog") is reported on the Asst. row. The Products page shows each egg product's report row.

**Tests:** `npm test` runs 180 automated tests (14 new in `tests/revision12.test.js`). The screens were **not** checked in a browser in this session (none was available), and `tests/e2e.mjs` was not updated.

## Earlier: revision 11

Nothing was rebuilt. The database is upgraded in place (version 8 → 9) with a safety copy first; no order, payment, price or stock number changes. Where this section and the older sections below disagree, **this section is the current behaviour**.

**Products**
- **Brown Cull Chicken** (a chicken product, reported in the CULL block), **Ducks** and **Catfish** (other products) are added once, on the first start. No price is invented: they stay hidden from the cashier until the admin sets their prices in Products. "Stock Chicken" was not added (it was a mistake in the request).
- **Pictures:** on the Products page every product has a **Picture** button. The New order cards show the photo, or an icon when there is none (Ducks 🦆, Catfish 🐟 ...). A photo is made smaller in the browser before it is saved, and kept in the database (a backup copies it).
- **Report block:** each chicken product has a category (B-Cull, Cull, Broiler, Other chicken) that decides its block on the paper Daily Report. Existing products were filled in once from their names.

**Other products are counted in pieces.** There is no "kg" row on the Daily Inventory any more. When something is sold by the kilo, New order asks for the **number of pieces** and their weight: the price uses the weight, and the stock of the product's "piece" row goes down by the pieces (1 catfish of 1.2 kg → −1; 3 ducks weighing 4.5 kg → −3). A piece sold whole and pieces sold by the kilo come off the same row.

**Discounts:** the reasons are Bulk Order, Reject, Employee, Wholesale, Dead, Katay and Other. Senior citizen and VIP are no longer offered. The amount is always typed by the cashier (fixed ₱ or %); no rate is invented. A Dead or Katay **discount** never changes the inventory.

**Daily Inventory**
- New chicken column **Katay** between Reject and Dead (a dying chicken slaughtered and bled at once so the meat is not damaged). Chicken New Total = Left − Reject − Katay − Dead − Pull Out. Reject, Katay, Dead and Pull Out are inventory losses: never a sale, never a discount.
- The tables line up (fixed columns; the italic previous-day note sits under the Beginning Balance box). The explanation under the tables was rewritten.
- The old Daily Report section and the old two buttons are gone. Below the tables: **Submit Inventory Today** (saves today's inventory as an Excel file in `backups/inventory/` on this computer AND downloads it; products with 0 in every column are left out, with a note in the file), **Closed Inventory Today and Reset the Day** (closes the day; needs a submission whose numbers are still the day's numbers, an intact saved file, and no Ongoing order) and **Export Inventory History** (every business day, every product).
- A day can only be closed on its own date or later, so closing twice can no longer push the business date ahead of the real date.

**After closing:** Complete orders leave the Order List and the Orders tab's default list ("Today's orders"). They are not deleted: choose "All saved orders, by date", search by number, or use any report. Standby orders stay, and count as sold on their own business day only.

**Reports (Orders tab):** "Download Daily Report" (was "Download Excel (like the paper form)") uses the business day; "Other collections" became a **DISCOUNTS** list (customer, reason, discount) with **TOTAL DISCOUNTS**, which is what LESS DISCOUNTS takes off. The daily CSV button is gone. The Spreadsheet Export **Excel** keeps every detail; the **CSV** has only the shop's 18 report columns, of the orders that were sold.

**Tests:** `npm test` runs 166 automated tests (14 new in `tests/revision11.test.js`). The browser tests in `tests/e2e.mjs` were **not** updated or run for this revision (they need Playwright and still describe revision 10's buttons).

## Earlier: revision 10: seven services, With Blood, Beginning Balance corrections, closing button on the Inventory page, fixed units for other products

Nothing was rebuilt. The database is upgraded in place (version 7 → 8, or 6 → 8 in one go) with a safety copy first; every order, payment, price and stock number is kept exactly as it was. Where this section and the revision 9 section below disagree, **this section is the current behaviour**.

### What you will see (plain language)

**1. Services (New order).** Seven services again: **Live, Pour, Dress, Po-ur & Slice, Dress & Slice, Pour & Dukot, Dress & Dukot.** The two you missed are back.
- **Pour** and **Dress** on their own mean the chicken is left whole: no slice size is asked.
- **Po-ur & Slice** and **Dress & Slice** ask for the slice size (small, medium or large pieces). The size buttons are switched off for every other service.
- The two **Dukot** services ask for no size. **Live** has no extras.
- Fees: Pour, Po-ur & Slice and Pour & Dukot all carry the **Pour** fee; Dress, Dress & Slice and Dress & Dukot carry the **Dress** fee (flat, per head or per kg, as the admin set it). **Live, With Blood and Dukot add nothing.**

**2. "With Blood".** "Dara (gathering the blood)" is now called **With Blood** on New order, the order slip, the Order List, the Orders tab and the spreadsheets. Saved orders are unaffected (the stored value is the same).

**3. Products → Service fees.** Only **Pour** and **Dress** are listed. Dara and Dukot are gone from the list and can no longer be given a fee. (Their old rows stay in the database, untouched, in case an old order was charged one; they are simply not used for new orders.)

**4. Daily Inventory → Beginning Balance can be corrected, with a reason.**
- A manager or the admin can change a Beginning Balance on the open day, including one that was carried over from the previous day.
- Changing a number that already has a value opens **"Why is the Beginning Balance changing?"** You must choose a reason (**Incorrect inventory, Recount (stock check), Typing mistake, Other**); "Other" also needs a few words. **Cancel keeps the old number and saves nothing.**
- The reason, the old and new number, who did it and when are saved in the inventory history (it cannot be edited or deleted). The row then shows a small **Edited: <reason>** tag; hover it for who and when.
- The reason is asked **only for Beginning Balance corrections**. Typing the very first Beginning Balance of a product needs no reason, and Additional, Reject, Dead and Pull Out work as before. The server refuses a correction without a reason even if the screen is bypassed. Cashiers can look but not change. A closed day cannot be changed at all.

**5. Italic number beside Beginning Balance.** Each Beginning Balance shows the previous business day's Beginning Balance and that day's date, in italics, month/day/year: for example **155** *(177 10/12/2026)*. A product's first day has no previous day, so no note. The two spreadsheets carry the same information (see below).

**6. Submit Closing Inventory / Reset Daily Records (Inventory page).** The old "Start New Business Day / Reset Daily Records" section is gone from New order. The same action is now the button **Submit Closing Inventory / Reset Daily Records** on the Daily Inventory page (managers and admin; for others the button is greyed out with a reason). It works exactly as before: one confirmation with your wording and **Cancel / Export Report / Confirm and Start New Day**; open **Ongoing** orders block it; each product's New Total becomes the next day's Beginning Balance; Sold, Additional, Reject, Dead and Pull Out start again at zero; everything is all-or-nothing and closed days are kept as history.
- **Order List after closing:** the **Complete** column is emptied (those orders stay saved in Orders, the reports and the closed day's inventory; nothing is deleted). **Standby** orders stay, still counted in the reports and inventory, and carry a small **"Sold MM/DD/YYYY"** tag when they were sold on an earlier day. When a Standby order from an earlier day is claimed (moved to Complete) it leaves the Order List at once and a message says so.
- The old **"Show completed orders from…"** choice is removed, because the Complete column now only ever holds the open day's orders.

**7. Other products: fixed units, and a better Products form.**
- **Other product:** piece, pack, sack, kg (piece/pack/sack at a fixed price; kg per kg). **Eggs:** piece, carton, tray. Every product has all of its units, so every unit has a row on the Daily Inventory from the moment the product exists. This fixes the missing "Etag (Sun-Dried) - kg" row.
- **Add product** (Products → Other products) now asks for the name and the type (Other product or Eggs). The admin can type a price for each unit in the same box; a manager cannot (prices stay admin-only), so the units start with no price and stay off the cashier screen until the admin prices them. **Units & prices** lets the admin set a price and switch a unit on or off; the unit name itself cannot be changed.
- **Existing products** get the missing units added the first time the new version starts (switched off at ₱0.00). Products with "egg" in the name (as a word; "Eggplant" is not) become Eggs. Old units such as **dozen** or **batch** are kept with their prices and keep working; new ones cannot be created.

**8. Rows at zero are hidden; Whole Inventory Spreadsheet export.**
- On the Daily Inventory, other-product rows with **no Beginning Balance, nothing added and nothing sold** are hidden. A line under the table says how many, and the list **"Type stock for a product that is not listed"** lets a manager show one and type its first balance. A product that sold out today is *not* hidden. Chicken rows are always shown.
- The button **Whole Inventory Spreadsheet export**, beside the closing button, downloads an Excel file with **every** product's inventory for the chosen business day, zero rows included. It only reads; it changes nothing.

**9. Daily Inventory Report moved to the Inventory page.** The section is gone from New order and is at the bottom of the Daily Inventory page (**Export to CSV / Export to Excel (.xlsx)**, for the business day chosen at the top). Its zero rows are left out. Both the Daily Report and the Whole Inventory file now have a last column **Previous Day's Beginning Balance (date)** and list the **Beginning Balance corrections with the reason given** (a table at the end of the CSV; a sheet called *Beginning Balance Edits* in Excel).

**10. Order List: Zoom out.** A **Zoom out** button next to Refresh draws the board at 70% so more orders fit without scrolling; it becomes **Normal size** to go back. It only changes how big things are drawn (the choice is remembered in that browser). It never touches an order.

### Before you use this in the shop

1. **Do this on a copy first.** Run it in a trial folder (see the update steps in the chat) and look at the Daily Inventory, the closing button and the Order List with your own data before you replace your working folder. The upgrade runs the first time the new version starts and cannot be undone except by restoring the safety copy.
2. **A safety copy is made automatically** next to your data file (named like `pos.db.before-v8-20261013120000.bak`, or `before-v7-` when you jump from revision 7). Also run `npm run backup` before you start. Keep both until you have checked your orders and stock.
3. **Nothing was deployed and no data was deleted.** The "Submit Closing Inventory" button changes data only when a manager presses it and confirms.

### Please confirm (assumptions I made in revision 10)

1. **What "zero" means for hiding:** an other-product row is hidden only when its Beginning Balance, Additional and Sold are all 0 (not when it merely ends the day at 0). Tell me if you would rather hide by New Total = 0.
2. **When a reason is required:** only when a Beginning Balance that already has a number (typed, or carried over, even if the carried number was 0) is changed. The first typing of a product's very first balance needs none. The reasons are the four listed above.
3. **Switched-off products:** a product that is deactivated and has no numbers has no row on the Daily Inventory and none in the Whole Inventory export either; reactivate it to see it again. A deactivated product that still has stock or sales that day stays visible.
4. **Old units kept:** dozen, batch and any other old unit stay as they are; they are not deleted or converted to carton/piece.
5. **Dates in the italic note and tags are month/day/year** (10/12/2026), as in your example.
6. **Egg detection for existing products is by name** (the word "egg"/"eggs"). If a product was classed wrongly, tell me; there is no screen yet to change a product's type.
7. **Old Dara and Dukot fees:** any fee the admin had set for them is no longer charged on new orders (it was your request to remove them). Orders already saved keep what they were charged.
8. **Complete orders of the *same* day** stay in the Complete column until the day is closed; only closing (or claiming an older Standby order) removes cards.
9. **Exports:** the extra last column and the corrections list in the Daily Report and Whole Inventory files are my addition so the previous-day number and the reasons are on paper too. Easy to remove if you do not want them.
10. **Whole Inventory Spreadsheet export is Excel only** (no CSV version).
11. **Closing explanation text:** I kept your revision 9 confirmation wording and the three buttons exactly; only the button that opens it moved and got its new name.

### What was tested, and what was not (revision 10)

- **Automated (Node 22.22, `TZ=UTC npm test`):** **157 of 157 passed** (47 unit including the services, units and both upgrades; 59 API; 8 clear-records; 28 inventory; **15 new Revision 10 tests**: Beginning Balance corrections and reasons, the italic previous-day note, closing clears Complete and keeps Standby, every unit has a row, hidden zero rows, both exports, fee list, starter data, upgrade 7 → 8 with rollback and idempotence, new database = upgraded database layout).
- **Upgrade rehearsals on copies:** version 7 → 8 and version 6 → 8 in one start were run on made-up databases (orders, payments, fees, stock, history): every order/payment/fee row came back identical, one safety copy was made (still the old version), a second start changed nothing, a forced failure left the file at its old version with every row.
- **Browser (Chromium, real screens):** `npm run test:e2e` **67 of 67 passed** (62 earlier checks updated + 5 new for Revision 10): the seven services and their fees, plain Pour/Dress without a size, With Blood, Products form for other products (manager and admin), zero-row hiding and the add-stock list, the reason dialog (required, Other needs words, Cancel saves nothing, Edited tag, history row), the closing button and its dialog, Complete cleared / Standby kept / claimed Standby leaves, the italic note, both Excel downloads and a failed download, phone widths, Zoom out and Normal size.
- **Looked at by eye:** screenshots of the Inventory page, New order services, closed day and zoomed Order List (taken from the real browser run).
- **Not tested:** other browsers than Chromium (Zoom out uses the CSS `zoom` property, which current Chrome, Edge, Safari and Firefox support; not checked in them); real tablets and real printers; the files opened in desktop Excel (the Excel files were generated and read back by the tests, and the earlier revision's files were opened in LibreOffice and openpyxl, but the Revision 10 files were not opened in Excel itself); your real data (the upgrade was rehearsed on made-up copies, not on your files); heavy use by many people at once beyond the race tests.
- **Known limitations:** inventory numbers refresh every 15 seconds and on reload; Whole Inventory is Excel only; no screen yet to change a product's type (Eggs/Other) after it is created.

## Earlier: revision 9 (Pour and Dress services, Official Receipt label, cash change, Daily Inventory, stock on New order, Daily Report, Start New Business Day). Revision 10 above changes some of this.

Nothing was rebuilt. The existing products, orders, payment methods, screens and database were kept; the database is upgraded in place (version 6 → 7) with a safety copy first. **Read "Before you use this in the shop" below first**: the app now checks stock, so you must type your Beginning Balances once before it will sell anything.

### Before you use this in the shop

1. **Type the Beginning Balances once.** Open **Daily Inventory** (the tab right beside Products) and type how many heads of each chicken product, and how much of each other product, you have right now. Until a product has a balance, New order refuses to sell it ("Insufficient stock. Only 0 heads of ... are available."). This is deliberate: the stock numbers are the shop's, so the app does not guess them.
2. **Official Receipt (a compliance warning, please read).** The slip header now says **"Order Slip. Official Receipt."** instead of "Not an official receipt", as you asked. **Changing a label does not make a document a legal receipt or invoice.** In the Philippines, receipts and invoices have rules set by the BIR (registration, authority to print or an approved system, serial numbers, required fields such as the seller's registered name, TIN and address, and how copies and records are kept). I have not checked this app against those rules and I cannot confirm it meets them. **Before you hand customers these slips as official receipts, ask your accountant or the BIR whether this app and printout are acceptable**, or keep issuing your registered receipt alongside the slip. Until then, the earlier arrangement (the app records payments for billing; the official receipt is issued separately) is the safe one. If you want the old wording back, it is one line (`data-slip-kind` in `public/js/views/checkout.js`).
3. **Nothing was deployed and no data was deleted.** The upgrade only runs when you start the new version on your own computer. Do a backup first (`npm run backup`); the app also saves its own copy named like `pos.db.before-v7-<time>.bak` before it changes anything.

### What you will see (plain language)

**1. Services (New order → Service and Cutting).** Five services: **Live, Pour, Dress, Pour & Dukot, Dress & Dukot**. The stand-alone **Dukot** button is gone from Cutting, which now has only small, medium and large pieces. Pour and Dress still need a slice size. The two Dukot services are complete on their own (Dukot is not sliced, so no slice size). Choosing a slice size while a Dukot service is selected switches it back to Pour or Dress. Dara and the other options are unchanged. The chosen service appears in the order summary, the slip, the order details, the Order List cards, the spreadsheet exports and the saved order. Old orders still read correctly because the services are saved the way they always were (service + cutting); only the names on screen changed. **Fees:** Pour and Dress keep the fees you set (₱45 and ₱25). A Dukot service costs that fee **plus** the separate Dukot fee, which the admin can set and which starts at ₱0.00, so today a Pour & Dukot costs the same as a Pour.

**2. Payment and the Official Receipt.** The slip says "Order Slip. Official Receipt." (see the warning above). The Payment panel's heading says "(required)" (done in revision 6) and the sentence about the official receipt was removed. When the method is **Cash** (and only then) it shows **Amount Paid (₱)**, **Money Received (₱)** and **Change (₱)**. Change = Money Received − Amount Paid. Example: Amount Paid ₱456.00 and Money Received ₱1,000.00 show **Change ₱544.00**. Equal amounts show ₱0.00; more shows the exact change. Less than what is due shows **"Insufficient payment"** and the order cannot be submitted as fully paid. Blank, negative, text and zero values give a plain message and no number. "1,000" typed with a thousands comma is understood by the screen. For Not recorded, GCash, Maya, Bank transfer and Other the calculator is not shown, and leaving Cash clears Money Received so an old figure cannot be saved by mistake. The saved payment always equals the final order total (after any discount); Money Received and Change are saved with it and printed on the slip, and the database itself refuses a change that does not add up.

**3. Daily Inventory tab.** Directly beside Products (cashiers do not see Products, so for them it follows Orders). Two tables for one business day:
- **Chicken Inventory:** Chicken Category, Beginning Balance, Additional, Total, Sold, Left, Reject, Dead, Pull Out, New Total (in heads). Total = Beginning + Additional. Left = Total − Sold. New Total = Left − Reject − Dead − Pull Out. Example: 100, 20, 120, 35, 85, 2, 1, 5, 77.
- **Other Products:** Product Name, Beginning Balance, Additional, Total, Sold, Left, New Total (New Total = Left). Each way of selling a product (for example Eggs per dozen and Eggs per piece) has its own row, because a dozen and a piece cannot be added together.
- **Sold is never typed.** It is counted from the saved orders. Reject, Dead and Pull Out are adjustments, not sales, and must be zero or more, and together cannot be more than what is Left.
- Managers and the admin type the numbers (saved when you leave the box, refused with a plain message if wrong). Cashiers can look. The Beginning Balance can be typed in only while there is no earlier day to carry it from; after that it is carried over and cannot be typed.
- One record per product per business day (the database refuses a duplicate). Closed days are read-only history.

**4. Stock on New order.** Under Chicken: **Number of Heads: N** (and per card; the product you pick shows its own available heads). Under Other Products each card shows its quantity and unit (for example "20 pieces", "15 bags"). These are the same saved numbers as the Daily Inventory (one source). Asking for more than is available shows exactly **"Insufficient stock. Only 3 heads of Whole Chicken are available."** (with the real number and name) and blocks Add. Zero, negative and invalid quantities are refused. The check is repeated on the server in the same step that saves the order, so two cashiers cannot sell the same last chicken.

**5. Daily Report (bottom of New order).** Pick a business date, then **Export to CSV** or **Export to Excel (.xlsx)**. The report is built from the saved records: business date, product, Beginning, Additional, Total, Sold, Left, New Total, chicken Reject / Dead / Pull Out, the order numbers with actual quantities, and the sales and payment summaries. The CSV starts with a byte-order mark so Excel reads it correctly; the Excel file has four sheets (Summary, Chicken Inventory, Other Products, Orders) with live formulas for Total, Left and New Total. A cashier gets the same stock figures but only their own orders in the sales part. A message says "Report saved: <file name>. Nothing was reset or changed." or why it failed. Exporting never changes stock or orders.

**6. Start New Business Day (below the Daily Report).** The button **Start New Business Day / Reset Daily Records** opens the confirmation with your exact wording and three buttons: **Cancel** (changes nothing), **Export Report** (saves the Excel report and comes back to the question; it never resets), and **Confirm and Start New Day**. Only confirming proceeds, in one all-or-nothing step: the day's Sold figures are frozen, the day is closed and kept, the next day is opened, each product's New Total becomes the next Beginning Balance, and Additional, Sold, Reject, Dead and Pull Out start at zero. Products, orders, reports and stock history are kept. **It is blocked, with the reason and the order numbers, while any order is still Ongoing** (an Ongoing order can still be canceled or changed, which would change the sold numbers after the day is closed). **Standby orders do not block it**: they were already counted as sold and carry over on the Order List, and the dialog says so. A negative New Total (Sold more than the stock typed in) also blocks it until the numbers are fixed. A second click or a second person cannot reset twice. Only managers and the admin can do it.

### Stock policy (one rule everywhere)

| What happens | Effect on stock |
|---|---|
| A new order is saved (Ongoing, Standby or Complete, it makes no difference) | Counted as **Sold** once, immediately. The pickup column never deducts anything. |
| An order is **changed** (replaced) | Its stock is freed for the replacement (same open business day), so nothing is deducted twice. |
| An order is **canceled** | The Cancel box has a tick-box "The chicken can go back into stock". **Ticked:** the stock is freed. **Left unticked (the default):** the heads are added to **Reject**, so the app never invents stock that may not exist. Other products always go back into stock. |
| An order is refunded | Stays sold (a refund records money only; it does not put chicken back). |
| The business day is closed | Sold is frozen. A closed day is never recounted, even if one of its orders is canceled later; add the chicken back with Additional on the day it returns. |
| Orders placed after a reset | Count on the new open business day. |

### Business days

A business day is its own record (`business_days`), separate from the calendar date, so a shop that closes late or forgets to reset does not lose or double-count anything. The first day is opened automatically. The next day's date is today, or the day after the closed day when that day is already today. If the open day is older than today, New order and Daily Inventory show a banner reminding a manager to start the new day.

### Risks I looked at first (Change #9) and what was done

1. **Inventory consistency and duplicate deductions.** Sold is counted from the saved orders, not kept as a second counter that can drift, so an order can only be counted once. Closed days freeze it. (Tested: policy table above, 28 inventory tests.)
2. **Payment validation and incorrect change.** One shared calculator for the screen and the tests, repeated on the server, and a database check that Change = Money Received − Amount Paid. Amount Paid must equal the order total. (Tested.)
3. **Concurrent cashiers and overselling.** The stock check runs inside the transaction that saves the order (SQLite write lock), not only on screen. (Tested: 8 cashiers racing for 5 heads get exactly 5; two programs on one database file cannot both get the last chicken; a stale screen is refused in the browser test.)
4. **Business-date handling and carryover.** Business day ≠ calendar day; carryover happens once, inside the reset transaction; the reset must name the day being closed so a second click cannot close the new day. (Tested.)
5. **Backup, recovery and history.** A safety copy before the upgrade; closed days and orders are never deleted by the reset; the reset is all-or-nothing (tested by making it fail half way). The clear-records command now also removes closed inventory days, and keeps the open day and its numbers.
6. **CSV / XLSX accuracy.** The files are built from the saved records with the same function the screens use; the XLSX was opened and checked with an independent reader (openpyxl) and LibreOffice, and its formulas give the same figures.
7. **Unresolved orders during a reset.** Ongoing orders block it; Standby carry over; both explained in the dialog.
8. **Receipt compliance.** Not solved by software; see the warning above.
9. **Deployment and persistent storage.** Unchanged requirement: a computer that runs Node 22.13+ with a persistent disk. The database is one file; back it up. Nothing was deployed.

### Architecture, files and plan

- **Database (`src/db.js`)**: schema version 7. New tables `business_days`, `inventory_records` (one row per day and chicken product, or per day and selling option) and `inventory_events` (append-only audit of every typed change); new columns `orders.business_day_id`, `payments.received_centavos`, `payments.change_centavos`. Triggers: one open day at most, closed days cannot be changed, orders can only be placed on the open day, the cash arithmetic must add up.
- **Server**: `src/services/inventory.js` (the one authority for stock: Daily Inventory, New order and the reset all read it), `src/services/inventoryReport.js` (CSV and XLSX), changes in `src/services/orders.js` (stock check, payment rules), `src/services/export.js`, `src/routes.js` (`/api/inventory`, `/api/inventory/records/:id`, `/api/inventory/close-check`, `/api/inventory/close-day`, `/api/inventory-report.csv|.xlsx`; the stock numbers are also in `/api/config`).
- **Shared**: `shared/inventory.js` (formulas and the exact messages), `shared/cash.js` (the cash calculator), `shared/rules.js` and `shared/constants.js` (the five services).
- **Screens**: `public/js/views/inventory.js` (Daily Inventory), `public/js/views/dayTools.js` (Daily Report and Start New Business Day), changes in `checkout.js`, `orders.js`, `slip.js`, `catalog.js`, `state.js`, `util.js`, `api.js`, `main.js`, and `public/css/app.css`.
- **Also modified**: `src/clearRecords.js`, `scripts/clear-records.js`, `scripts/demo.js` (the demo now has sample stock), `package.json` (the test list).
- **Tests**: `tests/inventory.test.js` (new), `tests/fixtures/schema-v6.sql` (new, the revision 7 database layout, used to rehearse the upgrade), and updates to `tests/unit.test.js`, `tests/api.test.js`, `tests/clear.test.js`, `tests/e2e.mjs`.

### The database upgrade (6 → 7)

Runs once, automatically, when the new version starts on an older file, inside one transaction. Before it starts, the app saves a full copy next to the database (`pos.db.before-v7-<time>.bak`). It **adds** the new tables and columns and **changes no existing row**:
- Every existing order is linked to a business day made from its calendar date. Past dates become closed days; today's date (if there are orders today) becomes the open day. These closed days have **no inventory numbers** (nobody typed any), so they show nothing on Daily Inventory and their orders are not deducted from anything.
- Existing payments get empty Money Received and Change (they were never recorded).
- If a step fails, the whole upgrade is rolled back and the file stays a working version 6.
- **Rehearsed** on a database in the exact revision 7 layout with real orders and payments: every row identical afterwards (compared table by table), safety copy made, rollback on failure, second start does nothing (tests in `tests/unit.test.js`).
- If you upgrade a database that already has orders **today**, those orders count as Sold on the open day, so its New Total is negative until you type the Beginning Balances. That is expected; type the balances once (the Beginning Balance box is open for that day) and the numbers fix themselves.

### How to run and verify

```
npm start                 # your real shop data (data/pos.db)
npm run demo              # sample data in data/demo.db, with sample stock
npm test                  # 140 automated tests
npm run test:browser      # current browser checks (needs: npm install, npx playwright install chromium)  [revision 17; was test:e2e]
```

Quick check by hand (use demo mode, not the real database): 1) New order: pick a chicken, choose Pour & Dukot and see no slice size is asked for. 2) Review: choose Cash, type Money Received 1000 on a ₱456.00 order, see Change ₱544.00. 3) Daily Inventory: see the order you just placed under Sold and the New Total drop. 4) Back on New order, export the CSV and Excel report. 5) Start New Business Day: Cancel (nothing changes), Export Report (the dialog stays), then Confirm, and see the next day's Beginning Balance equal the last New Total.

### Please confirm (assumptions I made in revision 9)

1. **Names:** "Pour" and "Dress" replace "Po-ur & Slice" and "Dressed & Slice" on screen; the Cutting section keeps small, medium and large pieces.
2. **Dukot price:** Pour & Dukot and Dress & Dukot cost the Pour or Dress fee **plus** the separate Dukot fee (admin sets it; starts at ₱0.00).
3. **Official Receipt label** and the removal of the old payment-note sentence conflict with the earlier rule that the official receipt is issued separately. I did what you asked; the compliance warning above stands.
4. **Strict stock:** nothing can be sold until a Beginning Balance is typed. A product added later starts at zero.
5. **Other products** are counted per way of selling (Eggs per dozen and per piece are two rows).
6. **Roles:** everyone signed in can view and export; only managers and the admin type inventory numbers and start a new day; a cashier's report shows only their own orders in the sales part.
7. **Ongoing blocks the reset; Standby carries over.** If you would rather Standby also block, or Ongoing carry over, say so.
8. **Cancel and stock:** a changed (replaced) order frees its stock for the replacement on the same open day. A canceled order frees it only if the cashier ticks "The chicken can go back into stock"; the default (unticked) records those heads as Reject. A canceled or replaced order from an already closed day does not change that day, and a replacement of it uses new stock on the open day.
9. **Payments:** Amount Paid must now equal the order total for every method. (In revision 6 a different amount was allowed with a warning.) Money Received is required for Cash on screen, but optional for a program calling the API directly.
10. **Typing:** the server accepts only plain numbers such as 1000.50; the screen also understands "1,000".
11. **Business date:** the next day's label is today's date, or the day after when the closed day is already today.
12. **Clear records** now also deletes closed inventory days and keeps the open day (its numbers are kept; its "carried" flag is reset).
13. From earlier revisions, still unconfirmed: shared bookmarks; accounts with history are closed rather than erased; walk-ins sort last; the sort is remembered; price history is cleared by clear-records unless `--keep-price-history`; order numbers restart at -001. Also your message about the account "gabriel (admin) is not ..." was cut off; I read it as "not deleted", and the main owner account is protected from deletion.

### What was tested, and what was not (revision 9)

- **Automated:** `npm test` **140 of 140 passed** (45 unit including the service rules, the cash calculator and the 6 → 7 upgrade rehearsal and rollback; 59 API; 8 clear-records; 28 new inventory tests for the five services, payments, formulas including 100/20/120/35/85/2/1/5/77, stock wording, race conditions, reports, exports and the reset). Run with `TZ=UTC`, Node 22.22.
- **Browser (Chromium, real screens):** `npm run test:e2e` **62 of 62 passed**, including the five services, the Cutting section, the cash calculator (₱456.00 / ₱1,000.00 → ₱544.00; insufficient, blank, negative and bad text), Number of Heads, the exact stock message at screen and at submit, the Daily Inventory tab and typing numbers, the CSV and Excel downloads and a failed download, the reset dialog (exact text, Cancel, Export Report, Ongoing blocker, Confirm once, carry-over), a cashier's read-only view, and phone-width layout (no sideways page scroll).
- **Independent file check:** the exported .xlsx opens in openpyxl and LibreOffice, and the formulas give the same numbers as the screen.
- **Not tested:** Microsoft Excel and Google Sheets themselves; Safari and Firefox; real phones and tablets; a real printer and paper; the BIR/official-receipt requirements; very large shops (thousands of orders per day); an actual deployment; the upgrade on **your** real database (I only rehearsed it on a copy of the revision 7 layout, so do the backup and run it first on a copy).
- **Known limitations:** inventory numbers refresh on the Daily Inventory screen every 15 seconds and on reload (they do not push instantly); the Daily Sales Report on the Orders tab (the paper-form report) is unchanged and still leaves the hand-counted boxes empty, while the new Daily Report export holds the saved stock; a canceled order from a closed day does not put chicken back (use Additional); partial refunds still do not exist; the app still needs the server to be reachable (no offline checkout).


## Added after revision 7: clear the example records (`npm run clear-records`)

For starting the real shop after trying the app with example orders. It deletes **every order** (with its items, payments and history) **and the price history**, and keeps everything you set up:

- **Kept exactly as it is:** all user accounts (the admin included, with passwords), chicken products, other products and ways of selling them, the current prices, the service fees and the settings.
- **Deleted:** all orders, their item lines, payment records and history entries, the price history list, and the order-number counters. The next order is `ORD-<today>-001` again.
- It is a **command, not a button**, on purpose: the app itself never deletes orders, and nobody can wipe the records by clicking something by mistake.

How to use it (in the app's folder, on the computer that runs it):

1. **Stop the app** (press Ctrl+C in the window where `npm start` runs). The command refuses to run while the app is running.
2. Run `npm run clear-records`. It shows how many orders, payments and price changes will be deleted and what stays, then asks you to type **CLEAR** (capital letters). Anything else cancels and deletes nothing.
3. Before deleting anything it saves a **safety copy of the whole database** next to it, named like `pos.db.before-clear-20261012160526.bak`, and checks the copy. If the copy cannot be made, nothing is deleted.
4. Start the app again with `npm start`.

Options: `npm run clear-records -- --keep-price-history` clears only the orders and keeps the price history. `npm run clear-records -- --confirm CLEAR` skips the question (for scripts; the safety copy is still made).

**To undo it:** stop the app and put the safety copy back as `pos.db` (keep the cleared one somewhere else first). Do not use it on real sales records you still need unless you have copied the safety copy somewhere safe.

All or nothing: the deletion runs as one step, and the database protections that stop orders being deleted are put back exactly as they were; if anything does not check out, the whole thing is rolled back. If your database is from an older version, the command first upgrades it (with its usual safety copy), the same upgrade that happens when the app starts.

**Please confirm (assumptions I made):** (1) users, products, current prices and service fees are kept; (2) the price history is cleared too, use `--keep-price-history` to keep it; (3) order numbers start again at `-001`, so a number used by a deleted example order can appear again on a real order.

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
2. Run `npm start`. The first start creates the admin account and the **starter data**: service prices (Pour ₱45, Dress ₱25) and your list of other products.
3. Sign in as the admin, then in **Products**:
   - **Chicken products**: add your chicken types and set each price per kg.
   - **Other products**: open **Units & prices** for each starter product and set its prices (they start with no price, so cashiers do not see them until you do). Typing a price turns that unit on. Every product has the fixed units piece, pack, sack, kg (Eggs: piece, carton, tray).
   - **Service fees**: check the two service prices, Pour and Dress. With Blood and Dukot have no fee.
   - **Daily Inventory** (the tab beside Products): type the **Beginning Balance** of every product you have in stock (other-product rows at zero are hidden; pick one from the list under the table to type its first balance). Orders are refused for a product with no stock.
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

Other commands: `npm run create-user -- <username> <cashier|manager|admin>` adds a user. `npm run backup` saves a consistent copy of the database into `backups/` (safe while the server runs). `npm run clear-records` deletes all orders and the price history but keeps users, products and prices (see the section above; stop the app first).

## 3. How the screens work

- **New order**: tap a product, type the weight with the number pad (or keyboard), choose the service and slice size, tap Add to order. The screen shows the stock available (Number of Heads). The scale-style readout shows `₱58.00/kg × 3.6 kg = ₱208.80` plus the service fee, and updates as you change anything. **Other products**: tap a product, choose how it is sold (per piece, per carton, per kg ...), type the quantity (whole numbers for fixed-price items, decimals for per-kg), add. Edit or remove any line. The unsent order survives a refresh.
- **Review**: the Order Slip with the double-check warning. Submit stays locked until the cashier ticks the confirmation box. **Discount** (optional: Senior citizen, Bulk Order Discount, Reject, Employee Discount, VIP or Other) and **Payment details** (the heading says required; the choices are Not recorded, Cash, GCash, Maya, Bank transfer or Other, then Amount Paid; for Cash also Money Received and Change; for GCash/Maya/bank the optional date and time, account name, account or mobile number and reference number) are on this screen. The slip header reads "Order Slip. Official Receipt." (see the compliance warning in the revision 9 section).
- **Order List**: the Kanban board (Ongoing, Standby, Complete) described above, with compact cards you tap to open, a star to bookmark, **Sort by** and **Show: All orders / Bookmarked** (revision 7). Drag a card, right-click it, or tap Move.
- **Orders**: search by order number or customer, filter by date and status, open any order to see exactly what was saved. The **Status** column shows the same status as the Order List for that order (Ongoing, Standby or Complete; Canceled or Replaced for orders that are not on the Order List; a Refunded badge on refunded ones). Cancel, change (void and replace) or refund (managers).
- **Products** (managers and admin), **Daily Inventory** (right beside Products: everyone can look, managers and the admin type the numbers) and **Users** (admin: add, edit, deactivate and delete accounts).
- **Daily Inventory page**: the buttons **Submit Closing Inventory / Reset Daily Records** (managers and admin) and **Whole Inventory Spreadsheet export**, the tables, and at the bottom the **Daily Inventory Report** (CSV and Excel export of one business day). New order no longer has these (revision 10).

**Number of heads:** on a chicken product, set the heads first (default 1), then type the total weight. Example: 3 heads, 5.4 kg together. The heads must be a whole number from 1 to 999. The "more than 50 kg" check looks at the total weight.

### The service and cutting rules (enforced on screen, on the server and in the database)

1. A service is required: **Live**, **Pour** (burn chicken, whole), **Dress** (dress chicken, whole), **Po-ur & Slice**, **Dress & Slice**, **Pour & Dukot** or **Dress & Dukot**.
2. **Live** clears and switches off With Blood and cutting, and has no fee.
3. Only **Po-ur & Slice** and **Dress & Slice** ask for a slice size: **small, medium or large pieces**, one at a time (the buttons are switched off for the other services). **Pour** and **Dress** are left whole, and the two **Dukot** services are not sliced; none of those needs a size. The database repeats these rules as CHECK constraints.
4. **With Blood** (saved as `dara`) is optional (not for Live) and independent of the others, and has no fee. Changing one choice never resets another.
5. Everything is saved on the specific chicken line, not on the whole order.

### Money rules

- Chicken line = price per kg × **total** live weight (all the heads weighed together), plus the service fee. A service fee is a flat amount per line, a rate per head (× the number of heads), or a rate per kg (the admin chooses). **Example:** 3.6 kg Cull Chicken at ₱58.00/kg is ₱208.80; with a Pour service it is ₱253.80, with a Dress service ₱233.80, as Live ₱208.80 (Pour ₱45, Dress ₱25 flat). The Pour fee applies to Pour, Po-ur & Slice and Pour & Dukot; the Dress fee to Dress, Dress & Slice and Dress & Dukot; With Blood and Dukot add nothing.
- Other products: **fixed price** items = price × a whole quantity (2 cartons at ₱120 = ₱240.00); **per-kg** items = price per kg × weight (1.5 kg at ₱80 = ₱120.00).
- **Subtotal** = sum of all lines. **Discount** (optional) is a fixed amount or a percentage of the subtotal, rounded half up to the centavo, and must be more than ₱0 and less than the subtotal. **Total** = subtotal − discount. Example: ₱253.80 with 20% off is ₱203.04.
- The server recalculates every price from the database. Prices sent by the browser are ignored, and an order is refused if a price changed while it was open. Past orders keep the prices, fees and discount they were sold with.

### Order lifecycle

- Order numbers look like `ORD-20261009-001`, use the Philippine date, come from an atomic counter in the database, and are never reused, even after a cancellation. Submitting twice (double tap, slow network) saves one order.
- **Cancel**: status Canceled, the order stays. A reason is required ("Other" needs an explanation). **Change**: the original becomes Replaced and a new linked order is created (the discount is carried over so you can adjust it). **Refund** (managers): full refund of the discounted total. It records the refund only; the chicken stays counted as sold. Cancel and change free the stock on the same open business day (see the stock policy in the revision 9 section).
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
| Look at the Daily Inventory, export the Daily Inventory Report and the Whole Inventory Spreadsheet | yes (own orders in the sales part) | yes | yes |
| Type inventory numbers, correct a Beginning Balance (with a reason), **Submit Closing Inventory / Reset Daily Records** | | yes | yes |
| Set or change **any price** (chicken per kg, service fees, other products) | | | yes |
| Manage users (add, edit, deactivate, **delete**) | | | yes |

### Spreadsheet export (managers and admin)

Orders > Spreadsheet export downloads `.xlsx` or `.csv` for the date range. The Excel file has **Transactions** (one row per item), **Orders**, **Audit Log**, **By Product** (totals per product and unit), **By Day / Week / Month** (with discounts given) and **Definitions**. Canceled rows are red, refunded amber, replaced gray, and the Status column says it in words. Order Total, discount and payment columns appear only on the first line of each order, so totals never double-count.

## 4. What works now, and what does not exist yet

**Built and tested:** sign-in and roles, chicken products, the seven services and fees, cash change calculator, Daily Inventory (with Beginning Balance corrections, the previous-day note, hidden zero rows) and stock checks on New order, the Daily Inventory Report and Whole Inventory exports, Submit Closing Inventory / Reset Daily Records, the Order List zoom, other products with fixed units, the checkout and review flow, discounts with reasons, payment details, order numbers, duplicate-submit protection, order history, cancel/change/refund with audit log, the Order List board with compact cards, bookmarks and sorting, user management with Delete Account, XLSX and CSV export, backup command.

**Not built yet:**
- **The paper-form Daily Sales Report (Orders tab)** still leaves the hand-counted boxes (inventory counts, **expenses, other collections and the cash count**) empty; since revision 9 the saved stock is in the Daily Inventory and the Daily Report export instead.
- **Offline checkout.** The app needs the server to be reachable. If the connection drops, the screen shows a clear error and keeps the unsent order on screen; nothing is saved until the server confirms.
- A **dashboard**, **partial refunds**, **live Google Sheets sync**, and **receipt printer support** ("Print slip" uses the browser's print dialog; the slip header now says "Official Receipt", which does **not** by itself make it a legal receipt: see the compliance warning in the revision 9 section).

**Assumptions in this version (please confirm; the revision 5 ones are listed at the top):**
1. Service fees are charged per head (3 heads at ₱25 = ₱75). The admin can switch a fee to per line (flat) or per kg.
2. Plain Pour and Dress are left whole (no size asked); Po-ur & Slice and Dress & Slice ask for a slice size; the two Dukot services are not sliced. Every Pour service carries the Pour fee and every Dress service the Dress fee.
3. With Blood is an optional extra with no fee; Dukot has no fee either.
4. "Authorized person" means the **admin**: only the admin can set prices. Managers can add products and ways of selling them, but those stay hidden until the admin prices them.
5. Other products use the fixed units of revision 10 (piece, pack, sack, kg; Eggs: piece, carton, tray). Older units such as dozen or batch are kept as they were. Laya and the other starter products get all the units; set a price only on the ones you sell.
6. Discounts apply to the whole order (other products included) and any cashier can apply one with a reason. If you want a manager to approve discounts, ask for it.
7. Your request said "Try to make the appearance more" and was cut off; I read it as more modern and easier to scan (pictures, clearer cards).
8. Other-product starter prices are unknown, so none were invented.

**Hosting.** The app needs a computer that runs Node 22.13+ and keeps a file on disk (a shop PC, a small VPS, or a host with a persistent disk). Static hosts such as Netlify cannot run it. This was not deployed to any host during development. **Update (revision 17):** a full step-by-step guide for going online is in [docs/deploy/online-hosting-guide.md](docs/deploy/online-hosting-guide.md).

## 5. Running the tests

```
npm test                 # 157 tests: money, services, units, cash change, heads, discounts, daily report, sorting, database safeguards and upgrades (2→3→4→5→6→7→8), full API incl. payments, the Order List, bookmarks and Delete Account, the clear-records command, the Daily Inventory, stock, reports and closing, and the Revision 10 behaviour (reasons, italic note, Order List clearing, units, hidden rows, exports)
npm install              # only for the browser test: installs Playwright
npx playwright install chromium
npm run test:browser     # (revision 17: replaces test:e2e) checks driving the real screens in Chromium (the seven services, the cash calculator, stock lines, Daily Inventory and its reason box, the report and Whole Inventory downloads, Submit Closing Inventory, Order List clearing and zoom, drag and drop, right-click, folded and open cards, bookmarks, sorting, Delete Account, Orders vs Order List status and colours, and phone-size screens)
```

Last results (Node 22.22, revision 10): `npm test` **157 of 157 passed**; browser test **67 of 67 passed**; the preview page's own browser checks **28 of 28 passed** (revision 10 preview). Both suites were also run from the unzipped package and from a folder whose name contains a space, such as `POS device` (see the final report for the exact results).

What the revision 7 tests cover:

- **Cards:** folded by default; a click opens, another click folds; Move, the star and Details do not open or fold the card; opening a card never changes its status (checked in the saved data); long names and long item lists do not make a card or the page wider.
- **Bookmarks:** set and remove; saved after a page reload; the Bookmarked filter shows exactly the bookmarked orders; the bookmark stays with its order after moving it between columns; canceled orders cannot be bookmarked; no order data is changed by bookmarking.
- **Sorting:** all five options, in every column, on known orders (including a walk-in, equal names, a missing and an invalid date), together with the Bookmarked filter; the saved orders are identical before and after sorting.
- **Delete Account:** a cashier and a manager are refused (403) by a direct request, and signed-out requests get 401; an admin can delete an unused account; an account with orders and payments is closed and every order, payment and audit row is unchanged and still shows the person's name; Cancel leaves the account unchanged; you cannot delete yourself, the main owner or the last active admin (UI and direct request); two requests at once delete once; the username stays reserved.
- **Clear records:** removes orders, lines, payments, history and price history and nothing else (users including the admin, products, prices, fees and sessions compared before and after); puts the database protections back exactly; numbering starts again; keeps the price history with `--keep-price-history`; if anything cannot be deleted nothing changes; the command refuses a wrong answer, a missing confirmation and a running app; the safety copy holds all the old records.
- **Upgrade 5 → 6:** run on a database built by the real revision 6 app with real orders (see below).

The upgrade to version 6 was rehearsed on a real revision 5 database: it was created by the revision 6 app itself (orders including a canceled one, a refund, payments, users who had taken orders, 8+ audit rows), then opened with this version. The database version went 5 → 6, the safety copy was created and was identical to the original, every row in order_items, payments, products, fees and the other data tables came through unchanged, the audit rows were identical, the orders were identical apart from the new `bookmarked` column (0), integrity and foreign-key checks were clean, and a second start did nothing. Then a bookmark, a move and the deletion of an account with history were done on that copy, and the order readout was identical before and after the account was deleted. (Earlier revisions' upgrade rehearsals are described in their sections.)

The Excel exports, including the Daily Sales Report, were checked in revision 4 (openpyxl and LibreOffice recalculation, PDF layout); this revision does not change them. **Not tested:** printing on your actual printer and paper size; Microsoft Excel and Google Sheets themselves; Safari or Firefox; real tablets or phones (drag and drop, folding cards and the star were tested with a mouse in Chromium, and the phone-size layout in a resized Chromium window; real touch dragging varies by device, which is why the **Move** button exists); a real scale or printer; any internet host.

## 6. Folder guide

```
server.js            starts the server (and adds the starter data on first run)
src/db.js            tables, constraints and triggers
src/routes.js        the API and who may call each route
src/services/        users, catalog (products, other products, fees), orders, export, dailyReport, inventory (stock, business days, the reset), inventoryReport (CSV and XLSX of one day)
src/xlsx.js, zip.js  spreadsheet writer (no packages)
src/clearRecords.js  the one deliberate way to clear orders and price history (used only by npm run clear-records)
shared/              rules used by both browser and server: money, services, pricing, discounts, Order List sorting (boardSort.js), cash.js (change calculator), inventory.js (stock formulas and messages)
public/              the screens: index.html, css/app.css, js/views/* (board.js is the Order List, users.js the Users tab, inventory.js the Daily Inventory, dayTools.js the closing dialog and the report and Whole Inventory downloads used by the Daily Inventory page)
scripts/             demo, create-user, backup, clear-records
tests/               unit, api, inventory and browser tests (tests/fixtures/schema-v4.sql, v5 and v6 are older database layouts, used to test the upgrades)
```
