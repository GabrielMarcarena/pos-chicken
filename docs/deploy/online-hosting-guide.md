# Put the Chicken POS online (free host, free address)

Written for the shop owner. Every step says **where** you do it: on a website, in your Windows/WSL terminal, or on the server.
Total time: about 1 to 1.5 hours the first time. Cost: ₱0 (see "What can go wrong" first).

## What you will have at the end
- Your POS at an address like **https://pitikpos.duckdns.org** (with the padlock).
- Cashier: that address. Customer screen: `/customerscreen`. Butcher TV: `/butcher`.
- The database on the server's own disk, backed up every night to your Google Drive.

## The pieces (all free)
| Piece | What it does | Free site |
|---|---|---|
| Server (a computer that is always on) | Runs the POS and keeps the database file | Oracle Cloud "Always Free" (Singapore) |
| Address | A name people type | DuckDNS (`yourname.duckdns.org`) |
| Padlock (HTTPS) | Keeps passwords private | Caddy (installed on the server) |
| Database | The file `pos.db`, on the server's disk | nothing extra to sign up for |
| Backups | A copy outside the server | Google Drive (15 GB free) |

Why not Render, Netlify or Supabase? They either erase files when they restart or need the database rewritten. The POS keeps its data in one file, so it needs a computer with a disk that stays.

## What can go wrong (read this first)
1. **Oracle can take back an idle free server.** Oracle's own page says a free server may be reclaimed if over 7 days its CPU use stays under 20% (and network under 20%). A POS is a light program, so it will look idle. Oracle's own advice is to **upgrade the account to "Pay As You Go"**: you still pay ₱0 while you stay inside the free limits, but they stop treating it as an idle free server. This guide does that in step 2. (Source: Oracle's *Always Free Resources* page, docs.oracle.com. Oracle changes its free plan from time to time; check that page when you sign up.)
2. **Nightly Drive backups are not optional.** If the server is ever lost, the Drive copy is your shop's records.
3. **If the internet in the shop is down, selling stops.** You said the generator keeps power and internet on. A phone hotspot is the quick backup.
4. **"Out of host capacity"** when creating the server: wait and try again, or try the other free shape. Free servers are sometimes all taken.
5. **If Oracle does not work out**, a small paid server (about ₱250–400 a month, any Ubuntu 24.04 server) works with exactly the same steps from step 6 onward.

---

## Step 1. The free address (DuckDNS) — on a website, 5 minutes
1. Open **duckdns.org** and sign in with Google.
2. In "domains", type a name, for example `pitikpos`, and press **add domain**. Your address is `pitikpos.duckdns.org`.
3. Copy the long **token** shown at the top of the page. Keep it private. You will need it in step 8.

## Step 2. Oracle Cloud account — on a website, 20 minutes
1. Open **oracle.com/cloud/free** and press **Start for free**.
2. Fill in your details. **Home region: choose Singapore** (closest to the Philippines). **It cannot be changed later.**
3. Oracle asks for a card to check you are real. Free accounts are not charged.
4. When you are in, press the menu (top left) → **Billing & Cost Management** → **Upgrade to Pay As You Go**. This is the safeguard against the idle rule above. Then go to **Budgets** and make a budget of ₱50 with an email alert, so you hear about any charge at once. Staying inside the Always Free list means nothing is charged.

## Step 3. Create the free server — on the Oracle website, 15 minutes
1. Menu → **Compute** → **Instances** → **Create instance**.
2. Name: `pos`. Image: **Canonical Ubuntu** (24.04, or 22.04 if that is what the list shows).
3. Shape → **Change shape**:
   - **VM.Standard.E2.1.Micro** (AMD, 1 GB memory). Works for one shop. Or
   - **Ampere A1.Flex** (1 OCPU, 6 GB memory) if it is available. More comfortable.
4. Networking: keep "Assign a public IPv4 address" on.
5. **Add SSH keys** → **Generate a key pair** → download both files. Keep the **private key** safe; it is your only way in.
6. **Create**. After a minute the page shows the **Public IP address**. Write it down.

## Step 4. Open the web doors on Oracle — on the Oracle website, 5 minutes
1. On the instance page press its **Subnet** link, then the **Security List** (default), then **Add Ingress Rules**.
2. Rule 1: Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port `80`.
3. Rule 2: the same with Destination Port `443`.

## Step 5. Point your address at the server — DuckDNS website, 1 minute
On duckdns.org put the server's public IP in the "current ip" box of your domain and press **update ip**.

## Step 6. Set up the server — in your terminal, 20 minutes
Open your WSL terminal. Put the downloaded private key somewhere safe and lock it:
```
chmod 600 ~/Downloads/ssh-key-*.key        # use the real file name
ssh -i ~/Downloads/ssh-key-XXXX.key ubuntu@YOUR_SERVER_IP
```
(Type `yes` the first time.) You are now **on the server**. Paste these blocks one at a time.

**6a. Timezone and a little extra memory**
```
sudo timedatectl set-timezone Asia/Manila
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
**6b. Open the doors inside the server** (Oracle's Ubuntu blocks them by default)
```
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo apt-get update && sudo apt-get install -y iptables-persistent     # answer Yes to both questions
sudo netfilter-persistent save
```
**6c. Install Node 24, git and Caddy**
```
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
node --version        # must show v24 (or at least v22.13)
```
**6d. Get the POS and set it up**
```
cd ~ && git clone https://github.com/GabrielMarcarena/pos-chicken.git
cd pos-chicken
mkdir -p ~/pos-data
cp .env.example .env
nano .env
```
In `.env` set these lines (Ctrl+O, Enter, Ctrl+X to save):
```
PORT=3000
HOST=127.0.0.1
DB_PATH=/home/ubuntu/pos-data/pos.db
ADMIN_USERNAME=your-admin-name
ADMIN_PASSWORD=a-long-password-you-have-not-used-anywhere-else
COOKIE_SECURE=true
TRUST_PROXY=1
```
Optional check: `npm test` (takes about a minute; all should pass).

## Step 7. Bring your data (optional) — 5 minutes
Your own computer's database is **already cleared** of test records (users, products and prices kept). To use it on the server, on **your own computer** in the POS folder:
```
npm run backup
scp -i ~/Downloads/ssh-key-XXXX.key backups/pos-*.db ubuntu@YOUR_SERVER_IP:/home/ubuntu/pos-data/pos.db
```
Then your usual admin name and password work on the server, so **change the password** after signing in (Users screen). If you skip this step, the server starts empty with the admin from `.env`, and you add products yourself.

## Step 8. Start it — on the server, 10 minutes
```
cd ~/pos-chicken
sudo cp deploy/chicken-pos.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now chicken-pos
systemctl status chicken-pos          # should say "active (running)"; press q

sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # change pitikpos.duckdns.org to YOUR address
sudo systemctl reload caddy
```
Wait a minute, then open **https://yourname.duckdns.org** on your phone or computer. You should see the sign-in page with a padlock. Sign in and change the admin password.

Keep the address pointed at the server (cron jobs), and make the nightly backup:
```
printf 'DOMAIN=pitikpos\nTOKEN=PASTE-YOUR-DUCKDNS-TOKEN\n' > ~/.duckdns && chmod 600 ~/.duckdns
chmod +x deploy/*.sh
crontab -e        # choose nano, then add these two lines at the bottom:
*/5 * * * * /home/ubuntu/pos-chicken/deploy/duckdns.sh
0 1 * * * /home/ubuntu/pos-chicken/deploy/backup-daily.sh >> /home/ubuntu/backup.log 2>&1
```
(`DOMAIN` is only the first part, without `.duckdns.org`.)

## Step 9. Backups to Google Drive — 10 minutes (do not skip)
On the server:
```
sudo apt-get install -y rclone
rclone config
```
Answer: `n` (new remote) → name `gdrive` → storage `drive` (type the number shown for "Google Drive") → leave client id/secret empty → scope `1` (full access) → leave the rest empty → **Use auto config? `n`**.
It then shows a command: `rclone authorize "drive" "..."`. Install rclone on your own Windows PC (rclone.org/downloads), run that command there, sign in to Google in the browser that opens, and paste the long code it prints back into the server. Finish with `y`, then `q`.
Test it: `~/pos-chicken/deploy/backup-daily.sh` — it should end with "Copied to Google Drive." and a folder `chicken-pos-backups` appears in your Drive.

## Step 10. Use it in the shop
- **Cashier:** open the address. Add it to the phone/computer home screen.
- **Customer screen:** `https://yourname.duckdns.org/customerscreen` on the customer-facing screen. It is opened from the cashier's New order screen, which feeds it.
- **Butcher TV:** open `https://yourname.duckdns.org/butcher`, sign in once with the Butcher TV account (Users screen → New user → Butcher TV). It stays signed in for a year.

## Step 11. Installing future updates
When a new revision is ready I push it to GitHub. On the server:
```
cd ~/pos-chicken && ./deploy/update.sh
```
It makes a backup, downloads the new version, restarts the POS, and the POS upgrades its own database with a safety copy.

## If something does not work
- **Site does not open:** `systemctl status chicken-pos` and `sudo systemctl status caddy`. Check steps 4 and 6b (both doors), and that DuckDNS shows the server's IP.
- **Padlock error right after step 8:** wait 2 minutes; Caddy is getting the certificate.
- **"Too many tries" at sign-in:** wait 15 minutes. (`TRUST_PROXY=1` makes sure only the person typing wrong passwords is blocked.)
- **See what the POS says:** `journalctl -u chicken-pos -n 50`.
- **Restore a backup:** `sudo systemctl stop chicken-pos`, copy a `backups/pos-....db` over `/home/ubuntu/pos-data/pos.db`, `sudo systemctl start chicken-pos`.
