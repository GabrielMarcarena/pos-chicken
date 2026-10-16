# Revision 12: handoff for the next session

> **Update 2026-10-16:** Revision 12 was finished and Revision 13 (Save + midnight auto-close, Katay/Dead per chicken, top-to-bottom Daily Sales Report, keyboard shortcuts) was built in this same folder. See the top of `README.md` and `C:\Users\gabri\Downloads\Chicken-POS-Revision-13-Report.html`. Sections 7-8 below are history. Browser checks now work from WSL: Playwright from `../chicken-pos-old/node_modules` plus the missing libraries (libnspr4, libnss3, libasound2t64) unpacked with `apt-get download` + `dpkg -x` and `LD_LIBRARY_PATH`.

Written 2026-10-15 at the end of a long session. Work stopped partway through Revision 12, at the user's request.
**Read all of this file before touching anything.** It is meant to be the only context the next session needs.

---

## 1. Who and what

**The owner.** The owner, signed in as "gabriel" (the admin login), runs a chicken shop in the Philippines. They are not a programmer.
- Write to them in plain, simple English.
- They sometimes send screenshots.
- They write requests as "Update #n" or "Change #n" lists, often with typos.

**The app: Chicken POS.** A point-of-sale and inventory web app.
- **Stack:** plain JavaScript on Node.js, using the built-in `node:sqlite`. There are no npm dependencies. It has its own xlsx writer in `src/xlsx.js`.
- **Screens:**
  - New order (cashier): chicken by weight with services, other products, discount, payment.
  - Order List (a Kanban board: Ongoing, Standby, Complete).
  - Orders (history, plus the Daily Sales Report and the spreadsheet exports).
  - Daily Inventory (business days, stock, close the day).
  - Products, and Users.
- **Background reading:** `README.md` (very detailed). The original specs are in `C:\Users\gabri\Downloads`: `Chicken Retail POS and Inventory System Consolidated Spec (v2).docx`, `REVISION REQUEST.docx` and `Chicken_POS_Revision_9_Request.docx`.

**How revisions work.** Each revision is a full copy of the previous folder, in `~/POS device/` in WSL Ubuntu:
- `chicken-pos-trial-rev9`, `chicken-pos-trial-rev10`, `rev10-new` and `chicken-pos-trial-rev11`: older revisions. **Do not modify them.**
- `chicken-pos-trial-rev13`: **this one, in progress.** It was made with `cp -a` from rev11, so it includes the shop's real `data/pos.db` and `backups/`.
- Git: the repo's last commit is "Update to revision 7". Everything since is uncommitted. Don't commit unless asked.

**Database history.** Earlier, the user had every record wiped except the admin login "gabriel": orders, products, fees and inventory. The rev11 data now holds a little real use from 14–16 Oct 2026.

## 2. The user's working preferences (follow these)

- **Clarify first only when it matters.** For Revision 11 the agent asked clarifying questions first, and the user answered with "ok" plus a rename. For Revision 12 the agent built straight away using reasonable defaults, and lists those decisions in the report so the user can confirm them (section 6).
- **The report.** When a revision is finished, write an HTML report and **save it straight to Downloads** (the user asked for this: "automatically download the file that you will report to me"). The previous one is `C:\Users\gabri\Downloads\Chicken-POS-Revision-11-Report.html`; use the same style and structure. Name the new one `Chicken-POS-Revision-12-Report.html`. It should cover:
  - what changed, in plain words
  - how to try it out
  - the decisions made, for the user to confirm
  - the test results
  - how to start the app
- **Button and label wording:** use the user's exact words. For example, "Closed Inventory Today and Reset the Day" was the user's own rename.
- **Never touch real shop data in tests or demos.** Use `:memory:` or `/tmp`.
- **Explanations:** the user asks "why does X exist?" questions. Answer from their own earlier requests and decisions.

## 3. Environment (quirks that cost time)

**Shells.** The agent runs on Windows (PowerShell plus Git Bash). The project lives in WSL Ubuntu, so work with it like this:
- **Files:** read and edit them through `\\wsl.localhost\Ubuntu\home\gabriel\POS device\chicken-pos-trial-rev13\...`.
- **Commands:** run them in WSL from **PowerShell** with `wsl --cd ~ bash <script.sh>`.
  - Without `--cd ~`, WSL fails while trying to enter the Windows working directory.
  - From Git Bash, `/mnt/c/...` paths get mangled.
  - Long inline `bash -c "..."` commands break on quoting. Write a script file and run that instead.

**Node.** Use `$HOME/.nvm/versions/node/v24.21.0/bin`. A Windows Node is on the PATH too, so `npm` can pick up the wrong one; set `PATH` first, as `handoff/t12.sh` does.

**Editing files.** Large multi-place edits went best as small Node patch scripts that do exact string replacement and fail if a string is missing or appears twice; see `handoff/patch.mjs`. Windows Node (in Git Bash) can run those directly on the `\\wsl.localhost` paths.

**Helper scripts in `handoff/`.**
- **`t12.sh`:** runs `node --check` on every source file, then the tests with TZ=UTC, and prints a summary.
  - The full output goes to `/tmp/cpos-check/test-out.txt`.
  - You can pass it test files, for example `tests/revision12.test.js`.
- **`demo12.mjs`:** starts a throwaway demo server on port **3011**.
  - The database and inventory folder live in `/tmp/cpos-check/demo`. It seeds sample products and prices; the logins are demo-admin / demo-admin-1 and demo-cashier / demo-cashier-1.
  - Run it in the **background**: `node --disable-warning=ExperimentalWarning handoff/demo12.mjs "$HOME/POS device/chicken-pos-trial-rev13"`. Otherwise it dies when the WSL call ends.
  - Open http://localhost:3011 in the built-in browser.
- **`patch.mjs`:** applies a JSON list of `[old, new]` replacements to a file.

**GitHub.** No access. `gh` is not installed and there are no GitHub tools in the session.

**Starting the real app.** Run `npm start` in the project (port 3000). Nothing has been started on rev12 yet. The first start upgrades `data/pos.db` from schema 9 to 10 and writes a `pos.db.before-v10-*.bak` safety copy automatically.

**Full transcript of the previous session:** `C:\Users\gabri\.claude\projects\C--Users-gabri-AppData-Roaming-Claude-scratch-workspaces-3fa04e70-be7d-48e0-822c-17810d3b0cc6-f42ad94b-c430-4127-8d85-9d9a9352464f-scratch-2026-10-13-f8aab4\be129d05-1e8d-4ff3-bb02-04a9796b1d25.jsonl`. It is very long; search it rather than reading it all.

## 4. The user's Revision 12 request (verbatim, typos kept)

The user attached three screenshots:
- **(a) The current Inventory tab.** The "How the numbers are worked out" and "Inventory actions" text was squeezed to about half the width. It showed the Submit, Closed and Export Inventory History buttons.
- **(b) The CSV export opened in Excel.** The headers ran into each other: "Transaction Order Numb Cashier or U Customer N ...".
- **(c) The old CASH BREAKDOWN box of the Daily Report:** 500/1000, OTHER BILLS, COINS, OVERALL TOTAL, EXCESS/LOSS.

The request:

> NEW UPDATE FOR THE WEBSITE:
> Update #1: Under the new order tab I want an button name as advanced. I want it align to the chicken and other product but align left because this is advanced option. and in this option I want a ref/stock like section switch stores chicken. this is like the chicken product but its for katay and dead. in which it only gets the kg and heads of chicken no service fee can be add. because this is automatically store in ref for preservation. but add an option if the product is click either add katay chicken or ordered same with the dead chicken. if order ask on for a price per kilo and if added some price add to order dont add discount let the cashier do that. if a dead or a katay is added in the ref/stock I want to update the inventory to +the number of heads of Katay or dead chicken. if it is directly added in the inventories dont update the number of stocks below the dead chicken and katay.
>
> Katay and dead must also have number of stock(like the number of heads in the chicken product) it will base on the daily inventory but if a katay or dead is added directly in the daily inventory ask if it is added from the ref/stock or not. if added add number of the kayat/dead number of stock and inventory if not it will not add but it will be added in the inventory.
>
> Update 2: Cash Break down also inside of advance. this helps cashier to CASH BREAKDOWN bills from:
> 1000x# 500x# 200x# 100x# 50x# and coins 20x# 10x# 5x# 1x# 25 cents x#
> And overall this updates the daily report analyze the report and you will see the section you will update it.
>
> Update#3 Inside the advance also add a expense button where this track the expenses. make this the add product and price for example:
> Coke: 75 / Bread: 35 / Meal:200 / Overall: 310
> Analyze the daily report and add this to the expenses.
>
> Change#1 in the inventory tab in the section of "Inventory actions" and "How the numbers are worked out the words are" compact. I want you to fix it its let them have the whole space. But I want you to make a design like for the note "How the numbers are worked out the words are" make it like a note book highlighting the important keywords.
>
> And for the Inventory actions make the Closed Inventory Today and Reset the Day to have a single action to reset and submit the inventory not like not to ask options: Cancel, Submit Inventory Today, Close the day and reset. the button must be : cancel, Close the day and reset(which also Submit Inventory Today).
>
> Remove the Export Inventory History buttong and its meaning from this section. fix this button button should also see like the submit inventory today but the only difference is this can download inventories (like inside of the submit inventory today) to Daily Inventory Business day which are labeled close. so if a user click on a date that is closed status the export button should be beside the status "close" and this button must only show to inventory dates that are closed. NOTE THAT THE EXPORT BUTTON MUST FOLLOW THE STRUCTURE SUBMIT INVENTORY WHERE I want to seethe chicken product and other product in it.
>
> Change#2 can you fix some of the exported files for example the CSV export sheet under orders. it look like this [screenshot b]
> can you set the cells to not overlap by the inputs. it will take time for the user to identify what is the identification of the record.
>
> ADDITIONAL INFORMATIONS FOR YOU:
> I want you to to know that there is also an assorted eggs. this are collected eggs in the shop from diffrent chicken thats why they are call assorted eggs. in the daily sales report in the egg section there is a record there for assosrted I just want you to link them if I will be creating a other product eggs assorted.

Just before this request, the user asked why the "Export Inventory History" button exists. The answer: their own Revision 11 request (section 4.5) asked for it, and it was kept in the clarification defaults they approved. Revision 12 now removes it, as requested above.

## 5. Background from Revision 11 (needed to understand the code)

**Business days.** One day is OPEN at a time; a closed day is frozen by database triggers.
- **Stock:** `inventory_records` keep figures in thousandths (77 heads = 77000).
- **Chicken:** New Total = Left − Reject − Katay − Dead − Pull Out. **Other products:** New Total = Left.
- **Sold** is counted from the orders, never typed in.

**Katay.** A dying chicken slaughtered and bled at once so the meat is not damaged. Katay and Dead are inventory loss columns.

**Discounts.** The reasons are BULK, REJECT, EMPLOYEE, WHOLESALE, DEAD, KATAY and OTHER. A discount reason never changes the inventory.

**Other products.** They are counted in pieces. A per-kg sale also records the number of pieces, which come off the product's "piece" stock row.

**Submit Inventory Today.**
- Saves an xlsx to `backups/inventory` and downloads it.
- Leaves out rows that are 0 in every column, with a note saying so.
- Records a fingerprint of the day's numbers. Closing used to require that the numbers still matched; Revision 12 adds `submit: true`, which submits and closes in one step.

**Reports.**
- The Daily Sales Report is an xlsx that copies the shop's paper form: B-CULL, CULL and BROILER blocks, EGGS (Asst., Sm., Med., Lar., XL), EXPENSES, OTHERS, DISCOUNTS, COLLECTIONS and CASH BREAKDOWN.
- Products have a category (BCULL, CULL, BROILER, OTHER) that picks their block.
- The CSV has 18 columns (`CSV_HEADERS` in `src/services/export.js`) and lists sold orders only.

**Rev11 report items (D1, D2) the user still hasn't answered:**
- **D1:** after an evening close, the business date can run at most one day ahead.
- **D2:** the CSV lists sold orders only.

## 6. Revision 12 decisions taken without asking (confirm them in the report)

- **D1:** "Advanced" is placed at the **left end** of the Chicken / Other products tab row, with a separator. It's easy to move if the user meant something else.
- **D2:** Storing in the ref asks **which chicken product** it came from, because Katay and Dead are recorded per chicken row on the Daily Inventory.
- **D3:** **Cashiers** may store in the ref (it is on New order). This changes the Daily Inventory Katay or Dead; who did it is recorded in both histories.
- **D4:** The ref stock is **not reset** when the day is closed (the freezer carries over).
  - Heads in the ref = heads put in − heads on sold orders.
  - So a canceled or replaced order returns its heads automatically, and a refund does not.
- **D5:** Lowering Katay or Dead on the inventory takes back out of the ref only the heads that came in from that row. It is refused (`REF_SOLD`) if they were already sold. Raising it asks Yes, No or Cancel.
- **D6:** Ref items are sold by the kilo at a price the cashier types: price = weight × price per kg, with no service fee and no automatic discount.
- **D7:** **Expected cash** comes from orders paid in cash or with no payment recorded, after discounts, minus refunds, minus expenses.
  - EXCESS/LOSS = cash counted − expected cash, and stays empty until the cash is counted.
  - GCash, Maya, bank and other payments are shown as LESS NON-CASH PAYMENTS.
- **D8:** Cash count and expenses are for the **open** day only.
  - Saving a cash count again replaces it; the latest one is used, and earlier counts stay in history.
  - A wrong expense is removed (marked, never deleted). A cashier can remove only their own.
  - On a report for one cashier, only that cashier's counts and expenses are shown.
- **D9:** **Submit Inventory Today** stays as its own button. The close button now also submits, and its dialog has only Cancel and "Close the day and reset".
- **D10:** The closed-day **Export** uses the submitted-file layout and also leaves out rows that are 0 in every column. It is not offered for an open day (409).
- **D11:** CSV files cannot store column widths. The fix is a new **"Download Sales List (Excel)"**: the same 18 columns and rows, with fitted widths, a frozen header row and filters. Also:
  - Plain CSV is kept as a small link.
  - Every sheet of the main Excel export is now width-fitted too.
- **D12:** **Assorted eggs** go on the Asst. row in any of these cases:
  - The product has the Eggs type.
  - Its name says "assorted" or "asst".
  - It is an egg product (the name contains "egg" or "itlog") whose name gives no size.

  The Products screen shows each egg product's report row.
- **D13:** The close dialog shows a reminder (not a block) when no cash breakdown was saved for the day.

## 7. DONE so far (code written)

**Server.** The full existing suite (166 tests) passes with it.
- **`src/db.js`:** schema **10** (`migrateTo10`: backup, then the new tables only). New append-only tables, guarded by triggers:
  - `ref_stock_entries` and `order_ref_items`
  - `cash_counts`
  - `expenses` (its only allowed update is "removed", once, while the day is open)
- **`src/services/refStock.js` (new):** `refBalance`, `refHeldBy`, `refFromRecord`, `addRefEntry`, `refSummary`.
- **`src/services/inventory.js`:**
  - `storeInRef`.
  - `updateRecord` accepts `to_ref` and handles corrections.
  - Ref demand in `demandOf`, `heldBy` and `assertStock`; `stockSummary.ref_heads`.
  - `inspect(..., { submitting })` and the `NO_CASH_COUNT` notice.
  - New `dayToClose` and `closeOpenDay`; `historyDays` was removed.
- **`src/services/inventoryReport.js`:**
  - `buildInventoryXlsx` (the shared layout; `sheetName` defaults to "Inventory Today").
  - `writeSubmission`, `submitInventory`, `closeAndSubmit` and `closedDayExport`.
  - The history export was removed.
- **`src/services/cashbook.js` (new):** `cashSales`, `expensesOf`, `addExpenses`, `removeExpense`, `latestCashCount`, `saveCashCount`, `dayMoney`.
- **`src/services/orders.js`:** `ref_items` handled throughout: validate, price with `refLine`, insert, load and present, snapshot, `line_count`, the board, and releasing heads on change.
- **`src/services/dailyReport.js`:**
  - The KATAY / DEAD (REF) block.
  - Expense rows filled in, and LESS EXPENSES uses them.
  - The full cash breakdown with formulas, expected cash and EXCESS/LOSS.
  - An EGGS-kind product without a size in its name goes on Asst.
  - The Notes sheet was updated.
- **`shared/constants.js`:** `eggSizeOf` (moved here), `REF_*`, `CASH_DENOMINATIONS`, `cashCountTotal`.
- **`shared/pricing.js`:** `refLine`.
- **`src/xlsx.js`:** `Sheet.fitColumns()`.
- **`src/services/export.js`:** "Ref Chicken" lines, `buildSalesListXlsx`, and every sheet width-fitted.
- **`src/routes.js`:**
  - New routes: `GET /api/advanced`, `POST /api/ref/store`, `POST /api/cash-count`, `POST /api/expenses`, `POST /api/expenses/:id/remove`, `GET /api/inventory/day.xlsx?date=`, `GET /api/export-sales.xlsx`.
  - `close-day` accepts `{submit:true}`; `close-check` accepts `?submit=1`.
  - `/api/inventory-history.xlsx` was removed and now returns 404.
  - `ref_labels` was added to `/api/config`.
- **`src/clearRecords.js`:** also clears the new tables, for closed days only.

**Tests updated for the intended changes:**
- Version 10.
- `NO_CASH_COUNT` filtered out in the rev10 notices test.
- The history tests rewritten to use the closed-day export (inventory, revision10 and revision11 test files).

**Browser.** The code is written but **not yet checked** with `node --check` or in a browser.
- **`public/js/state.js`:** `refItems`, `priceRef`, `savedRefHeads`, `availableRefHeads`.
- **`public/js/views/advanced.js` (new):** sub-tabs for Ref stock, Cash breakdown and Expenses.
- **`public/js/views/checkout.js`:** the Advanced tab, the ref screen (`cfgRefHtml`, `updateRefCfg`, `startRef`, `storeRef`), ref lines in the order panel and review, and `ref_items` sent with the order.
- **`slip.js`, `board.js` and `orders.js`:** ref lines shown; changing an order copies its ref lines and held heads; the buttons are Excel, Sales List (Excel) and Plain CSV.
- **`public/js/views/dayTools.js`:** rewritten.
  - The close dialog has only Cancel and "Close the day and reset", which submits and closes, then downloads the file.
  - `exportClosedDay` was added.
- **`public/js/views/inventory.js`:**
  - `notebookHtml()`.
  - The `<dl class="inv-help">` actions help.
  - The Export button beside "Closed".
  - `askRef()` when Katay or Dead is raised.
- **`public/js/views/catalog.js`:** shows each egg product's report row, and a hint while a product name is typed.

## 8. PENDING (do these in order)

1. **CSS in `public/css/app.css` (nothing added yet).** The app has a light theme only; use the existing CSS variables (`--pine`, `--amber`, `--tag` and so on). Classes still needing styles:
   - **Inventory page:** `.notebook`, `.notebook-head`, `.notebook-lines` (lined paper, a red margin line, a handwritten-style heading), `mark.hl`, `.hl--red`, `.hl--amber` (highlighter look), `.inv-export`.
   - **Full width:** `dl.inv-help` with its `div`, `dt` and `dd`. **Remove** the `max-width` rules on `.inv-notes`, `.inv-explain .inv-notes` and `.inv-help` (around lines 428, 478 and 480), so both sections use the full width; that is the user's complaint.
   - **New order tabs:** `.tabs--adv`, `.tab--adv`, `.tab-sep`.
   - **Advanced:** `.subtabs`, `.subtab[aria-selected="true"]`, `.adv`, `.adv-day`, `.adv-section`, `.adv-table`, `.adv-in`, `.adv-out`.
   - **Ref:** `.ref-grid`, `.ref-card--katay`, `.ref-card--dead`, `.chip--ref`.
   - **Cash:** `.cash-grid` (two columns, one column on phones), `.cash-table`, `.cash-input`, `.cash-sub`, `.cash-sum`, `.cash-line`, `.cash-line--big`, `.cash-excess` (green), `.cash-loss` (red), `.cash-note`.
   - **Expenses:** `.exp-form`, `.exp-line` (three-column grid), `.exp-foot`, `.exp-new-total`, `.exp-removed` (struck through).
   - **Small text:** `.small`.
   - Everything must also work at phone width (375 px).
2. **Check everything, then run the full suite.** Run `wsl --cd ~ bash handoff/t12.sh` from the project folder, or pass the full path.
   - `catalog.js` and `dailyReport.js` were last patched with `sed`; check them carefully (the `eggRowText` and `eggHint` lines, and line ~66 and ~119 of `dailyReport.js`).
   - `shared/constants.js` `eggSizeOf` now matches `/egg|itlog/i`.
3. **Write `tests/revision12.test.js` and add it to the `npm test` script in `package.json`.** Copy the `makeShop`, `client` and `readZip` helpers from `tests/revision11.test.js`. Cover:
   - **Storing in the ref:** raises the inventory Katay or Dead and the ref; refused when Reject + Katay + Dead + Pull Out would exceed what is Left.
   - **Selling from the ref:** lowers the ref; "Insufficient stock" when short; a cancel returns the heads; a change releases them; a refund does not return them.
   - **Typing on the inventory:** `to_ref` true and false; lowering with the correction entry; the `REF_SOLD` refusal.
   - **Close and submit in one step:** the file is saved and recorded and the day is closed; on failure no file is left and the day stays open; an Ongoing order still blocks it.
   - **Closed-day export:** the layout, zero rows left out, an open day refused with 409, and a signed-out request refused with 401.
   - **Cash count:** validation, the latest count wins, a closed day is refused.
   - **Expenses:** adding, removing, the cashier-own rule, a closed day is locked.
   - **Daily Report:** the REF block, the expense rows and LESS EXPENSES, the cash breakdown values, the EXPECTED CASH and EXCESS/LOSS formulas, and the per-cashier filtering.
   - **Sales List:** exactly the 18 headers, fitted widths (`<cols>` widths ≥ header length), sold orders only.
   - **Eggs:** "Eggs Assorted" and an EGGS-type product named "Itlog" both go on Asst.
   - **clearRecords** with the new tables.
   - **Upgrade 9 → 10:** a backup is made and the data is unchanged.
4. **Check the screens in the browser with the demo.** Start `handoff/demo12.mjs` in the background and open http://localhost:3011 in the built-in browser. Check:
   - New order > Advanced and all three sub-tabs.
   - Storing in the ref, and selling Katay or Dead through to checkout.
   - The "into the ref?" question when Katay or Dead is raised on the inventory.
   - The close dialog has only two buttons.
   - The Export button appears only on a closed day.
   - The notebook look and the full-width sections.
   - Phone width.
   - The Sales List xlsx column widths.
5. **README and version.** Document Revision 12 in `README.md` and bump the version in `package.json` (it is currently 1.0.0).
6. **The report.** Save `C:\Users\gabri\Downloads\Chicken-POS-Revision-12-Report.html`, styled like the rev11 report. It must cover:
   - every change, in plain words
   - how to try each one
   - the decisions from section 6, for the user to confirm
   - the rev11 D1/D2 questions that are still open
   - the test counts
   - a note that the first start upgrades the database (with a safety copy)
7. **Then ask the user** whether to start rev12 on the real data (`npm start` in rev12) and to confirm the decisions.

**Delete this file (and `handoff/`)** once Revision 12 is delivered, or move the notes into the README.
