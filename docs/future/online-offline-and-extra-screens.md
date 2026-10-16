# Chicken POS: review, going online, offline use, and extra screens

## Context
You asked four things:
1. What can be improved in the website.
2. What problems we would hit if we put it online with an online database.
3. Offline app or online website: which is better.
4. Can we add a **customer screen** (shows their order and payment) and a **butcher screen** (shows how to cut each order)?

This is a review only. Nothing has been changed. The last section lists what I suggest building next, in order, for you to approve.

---

## 1. What I looked at (short version)
- **How it's built:** Node.js server + one SQLite database file (`data/pos.db`), no outside packages. The browser screens are plain JavaScript. About 9,500 lines of code.
- **Good parts already there:**
  - passwords are stored safely (scrypt)
  - the server checks who is allowed to do each action, not the browser
  - the database itself blocks changes to finished orders, payments and closed days
  - automatic safety copies are made before each database upgrade
  - there are tests
- **Screens:** New order, Order List (Ongoing / Standby / Complete), Orders, Products, Daily Inventory, Users.
- The Order List and Orders screens re-check the server **every 20 seconds** ([board.js](public/js/views/board.js), [orders.js:164](public/js/views/orders.js#L164)).

## 2. Things to improve (even if it stays in the shop)
1. **Save your work in git.** The last saved version (commit) is Revision 12. All of Revision 13 is unsaved, and each revision is a full copied folder. Saving each revision in git, instead of copying folders, makes it safe to undo mistakes.
2. **Backups need to leave the computer.** Today, backups go to `backups/` on the same PC (see [scripts/backup.js](scripts/backup.js)). If that PC breaks or is stolen, every order is gone. Add an automatic daily copy to Google Drive, a USB drive or the cloud.
3. **Old safety copies pile up.** `data/` already holds 9 `.bak` files. Delete old ones automatically, keeping the last few.
4. **Old sign-ins are never cleaned out.** An old sign-in is only removed when someone tries to use it ([users.js:174](src/services/users.js#L174)). Add a small cleanup, for example at the midnight close.
5. **Very large files.** [checkout.js](public/js/views/checkout.js) (1,150 lines) and the README (91 KB) are getting hard to change safely. Split them up the next time we work on them.
6. **Screen updates are slow.** Checking every 20 seconds is fine today. The new customer and butcher screens need **instant** updates (see section 5).

## 3. Problems if we put it online with an online database
| # | Problem | Why it matters | What to do |
|---|---|---|---|
| 1 | **Shop internet goes down = no selling** | Every sale needs the server. If the internet drops, the cashier sees "Could not reach the server" ([api.js:22](public/js/api.js#L22)). | Biggest reason to keep the server **inside the shop** (section 4). |
| 2 | **Moving to an online database (MySQL/Postgres) is a big rewrite** | The code talks to SQLite directly everywhere (`node:sqlite`). Many business rules are built into SQLite itself (40+ "cannot be changed" rules in [db.js](src/db.js)). | Online, keep SQLite on a server with a **permanent disk**. Don't switch databases. |
| 3 | **Files disappear on many cheap/free hosts** | The database and the saved inventory files are ordinary files on disk (`backups/inventory`, [inventory.js:529](src/services/inventory.js#L529)). Hosts like Render and Heroku delete these files when they restart. | Use a small VPS, or a host with a "persistent volume" (for example Railway, Fly.io or DigitalOcean). Point `DB_PATH` at it. |
| 4 | **The midnight close needs the server awake** | The day closes using a once-a-minute timer inside the server ([server.js:44](server.js#L44)). Free hosts "sleep". The code does catch up when it wakes, but closing late can be confusing. | Use a paid host that is always on. Run **only one** copy of the server. |
| 5 | **Running two copies of the server breaks things** | One database file, sign-in limits kept in memory, and the midnight timer all assume a single server. | Run one server. That is plenty for one shop. |
| 6 | **HTTPS** | The app does not do HTTPS itself. Without it, passwords travel unprotected. | Put Caddy, Nginx or Cloudflare in front of it. Set `COOKIE_SECURE=true`. |
| 7 | **The sign-in limit behind a proxy** | The limit is keyed on username + IP ([routes.js:40](src/routes.js#L40)). Behind a proxy everyone shares one IP. A stranger could then lock the owner out for 15 minutes by typing wrong passwords. | Read the real IP from the proxy header, and only when behind our own proxy. |
| 8 | **Anyone on the internet can find the sign-in page** | Today only people in the shop can reach it. | Use strong passwords, change the `.env` admin password, and consider Cloudflare Access or Tailscale so only shop devices can open it. |
| 9 | **Large exports pause everyone** | Excel exports are built all at once, and the database calls make every other request wait meanwhile. | Fine at shop size. Only matters with years of data. |
| 10 | **Node version** | `node:sqlite` needs Node 22.13+ ([package.json](package.json)). Some hosts run older versions. | Choose a host that lets you pick Node 22 or 24. |

## 4. Offline app or online? My recommendation
**Best for a chicken shop: run it "local first", with an online backup.**

- **In the shop:** one small, cheap computer, for example a mini PC (about ₱8–15k) or the cashier laptop, runs `npm start` all day. Every screen joins it over the shop **Wi-Fi/router**: cashier, customer display and butcher tablet.
  - Works with **no internet**.
  - Fast, and costs nothing per month.
  - A cheap UPS keeps it running through brownouts.
- **Online part (optional, added later):**
  - The database is copied automatically to the cloud every few minutes (for example with Litestream or a nightly upload). Nothing is lost if the PC dies.
  - If you want to check sales from home, use Tailscale (a free private network) to open the shop's app from your phone, without putting it on the public internet.

Why not the other two:
- **Fully online:** if the internet drops, the shop stops selling. It also needs monthly hosting and all the security work in section 3.
- **True offline app (installable, each device keeps its own copy and syncs later):** a very big rewrite. Stock counts, the one open business day, and order numbers all assume a **single** place that holds the truth. Two tablets selling the last chicken while offline would conflict.

So: **one server in the shop = an "offline" system for the whole shop**, without the sync problems.

## 5. Customer screen and butcher screen: will it work?
**Yes, both are possible and fit the app well.** The order already stores everything the butcher needs:
- the service: Live, Pour, Dress, Slice, Dukot ([constants.js](shared/constants.js))
- the piece size: small, medium or large
- the weight and number of heads
- the Ongoing / Standby / Complete status

### Butcher screen (Kitchen display)
- A new screen (for example `#/butcher`) on a tablet or TV mounted in the butcher area.
- It shows **Ongoing** orders, oldest first, as big cards. Each card shows:
  - order number and customer name
  - each chicken: kind, kg or heads, the service in big words ("Dress & Slice — Medium pieces"), and notes
- One big **"Done"** button on each card moves the order to **Standby** (ready for pickup). This reuses the existing `POST /api/orders/:id/fulfillment` route.
- New orders appear **instantly**. We add a "live updates" connection (Server-Sent Events: built into browsers, no extra packages). Optionally it plays a beep when a new order arrives.

### Customer screen (Customer-facing display)
- A second monitor facing the customer. It shows the items being added, the subtotal, the discount, the total, then the cash received and change, then "Thank you".
- **Easiest, recommended:**
  - Plug a **second monitor** into the cashier computer.
  - The cashier screen opens a second window on that monitor.
  - The two windows talk directly inside the same computer (BroadcastChannel), with no server change and no internet.
  - It updates **as the cashier types**, even before the order is saved.
- **Alternative:** a separate tablet. That needs the draft order sent to the server live, which is more work.

### Sign-in for the displays
- Add a limited **"display" account type**. It can only *see* the butcher or customer screen, and can't open sales, prices or users.
- Then a tablet left in the butcher area can't be used to change anything except marking orders done.

### Hardware
- **Customer display:** any HDMI monitor.
- **Butcher display:** any cheap Android tablet or smart TV with a browser, on the shop Wi-Fi.
- Both work with the "server in the shop" setup from section 4.

## 6. Suggested next steps (in order, for your approval)
1. **Safety first:**
   - commit Revision 13 in git
   - an automatic off-computer backup
   - clean up old `.bak` files and old sign-ins
2. **Live updates (SSE):** add a `GET /api/events` stream in [src/app.js](src/app.js)/[src/routes.js](src/routes.js). It tells screens when an order is created or moved. The Order List switches from 20-second checks to instant updates.
3. **Butcher screen:**
   - a `display` role in [users.js](src/services/users.js) (`ROLE_RANK`) and [shared/constants.js](shared/constants.js) `ROLES`
   - a new view `public/js/views/butcher.js` that reuses `prepChips` from [util.js](public/js/util.js) and `listBoard` data
   - the route added in [main.js](public/js/main.js)
4. **Customer screen:**
   - a new `public/js/views/customer.js` that opens in a second window
   - [checkout.js](public/js/views/checkout.js) posts the draft order and payment over BroadcastChannel whenever they change
5. **Shop setup guide:**
   - mini PC + router + UPS
   - start automatically on boot
   - Tailscale for remote viewing
   - written in plain steps in the README

## Verification (when we build it)
- `npm test` plus new tests for:
  - the display role: it can't create orders or see prices
  - the events stream
- Browser check with the demo server (`handoff/demo12.mjs`, port 3011):
  - open the cashier, butcher and customer screens side by side
  - make an order: it appears on the butcher screen at once
  - press Done: it moves to Standby on the Order List
  - the customer window shows the total and change while the cashier types
- Never use the real `data/pos.db` for tests.
