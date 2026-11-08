# Pise Kirana — Billing & Inventory System

A complete billing (POS) and inventory management web app for **Pise Kirana**.
Works on **mobile phones, tablets, laptops and desktop PCs** from the same app — just open it in a browser.
It can also be installed on a phone's home screen like an app.

## Features

| | Admin | Owner | Employee |
|---|:-:|:-:|:-:|
| Create bills (POS), scan barcodes, take payments (Cash / UPI / Card / Udhaar / split) | ✅ | ✅ | ✅ |
| Print receipt (80 mm thermal or normal printer), share bill on WhatsApp | ✅ | ✅ | ✅ |
| Collect pending udhaar from customers | ✅ | ✅ | ✅ |
| View stock & customers | ✅ | ✅ | ✅ |
| See bills | All | All | Own bills only |
| Change selling price at the counter | ✅ | ✅ | ❌ |
| Add / edit items, stock-in (purchases), stock corrections, stock history | ✅ | ✅ | ❌ |
| Cancel bills (stock & udhaar automatically restored) | ✅ | ✅ | ❌ |
| Dashboard profit, reports (sales, profit, payment modes, top items, category, staff), CSV export | ✅ | ✅ | ❌ |
| Manage employees & owners | ✅ | ✅ | ❌ |
| Manage admin accounts | ✅ | ❌ | ❌ |
| Shop settings (name, address, GSTIN, UPI ID, bill footer) | ✅ | ✅ | ❌ |

Other highlights
- **3 languages — English (default), हिंदी (Hindi), मराठी (Marathi).** Switch any time from the login screen,
  the sidebar, the *More* menu on phones, or Settings. Each phone/computer remembers its own choice, so the
  owner can use English while staff use Hindi or Marathi. Receipts, WhatsApp bills/reminders and error
  messages follow the chosen language. Translations live in `public/js/i18n.js` and are easy to edit.
- Loose items sold by weight (kg / g / litre) with quick-quantity buttons (¼ kg, ½ kg, 1 kg…)
- GST-inclusive pricing with GST shown on receipt, discounts in ₹ or %
- Low-stock alerts, stock value, profit margin per item
- Udhaar (credit) ledger per customer with WhatsApp payment reminders
- Light & dark mode, mobile bottom navigation, slide-up cart on phones
- Secure login: hashed passwords (scrypt), HttpOnly session cookies, login throttling, role checks on the server

## Run it

Requires **Node.js 22.5 or newer** (https://nodejs.org). There are **no packages to install**.

```bash
npm start
```

Then open **http://localhost:3000** on the shop computer.
To use it from phones, connect them to the **same Wi-Fi** and open the address printed in the terminal
(e.g. `http://192.168.1.5:3000`). In Chrome use *⋮ → Add to Home screen* to install it like an app.

### Default logins (change them right after first login: Settings → Change my password)

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `admin123` |
| Owner | `owner` | `owner123` |
| Employee | `employee` | `emp123` |

The first start also adds some sample kirana items so you can try billing. Remove or hide them in
**Inventory**, or start with an empty shop with `SEED_SAMPLE=0 npm start` on a fresh database.

### Options (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Folder for the database file `pise-kirana.db` |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin123` | First admin account (only used on a new database) |
| `SEED_SAMPLE` | `1` | Set to `0` to skip sample items on a new database |
| `DEMO_MODE` | off | Set to `1` for a public trial/demo (see below) |
| `DEMO_RESET_HOURS` | `6` | How often demo data resets |
| `TZ` | server's | Set to `Asia/Kolkata` on cloud hosts so dates/reports use Indian time |

### Backup

All data is in one file: `data/pise-kirana.db`. Copy it (e.g. to a pen drive or Google Drive) daily.

## Put a free demo online for customers to try

The app has a **demo mode** (`DEMO_MODE=1`) made for showing to customers:
- a "Demo version" banner, and one-tap demo logins for Admin / Owner / Employee on the login screen
- a week of realistic sample sales, customers and udhaar, so the dashboard and reports look real
- visitors can't change the demo passwords or disable the demo logins (so nobody locks others out)
- **all data resets automatically every 6 hours** (`DEMO_RESET_HOURS`), so every visitor sees a clean shop

### Option A — Render (free, easiest, no server knowledge needed)

1. Make sure this code is on the branch you want to deploy (e.g. merge it into `main`).
2. Sign up at **https://render.com** with your GitHub account.
3. Click **New → Blueprint**, choose this repository and branch, then **Apply**.
   Render reads `render.yaml` and sets everything up (Node 22, India time zone, demo mode).
4. After a few minutes you get a link like `https://pise-kirana-demo.onrender.com`. Share it with customers.

Notes on the free plan: the app goes to sleep after ~15 minutes without visitors and the first visit after
that takes ~30–60 seconds to wake up. Data is also wiped on every restart — fine for a demo.
For no sleeping, choose a paid plan (Starter) in Render.

### Option B — Docker (Railway, Fly.io, any VPS)

```bash
docker build -t pise-kirana .
docker run -d -p 3000:3000 -e DEMO_MODE=1 -v pise-data:/data pise-kirana
```

### Real use by a shop (not a demo)

Deploy the same way but **without** `DEMO_MODE`, keep a persistent disk for `/data` (`DATA_DIR`), use HTTPS,
and change the three default passwords right after the first login.
Give each shop its own copy (its own deployment and database).

## Tests

```bash
npm test
```

## Project structure

```
server/server.js   HTTP server + REST API (roles & permissions enforced here)
server/db.js       SQLite schema, defaults, sample data
server/auth.js     password hashing, sessions, role permissions
public/            the web app (HTML/CSS/JS, no build step)
public/js/i18n.js  English / Hindi / Marathi translations
test/              API tests
```
