'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const DB = require('../server/db');
const { createApp } = require('../server/server');

async function start(demo) {
  const db = DB.open(':memory:');
  if (demo) DB.seedDemo(db);
  const server = http.createServer(createApp(db, { demo }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, cookie = '', method) => {
    const res = await fetch(base + '/api' + path, { method: method || (body ? 'POST' : 'GET'),
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  return { db, server, base, call };
}

test('demo seed creates a week of consistent sales', async () => {
  const { db, server, call } = await start(true);
  try {
    const bills = db.prepare('SELECT COUNT(*) c FROM bills').get().c;
    assert.ok(bills > 20, `expected demo bills, got ${bills}`);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM products WHERE stock < 0').get().c, 0);
    // customer balances equal their bills' dues
    const mismatch = db.prepare(`SELECT COUNT(*) c FROM customers c WHERE abs(c.balance - (SELECT COALESCE(SUM(due),0) FROM bills b WHERE b.customer_id = c.id)) > 0.01`).get().c;
    assert.equal(mismatch, 0);
    // new bill numbers continue after demo bills
    const { cookie } = await call('/login', { username: 'employee', password: 'emp123' });
    const p = (await call('/products', null, cookie)).data[0];
    const r = await call('/bills', { items: [{ product_id: p.id, qty: 1 }], payments: [{ mode: 'cash', amount: p.price }] }, cookie);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.bill_no, `PK-${String(bills + 1).padStart(6, '0')}`);
    // public info flags demo
    assert.equal((await call('/public')).data.demo, true);
  } finally { server.close(); }
});

test('demo protects the shared logins', async () => {
  const { server, call } = await start(true);
  try {
    const { cookie } = await call('/login', { username: 'admin', password: 'admin123' });
    assert.equal((await call('/me/password', { current: 'admin123', password: 'hacked1' }, cookie)).status, 403);
    const users = (await call('/users', null, cookie)).data;
    const emp = users.find((u) => u.username === 'employee');
    assert.equal((await call(`/users/${emp.id}`, { active: false }, cookie, 'PUT')).status, 403);
    // visitors can still create and edit their own extra users
    const nu = await call('/users', { name: 'Trial', username: 'trial', password: 'secret1', role: 'employee' }, cookie);
    assert.equal((await call(`/users/${nu.data.id}`, { active: false }, cookie, 'PUT')).status, 200);
  } finally { server.close(); }
});

test('demo reset restores a clean shop', async () => {
  const { db, server } = await start(true);
  try {
    const before = db.prepare('SELECT COUNT(*) c FROM bills').get().c;
    db.prepare("UPDATE settings SET value = 'Changed' WHERE key = 'shop_name'").run();
    DB.resetDemo(db);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM bills').get().c, before);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'shop_name'").get().value, 'Pise Kirana');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 3);
  } finally { server.close(); }
});

test('normal mode hides demo and allows password change', async () => {
  const { server, call, base } = await start(false);
  try {
    assert.equal((await call('/public')).data.demo, false);
    assert.equal(await (await fetch(base + '/healthz')).text(), 'ok');
    const { cookie } = await call('/login', { username: 'owner', password: 'owner123' });
    assert.equal((await call('/me/password', { current: 'owner123', password: 'newpass1' }, cookie)).status, 200);
  } finally { server.close(); }
});
