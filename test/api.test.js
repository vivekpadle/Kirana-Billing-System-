'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.DB_FILE = ':memory:';
const DB = require('../server/db');
const { createApp } = require('../server/server');

let server, base;
before(async () => {
  server = http.createServer(createApp(DB.open(':memory:')));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function login(username, password, role) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, role }) });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { status: res.status, cookie };
}
function client(cookie) {
  return async (path, body, method) => {
    const res = await fetch(base + '/api' + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
}

test('login checks role and password', async () => {
  assert.equal((await login('admin', 'wrong', 'admin')).status, 401);
  assert.equal((await login('employee', 'emp123', 'owner')).status, 403);
  assert.equal((await login('owner', 'owner123', 'owner')).status, 200);
});

test('employee permissions are limited', async () => {
  const emp = client((await login('employee', 'emp123', 'employee')).cookie);
  assert.equal((await emp('/products')).status, 200);
  assert.equal((await emp('/reports')).status, 403);
  assert.equal((await emp('/users')).status, 403);
  assert.equal((await emp('/products', { name: 'X', price: 1 })).status, 403);
  assert.equal((await client('')('/products')).status, 401);
});

test('owner cannot create admins; admin can', async () => {
  const owner = client((await login('owner', 'owner123')).cookie);
  assert.equal((await owner('/users', { name: 'A2', username: 'admin2', password: 'secret1', role: 'admin' })).status, 403);
  assert.equal((await owner('/users', { name: 'Ravi', username: 'ravi', password: 'secret1', role: 'employee' })).status, 200);
  const admin = client((await login('admin', 'admin123')).cookie);
  assert.equal((await admin('/users', { name: 'A2', username: 'admin2', password: 'secret1', role: 'admin' })).status, 200);
});

test('billing reduces stock, handles change, udhaar and cancel', async () => {
  const emp = client((await login('employee', 'emp123')).cookie);
  const owner = client((await login('owner', 'owner123')).cookie);
  const products = (await emp('/products')).data;
  const salt = products.find((p) => p.name.startsWith('Tata Salt'));
  const startStock = salt.stock;

  // cash sale with change; employee price override ignored
  let r = await emp('/bills', { items: [{ product_id: salt.id, qty: 2, price: 1 }], payments: [{ mode: 'cash', amount: 100 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.total, 56);
  assert.equal(r.data.change_returned, 44);
  assert.equal(r.data.status, 'paid');
  assert.equal((await emp('/products')).data.find((p) => p.id === salt.id).stock, startStock - 2);

  // udhaar without customer fails
  r = await emp('/bills', { items: [{ product_id: salt.id, qty: 1 }], payments: [] });
  assert.equal(r.status, 400);

  // partial: 20 UPI, rest udhaar
  r = await emp('/bills', { items: [{ product_id: salt.id, qty: 1 }], payments: [{ mode: 'upi', amount: 20 }], customer_name: 'Sita', customer_phone: '9876543210' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.due, 8);
  assert.equal(r.data.status, 'partial');
  const billId = r.data.id;
  const cust = (await emp('/customers?q=98765')).data[0];
  assert.equal(cust.balance, 8);

  // collect due
  r = await emp(`/customers/${cust.id}/payments`, { amount: 5, mode: 'cash' });
  assert.equal(r.data.balance, 3);

  // too much stock
  r = await emp('/bills', { items: [{ product_id: salt.id, qty: 99999 }], payments: [{ mode: 'cash', amount: 1 }] });
  assert.equal(r.status, 400);

  // employee cannot cancel, owner can
  assert.equal((await emp(`/bills/${billId}/cancel`, { reason: 'x' })).status, 403);
  r = await owner(`/bills/${billId}/cancel`, { reason: 'wrong item' });
  assert.equal(r.data.status, 'cancelled');
  assert.equal((await emp('/products')).data.find((p) => p.id === salt.id).stock, startStock - 2);
  assert.equal((await emp(`/customers/${cust.id}`)).data.balance, 0);

  // reports
  const rep = (await owner('/reports')).data;
  assert.equal(rep.summary.bills, 1);
  assert.equal(rep.summary.sales, 56);
});

test('stock in and adjust', async () => {
  const owner = client((await login('owner', 'owner123')).cookie);
  const p = (await owner('/products', { name: 'Test Biscuit', price: 10, cost: 8, stock: 5 })).data;
  let r = await owner(`/products/${p.id}/stock`, { type: 'purchase', qty: 10, cost: 7.5 });
  assert.equal(r.data.stock, 15); assert.equal(r.data.cost, 7.5);
  r = await owner(`/products/${p.id}/stock`, { type: 'adjust', set_to: 12, note: 'damaged' });
  assert.equal(r.data.stock, 12);
  assert.equal((await owner(`/products/${p.id}/moves`)).data.length, 3);
});

test('non-JSON writes are rejected (CSRF guard)', async () => {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=admin123' });
  assert.equal(res.status, 415);
});
