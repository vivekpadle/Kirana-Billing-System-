'use strict';
// Database layer for Pise Kirana — uses Node's built-in SQLite (node:sqlite, Node >= 22.5)
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'pise-kirana.db');

function open(file = DB_FILE) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','owner','employee')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      barcode TEXT,
      category TEXT NOT NULL DEFAULT 'General',
      unit TEXT NOT NULL DEFAULT 'pcs',
      price REAL NOT NULL DEFAULT 0,      -- selling price (GST inclusive)
      mrp REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,       -- purchase price
      gst_rate REAL NOT NULL DEFAULT 0,
      stock REAL NOT NULL DEFAULT 0,
      low_stock REAL NOT NULL DEFAULT 5,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL AND barcode <> '';

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE,
      address TEXT,
      balance REAL NOT NULL DEFAULT 0,    -- amount due (udhaar)
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_no TEXT UNIQUE,
      customer_id INTEGER REFERENCES customers(id),
      customer_name TEXT,
      customer_phone TEXT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      subtotal REAL NOT NULL,
      discount REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      paid REAL NOT NULL DEFAULT 0,
      due REAL NOT NULL DEFAULT 0,
      change_returned REAL NOT NULL DEFAULT 0,
      payment_mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','partial','credit','cancelled')),
      notes TEXT,
      cancelled_by INTEGER REFERENCES users(id),
      cancelled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_bills_created ON bills(created_at);

    CREATE TABLE IF NOT EXISTS bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      name TEXT NOT NULL,
      unit TEXT,
      qty REAL NOT NULL,
      price REAL NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      gst_rate REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id);

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER REFERENCES bills(id),
      customer_id INTEGER REFERENCES customers(id),
      amount REAL NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('cash','upi','card')),
      kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','due_collection','refund')),
      user_id INTEGER NOT NULL REFERENCES users(id),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);

    CREATE TABLE IF NOT EXISTS stock_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      change REAL NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('sale','purchase','adjust','cancel','opening')),
      ref TEXT,
      note TEXT,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_stock_moves_product ON stock_moves(product_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

const DEFAULT_SETTINGS = {
  shop_name: 'Pise Kirana',
  shop_tagline: 'Your trusted neighbourhood store',
  shop_address: '',
  shop_phone: '',
  gstin: '',
  upi_id: '',
  bill_footer: 'Thank you! Visit again.',
  allow_negative_stock: '0',
};

const SAMPLE_PRODUCTS = [
  ['Tata Salt 1kg', '8901058000017', 'Grocery', 'pcs', 28, 28, 24, 0, 60, 10],
  ['Aashirvaad Atta 5kg', '8901725181109', 'Grocery', 'pcs', 265, 280, 240, 0, 25, 5],
  ['Basmati Rice (loose)', '', 'Grocery', 'kg', 110, 120, 90, 0, 50, 10],
  ['Toor Dal', '', 'Grocery', 'kg', 160, 170, 135, 0, 40, 8],
  ['Sugar', '', 'Grocery', 'kg', 46, 48, 40, 0, 80, 15],
  ['Fortune Sunflower Oil 1L', '8906007280017', 'Oil & Ghee', 'pcs', 145, 160, 128, 5, 30, 6],
  ['Amul Ghee 500ml', '8901262010016', 'Oil & Ghee', 'pcs', 315, 330, 290, 12, 15, 4],
  ['Amul Taaza Milk 500ml', '8901262150019', 'Dairy', 'pcs', 27, 27, 24, 0, 40, 10],
  ['Amul Butter 100g', '8901262011013', 'Dairy', 'pcs', 58, 60, 52, 12, 20, 5],
  ['Parle-G 250g', '8901719110016', 'Snacks', 'pcs', 25, 25, 21, 18, 50, 10],
  ['Maggi Noodles 70g', '8901058851298', 'Snacks', 'pcs', 14, 14, 12, 12, 100, 20],
  ['Lays Classic 52g', '8901491101837', 'Snacks', 'pcs', 20, 20, 16, 12, 45, 10],
  ['Red Label Tea 250g', '8901030627751', 'Beverages', 'pcs', 140, 150, 122, 5, 20, 5],
  ['Bru Coffee 50g', '8901030683917', 'Beverages', 'pcs', 105, 110, 92, 18, 12, 4],
  ['Surf Excel 1kg', '8901030704025', 'Household', 'pcs', 135, 140, 118, 18, 18, 5],
  ['Vim Bar 200g', '8901030750138', 'Household', 'pcs', 20, 20, 17, 18, 40, 10],
  ['Colgate 200g', '8901314010384', 'Personal Care', 'pcs', 110, 118, 96, 18, 22, 5],
  ['Lux Soap 100g', '8901030700539', 'Personal Care', 'pcs', 38, 40, 32, 18, 3, 8],
];

function seed(db) {
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const ins = db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)');
    ins.run('Administrator', process.env.ADMIN_USER || 'admin', hashPassword(process.env.ADMIN_PASS || 'admin123'), 'admin');
    ins.run('Pise (Owner)', 'owner', hashPassword('owner123'), 'owner');
    ins.run('Counter Staff', 'employee', hashPassword('emp123'), 'employee');
  }

  const productCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (productCount === 0 && process.env.SEED_SAMPLE !== '0') {
    const ins = db.prepare(`INSERT INTO products (name, barcode, category, unit, price, mrp, cost, gst_rate, stock, low_stock)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const mv = db.prepare(`INSERT INTO stock_moves (product_id, change, reason, note) VALUES (?, ?, 'opening', 'Opening stock')`);
    for (const p of SAMPLE_PRODUCTS) {
      const r = ins.run(p[0], p[1] || null, ...p.slice(2));
      mv.run(r.lastInsertRowid, p[8]);
    }
  }
}

/** Run fn inside a transaction (node:sqlite has no helper). */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { open, tx, DB_FILE };
