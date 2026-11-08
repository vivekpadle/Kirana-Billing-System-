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

### Backup

All data is in one file: `data/pise-kirana.db`. Copy it (e.g. to a pen drive or Google Drive) daily.

### Putting it online

To use it from anywhere (not just shop Wi-Fi), deploy to any Node.js host (a VPS, Render, Railway, etc.)
with a persistent disk for `DATA_DIR`, and serve it over **HTTPS**.

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
test/              API tests
```
