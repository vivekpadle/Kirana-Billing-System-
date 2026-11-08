'use strict';
const crypto = require('node:crypto');

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function getSessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.name, u.username, u.role, u.active, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?`).get(token);
  if (!row || row.expires_at < Date.now() || !row.active) return null;
  // sliding expiry
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() + SESSION_TTL_MS, token);
  return { id: row.id, name: row.name, username: row.username, role: row.role };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/*
 * Role permissions.
 *  admin    – everything, including managing admin/owner accounts
 *  owner    – everything in the shop (inventory, reports, staff, settings)
 *  employee – billing (POS), taking payments, viewing stock, customers
 */
const PERMISSIONS = {
  admin: ['*'],
  owner: ['pos', 'bills.view_all', 'bills.cancel', 'products.view', 'products.edit', 'stock.edit',
          'customers.view', 'customers.edit', 'payments.collect', 'reports.view', 'users.manage', 'settings.edit'],
  employee: ['pos', 'products.view', 'customers.view', 'customers.edit', 'payments.collect'],
};

function can(user, perm) {
  if (!user) return false;
  const list = PERMISSIONS[user.role] || [];
  return list.includes('*') || list.includes(perm);
}

module.exports = { hashPassword, verifyPassword, createSession, getSessionUser, destroySession, can, PERMISSIONS, SESSION_TTL_MS };
