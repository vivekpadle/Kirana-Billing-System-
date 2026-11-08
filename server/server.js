'use strict';
// Pise Kirana — Billing & Inventory server (zero external dependencies)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const DB = require('./db');
const auth = require('./auth');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
const PAY_MODES = ['cash', 'upi', 'card'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- router
function createApp(db) {
  const routes = [];
  const route = (method, pattern, perm, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, perm, handler });
  };
  const getSettings = () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));

  // simple login throttle: 10 failures per 15 min per IP+username
  const failures = new Map();
  const throttleKey = (req, u) => `${req.socket.remoteAddress}|${String(u).toLowerCase()}`;

  // ---------------- auth
  route('POST', '/api/login', null, async ({ req, body, res }) => {
    const username = str(body.username, 60); const password = String(body.password || '');
    const key = throttleKey(req, username);
    const f = failures.get(key);
    if (f && f.count >= 10 && Date.now() - f.first < 15 * 60 * 1000) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      const cur = f && Date.now() - f.first < 15 * 60 * 1000 ? f : { count: 0, first: Date.now() };
      cur.count++; failures.set(key, cur);
      throw new HttpError(401, 'Invalid username or password');
    }
    if (!user.active) throw new HttpError(403, 'This account is disabled. Contact the owner.');
    if (body.role && body.role !== user.role) throw new HttpError(403, `This account is not a ${body.role} account`);
    failures.delete(key);
    const token = auth.createSession(db, user.id);
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
    res.setHeader('Set-Cookie', `pk_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${auth.SESSION_TTL_MS / 1000}${secure}`);
    return { user: { id: user.id, name: user.name, username: user.username, role: user.role } };
  });

  route('POST', '/api/logout', null, ({ token, res }) => {
    auth.destroySession(db, token);
    res.setHeader('Set-Cookie', 'pk_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });

  route('GET', '/api/me', 'auth', ({ user }) => ({
    user, permissions: auth.PERMISSIONS[user.role], settings: getSettings(),
  }));

  route('POST', '/api/me/password', 'auth', ({ user, body }) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!auth.verifyPassword(String(body.current || ''), row.password_hash)) throw new HttpError(400, 'Current password is wrong');
    if (String(body.password || '').length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(body.password), user.id);
    return { ok: true };
  });

  // ---------------- settings
  route('GET', '/api/settings', 'auth', () => getSettings());
  // shop branding for the login screen (no login required)
  route('GET', '/api/public', null, () => { const s = getSettings(); return { shop_name: s.shop_name, shop_tagline: s.shop_tagline }; });
  route('PUT', '/api/settings', 'settings.edit', ({ body }) => {
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const allowed = ['shop_name', 'shop_tagline', 'shop_address', 'shop_phone', 'gstin', 'upi_id', 'bill_footer', 'allow_negative_stock'];
    for (const k of allowed) if (k in body) up.run(k, str(body[k], 500));
    return getSettings();
  });

  // ---------------- users
  route('GET', '/api/users', 'users.manage', () =>
    db.prepare('SELECT id, name, username, phone, role, active, created_at FROM users ORDER BY role, name').all());

  const assertCanManageRole = (actor, role) => {
    if (!['admin', 'owner', 'employee'].includes(role)) throw new HttpError(400, 'Invalid role');
    if (actor.role !== 'admin' && role === 'admin') throw new HttpError(403, 'Only an admin can manage admin accounts');
  };

  route('POST', '/api/users', 'users.manage', ({ user, body }) => {
    const role = str(body.role, 20); assertCanManageRole(user, role);
    const name = str(body.name, 80); const username = str(body.username, 40);
    if (!name || !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'Name and a valid username (3+ letters/numbers) are required');
    if (String(body.password || '').length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Username already exists');
    const r = db.prepare('INSERT INTO users (name, username, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)')
      .run(name, username, str(body.phone, 20), auth.hashPassword(body.password), role);
    return { id: Number(r.lastInsertRowid) };
  });

  route('PUT', '/api/users/:id', 'users.manage', ({ user, params, body }) => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
    if (!target) throw new HttpError(404, 'User not found');
    assertCanManageRole(user, target.role);
    const role = body.role ? str(body.role, 20) : target.role; assertCanManageRole(user, role);
    const active = body.active == null ? target.active : (body.active ? 1 : 0);
    if (target.id === user.id && (!active || role !== target.role)) throw new HttpError(400, 'You cannot disable or change the role of your own account');
    if (target.role === 'admin' && (role !== 'admin' || !active)) {
      const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c;
      if (admins <= 1) throw new HttpError(400, 'At least one active admin is required');
    }
    db.prepare('UPDATE users SET name = ?, phone = ?, role = ?, active = ? WHERE id = ?')
      .run(str(body.name, 80) || target.name, body.phone != null ? str(body.phone, 20) : target.phone, role, active, target.id);
    if (body.password) {
      if (String(body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(body.password), target.id);
    }
    if (!active || body.password) db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id <> ?').run(target.id, user.id);
    return { ok: true };
  });

  // ---------------- products / inventory
  route('GET', '/api/products', 'products.view', ({ query }) => {
    const q = str(query.get('q'), 100); const cat = str(query.get('category'), 60);
    const where = ['p.active = 1']; const args = [];
    if (query.get('all') === '1') where.length = 0;
    if (q) { where.push('(p.name LIKE ? OR p.barcode = ? OR p.category LIKE ?)'); args.push(`%${q}%`, q, `%${q}%`); }
    if (cat) { where.push('p.category = ?'); args.push(cat); }
    if (query.get('low') === '1') where.push('p.stock <= p.low_stock');
    return db.prepare(`SELECT * FROM products p ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name LIMIT 1000`).all(...args);
  });

  route('GET', '/api/products/categories', 'products.view', () =>
    db.prepare('SELECT category, COUNT(*) AS count FROM products WHERE active = 1 GROUP BY category ORDER BY category').all());

  const productFields = (body, existing = {}) => {
    const p = {
      name: str(body.name ?? existing.name, 120),
      barcode: str(body.barcode ?? existing.barcode, 60) || null,
      category: str(body.category ?? existing.category, 60) || 'General',
      unit: str(body.unit ?? existing.unit, 20) || 'pcs',
      price: r2(num(body.price ?? existing.price)),
      mrp: r2(num(body.mrp ?? existing.mrp)),
      cost: r2(num(body.cost ?? existing.cost)),
      gst_rate: num(body.gst_rate ?? existing.gst_rate),
      low_stock: num(body.low_stock ?? existing.low_stock, 5),
      active: body.active == null ? (existing.active ?? 1) : (body.active ? 1 : 0),
    };
    if (!p.name) throw new HttpError(400, 'Product name is required');
    if (p.price < 0 || p.cost < 0 || p.mrp < 0) throw new HttpError(400, 'Prices cannot be negative');
    if (p.gst_rate < 0 || p.gst_rate > 28) throw new HttpError(400, 'GST rate must be between 0 and 28');
    return p;
  };
  const barcodeTaken = (code, id = 0) => code && db.prepare('SELECT 1 FROM products WHERE barcode = ? AND id <> ?').get(code, id);

  route('POST', '/api/products', 'products.edit', ({ user, body }) => {
    const p = productFields(body);
    if (barcodeTaken(p.barcode)) throw new HttpError(409, 'Another product already uses this barcode');
    const stock = num(body.stock);
    return DB.tx(db, () => {
      const r = db.prepare(`INSERT INTO products (name, barcode, category, unit, price, mrp, cost, gst_rate, low_stock, active, stock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.name, p.barcode, p.category, p.unit, p.price, p.mrp, p.cost, p.gst_rate, p.low_stock, p.active, stock);
      if (stock) db.prepare(`INSERT INTO stock_moves (product_id, change, reason, note, user_id) VALUES (?, ?, 'opening', 'Opening stock', ?)`).run(r.lastInsertRowid, stock, user.id);
      return { id: Number(r.lastInsertRowid) };
    });
  });

  route('PUT', '/api/products/:id', 'products.edit', ({ params, body }) => {
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(params.id);
    if (!existing) throw new HttpError(404, 'Product not found');
    const p = productFields(body, existing);
    if (barcodeTaken(p.barcode, existing.id)) throw new HttpError(409, 'Another product already uses this barcode');
    db.prepare(`UPDATE products SET name=?, barcode=?, category=?, unit=?, price=?, mrp=?, cost=?, gst_rate=?, low_stock=?, active=?,
      updated_at=datetime('now','localtime') WHERE id=?`).run(p.name, p.barcode, p.category, p.unit, p.price, p.mrp, p.cost, p.gst_rate, p.low_stock, p.active, existing.id);
    return { ok: true };
  });

  route('DELETE', '/api/products/:id', 'products.edit', ({ params }) => {
    // soft delete to keep bill history intact
    db.prepare("UPDATE products SET active = 0, updated_at=datetime('now','localtime') WHERE id = ?").run(params.id);
    return { ok: true };
  });

  route('POST', '/api/products/:id/stock', 'stock.edit', ({ user, params, body }) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(params.id);
    if (!p) throw new HttpError(404, 'Product not found');
    const type = body.type === 'adjust' ? 'adjust' : 'purchase';
    let change = num(body.qty);
    if (type === 'purchase' && change <= 0) throw new HttpError(400, 'Purchase quantity must be greater than 0');
    if (type === 'adjust' && body.set_to != null) change = num(body.set_to) - p.stock;
    if (!change) throw new HttpError(400, 'No stock change');
    return DB.tx(db, () => {
      db.prepare("UPDATE products SET stock = stock + ?, updated_at=datetime('now','localtime') WHERE id = ?").run(change, p.id);
      if (type === 'purchase' && body.cost != null && num(body.cost) > 0) db.prepare('UPDATE products SET cost = ? WHERE id = ?').run(r2(num(body.cost)), p.id);
      db.prepare('INSERT INTO stock_moves (product_id, change, reason, note, user_id) VALUES (?, ?, ?, ?, ?)')
        .run(p.id, change, type, str(body.note, 200), user.id);
      return db.prepare('SELECT * FROM products WHERE id = ?').get(p.id);
    });
  });

  route('GET', '/api/products/:id/moves', 'products.view', ({ params }) =>
    db.prepare(`SELECT m.*, u.name AS user_name FROM stock_moves m LEFT JOIN users u ON u.id = m.user_id
                WHERE m.product_id = ? ORDER BY m.id DESC LIMIT 200`).all(params.id));

  // ---------------- customers
  route('GET', '/api/customers', 'customers.view', ({ query }) => {
    const q = str(query.get('q'), 60);
    const dueOnly = query.get('due') === '1';
    const where = []; const args = [];
    if (q) { where.push('(name LIKE ? OR phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    if (dueOnly) where.push('balance > 0.009');
    return db.prepare(`SELECT * FROM customers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY balance DESC, name LIMIT 500`).all(...args);
  });

  const upsertCustomer = (name, phone, address) => {
    phone = str(phone, 15).replace(/[^\d+]/g, ''); name = str(name, 80);
    if (!phone && !name) return null;
    if (phone) {
      const ex = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
      if (ex) {
        if (name && name !== ex.name) db.prepare('UPDATE customers SET name = ? WHERE id = ?').run(name, ex.id);
        return ex.id;
      }
    }
    if (!name) name = phone;
    return Number(db.prepare('INSERT INTO customers (name, phone, address) VALUES (?, ?, ?)').run(name, phone || null, str(address, 200)).lastInsertRowid);
  };

  route('POST', '/api/customers', 'customers.edit', ({ body }) => {
    if (!str(body.name)) throw new HttpError(400, 'Customer name is required');
    const phone = str(body.phone, 15).replace(/[^\d+]/g, '');
    if (phone && db.prepare('SELECT 1 FROM customers WHERE phone = ?').get(phone)) throw new HttpError(409, 'A customer with this phone already exists');
    return { id: upsertCustomer(body.name, phone, body.address) };
  });

  route('PUT', '/api/customers/:id', 'customers.edit', ({ params, body }) => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(params.id);
    if (!c) throw new HttpError(404, 'Customer not found');
    const phone = body.phone != null ? str(body.phone, 15).replace(/[^\d+]/g, '') || null : c.phone;
    if (phone && db.prepare('SELECT 1 FROM customers WHERE phone = ? AND id <> ?').get(phone, c.id)) throw new HttpError(409, 'Phone already used by another customer');
    db.prepare('UPDATE customers SET name = ?, phone = ?, address = ? WHERE id = ?')
      .run(str(body.name, 80) || c.name, phone, body.address != null ? str(body.address, 200) : c.address, c.id);
    return { ok: true };
  });

  route('GET', '/api/customers/:id', 'customers.view', ({ params }) => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(params.id);
    if (!c) throw new HttpError(404, 'Customer not found');
    c.bills = db.prepare('SELECT id, bill_no, total, paid, due, status, created_at FROM bills WHERE customer_id = ? ORDER BY id DESC LIMIT 100').all(c.id);
    c.payments = db.prepare(`SELECT p.*, u.name AS user_name FROM payments p LEFT JOIN users u ON u.id = p.user_id
                             WHERE p.customer_id = ? ORDER BY p.id DESC LIMIT 100`).all(c.id);
    return c;
  });

  // collect udhaar / due payment
  route('POST', '/api/customers/:id/payments', 'payments.collect', ({ user, params, body }) => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(params.id);
    if (!c) throw new HttpError(404, 'Customer not found');
    const amount = r2(num(body.amount)); const mode = PAY_MODES.includes(body.mode) ? body.mode : null;
    if (!mode) throw new HttpError(400, 'Choose payment mode: cash, UPI or card');
    if (amount <= 0) throw new HttpError(400, 'Amount must be greater than 0');
    if (amount > r2(c.balance) + 0.001) throw new HttpError(400, `Amount is more than the due balance (₹${r2(c.balance)})`);
    return DB.tx(db, () => {
      db.prepare("INSERT INTO payments (customer_id, amount, mode, kind, user_id, note) VALUES (?, ?, ?, 'due_collection', ?, ?)")
        .run(c.id, amount, mode, user.id, str(body.note, 200));
      db.prepare('UPDATE customers SET balance = round(balance - ?, 2) WHERE id = ?').run(amount, c.id);
      // settle oldest open bills first
      let left = amount;
      const open = db.prepare("SELECT id, due, paid FROM bills WHERE customer_id = ? AND due > 0.009 AND status <> 'cancelled' ORDER BY id").all(c.id);
      for (const b of open) {
        if (left <= 0) break;
        const pay = Math.min(left, b.due); left = r2(left - pay);
        const due = r2(b.due - pay);
        db.prepare('UPDATE bills SET due = ?, paid = round(paid + ?, 2), status = ? WHERE id = ?').run(due, pay, due > 0.009 ? 'partial' : 'paid', b.id);
      }
      return db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id);
    });
  });

  // ---------------- bills (POS)
  route('POST', '/api/bills', 'pos', ({ user, body }) => {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw new HttpError(400, 'Cart is empty');
    if (items.length > 300) throw new HttpError(400, 'Too many items in one bill');
    const settings = getSettings();
    const allowNegative = settings.allow_negative_stock === '1';

    return DB.tx(db, () => {
      const getP = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
      const lines = []; let subtotal = 0; let tax = 0;
      const merged = new Map();
      for (const it of items) {
        const id = Number(it.product_id); const qty = num(it.qty);
        if (!(qty > 0)) throw new HttpError(400, 'Quantity must be greater than 0');
        merged.set(id, { qty: (merged.get(id)?.qty || 0) + qty, price: it.price });
      }
      for (const [id, it] of merged) {
        const p = getP.get(id);
        if (!p) throw new HttpError(400, 'A product in the cart no longer exists');
        if (!allowNegative && p.stock < it.qty - 1e-9) throw new HttpError(400, `Not enough stock for ${p.name} (available ${p.stock} ${p.unit})`);
        // owners/admins may override selling price at the counter; employees always use list price
        let price = p.price;
        if (it.price != null && user.role !== 'employee') price = r2(Math.max(0, num(it.price, p.price)));
        const amount = r2(price * it.qty);
        subtotal += amount;
        tax += p.gst_rate ? amount * p.gst_rate / (100 + p.gst_rate) : 0;
        lines.push({ p, qty: it.qty, price, amount });
      }
      subtotal = r2(subtotal);
      let discount = r2(Math.max(0, num(body.discount)));
      if (discount > subtotal) throw new HttpError(400, 'Discount cannot exceed subtotal');
      const total = r2(subtotal - discount);
      tax = subtotal ? r2(tax * (total / subtotal)) : 0;

      // payments: [{mode, amount}]
      const pays = (Array.isArray(body.payments) ? body.payments : [])
        .map((p) => ({ mode: p.mode, amount: r2(num(p.amount)) }))
        .filter((p) => p.amount > 0);
      for (const p of pays) if (!PAY_MODES.includes(p.mode)) throw new HttpError(400, 'Invalid payment mode');
      const tendered = r2(pays.reduce((s, p) => s + p.amount, 0));
      // change can only be returned from cash
      const cashTendered = r2(pays.filter((p) => p.mode === 'cash').reduce((s, p) => s + p.amount, 0));
      const nonCash = r2(tendered - cashTendered);
      if (nonCash > total + 0.001) throw new HttpError(400, 'UPI/Card amount is more than the bill total');
      const change = r2(Math.max(0, tendered - total));
      const paid = r2(tendered - change);
      const due = r2(total - paid);

      let customerId = null;
      if (body.customer_id) {
        const c = db.prepare('SELECT id, name, phone FROM customers WHERE id = ?').get(body.customer_id);
        if (!c) throw new HttpError(400, 'Customer not found');
        customerId = c.id; body.customer_name = body.customer_name || c.name; body.customer_phone = body.customer_phone || c.phone;
      } else {
        customerId = upsertCustomer(body.customer_name, body.customer_phone);
      }
      if (due > 0.009 && !customerId) throw new HttpError(400, 'Customer name & phone are required for credit (udhaar) bills');
      if (due > 0.009 && !str(body.customer_phone) && !db.prepare('SELECT phone FROM customers WHERE id = ?').get(customerId).phone)
        throw new HttpError(400, 'Customer phone is required for credit (udhaar) bills');

      const modes = [...new Set(pays.map((p) => p.mode))];
      if (due > 0.009) modes.push('credit');
      const paymentMode = modes.length ? modes.join('+') : 'credit';
      const status = due <= 0.009 ? 'paid' : paid > 0 ? 'partial' : 'credit';

      const r = db.prepare(`INSERT INTO bills (customer_id, customer_name, customer_phone, user_id, subtotal, discount, tax, total, paid, due,
          change_returned, payment_mode, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(customerId, str(body.customer_name, 80) || null, str(body.customer_phone, 15) || null, user.id, subtotal, discount, tax, total,
          paid, due, change, paymentMode, status, str(body.notes, 300) || null);
      const billId = Number(r.lastInsertRowid);
      const billNo = `PK-${String(billId).padStart(6, '0')}`;
      db.prepare('UPDATE bills SET bill_no = ? WHERE id = ?').run(billNo, billId);

      const insItem = db.prepare('INSERT INTO bill_items (bill_id, product_id, name, unit, qty, price, cost, gst_rate, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const decStock = db.prepare("UPDATE products SET stock = stock - ?, updated_at=datetime('now','localtime') WHERE id = ?");
      const move = db.prepare("INSERT INTO stock_moves (product_id, change, reason, ref, user_id) VALUES (?, ?, 'sale', ?, ?)");
      for (const l of lines) {
        insItem.run(billId, l.p.id, l.p.name, l.p.unit, l.qty, l.price, l.p.cost, l.p.gst_rate, l.amount);
        decStock.run(l.qty, l.p.id);
        move.run(l.p.id, -l.qty, billNo, user.id);
      }
      // record payments (net of change, which always comes out of cash)
      const insPay = db.prepare("INSERT INTO payments (bill_id, customer_id, amount, mode, kind, user_id) VALUES (?, ?, ?, ?, 'sale', ?)");
      let changeLeft = change;
      for (const p of pays) {
        let amt = p.amount;
        if (p.mode === 'cash' && changeLeft > 0) { const d = Math.min(amt, changeLeft); amt = r2(amt - d); changeLeft = r2(changeLeft - d); }
        if (amt > 0) insPay.run(billId, customerId, amt, p.mode, user.id);
      }
      if (due > 0.009) db.prepare('UPDATE customers SET balance = round(balance + ?, 2) WHERE id = ?').run(due, customerId);
      return getBill(billId);
    });
  });

  function getBill(id) {
    const b = db.prepare(`SELECT b.*, u.name AS cashier, cu.name AS cancelled_by_name FROM bills b
      JOIN users u ON u.id = b.user_id LEFT JOIN users cu ON cu.id = b.cancelled_by WHERE b.id = ?`).get(id);
    if (!b) return null;
    b.items = db.prepare('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id').all(id);
    b.payments = db.prepare('SELECT mode, amount, kind, created_at FROM payments WHERE bill_id = ? ORDER BY id').all(id);
    return b;
  }

  route('GET', '/api/bills', 'pos', ({ user, query }) => {
    const where = []; const args = [];
    const from = str(query.get('from'), 10); const to = str(query.get('to'), 10); const q = str(query.get('q'), 60);
    if (from) { where.push('date(b.created_at) >= ?'); args.push(from); }
    if (to) { where.push('date(b.created_at) <= ?'); args.push(to); }
    if (q) { where.push('(b.bill_no LIKE ? OR b.customer_name LIKE ? OR b.customer_phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (query.get('status')) { where.push('b.status = ?'); args.push(str(query.get('status'), 20)); }
    // employees only see the bills they created
    if (!auth.can(user, 'bills.view_all')) { where.push('b.user_id = ?'); args.push(user.id); }
    else if (query.get('user_id')) { where.push('b.user_id = ?'); args.push(Number(query.get('user_id'))); }
    return db.prepare(`SELECT b.id, b.bill_no, b.customer_name, b.customer_phone, b.total, b.paid, b.due, b.payment_mode, b.status,
        b.created_at, u.name AS cashier, (SELECT COUNT(*) FROM bill_items i WHERE i.bill_id = b.id) AS item_count
      FROM bills b JOIN users u ON u.id = b.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY b.id DESC LIMIT 500`).all(...args);
  });

  route('GET', '/api/bills/:id', 'pos', ({ user, params }) => {
    const b = getBill(Number(params.id));
    if (!b) throw new HttpError(404, 'Bill not found');
    if (!auth.can(user, 'bills.view_all') && b.user_id !== user.id) throw new HttpError(403, 'Not allowed');
    return b;
  });

  route('POST', '/api/bills/:id/cancel', 'bills.cancel', ({ user, params, body }) => {
    const b = getBill(Number(params.id));
    if (!b) throw new HttpError(404, 'Bill not found');
    if (b.status === 'cancelled') throw new HttpError(400, 'Bill is already cancelled');
    return DB.tx(db, () => {
      const inc = db.prepare("UPDATE products SET stock = stock + ?, updated_at=datetime('now','localtime') WHERE id = ?");
      const move = db.prepare("INSERT INTO stock_moves (product_id, change, reason, ref, note, user_id) VALUES (?, ?, 'cancel', ?, ?, ?)");
      for (const it of b.items) if (it.product_id) { inc.run(it.qty, it.product_id); move.run(it.product_id, it.qty, b.bill_no, 'Bill cancelled', user.id); }
      if (b.due > 0 && b.customer_id) db.prepare('UPDATE customers SET balance = round(balance - ?, 2) WHERE id = ?').run(b.due, b.customer_id);
      // refund what was collected on this bill (recorded as negative cash so reports net out)
      if (b.paid > 0) db.prepare("INSERT INTO payments (bill_id, customer_id, amount, mode, kind, user_id, note) VALUES (?, ?, ?, 'cash', 'refund', ?, ?)")
        .run(b.id, b.customer_id, -b.paid, user.id, 'Refund on cancel');
      db.prepare("UPDATE bills SET status = 'cancelled', due = 0, cancelled_by = ?, cancelled_at = datetime('now','localtime'), notes = trim(coalesce(notes,'') || ' ' || ?) WHERE id = ?")
        .run(user.id, str(body.reason, 200) ? `[Cancelled: ${str(body.reason, 200)}]` : '[Cancelled]', b.id);
      return getBill(b.id);
    });
  });

  // ---------------- dashboard & reports
  route('GET', '/api/dashboard', 'pos', ({ user }) => {
    const mine = !auth.can(user, 'reports.view');
    const uf = mine ? ' AND user_id = ' + Number(user.id) : '';
    const today = db.prepare(`SELECT COUNT(*) AS bills, COALESCE(SUM(total),0) AS sales, COALESCE(SUM(due),0) AS credit
      FROM bills WHERE status <> 'cancelled' AND date(created_at) = date('now','localtime')${uf}`).get();
    const pay = db.prepare(`SELECT mode, ROUND(SUM(amount),2) AS amount FROM payments
      WHERE date(created_at) = date('now','localtime')${uf} GROUP BY mode`).all();
    const out = { today, payments_today: pay, mine };
    if (!mine) {
      out.profit_today = db.prepare(`SELECT COALESCE(SUM(i.amount - i.cost * i.qty),0) - COALESCE((SELECT SUM(discount) FROM bills
          WHERE status <> 'cancelled' AND date(created_at) = date('now','localtime')),0) AS profit
        FROM bill_items i JOIN bills b ON b.id = i.bill_id WHERE b.status <> 'cancelled' AND date(b.created_at) = date('now','localtime')`).get().profit;
      out.low_stock = db.prepare('SELECT id, name, stock, unit, low_stock FROM products WHERE active = 1 AND stock <= low_stock ORDER BY stock LIMIT 20').all();
      out.total_due = db.prepare('SELECT COALESCE(SUM(balance),0) AS v FROM customers').get().v;
      out.stock_value = db.prepare('SELECT COALESCE(SUM(stock * cost),0) AS v FROM products WHERE active = 1 AND stock > 0').get().v;
      out.last7 = db.prepare(`SELECT date(created_at) AS day, ROUND(SUM(total),2) AS sales, COUNT(*) AS bills FROM bills
        WHERE status <> 'cancelled' AND date(created_at) >= date('now','localtime','-6 days') GROUP BY day ORDER BY day`).all();
    }
    out.recent = db.prepare(`SELECT b.id, b.bill_no, b.customer_name, b.total, b.status, b.payment_mode, b.created_at, u.name AS cashier
      FROM bills b JOIN users u ON u.id = b.user_id WHERE 1=1${uf.replace('user_id', 'b.user_id')} ORDER BY b.id DESC LIMIT 8`).all();
    return out;
  });

  route('GET', '/api/reports', 'reports.view', ({ query }) => {
    const from = str(query.get('from'), 10) || new Date().toISOString().slice(0, 10);
    const to = str(query.get('to'), 10) || from;
    const range = "date(b.created_at) BETWEEN ? AND ? AND b.status <> 'cancelled'";
    const summary = db.prepare(`SELECT COUNT(*) AS bills, COALESCE(SUM(subtotal),0) AS gross, COALESCE(SUM(discount),0) AS discount,
        COALESCE(SUM(total),0) AS sales, COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(due),0) AS credit FROM bills b WHERE ${range}`).get(from, to);
    summary.cost = db.prepare(`SELECT COALESCE(SUM(i.cost * i.qty),0) AS v FROM bill_items i JOIN bills b ON b.id = i.bill_id WHERE ${range}`).get(from, to).v;
    summary.profit = r2(summary.sales - summary.cost);
    summary.avg_bill = summary.bills ? r2(summary.sales / summary.bills) : 0;
    const payments = db.prepare(`SELECT mode, kind, ROUND(SUM(amount),2) AS amount, COUNT(*) AS count FROM payments
      WHERE date(created_at) BETWEEN ? AND ? GROUP BY mode, kind ORDER BY mode`).all(from, to);
    const daily = db.prepare(`SELECT date(b.created_at) AS day, COUNT(*) AS bills, ROUND(SUM(b.total),2) AS sales FROM bills b
      WHERE ${range} GROUP BY day ORDER BY day`).all(from, to);
    const top = db.prepare(`SELECT i.name, i.unit, ROUND(SUM(i.qty),3) AS qty, ROUND(SUM(i.amount),2) AS amount,
        ROUND(SUM(i.amount - i.cost * i.qty),2) AS margin
      FROM bill_items i JOIN bills b ON b.id = i.bill_id WHERE ${range} GROUP BY i.product_id, i.name ORDER BY amount DESC LIMIT 15`).all(from, to);
    const byStaff = db.prepare(`SELECT u.name, u.role, COUNT(*) AS bills, ROUND(SUM(b.total),2) AS sales FROM bills b
      JOIN users u ON u.id = b.user_id WHERE ${range} GROUP BY u.id ORDER BY sales DESC`).all(from, to);
    const byCategory = db.prepare(`SELECT COALESCE(p.category,'Other') AS category, ROUND(SUM(i.amount),2) AS amount FROM bill_items i
      JOIN bills b ON b.id = i.bill_id LEFT JOIN products p ON p.id = i.product_id WHERE ${range} GROUP BY category ORDER BY amount DESC`).all(from, to);
    return { from, to, summary, payments, daily, top, byStaff, byCategory };
  });

  // ---------------------------------------------------------------- handler
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');

    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      const pathname = url.pathname.replace(/\/+$/, '');
      let matched = null; let methodMismatch = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        if (r.method !== req.method) { methodMismatch = true; continue; }
        matched = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
        break;
      }
      if (!matched) throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? 'Method not allowed' : 'Not found');

      // CSRF defence: state-changing requests must be JSON (forces CORS preflight) from same origin
      if (req.method !== 'GET') {
        const ct = req.headers['content-type'] || '';
        if (!ct.includes('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
      }

      const token = parseCookies(req.headers.cookie).pk_session;
      const user = auth.getSessionUser(db, token);
      const { perm } = matched.r;
      if (perm) {
        if (!user) throw new HttpError(401, 'Please log in');
        if (perm !== 'auth' && !auth.can(user, perm)) throw new HttpError(403, 'You do not have permission for this action');
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await matched.r.handler({ req, res, user, token, body, params: matched.params, query: url.searchParams });
      send(200, result);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      if (String(e.message).includes('UNIQUE constraint')) return send(409, { error: 'Duplicate value' });
      console.error(e);
      send(500, { error: 'Server error' });
    }
  };
}

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  });
}

if (require.main === module) {
  const db = DB.open();
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  http.createServer(createApp(db)).listen(PORT, HOST, () => {
    console.log(`\n  Pise Kirana is running`);
    console.log(`  → On this computer:       http://localhost:${PORT}`);
    for (const addrs of Object.values(require('node:os').networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  → On phones (same Wi-Fi): http://${a.address}:${PORT}`);
    }
    console.log(`  Database: ${DB.DB_FILE}\n`);
  });
}

module.exports = { createApp };
