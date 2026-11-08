/* Pise Kirana — single page app (vanilla JS, no build step) */
(() => {
  'use strict';

  // ------------------------------------------------------------------ utils
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (n) => inr.format(Number(n) || 0);
  const money0 = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
  const qtyFmt = (n) => { const v = Math.round(Number(n) * 1000) / 1000; return String(v); };
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const localDate = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return localDate(d); };
  const t = (k, v) => window.I18N.t(k, v);
  const dt = (s) => { if (!s) return ''; const d = new Date(s.replace(' ', 'T')); return d.toLocaleString(window.I18N.locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  const dShort = (s) => new Date(s + 'T00:00').toLocaleDateString(window.I18N.locale, { day: '2-digit', month: 'short' });
  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pk_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('pk_' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (res.status === 401 && path !== '/login' && path !== '/me') { state.user = null; renderLogin(); throw new Error(t('Session expired. Please log in again.')); }
    if (!res.ok) throw new Error(window.I18N.tMsg(data && data.error) || `${t('Request failed')} (${res.status})`);
    return data;
  }

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`; el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 4500 : 2600);
  }
  const fail = (e) => toast(e.message || String(e), 'error');

  function modal({ title, body, foot = '', wide = false, onClose }) {
    const root = $('#modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="${t('Close')}">✕</button></div>
      <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`;
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
    const onKey = (e) => { if (e.key === 'Escape' && root.lastElementChild === wrap) close(); };
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey);
    root.appendChild(wrap);
    const first = $('input:not([type=hidden]):not([readonly]), select, textarea', wrap);
    if (first && window.matchMedia('(pointer:fine)').matches) setTimeout(() => first.focus(), 30);
    return { el: wrap, close };
  }

  function confirmBox(title, message, okLabel = t('Confirm'), danger = false) {
    return new Promise((resolve) => {
      let done = false;
      const m = modal({
        title, body: `<p style="margin:0">${esc(message)}</p>`,
        foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button>`,
        onClose: () => { if (!done) resolve(false); },
      });
      $('[data-ok]', m.el).onclick = () => { done = true; m.close(); resolve(true); };
    });
  }

  const formData = (form) => Object.fromEntries(new FormData(form).entries());
  const statusBadge = (s) => ({ paid: `<span class="badge green">${t('Paid')}</span>`, partial: `<span class="badge amber">${t('Partial')}</span>`,
    credit: `<span class="badge red">${t('Udhaar')}</span>`, cancelled: `<span class="badge gray">${t('Cancelled')}</span>` }[s] || esc(s));
  const modeLabel = (m) => String(m || '').split('+').map((x) => t({ cash: 'Cash', upi: 'UPI', card: 'Card', credit: 'Udhaar' }[x] || x)).join(' + ');
  const roleBadge = (r) => `<span class="badge ${r === 'admin' ? 'red' : r === 'owner' ? 'amber' : 'blue'}">${esc(t(r))}</span>`;
  const shopName = () => t(state.settings.shop_name || 'Pise Kirana');
  const langSelect = (id) => `<select class="input lang-select" id="${id}" aria-label="${t('Language')}">${Object.entries(window.I18N.LANGS).map(([k, v]) => `<option value="${k}" ${k === window.I18N.lang ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  // switching language re-draws the current screen (cart is kept)
  const bindLang = (el, after) => { if (el) el.onchange = () => { window.I18N.set(el.value); after(); }; };

  // ------------------------------------------------------------------ state
  const state = {
    user: null, perms: [], settings: {},
    cart: new Map(), discount: 0, discountType: 'amt', customer: { name: '', phone: '' },
    products: [], category: '',
  };
  const can = (p) => state.perms.includes('*') || state.perms.includes(p);

  // theme
  const applyTheme = () => { const t = store.get('theme', 'auto'); if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t; };
  applyTheme();

  // ------------------------------------------------------------------ login
  function renderLogin() {
    const shop = shopName();
    let role = store.get('lastRole', 'employee');
    $('#modal-root').innerHTML = '';
    $('#root').innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <div class="row" style="justify-content:flex-end;margin:-8px -4px 10px"><span class="small muted">🌐</span>${langSelect('login-lang')}</div>
          <div class="brand"><div class="brand-logo">PK</div>
            <div class="grow"><div class="brand-name">${esc(shop)}</div><div class="brand-sub">${t('Billing & Inventory System')}</div></div></div>
          <div class="role-tabs" role="tablist">
            <button type="button" data-role="admin"><span class="ico">🛡️</span>${t('Admin')}</button>
            <button type="button" data-role="owner"><span class="ico">👑</span>${t('Owner')}</button>
            <button type="button" data-role="employee"><span class="ico">🧑‍💼</span>${t('Employee')}</button>
          </div>
          <form id="login-form" class="stack" autocomplete="on">
            <label class="field">${t('Username')}<input class="input" name="username" autocomplete="username" autocapitalize="none" required></label>
            <label class="field">${t('Password')}<input class="input" name="password" type="password" autocomplete="current-password" required></label>
            <button class="btn primary lg block" type="submit" id="login-btn"></button>
          </form>
          ${state.settings.demo ? `<div class="demo-hint"><b>🎯 ${t('Demo — try it with these logins')}</b>
            <div class="row" style="margin-top:8px">${[['admin', 'admin123'], ['owner', 'owner123'], ['employee', 'emp123']].map(([u, pw]) => `<button type="button" class="btn sm" data-demo="${u}|${pw}"><b>${t(u[0].toUpperCase() + u.slice(1))}</b>&nbsp;· ${u} / ${pw}</button>`).join('')}</div></div>` : ''}
        </div>
      </div>`;
    const setRole = (r) => {
      role = r; store.set('lastRole', r);
      $$('.role-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.role === r));
      $('#login-btn').textContent = t('Login as {role}', { role: r[0].toUpperCase() + r.slice(1) });
    };
    bindLang($('#login-lang'), renderLogin);
    $$('.role-tabs button').forEach((b) => (b.onclick = () => setRole(b.dataset.role)));
    $$('[data-demo]').forEach((b) => (b.onclick = () => {
      const [u, pw] = b.dataset.demo.split('|');
      setRole(u); $('[name=username]').value = u; $('[name=password]').value = pw;
      $('#login-form').requestSubmit();
    }));
    setRole(role);
    $('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', e.target); btn.disabled = true;
      try {
        await api('/login', { body: { ...formData(e.target), role } });
        await boot();
        location.hash = role === 'employee' ? '#/pos' : '#/dashboard';
      } catch (err) { fail(err); btn.disabled = false; }
    };
  }

  // ------------------------------------------------------------------ shell
  const NAV = [
    { id: 'dashboard', label: 'Dashboard', ico: '🏠', perm: 'pos' },
    { id: 'pos', label: 'New Bill', ico: '🧾', perm: 'pos' },
    { id: 'bills', label: 'Bills', ico: '📄', perm: 'pos' },
    { id: 'products', label: 'Inventory', ico: '📦', perm: 'products.view' },
    { id: 'customers', label: 'Customers', ico: '👥', perm: 'customers.view' },
    { id: 'reports', label: 'Reports', ico: '📊', perm: 'reports.view' },
    { id: 'users', label: 'Staff & Users', ico: '🔐', perm: 'users.manage' },
    { id: 'settings', label: 'Settings', ico: '⚙️', perm: 'pos' },
  ];

  function renderShell() {
    const items = NAV.filter((n) => can(n.perm));
    const u = state.user;
    const mobileMain = ['dashboard', 'pos', 'bills', 'products'].filter((id) => items.some((i) => i.id === id));
    $('#root').innerHTML = `
      <div class="app">
        <aside class="sidebar">
          <div class="brand"><div class="brand-logo">PK</div><div><div class="brand-name">${esc(shopName())}</div><div class="brand-sub">${t('Billing & Inventory')}</div></div></div>
          <nav class="nav">${items.map((n) => `<a href="#/${n.id}" data-nav="${n.id}"><span class="ico">${n.ico}</span>${t(n.label)}</a>`).join('')}</nav>
          <div class="sidebar-foot">
            <div class="user-chip"><div class="avatar">${esc(u.name[0] || '?')}</div><div class="grow" style="min-width:0"><div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.name)}</div>${roleBadge(u.role)}</div>
            <button class="icon-btn" id="logout-btn" title="${t('Logout')}" aria-label="${t('Logout')}">⎋</button></div>
            <div style="padding:6px 8px 0">${langSelect('side-lang')}</div>
          </div>
        </aside>
        <div class="main">
          ${state.demo ? `<div class="demo-bar">🎯 ${t('Demo version — try freely. All data resets automatically every few hours.')}</div>` : ''}
          <header class="topbar">
            <div class="mobile-brand"><div class="brand-logo" style="width:34px;height:34px;font-size:15px;border-radius:9px">PK</div></div>
            <h1 id="page-title"></h1>
            <div id="page-actions" class="row"></div>
          </header>
          <main class="content" id="view"></main>
        </div>
        <nav class="bottom-nav">
          ${mobileMain.map((id) => { const n = NAV.find((x) => x.id === id); return `<a href="#/${id}" data-nav="${id}"><span class="ico">${n.ico}</span>${id === 'pos' ? t('Bill') : id === 'dashboard' ? t('Dashboard') : t(n.label)}</a>`; }).join('')}
          <button id="more-btn"><span class="ico">☰</span>${t('More')}</button>
        </nav>
      </div>`;
    $('#logout-btn').onclick = logout;
    const relang = () => { renderShell(); route(); };
    bindLang($('#side-lang'), relang);
    $('#more-btn').onclick = () => {
      const rest = items.filter((i) => !mobileMain.includes(i.id));
      const m = modal({
        title: `${u.name} · ${t(u.role)}`,
        body: `<div class="card">${rest.map((n) => `<a class="list-item" style="text-decoration:none;color:inherit" href="#/${n.id}" data-close><span style="font-size:20px">${n.ico}</span><span class="grow">${t(n.label)}</span>›</a>`).join('')}
          <div class="list-item"><span style="font-size:20px">🌐</span><span class="grow">${t('Language')}</span>${langSelect('more-lang')}</div>
          <button class="list-item btn ghost block" style="justify-content:flex-start;border-radius:0" id="m-logout"><span style="font-size:20px">⎋</span><span class="grow" style="text-align:left">${t('Logout')}</span></button></div>`,
      });
      bindLang($('#more-lang', m.el), () => { m.close(); relang(); });
      $('#m-logout', m.el).onclick = () => { m.close(); logout(); };
    };
  }

  async function logout() {
    try { await api('/logout', { body: {} }); } catch { /* ignore */ }
    state.user = null; state.cart.clear();
    location.hash = '';
    renderLogin();
  }

  function setTitle(title, actions = '') {
    $('#page-title').textContent = title;
    $('#page-actions').innerHTML = actions;
    document.title = `${title} · ${shopName()}`;
  }

  // ------------------------------------------------------------------ router
  const VIEWS = {};
  async function route() {
    if (!state.user) return;
    const [, name = '', arg] = (location.hash || '').split('/');
    let id = name || (state.user.role === 'employee' ? 'pos' : 'dashboard');
    const nav = NAV.find((n) => n.id === id);
    if (!nav || !can(nav.perm)) id = 'pos';
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === id));
    const view = $('#view');
    view.innerHTML = `<div class="loading"><div class="spinner"></div>${t('Loading…')}</div>`;
    $('#modal-root').innerHTML = '';
    window.scrollTo(0, 0);
    try { await VIEWS[id](view, arg); } catch (e) { view.innerHTML = `<div class="card empty">⚠️ ${esc(e.message)}</div>`; }
  }
  window.addEventListener('hashchange', route);

  // ------------------------------------------------------------------ dashboard
  VIEWS.dashboard = async (view) => {
    setTitle(t('Dashboard'), `<a class="btn primary" href="#/pos">＋ ${t('New Bill')}</a>`);
    const d = await api('/dashboard');
    const payMap = Object.fromEntries(d.payments_today.map((p) => [p.mode, p.amount]));
    const max = Math.max(1, ...(d.last7 || []).map((x) => x.sales));
    const days = [];
    for (let i = 6; i >= 0; i--) { const day = addDays(-i); days.push((d.last7 || []).find((x) => x.day === day) || { day, sales: 0, bills: 0 }); }
    view.innerHTML = `
      <p class="muted" style="margin:0 0 14px">${esc(t('Namaste {name} 🙏', { name: state.user.name }))} — ${new Date().toLocaleDateString(window.I18N.locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${d.mine ? ' · ' + t('showing your sales') : ''}</p>
      <div class="stats">
        <div class="card stat green"><div class="label">${t("Today's sales")}</div><div class="value">${money0(d.today.sales)}</div><div class="sub">${t('{n} bills', { n: d.today.bills })}</div></div>
        <div class="card stat"><div class="label">${t('Cash collected')}</div><div class="value">${money0(payMap.cash)}</div><div class="sub">${t('UPI')} ${money0(payMap.upi)} · ${t('Card')} ${money0(payMap.card)}</div></div>
        ${d.mine ? `<div class="card stat red"><div class="label">${t('Udhaar given today')}</div><div class="value">${money0(d.today.credit)}</div></div>` : `
        <div class="card stat amber"><div class="label">${t("Today's profit")}</div><div class="value">${money0(d.profit_today)}</div><div class="sub">${t('after discounts')}</div></div>
        <div class="card stat red"><div class="label">${t('Total udhaar due')}</div><div class="value">${money0(d.total_due)}</div><div class="sub"><a href="#/customers">${t('View customers')}</a></div></div>
        <div class="card stat"><div class="label">${t('Stock value')}</div><div class="value">${money0(d.stock_value)}</div><div class="sub">${t('at cost price')}</div></div>`}
      </div>
      <div class="two-col">
        <div class="stack">
          ${d.mine ? '' : `<div class="card"><div class="card-head"><h3>${t('Last 7 days')}</h3><a class="small" href="#/reports">${t('Reports ›')}</a></div>
            <div class="card-pad"><div class="bars">${days.map((x) => `<div class="bar" title="${esc(x.day)}: ${money(x.sales)}"><div class="val">${x.sales ? money0(x.sales) : ''}</div><div class="fill" style="height:${(x.sales / max) * 100}%"></div><div class="lbl">${dShort(x.day)}</div></div>`).join('')}</div></div></div>`}
          <div class="card"><div class="card-head"><h3>${t('Recent bills')}</h3><a class="small" href="#/bills">${t('All bills ›')}</a></div>
            ${d.recent.length ? `<div class="table-wrap"><table class="table responsive"><tbody>${d.recent.map((b) => `
              <tr class="clickable" data-bill="${b.id}"><td class="primary-cell">${esc(b.bill_no)}<div class="small muted">${esc(b.customer_name || t('Walk-in'))}</div></td>
              <td data-label="${t('Time')}" class="small muted">${dt(b.created_at)}</td><td data-label="${t('Mode')}">${esc(modeLabel(b.payment_mode))}</td>
              <td data-label="${t('Status')}">${statusBadge(b.status)}</td><td data-label="${t('Total')}" class="right num"><b>${money(b.total)}</b></td></tr>`).join('')}</tbody></table></div>`
              : `<div class="empty">${t('No bills yet.')} <a href="#/pos">${t('Create the first bill')}</a></div>`}
          </div>
        </div>
        ${d.mine ? '' : `<div class="card"><div class="card-head"><h3>⚠️ ${t('Low stock')}</h3><a class="small" href="#/products/low">${t('Manage ›')}</a></div>
          ${d.low_stock.length ? d.low_stock.map((p) => `<div class="list-item"><span class="grow">${esc(p.name)}</span>
            <span class="badge ${p.stock <= 0 ? 'red' : 'amber'}">${qtyFmt(p.stock)} ${esc(p.unit)}</span></div>`).join('') : `<div class="empty">${t('All items are well stocked 👍')}</div>`}
        </div>`}
      </div>`;
    $$('[data-bill]', view).forEach((tr) => (tr.onclick = () => showBill(tr.dataset.bill)));
  };

  // ------------------------------------------------------------------ POS
  VIEWS.pos = async (view) => {
    setTitle(t('New Bill'), `<span class="small muted nowrap">${esc(state.user.name)}</span>`);
    view.innerHTML = `
      <div class="pos">
        <section>
          <div class="pos-search">
            <div class="search-box"><span class="s-ico">🔍</span>
              <input class="input" id="pos-q" placeholder="${t('Search item or scan barcode…')}" autocomplete="off" inputmode="search"></div>
            <div class="chips" id="pos-cats"></div>
          </div>
          <div class="product-grid" id="pos-grid"></div>
        </section>
        <aside class="card cart" id="cart"></aside>
      </div>
      <button class="cart-fab" id="cart-fab"></button>`;
    const [products, cats] = await Promise.all([api('/products'), api('/products/categories')]);
    state.products = products;
    // refresh product data in cart (prices/stock may have changed)
    for (const [id, line] of state.cart) { const p = products.find((x) => x.id === id); if (p) line.product = p; else state.cart.delete(id); }

    const catsEl = $('#pos-cats');
    catsEl.innerHTML = `<button class="chip" data-cat="">${t('All')}</button>` + cats.map((c) => `<button class="chip" data-cat="${esc(c.category)}">${esc(c.category)}</button>`).join('');
    const setCat = (c) => { state.category = c; $$('.chip', catsEl).forEach((b) => b.classList.toggle('active', b.dataset.cat === c)); drawGrid(); };
    $$('.chip', catsEl).forEach((b) => (b.onclick = () => setCat(b.dataset.cat)));
    setCat(state.category && cats.some((c) => c.category === state.category) ? state.category : '');

    const q = $('#pos-q');
    q.oninput = debounce(drawGrid, 120);
    q.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const term = q.value.trim(); if (!term) return;
      const exact = state.products.find((p) => p.barcode && p.barcode === term);
      const list = filtered();
      const pick = exact || (list.length === 1 ? list[0] : null);
      if (pick) { q.value = ''; drawGrid(); pickProduct(pick); } else if (!list.length) toast(t('No item found for "{q}"', { q: term }), 'error');
    };
    if (window.matchMedia('(pointer:fine)').matches) q.focus();
    $('#cart-fab').onclick = () => toggleCart(true);
    drawCart();
  };

  function filtered() {
    const term = ($('#pos-q')?.value || '').trim().toLowerCase();
    return state.products.filter((p) => (!state.category || p.category === state.category) &&
      (!term || p.name.toLowerCase().includes(term) || (p.barcode || '') === term || (p.category || '').toLowerCase().includes(term)));
  }

  function drawGrid() {
    const grid = $('#pos-grid'); if (!grid) return;
    const list = filtered();
    grid.innerHTML = list.length ? list.map((p) => {
      const inCart = state.cart.get(p.id)?.qty;
      const cls = p.stock <= 0 ? 'out' : p.stock <= p.low_stock ? 'low' : '';
      return `<button class="p-tile ${cls}" data-pid="${p.id}">
        ${inCart ? `<span class="in-cart">${qtyFmt(inCart)}</span>` : ''}
        <span class="p-name">${esc(p.name)}</span>
        <span class="p-stock">${p.stock <= 0 ? t('Out of stock') : esc(t('Stock: {n} {u}', { n: qtyFmt(p.stock), u: p.unit }))}</span>
        <span class="p-price">${money(p.price)}<span class="small muted" style="font-weight:500">/${esc(p.unit)}</span></span>
      </button>`;
    }).join('') : `<div class="card empty" style="grid-column:1/-1">${t('No items found')}</div>`;
    $$('.p-tile', grid).forEach((b) => (b.onclick = () => pickProduct(state.products.find((x) => x.id === Number(b.dataset.pid)))));
  }

  // loose / weighed items ask for quantity the first time; packed items add 1
  function pickProduct(p) {
    if (['kg', 'g', 'l', 'ltr', 'ml'].includes(String(p.unit).toLowerCase()) && !state.cart.has(p.id)) askQty(p); else addToCart(p);
  }

  function askQty(p) {
    const m = modal({
      title: p.name,
      body: `<form id="qf" class="stack"><label class="field">${esc(t('Quantity ({u})', { u: p.unit }))}<input class="input" name="qty" type="number" step="any" min="0.001" value="1" inputmode="decimal" required></label>
        <div class="quick-cash">${[0.25, 0.5, 1, 2, 5].map((v) => `<button type="button" class="btn sm" data-v="${v}">${v} ${esc(p.unit)}</button>`).join('')}</div>
        <div class="muted small">${esc(t('Price: {p} / {u}', { p: money(p.price), u: p.unit }))}</div></form>`,
      foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" form="qf">${t('Add to bill')}</button>`,
    });
    const f = $('#qf', m.el);
    $$('[data-v]', m.el).forEach((b) => (b.onclick = () => { f.qty.value = b.dataset.v; }));
    f.onsubmit = (e) => { e.preventDefault(); const qn = Number(f.qty.value); if (qn > 0) { addToCart(p, qn); m.close(); } };
  }

  function addToCart(p, qty = 1) {
    const allowNeg = state.settings.allow_negative_stock === '1';
    const line = state.cart.get(p.id) || { product: p, qty: 0, price: null };
    if (!allowNeg && line.qty + qty > p.stock + 1e-9) return toast(t('Only {n} {u} of {name} in stock', { n: qtyFmt(p.stock), u: p.unit, name: p.name }), 'error');
    line.qty = r2(line.qty + qty);
    state.cart.set(p.id, line);
    drawCart(); drawGrid();
    if (navigator.vibrate) navigator.vibrate(15);
  }

  function cartTotals() {
    let subtotal = 0;
    for (const l of state.cart.values()) subtotal += r2((l.price ?? l.product.price) * l.qty);
    subtotal = r2(subtotal);
    let discount = state.discountType === 'pct' ? r2(subtotal * Math.min(100, state.discount) / 100) : r2(state.discount);
    discount = Math.min(discount, subtotal);
    return { subtotal, discount, total: r2(subtotal - discount), count: state.cart.size };
  }

  function toggleCart(open) {
    const cart = $('#cart'); if (!cart) return;
    cart.classList.toggle('open', open);
    $('.sheet-backdrop')?.remove();
    if (open && window.matchMedia('(max-width: 899px)').matches) {
      const bd = document.createElement('div'); bd.className = 'sheet-backdrop'; bd.onclick = () => toggleCart(false);
      document.body.appendChild(bd);
    }
  }

  function drawCart() {
    const cart = $('#cart'); if (!cart) return;
    const tt = cartTotals();
    const canPrice = state.user.role !== 'employee';
    const lines = [...state.cart.values()];
    cart.innerHTML = `
      <div class="card-head"><h3>🛒 ${t('Cart')} <span class="muted small">(${t('{n} items', { n: tt.count })})</span></h3>
        ${tt.count ? `<button class="btn sm ghost danger" id="clear-cart">${t('Clear')}</button>` : ''}
        <button class="icon-btn mobile-only" id="cart-close" aria-label="${t('Close')}" style="${window.matchMedia('(max-width: 899px)').matches ? '' : 'display:none'}">✕</button></div>
      <div class="cart-items">${lines.length ? lines.map((l) => {
        const price = l.price ?? l.product.price;
        return `<div class="cart-line" data-id="${l.product.id}">
          <div class="n">${esc(l.product.name)}</div>
          <div class="amt num">${money(price * l.qty)}</div>
          <div class="meta">${canPrice ? `<button class="btn sm ghost" style="padding:0 4px;min-height:0" data-price>${money(price)}</button>` : money(price)} / ${esc(l.product.unit)}</div>
          <div class="qty"><button data-dec aria-label="${t('Less')}">−</button><input type="number" step="any" min="0" value="${qtyFmt(l.qty)}" inputmode="decimal" aria-label="${t('Quantity')}"><button data-inc aria-label="${t('More qty')}">+</button></div>
        </div>`;
      }).join('') : `<div class="empty">${t('Cart is empty.')}<br><span class="small">${t('Tap items or scan barcodes to add.')}</span></div>`}</div>
      <div class="cart-totals">
        <div class="line"><span>${t('Subtotal')}</span><span class="num">${money(tt.subtotal)}</span></div>
        <div class="line" style="align-items:center"><span>${t('Discount')}</span>
          <span class="row" style="gap:4px;flex-wrap:nowrap"><input class="input" id="disc" type="number" min="0" step="any" value="${state.discount || ''}" placeholder="0" style="width:84px;min-height:34px;padding:4px 8px" inputmode="decimal">
          <select class="input" id="disc-type" style="width:62px;min-height:34px;padding:4px"><option value="amt">₹</option><option value="pct">%</option></select></span></div>
        ${tt.discount ? `<div class="line muted"><span>${t('Discount applied')}</span><span class="num">− ${money(tt.discount)}</span></div>` : ''}
        <div class="line grand"><span>${t('Total')}</span><span class="num">${money(tt.total)}</span></div>
        <button class="btn primary lg block" id="checkout" ${tt.count ? '' : 'disabled'}>${t('Take Payment')} · ${money(tt.total)}</button>
      </div>`;
    $('#disc-type', cart).value = state.discountType;
    $('#disc', cart).onchange = (e) => { state.discount = Math.max(0, Number(e.target.value) || 0); drawCart(); };
    $('#disc-type', cart).onchange = (e) => { state.discountType = e.target.value; drawCart(); };
    $('#clear-cart', cart)?.addEventListener('click', async () => {
      if (await confirmBox(t('Clear cart?'), t('Remove all items from this bill?'), t('Clear'), true)) { state.cart.clear(); state.discount = 0; drawCart(); drawGrid(); }
    });
    $('#cart-close', cart)?.addEventListener('click', () => toggleCart(false));
    $('#checkout', cart).onclick = checkout;
    $$('.cart-line', cart).forEach((row) => {
      const id = Number(row.dataset.id); const line = state.cart.get(id);
      const setQty = (q) => {
        q = r2(q);
        if (q <= 0) state.cart.delete(id);
        else if (state.settings.allow_negative_stock !== '1' && q > line.product.stock + 1e-9) { toast(t('Only {n} {u} in stock', { n: qtyFmt(line.product.stock), u: line.product.unit }), 'error'); }
        else line.qty = q;
        drawCart(); drawGrid();
      };
      $('[data-inc]', row).onclick = () => setQty(line.qty + 1);
      $('[data-dec]', row).onclick = () => setQty(line.qty >= 1 ? line.qty - 1 : 0);
      $('input', row).onchange = (e) => setQty(Number(e.target.value) || 0);
      $('[data-price]', row)?.addEventListener('click', () => {
        const m = modal({
          title: t('Price for {name}', { name: line.product.name }),
          body: `<form id="pf" class="stack"><label class="field">${esc(t('Selling price per {u} (₹)', { u: line.product.unit }))}<input class="input" name="price" type="number" step="0.01" min="0" value="${line.price ?? line.product.price}" inputmode="decimal"></label>
            <div class="small muted">${t('List price {p} · MRP {m}', { p: money(line.product.price), m: money(line.product.mrp) })}</div></form>`,
          foot: `<button class="btn" type="button" id="pf-reset">${t('Reset')}</button><button class="btn primary" form="pf">${t('Apply')}</button>`,
        });
        $('#pf', m.el).onsubmit = (e) => { e.preventDefault(); line.price = r2(Number(e.target.price.value) || 0); m.close(); drawCart(); };
        $('#pf-reset', m.el).onclick = () => { line.price = null; m.close(); drawCart(); };
      });
    });
    const fab = $('#cart-fab');
    if (fab) { fab.hidden = !tt.count; fab.innerHTML = `<span>🛒 ${t('{n} items', { n: tt.count })}</span><span>${money(tt.total)} ›</span>`; }
  }

  function checkout() {
    const tot = cartTotals();
    if (!tot.count) return;
    toggleCart(false);
    const s = state.settings;
    const pay = { cash: tot.total, upi: 0, card: 0 };
    let mode = 'cash'; let split = false;
    const m = modal({
      title: `${t('Payment')} · ${money(tot.total)}`,
      body: `
        <div class="stack">
          <div class="pay-modes">
            <button class="pay-mode" data-mode="cash"><span class="ico">💵</span>${t('Cash')}</button>
            <button class="pay-mode" data-mode="upi"><span class="ico">📱</span>${t('UPI')}</button>
            <button class="pay-mode" data-mode="card"><span class="ico">💳</span>${t('Card')}</button>
            <button class="pay-mode" data-mode="credit"><span class="ico">📒</span>${t('Udhaar')}</button>
          </div>
          <div id="pay-fields"></div>
          <div id="pay-summary"></div>
          <details id="cust-box" ${state.customer.phone || state.customer.name ? 'open' : ''}>
            <summary style="cursor:pointer;font-weight:600">${t('Customer details')} <span class="muted small">${t('(required for udhaar)')}</span></summary>
            <div class="grid-2" style="margin-top:10px">
              <label class="field">${t('Mobile')}<input class="input" id="c-phone" type="tel" inputmode="tel" maxlength="15" list="cust-list" value="${esc(state.customer.phone)}" placeholder="${t('10-digit number')}"></label>
              <label class="field">${t('Name')}<input class="input" id="c-name" value="${esc(state.customer.name)}" placeholder="${t('Customer name')}"></label>
            </div>
            <datalist id="cust-list"></datalist>
            <div id="cust-info" class="small muted" style="margin-top:6px"></div>
          </details>
          <label class="field">${t('Note (optional)')}<input class="input" id="b-note" maxlength="200"></label>
        </div>`,
      foot: `<button class="btn" data-close>${t('Back')}</button><button class="btn primary lg" id="pay-done">✔ ${t('Complete Sale')}</button>`,
    });
    const el = m.el;
    let custCache = [];
    const draw = () => {
      $$('.pay-mode', el).forEach((b) => b.classList.toggle('active', !split && b.dataset.mode === mode));
      const f = $('#pay-fields', el);
      if (split) {
        f.innerHTML = `<div class="grid-3">${['cash', 'upi', 'card'].map((k) => `<label class="field">${t({ cash: 'Cash', upi: 'UPI', card: 'Card' }[k])}<input class="input" data-pay="${k}" type="number" min="0" step="0.01" inputmode="decimal" value="${pay[k] || ''}" placeholder="0"></label>`).join('')}</div>
          <button class="btn sm ghost" id="no-split">← ${t('Single payment mode')}</button>`;
      } else if (mode === 'cash') {
        const notes = [...new Set([tot.total, Math.ceil(tot.total / 10) * 10, Math.ceil(tot.total / 50) * 50, Math.ceil(tot.total / 100) * 100, Math.ceil(tot.total / 500) * 500, 2000])].filter((v) => v >= tot.total).slice(0, 5);
        f.innerHTML = `<label class="field">${t('Cash received (₹)')}<input class="input" data-pay="cash" type="number" min="0" step="0.01" inputmode="decimal" value="${pay.cash || ''}" style="font-size:20px;font-weight:700"></label>
          <div class="quick-cash" style="margin-top:8px">${notes.map((v) => `<button class="btn sm" data-quick="${v}">${money0(v)}</button>`).join('')}</div>
          <button class="btn sm ghost" id="do-split" style="margin-top:6px">${t('Split / part payment')}</button>`;
      } else if (mode === 'upi' || mode === 'card') {
        const upiLink = s.upi_id ? `upi://pay?pa=${encodeURIComponent(s.upi_id)}&pn=${encodeURIComponent(shopName())}&am=${tot.total.toFixed(2)}&cu=INR` : '';
        f.innerHTML = `<label class="field">${t(mode === 'upi' ? 'UPI amount received (₹)' : 'Card amount received (₹)')}<input class="input" data-pay="${mode}" type="number" min="0" step="0.01" inputmode="decimal" value="${pay[mode] || ''}" style="font-size:20px;font-weight:700"></label>
          ${mode === 'upi' ? (s.upi_id ? `<div class="small muted" style="margin-top:6px">${t('Shop UPI ID')}: <b>${esc(s.upi_id)}</b> · <a href="${esc(upiLink)}">${t('Open UPI app')}</a></div>` : `<div class="small muted" style="margin-top:6px">${t('Tip: add your UPI ID in Settings.')}</div>`) : ''}
          <div class="small muted" style="margin-top:4px">${t(mode === 'upi' ? 'Confirm the payment is received on your phone / soundbox before completing.' : 'Confirm the payment is received on your card machine before completing.')}</div>
          <button class="btn sm ghost" id="do-split" style="margin-top:6px">${t('Split / part payment')}</button>`;
      } else {
        f.innerHTML = `<div class="due-box due"><span>${t('Full amount on udhaar')}</span><span>${money(tot.total)}</span></div>`;
        $('#cust-box', el).open = true;
      }
      $$('[data-pay]', f).forEach((inp) => (inp.oninput = () => { pay[inp.dataset.pay] = Math.max(0, Number(inp.value) || 0); summary(); }));
      $$('[data-quick]', f).forEach((b) => (b.onclick = () => { pay.cash = Number(b.dataset.quick); $('[data-pay=cash]', f).value = pay.cash; summary(); }));
      $('#do-split', f)?.addEventListener('click', () => { split = true; draw(); });
      $('#no-split', f)?.addEventListener('click', () => { split = false; setMode(mode === 'credit' ? 'cash' : mode); });
      summary();
    };
    const summary = () => {
      const paid = r2(pay.cash + pay.upi + pay.card);
      const diff = r2(paid - tot.total);
      $('#pay-summary', el).innerHTML = diff > 0
        ? `<div class="due-box change"><span>${t('Return change')}</span><span>${money(diff)}</span></div>`
        : diff < 0 ? `<div class="due-box due"><span>${t('Balance on udhaar')}</span><span>${money(-diff)}</span></div>` : '';
      if (diff < 0) $('#cust-box', el).open = true;
    };
    const setMode = (md) => {
      mode = md; split = false;
      pay.cash = 0; pay.upi = 0; pay.card = 0;
      if (md !== 'credit') pay[md] = tot.total;
      draw();
    };
    $$('.pay-mode', el).forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
    setMode('cash');

    // customer lookup
    const phoneEl = $('#c-phone', el); const nameEl = $('#c-name', el);
    const lookup = debounce(async () => {
      const v = phoneEl.value.trim();
      if (v.length < 3) return;
      try {
        custCache = await api('/customers?q=' + encodeURIComponent(v));
        $('#cust-list', el).innerHTML = custCache.slice(0, 10).map((c) => `<option value="${esc(c.phone || '')}">${esc(c.name)}</option>`).join('');
        const exact = custCache.find((c) => c.phone === v.replace(/[^\d+]/g, ''));
        if (exact) {
          if (!nameEl.value) nameEl.value = exact.name;
          $('#cust-info', el).innerHTML = `${t('Existing customer')}: <b>${esc(exact.name)}</b>${exact.balance > 0 ? ` · <span style="color:var(--danger)">${t('Previous due')} ${money(exact.balance)}</span>` : ''}`;
        } else $('#cust-info', el).textContent = '';
      } catch { /* ignore */ }
    }, 250);
    phoneEl.oninput = lookup;

    $('#pay-done', el).onclick = async (e) => {
      const btn = e.currentTarget;
      const payments = ['cash', 'upi', 'card'].filter((k) => pay[k] > 0).map((k) => ({ mode: k, amount: pay[k] }));
      const paid = r2(pay.cash + pay.upi + pay.card);
      const custName = nameEl.value.trim(); const custPhone = phoneEl.value.trim();
      if (paid < tot.total - 0.001 && (!custName || !custPhone)) { $('#cust-box', el).open = true; phoneEl.focus(); return toast(t('Enter customer mobile & name for udhaar'), 'error'); }
      btn.disabled = true;
      try {
        const bill = await api('/bills', {
          body: {
            items: [...state.cart.values()].map((l) => ({ product_id: l.product.id, qty: l.qty, price: l.price ?? undefined })),
            discount: tot.discount, payments, customer_name: custName, customer_phone: custPhone, notes: $('#b-note', el).value,
          },
        });
        state.cart.clear(); state.discount = 0; state.customer = { name: '', phone: '' };
        m.close();
        toast(t('Bill {no} saved', { no: bill.bill_no }), 'success');
        // refresh stock numbers
        api('/products').then((p) => { state.products = p; drawGrid(); }).catch(() => {});
        drawCart(); drawGrid();
        showReceipt(bill, true);
      } catch (err) { fail(err); btn.disabled = false; }
    };
    // keep typed customer if user goes back
    nameEl.onchange = () => { state.customer.name = nameEl.value; };
    phoneEl.onchange = () => { state.customer.phone = phoneEl.value; };
  }

  // ------------------------------------------------------------------ receipt
  function receiptHTML(b) {
    const s = state.settings;
    return `<div class="receipt">
      <h2>${esc(shopName())}</h2>
      ${s.shop_tagline ? `<div class="c">${esc(t(s.shop_tagline))}</div>` : ''}
      ${s.shop_address ? `<div class="c">${esc(s.shop_address)}</div>` : ''}
      ${s.shop_phone ? `<div class="c">${t('Ph')}: ${esc(s.shop_phone)}</div>` : ''}
      ${s.gstin ? `<div class="c">GSTIN: ${esc(s.gstin)}</div>` : ''}
      <hr>
      <table><tr><td>${t('Bill')}: <b>${esc(b.bill_no)}</b></td><td class="r">${dt(b.created_at)}</td></tr>
      ${b.customer_name || b.customer_phone ? `<tr><td colspan="2">${t('Customer')}: ${esc(b.customer_name || '')} ${esc(b.customer_phone || '')}</td></tr>` : ''}
      <tr><td colspan="2">${t('Cashier')}: ${esc(b.cashier || '')}</td></tr></table>
      <hr>
      <table><tr><td><b>${t('Item')}</b></td><td class="r"><b>${t('Qty')}</b></td><td class="r"><b>${t('Rate')}</b></td><td class="r"><b>${t('Amt')}</b></td></tr>
      ${b.items.map((i) => `<tr><td colspan="4">${esc(i.name)}</td></tr><tr><td></td><td class="r">${qtyFmt(i.qty)} ${esc(i.unit || '')}</td><td class="r">${i.price.toFixed(2)}</td><td class="r">${i.amount.toFixed(2)}</td></tr>`).join('')}
      </table><hr>
      <table>
        <tr><td>${t('Subtotal')}</td><td class="r">${b.subtotal.toFixed(2)}</td></tr>
        ${b.discount ? `<tr><td>${t('Discount')}</td><td class="r">-${b.discount.toFixed(2)}</td></tr>` : ''}
        <tr class="big"><td>${t('TOTAL')}</td><td class="r">₹${b.total.toFixed(2)}</td></tr>
        ${b.tax ? `<tr><td class="small">${t('(Incl. GST)')}</td><td class="r small">${b.tax.toFixed(2)}</td></tr>` : ''}
        ${b.payments.filter((p) => p.kind === 'sale').map((p) => `<tr><td>${esc(t('Paid ({mode})', { mode: modeLabel(p.mode) }))}</td><td class="r">${p.amount.toFixed(2)}</td></tr>`).join('')}
        ${b.change_returned ? `<tr><td>${t('Cash received')}</td><td class="r">${(b.paid + b.change_returned).toFixed(2)}</td></tr><tr><td>${t('Change returned')}</td><td class="r">${b.change_returned.toFixed(2)}</td></tr>` : ''}
        ${b.due > 0 ? `<tr><td><b>${t('Balance due')}</b></td><td class="r"><b>${b.due.toFixed(2)}</b></td></tr>` : ''}
      </table>
      ${b.status === 'cancelled' ? `<hr><div class="c big">${t('*** CANCELLED ***')}</div>` : ''}
      <hr><div class="c">${esc(t(s.bill_footer || 'Thank you! Visit again.'))}</div>
    </div>`;
  }

  function billText(b) {
    const s = state.settings;
    const lines = [`*${shopName()}*`, `${t('Bill')}: ${b.bill_no}  ${dt(b.created_at)}`, ''];
    for (const i of b.items) lines.push(`${i.name} x ${qtyFmt(i.qty)} = ₹${i.amount.toFixed(2)}`);
    lines.push('');
    if (b.discount) lines.push(`${t('Discount')}: -₹${b.discount.toFixed(2)}`);
    lines.push(`*${t('Total')}: ₹${b.total.toFixed(2)}*`);
    if (b.due > 0) lines.push(`${t('Balance due')}: ₹${b.due.toFixed(2)}`);
    lines.push('', t(s.bill_footer || 'Thank you! Visit again.'));
    return lines.join('\n');
  }

  function printReceipt(b) {
    $('#print-area').innerHTML = receiptHTML(b);
    setTimeout(() => window.print(), 50);
  }

  function showReceipt(b, fresh = false) {
    const phone = String(b.customer_phone || '').replace(/\D/g, '');
    const wa = `https://wa.me/${phone.length === 10 ? '91' + phone : phone}?text=${encodeURIComponent(billText(b))}`;
    const m = modal({
      title: fresh ? `✅ ${t('Sale complete')}` : `${t('Bill')} ${b.bill_no}`,
      body: `${fresh && b.change_returned ? `<div class="due-box change" style="margin-bottom:12px;font-size:18px"><span>${t('Return change')}</span><span>${money(b.change_returned)}</span></div>` : ''}${receiptHTML(b)}`,
      foot: `<a class="btn" href="${esc(wa)}" target="_blank" rel="noopener">${t('WhatsApp')}</a>
        <button class="btn" id="r-print">🖨️ ${t('Print')}</button>
        ${!fresh && can('bills.cancel') && b.status !== 'cancelled' ? `<button class="btn danger" id="r-cancel">${t('Cancel bill')}</button>` : ''}
        ${fresh ? `<button class="btn primary" data-close>＋ ${t('Next bill')}</button>` : `<button class="btn primary" data-close>${t('Close')}</button>`}`,
    });
    $('#r-print', m.el).onclick = () => printReceipt(b);
    $('#r-cancel', m.el)?.addEventListener('click', async () => {
      const reason = prompt(t('Reason for cancelling this bill? (stock will be restored)'));
      if (reason === null) return;
      try { await api(`/bills/${b.id}/cancel`, { body: { reason } }); toast(t('Bill cancelled'), 'success'); m.close(); route(); } catch (e) { fail(e); }
    });
  }

  async function showBill(id) {
    try { showReceipt(await api('/bills/' + id)); } catch (e) { fail(e); }
  }

  // ------------------------------------------------------------------ bills list
  VIEWS.bills = async (view) => {
    const all = can('bills.view_all');
    setTitle(t(all ? 'All Bills' : 'My Bills'), all ? '<button class="btn" id="csv">⬇ CSV</button>' : '');
    const f = store.get('billFilter', { from: localDate(), to: localDate(), q: '', status: '' });
    view.innerHTML = `
      <div class="toolbar">
        <input class="input" id="bq" placeholder="${t('Bill no, customer name or phone')}" value="${esc(f.q)}">
        <input class="input" type="date" id="bfrom" value="${esc(f.from)}" style="flex:0 1 160px">
        <input class="input" type="date" id="bto" value="${esc(f.to)}" style="flex:0 1 160px">
        <select class="input" id="bstatus"><option value="">${t('All status')}</option><option value="paid">${t('Paid')}</option><option value="partial">${t('Partial')}</option><option value="credit">${t('Udhaar')}</option><option value="cancelled">${t('Cancelled')}</option></select>
      </div>
      <div class="card" id="bills-list"></div>`;
    $('#bstatus').value = f.status;
    let rows = [];
    const load = async () => {
      Object.assign(f, { q: $('#bq').value.trim(), from: $('#bfrom').value, to: $('#bto').value, status: $('#bstatus').value });
      store.set('billFilter', f);
      const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
      rows = await api('/bills?' + qs);
      const live = rows.filter((r) => r.status !== 'cancelled');
      const total = live.reduce((s, r) => s + r.total, 0);
      $('#bills-list').innerHTML = rows.length ? `
        <div class="card-head"><h3>${t('{n} bills', { n: rows.length })}</h3><span class="num"><b>${money(total)}</b></span></div>
        <div class="table-wrap"><table class="table responsive"><thead><tr><th>${t('Bill')}</th><th>${t('Date')}</th><th>${t('Customer')}</th><th>${t('Items')}</th><th>${t('Payment')}</th>${all ? `<th>${t('Cashier')}</th>` : ''}<th>${t('Status')}</th><th class="right">${t('Total')}</th></tr></thead>
        <tbody>${rows.map((b) => `<tr class="clickable" data-bill="${b.id}">
          <td class="primary-cell">${esc(b.bill_no)}</td><td data-label="${t('Date')}" class="nowrap">${dt(b.created_at)}</td>
          <td data-label="${t('Customer')}">${esc(b.customer_name || t('Walk-in'))}${b.customer_phone ? `<div class="small muted">${esc(b.customer_phone)}</div>` : ''}</td>
          <td data-label="${t('Items')}">${b.item_count}</td><td data-label="${t('Payment')}">${esc(modeLabel(b.payment_mode))}</td>
          ${all ? `<td data-label="${t('Cashier')}">${esc(b.cashier)}</td>` : ''}
          <td data-label="${t('Status')}">${statusBadge(b.status)}${b.due > 0 ? `<div class="small" style="color:var(--danger)">${t('Due {amt}', { amt: money(b.due) })}</div>` : ''}</td>
          <td data-label="${t('Total')}" class="right num"><b>${money(b.total)}</b></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">${t('No bills found for this filter')}</div>`;
      $$('[data-bill]', view).forEach((tr) => (tr.onclick = () => showBill(tr.dataset.bill)));
    };
    $('#bq').oninput = debounce(load, 300);
    ['#bfrom', '#bto', '#bstatus'].forEach((s) => ($(s).onchange = load));
    $('#csv')?.addEventListener('click', () => {
      const head = ['Bill No', 'Date', 'Customer', 'Phone', 'Items', 'Payment', 'Cashier', 'Status', 'Total', 'Paid', 'Due'];
      const csv = [head, ...rows.map((b) => [b.bill_no, b.created_at, b.customer_name, b.customer_phone, b.item_count, modeLabel(b.payment_mode), b.cashier, b.status, b.total, b.paid, b.due])]
        .map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `pise-kirana-bills-${f.from}-to-${f.to}.csv`; a.click();
    });
    await load();
  };

  // ------------------------------------------------------------------ inventory
  VIEWS.products = async (view, arg) => {
    const edit = can('products.edit');
    setTitle(t('Inventory'), edit ? `<button class="btn primary" id="add-prod">＋ ${t('Add item')}</button>` : '');
    view.innerHTML = `
      <div class="tabs"><button data-tab="all">${t('All items')}</button><button data-tab="low">⚠️ ${t('Low stock')}</button>${edit ? `<button data-tab="inactive">${t('Hidden')}</button>` : ''}</div>
      <div class="toolbar"><input class="input" id="pq" placeholder="${t('Search by name, barcode or category')}"><select class="input" id="pcat"><option value="">${t('All categories')}</option></select></div>
      <div class="card" id="plist"></div>`;
    let tab = arg === 'low' ? 'low' : 'all';
    let products = [];
    const cats = await api('/products/categories');
    $('#pcat').innerHTML += cats.map((c) => `<option>${esc(c.category)}</option>`).join('');
    const draw = () => {
      $$('[data-tab]', view).forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      const q = $('#pq').value.trim().toLowerCase(); const cat = $('#pcat').value;
      const list = products.filter((p) => (tab === 'inactive' ? !p.active : p.active) && (tab !== 'low' || p.stock <= p.low_stock) && (!cat || p.category === cat) &&
        (!q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q) || p.category.toLowerCase().includes(q)));
      const val = list.reduce((s, p) => s + Math.max(0, p.stock) * p.cost, 0);
      $('#plist').innerHTML = list.length ? `
        <div class="card-head"><h3>${t('{n} items', { n: list.length })}</h3>${edit ? `<span class="small muted">${t('Stock value {v}', { v: money0(val) })}</span>` : ''}</div>
        <div class="table-wrap"><table class="table responsive"><thead><tr><th>${t('Item')}</th><th>${t('Category')}</th><th class="right">${t('Price')}</th>${edit ? `<th class="right">${t('Cost')}</th><th class="right">${t('Margin')}</th>` : ''}<th class="right">${t('Stock')}</th><th></th></tr></thead>
        <tbody>${list.map((p) => {
          const low = p.stock <= p.low_stock;
          const margin = p.price ? ((p.price - p.cost) / p.price) * 100 : 0;
          return `<tr data-id="${p.id}">
            <td class="primary-cell">${esc(p.name)}${p.barcode ? `<div class="small muted">${esc(p.barcode)}</div>` : ''}</td>
            <td data-label="${t('Category')}">${esc(p.category)}</td>
            <td data-label="${t('Price')}" class="right num"><span>${money(p.price)}<span class="small muted">/${esc(p.unit)}</span></span></td>
            ${edit ? `<td data-label="${t('Cost')}" class="right num">${money(p.cost)}</td><td data-label="${t('Margin')}" class="right num">${margin.toFixed(0)}%</td>` : ''}
            <td data-label="${t('Stock')}" class="right"><span class="badge ${p.stock <= 0 ? 'red' : low ? 'amber' : 'green'}">${qtyFmt(p.stock)} ${esc(p.unit)}</span></td>
            <td class="right nowrap">${edit ? `<button class="btn sm" data-stock>${t('+ Stock')}</button> <button class="btn sm ghost" data-edit>${t('Edit')}</button>` : `<button class="btn sm ghost" data-hist>${t('History')}</button>`}</td>
          </tr>`;
        }).join('')}</tbody></table></div>` : `<div class="empty">${t(tab === 'low' ? 'No low-stock items 👍' : 'No items found')}</div>`;
      $$('tr[data-id]', view).forEach((tr) => {
        const p = products.find((x) => x.id === Number(tr.dataset.id));
        $('[data-edit]', tr)?.addEventListener('click', () => productForm(p, reload));
        $('[data-stock]', tr)?.addEventListener('click', () => stockForm(p, reload));
        $('[data-hist]', tr)?.addEventListener('click', () => stockHistory(p));
      });
    };
    const reload = async () => { products = await api('/products?all=1'); draw(); };
    $$('[data-tab]', view).forEach((b) => (b.onclick = () => { tab = b.dataset.tab; draw(); }));
    $('#pq').oninput = debounce(draw, 150);
    $('#pcat').onchange = draw;
    $('#add-prod')?.addEventListener('click', () => productForm(null, reload));
    await reload();
  };

  function productForm(p, done) {
    const isNew = !p; p = p || { unit: 'pcs', gst_rate: 0, low_stock: 5, category: 'General', active: 1 };
    const m = modal({
      title: isNew ? t('Add new item') : t('Edit · {name}', { name: p.name }), wide: true,
      body: `<form id="pform" class="grid-2">
        <label class="field full">${t('Item name *')}<input class="input" name="name" required maxlength="120" value="${esc(p.name || '')}"></label>
        <label class="field">${t('Barcode')}<input class="input" name="barcode" maxlength="60" value="${esc(p.barcode || '')}" placeholder="${t('Scan or type')}"></label>
        <label class="field">${t('Category')}<input class="input" name="category" list="cat-list" value="${esc(p.category || '')}"></label>
        <datalist id="cat-list">${[...new Set(state.products.map((x) => x.category))].map((c) => `<option>${esc(c)}</option>`).join('')}</datalist>
        <label class="field">${t('Unit')}<select class="input" name="unit">${['pcs', 'kg', 'g', 'l', 'ml', 'pack', 'box', 'dozen', 'bottle'].map((u) => `<option ${u === p.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
        <label class="field">GST %<select class="input" name="gst_rate">${[0, 5, 12, 18, 28].map((g) => `<option value="${g}" ${Number(p.gst_rate) === g ? 'selected' : ''}>${g}%</option>`).join('')}</select></label>
        <label class="field">${t('Selling price (₹) *')}<input class="input" name="price" type="number" step="0.01" min="0" required value="${p.price ?? ''}" inputmode="decimal"></label>
        <label class="field">MRP (₹)<input class="input" name="mrp" type="number" step="0.01" min="0" value="${p.mrp ?? ''}" inputmode="decimal"></label>
        <label class="field">${t('Purchase cost (₹)')}<input class="input" name="cost" type="number" step="0.01" min="0" value="${p.cost ?? ''}" inputmode="decimal"></label>
        <label class="field">${t('Low stock alert at')}<input class="input" name="low_stock" type="number" step="any" min="0" value="${p.low_stock ?? 5}" inputmode="decimal"></label>
        ${isNew ? `<label class="field">${t('Opening stock')}<input class="input" name="stock" type="number" step="any" min="0" value="0" inputmode="decimal"></label>` : ''}
        ${isNew ? '' : `<label class="check full"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> ${t('Show this item in billing (uncheck to hide)')}</label>`}
      </form>`,
      foot: `${isNew ? '' : `<button class="btn ghost" id="p-hist" type="button">${t('Stock history')}</button><span class="grow"></span>`}<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" form="pform">${t('Save')}</button>`,
    });
    $('#p-hist', m.el)?.addEventListener('click', () => stockHistory(p));
    $('#pform', m.el).onsubmit = async (e) => {
      e.preventDefault();
      const body = formData(e.target);
      if (!isNew) body.active = e.target.active.checked;
      try {
        await api(isNew ? '/products' : `/products/${p.id}`, { method: isNew ? 'POST' : 'PUT', body });
        toast(t('Item saved'), 'success'); m.close(); done && done();
      } catch (err) { fail(err); }
    };
  }

  function stockForm(p, done) {
    const m = modal({
      title: t('Stock · {name}', { name: p.name }),
      body: `<p class="muted" style="margin-top:0">${t('Current stock')}: <b>${qtyFmt(p.stock)} ${esc(p.unit)}</b></p>
        <div class="tabs"><button data-t="purchase" class="active">${t('Stock in (purchase)')}</button><button data-t="adjust">${t('Correct / adjust')}</button></div>
        <form id="sform" class="stack">
          <div id="s-purchase" class="grid-2">
            <label class="field">${esc(t('Quantity received ({u})', { u: p.unit }))}<input class="input" name="qty" type="number" step="any" min="0" inputmode="decimal"></label>
            <label class="field">${esc(t('Cost per {u} (₹)', { u: p.unit }))}<input class="input" name="cost" type="number" step="0.01" min="0" value="${p.cost}" inputmode="decimal"></label>
          </div>
          <div id="s-adjust" hidden><label class="field">${esc(t('Actual stock counted ({u})', { u: p.unit }))}<input class="input" name="set_to" type="number" step="any" value="${qtyFmt(p.stock)}" inputmode="decimal"></label>
            <div class="small muted" style="margin-top:4px">${t('Use for damage, expiry, theft or counting corrections.')}</div></div>
          <label class="field">${t('Note')}<input class="input" name="note" maxlength="200" placeholder="${t('Supplier / invoice no / reason')}"></label>
        </form>`,
      foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" form="sform">${t('Update stock')}</button>`,
    });
    let type = 'purchase';
    $$('[data-t]', m.el).forEach((b) => (b.onclick = () => {
      type = b.dataset.t; $$('[data-t]', m.el).forEach((x) => x.classList.toggle('active', x === b));
      $('#s-purchase', m.el).hidden = type !== 'purchase'; $('#s-adjust', m.el).hidden = type !== 'adjust';
    }));
    $('#sform', m.el).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const body = type === 'purchase' ? { type, qty: Number(f.qty), cost: f.cost, note: f.note } : { type, set_to: Number(f.set_to), note: f.note };
      try { await api(`/products/${p.id}/stock`, { body }); toast(t('Stock updated'), 'success'); m.close(); done && done(); } catch (err) { fail(err); }
    };
  }

  async function stockHistory(p) {
    try {
      const moves = await api(`/products/${p.id}/moves`);
      const label = { sale: 'Sale', purchase: 'Stock in', adjust: 'Adjustment', cancel: 'Bill cancelled', opening: 'Opening' };
      modal({
        title: t('History · {name}', { name: p.name }), wide: true,
        body: moves.length ? `<div class="table-wrap"><table class="table responsive"><thead><tr><th>${t('Date')}</th><th>${t('Type')}</th><th class="right">${t('Change')}</th><th>${t('Ref / note')}</th><th>${t('By')}</th></tr></thead><tbody>
          ${moves.map((mv) => `<tr><td class="primary-cell">${dt(mv.created_at)}</td><td data-label="${t('Type')}">${label[mv.reason] ? t(label[mv.reason]) : esc(mv.reason)}</td>
            <td data-label="${t('Change')}" class="right num" style="color:${mv.change < 0 ? 'var(--danger)' : 'var(--brand)'}"><b>${mv.change > 0 ? '+' : ''}${qtyFmt(mv.change)}</b></td>
            <td data-label="${t('Ref / note')}">${esc(mv.ref || '')} ${esc(mv.note || '')}</td><td data-label="${t('By')}">${esc(mv.user_name || '')}</td></tr>`).join('')}</tbody></table></div>`
          : `<div class="empty">${t('No stock movement yet')}</div>`,
      });
    } catch (e) { fail(e); }
  }

  // ------------------------------------------------------------------ customers
  VIEWS.customers = async (view) => {
    setTitle(t('Customers & Udhaar'), can('customers.edit') ? `<button class="btn primary" id="add-cust">${t('+ Customer')}</button>` : '');
    view.innerHTML = `
      <div class="toolbar"><input class="input" id="cq" placeholder="${t('Search name or mobile')}"><label class="check"><input type="checkbox" id="cdue"> ${t('Only with udhaar due')}</label></div>
      <div class="card" id="clist"></div>`;
    const load = async () => {
      const qs = new URLSearchParams({ q: $('#cq').value.trim(), due: $('#cdue').checked ? '1' : '' });
      const list = await api('/customers?' + qs);
      const due = list.reduce((s, c) => s + Math.max(0, c.balance), 0);
      $('#clist').innerHTML = list.length ? `
        <div class="card-head"><h3>${t('{n} customers', { n: list.length })}</h3><span>${t('Total due')} <b style="color:var(--danger)">${money(due)}</b></span></div>
        <div class="table-wrap"><table class="table responsive"><thead><tr><th>${t('Name')}</th><th>${t('Mobile')}</th><th>${t('Since')}</th><th class="right">${t('Udhaar due')}</th><th></th></tr></thead>
        <tbody>${list.map((c) => `<tr class="clickable" data-id="${c.id}"><td class="primary-cell">${esc(c.name)}</td><td data-label="${t('Mobile')}">${esc(c.phone || '-')}</td>
          <td data-label="${t('Since')}" class="small muted">${esc((c.created_at || '').slice(0, 10))}</td>
          <td data-label="${t('Udhaar due')}" class="right num">${c.balance > 0.009 ? `<b style="color:var(--danger)">${money(c.balance)}</b>` : '<span class="muted">—</span>'}</td>
          <td class="right">${c.balance > 0.009 && can('payments.collect') ? `<button class="btn sm primary" data-collect>${t('Collect')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">${t('No customers found')}</div>`;
      $$('tr[data-id]', view).forEach((tr) => {
        const c = list.find((x) => x.id === Number(tr.dataset.id));
        tr.onclick = (e) => { if (e.target.closest('[data-collect]')) collectPayment(c, load); else customerDetail(c.id, load); };
      });
    };
    $('#cq').oninput = debounce(load, 250);
    $('#cdue').onchange = load;
    $('#add-cust')?.addEventListener('click', () => customerForm(null, load));
    await load();
  };

  function customerForm(c, done) {
    const isNew = !c; c = c || {};
    const m = modal({
      title: t(isNew ? 'Add customer' : 'Edit customer'),
      body: `<form id="cform" class="stack">
        <label class="field">${t('Name *')}<input class="input" name="name" required maxlength="80" value="${esc(c.name || '')}"></label>
        <label class="field">${t('Mobile')}<input class="input" name="phone" type="tel" inputmode="tel" maxlength="15" value="${esc(c.phone || '')}"></label>
        <label class="field">${t('Address')}<input class="input" name="address" maxlength="200" value="${esc(c.address || '')}"></label></form>`,
      foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" form="cform">${t('Save')}</button>`,
    });
    $('#cform', m.el).onsubmit = async (e) => {
      e.preventDefault();
      try { await api(isNew ? '/customers' : `/customers/${c.id}`, { method: isNew ? 'POST' : 'PUT', body: formData(e.target) }); toast(t('Customer saved'), 'success'); m.close(); done && done(); }
      catch (err) { fail(err); }
    };
  }

  function collectPayment(c, done) {
    let mode = 'cash';
    const m = modal({
      title: t('Collect udhaar · {name}', { name: c.name }),
      body: `<div class="due-box due" style="margin-bottom:14px"><span>${t('Total due')}</span><span>${money(c.balance)}</span></div>
        <form id="payf" class="stack">
          <div class="pay-modes" style="grid-template-columns:repeat(3,1fr)">
            <button type="button" class="pay-mode active" data-mode="cash"><span class="ico">💵</span>${t('Cash')}</button>
            <button type="button" class="pay-mode" data-mode="upi"><span class="ico">📱</span>${t('UPI')}</button>
            <button type="button" class="pay-mode" data-mode="card"><span class="ico">💳</span>${t('Card')}</button></div>
          <label class="field">${t('Amount received (₹)')}<input class="input" name="amount" type="number" step="0.01" min="0.01" max="${c.balance}" value="${c.balance}" required inputmode="decimal" style="font-size:20px;font-weight:700"></label>
          <label class="field">${t('Note')}<input class="input" name="note" maxlength="200"></label></form>`,
      foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" form="payf">${t('Save payment')}</button>`,
    });
    $$('.pay-mode', m.el).forEach((b) => (b.onclick = () => { mode = b.dataset.mode; $$('.pay-mode', m.el).forEach((x) => x.classList.toggle('active', x === b)); }));
    $('#payf', m.el).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      try {
        const r = await api(`/customers/${c.id}/payments`, { body: { amount: Number(f.amount), mode, note: f.note } });
        toast(t('Payment saved. Remaining due {v}', { v: money(r.balance) }), 'success'); m.close(); done && done();
      } catch (err) { fail(err); }
    };
  }

  async function customerDetail(id, done) {
    try {
      const c = await api('/customers/' + id);
      const m = modal({
        title: c.name, wide: true,
        body: `<div class="row" style="margin-bottom:12px"><div class="grow"><div>📞 ${esc(c.phone || '-')}</div>${c.address ? `<div class="muted small">${esc(c.address)}</div>` : ''}</div>
            <div class="due-box ${c.balance > 0.009 ? 'due' : 'change'}" style="gap:16px"><span>${t('Due')}</span><span>${money(c.balance)}</span></div></div>
          <h4 style="margin:10px 0 6px">${t('Bills')}</h4>
          ${c.bills.length ? `<div class="table-wrap card"><table class="table responsive"><tbody>${c.bills.map((b) => `<tr class="clickable" data-bill="${b.id}"><td class="primary-cell">${esc(b.bill_no)}</td>
            <td data-label="${t('Date')}">${dt(b.created_at)}</td><td data-label="${t('Status')}">${statusBadge(b.status)}</td><td data-label="${t('Total')}" class="right num">${money(b.total)}</td>
            <td data-label="${t('Due')}" class="right num">${b.due > 0 ? `<span style="color:var(--danger)">${money(b.due)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : `<div class="muted">${t('No bills')}</div>`}
          <h4 style="margin:16px 0 6px">${t('Payments')}</h4>
          ${c.payments.length ? `<div class="table-wrap card"><table class="table responsive"><tbody>${c.payments.map((p) => `<tr><td class="primary-cell">${money(p.amount)}</td>
            <td data-label="${t('Mode')}">${esc(modeLabel(p.mode))}</td><td data-label="${t('Type')}">${t(p.kind === 'due_collection' ? 'Udhaar paid' : p.kind === 'refund' ? 'Refund' : 'At billing')}</td>
            <td data-label="${t('Date')}">${dt(p.created_at)}</td><td data-label="${t('By')}">${esc(p.user_name || '')}</td></tr>`).join('')}</tbody></table></div>` : `<div class="muted">${t('No payments')}</div>`}`,
        foot: `${can('customers.edit') ? `<button class="btn" id="c-edit">${t('Edit')}</button>` : ''}
          ${c.phone && c.balance > 0.009 ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${c.phone.replace(/\D/g, '').length === 10 ? '91' : ''}${esc(c.phone.replace(/\D/g, ''))}?text=${encodeURIComponent(t('Namaste {name}, your pending balance at {shop} is ₹{amt}. Kindly pay at your convenience. Thank you!', { name: c.name, shop: shopName(), amt: c.balance.toFixed(2) }))}">${t('WhatsApp reminder')}</a>` : ''}
          ${c.balance > 0.009 && can('payments.collect') ? `<button class="btn primary" id="c-collect">${t('Collect payment')}</button>` : ''}`,
      });
      $$('[data-bill]', m.el).forEach((tr) => (tr.onclick = () => showBill(tr.dataset.bill)));
      $('#c-edit', m.el)?.addEventListener('click', () => { m.close(); customerForm(c, done); });
      $('#c-collect', m.el)?.addEventListener('click', () => { m.close(); collectPayment(c, done); });
    } catch (e) { fail(e); }
  }

  // ------------------------------------------------------------------ reports
  VIEWS.reports = async (view) => {
    setTitle(t('Reports'));
    const presets = {
      today: [localDate(), localDate()], yesterday: [addDays(-1), addDays(-1)], week: [addDays(-6), localDate()],
      month: [localDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), localDate()], days30: [addDays(-29), localDate()],
    };
    view.innerHTML = `
      <div class="toolbar">
        <div class="chips" style="padding:0;flex:1 1 100%">${[['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Last 7 days'], ['month', 'This month'], ['days30', 'Last 30 days']].map(([k, l]) => `<button class="chip" data-p="${k}">${t(l)}</button>`).join('')}</div>
        <input class="input" type="date" id="rfrom" style="flex:0 1 170px"><span class="muted">${t('to')}</span><input class="input" type="date" id="rto" style="flex:0 1 170px">
        <button class="btn" id="rprint">🖨️ ${t('Print')}</button>
      </div>
      <div id="rbody"></div>`;
    const load = async () => {
      const r = await api(`/reports?from=${$('#rfrom').value}&to=${$('#rto').value}`);
      const s = r.summary;
      const pm = {};
      for (const p of r.payments) { pm[p.mode] = pm[p.mode] || { sale: 0, due_collection: 0, refund: 0 }; pm[p.mode][p.kind] = p.amount; }
      const maxD = Math.max(1, ...r.daily.map((d) => d.sales));
      const maxC = Math.max(1, ...r.byCategory.map((c) => c.amount));
      $('#rbody').innerHTML = `
        <div class="stats">
          <div class="card stat green"><div class="label">${t('Net sales')}</div><div class="value">${money0(s.sales)}</div><div class="sub">${t('{n} bills · avg {v}', { n: s.bills, v: money0(s.avg_bill) })}</div></div>
          <div class="card stat amber"><div class="label">${t('Gross profit')}</div><div class="value">${money0(s.profit)}</div><div class="sub">${t('{p}% margin', { p: s.sales ? ((s.profit / s.sales) * 100).toFixed(1) : 0 })}</div></div>
          <div class="card stat"><div class="label">${t('Discounts')}</div><div class="value">${money0(s.discount)}</div><div class="sub">${t('GST incl. {v}', { v: money0(s.tax) })}</div></div>
          <div class="card stat red"><div class="label">${t('Udhaar (unpaid)')}</div><div class="value">${money0(s.credit)}</div><div class="sub">${t('from these bills')}</div></div>
        </div>
        <div class="two-col">
          <div class="stack">
            <div class="card"><div class="card-head"><h3>${t('Daily sales')}</h3></div><div class="card-pad">${r.daily.length ? `<div class="bars" style="overflow-x:auto">${r.daily.map((d) => `<div class="bar" style="min-width:${r.daily.length > 14 ? 26 : 34}px" title="${esc(d.day)}: ${money(d.sales)} (${d.bills} bills)"><div class="val">${r.daily.length <= 10 ? money0(d.sales) : ''}</div><div class="fill" style="height:${(d.sales / maxD) * 100}%"></div><div class="lbl">${dShort(d.day)}</div></div>`).join('')}</div>` : `<div class="empty">${t('No sales')}</div>`}</div></div>
            <div class="card"><div class="card-head"><h3>${t('Top selling items')}</h3></div>${r.top.length ? `<div class="table-wrap"><table class="table responsive"><thead><tr><th>${t('Item')}</th><th class="right">${t('Qty')}</th><th class="right">${t('Sales')}</th><th class="right">${t('Margin')}</th></tr></thead><tbody>
              ${r.top.map((x) => `<tr><td class="primary-cell">${esc(x.name)}</td><td data-label="${t('Qty')}" class="right num">${qtyFmt(x.qty)} ${esc(x.unit || '')}</td><td data-label="${t('Sales')}" class="right num">${money(x.amount)}</td><td data-label="${t('Margin')}" class="right num">${money(x.margin)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${t('No data')}</div>`}</div>
          </div>
          <div class="stack">
            <div class="card"><div class="card-head"><h3>${t('Money collected')}</h3></div>
              ${['cash', 'upi', 'card'].map((k) => { const v = pm[k] || {}; const net = (v.sale || 0) + (v.due_collection || 0) + (v.refund || 0);
                return `<div class="list-item"><span class="grow"><b>${modeLabel(k)}</b><div class="small muted">${t('Sales {a} · Udhaar recd {b}', { a: money(v.sale || 0), b: money(v.due_collection || 0) })}${v.refund ? ` · ${t('Refund {v}', { v: money(v.refund) })}` : ''}</div></span><b class="num">${money(net)}</b></div>`; }).join('')}
            </div>
            <div class="card"><div class="card-head"><h3>${t('By category')}</h3></div>${r.byCategory.length ? r.byCategory.map((c) => `<div class="list-item" style="display:block"><div class="row"><span class="grow">${esc(c.category)}</span><b class="num">${money(c.amount)}</b></div><div class="hbar"><span style="width:${(c.amount / maxC) * 100}%"></span></div></div>`).join('') : `<div class="empty">${t('No data')}</div>`}</div>
            <div class="card"><div class="card-head"><h3>${t('By staff')}</h3></div>${r.byStaff.length ? r.byStaff.map((u) => `<div class="list-item"><span class="grow">${esc(u.name)} ${roleBadge(u.role)}<div class="small muted">${t('{n} bills', { n: u.bills })}</div></span><b class="num">${money(u.sales)}</b></div>`).join('') : `<div class="empty">${t('No data')}</div>`}</div>
          </div>
        </div>`;
    };
    const setPreset = (k) => { [$('#rfrom').value, $('#rto').value] = presets[k]; $$('[data-p]', view).forEach((b) => b.classList.toggle('active', b.dataset.p === k)); load(); };
    $$('[data-p]', view).forEach((b) => (b.onclick = () => setPreset(b.dataset.p)));
    ['#rfrom', '#rto'].forEach((s) => ($(s).onchange = () => { $$('[data-p]', view).forEach((b) => b.classList.remove('active')); load(); }));
    $('#rprint').onclick = () => {
      $('#print-area').innerHTML = `<div style="font-family:sans-serif;color:#000"><h2>${esc(shopName())} — ${t('Sales report')} ${esc($('#rfrom').value)} ${t('to')} ${esc($('#rto').value)}</h2>${$('#rbody').innerHTML}</div>`;
      setTimeout(() => window.print(), 50);
    };
    setPreset('today');
  };

  // ------------------------------------------------------------------ users
  VIEWS.users = async (view) => {
    setTitle(t('Staff & Users'), `<button class="btn primary" id="add-user">＋ ${t('Add user')}</button>`);
    const load = async () => {
      const users = await api('/users');
      view.innerHTML = `
        <div class="card card-pad small muted" style="margin-bottom:14px">
          <b>${t('Admin')}</b> — ${t('full control incl. admin accounts')} · <b>${t('Owner')}</b> — ${t('everything in the shop: inventory, reports, staff, settings')} ·
          <b>${t('Employee')}</b> — ${esc(t('billing, taking payments, viewing stock & customers, own bills only'))}.</div>
        <div class="card"><div class="table-wrap"><table class="table responsive"><thead><tr><th>${t('Name')}</th><th>${t('Username')}</th><th>${t('Role')}</th><th>${t('Mobile')}</th><th>${t('Status')}</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr data-id="${u.id}"><td class="primary-cell">${esc(u.name)}${u.id === state.user.id ? ` <span class="small muted">${t('(you)')}</span>` : ''}</td>
          <td data-label="${t('Username')}">${esc(u.username)}</td><td data-label="${t('Role')}">${roleBadge(u.role)}</td><td data-label="${t('Mobile')}">${esc(u.phone || '-')}</td>
          <td data-label="${t('Status')}">${u.active ? `<span class="badge green">${t('Active')}</span>` : `<span class="badge gray">${t('Disabled')}</span>`}</td>
          <td class="right">${u.role === 'admin' && state.user.role !== 'admin' ? '' : `<button class="btn sm" data-edit>${t('Edit')}</button>`}</td></tr>`).join('')}</tbody></table></div></div>`;
      $$('[data-edit]', view).forEach((b) => (b.onclick = () => userForm(users.find((u) => u.id === Number(b.closest('tr').dataset.id)), load)));
    };
    $('#add-user').onclick = () => userForm(null, load);
    await load();
  };

  function userForm(u, done) {
    const isNew = !u; u = u || { role: 'employee', active: 1 };
    const roles = state.user.role === 'admin' ? ['employee', 'owner', 'admin'] : ['employee', 'owner'];
    const m = modal({
      title: isNew ? t('Add user') : t('Edit · {name}', { name: u.name }),
      body: `<form id="uform" class="grid-2">
        <label class="field full">${t('Full name *')}<input class="input" name="name" required maxlength="80" value="${esc(u.name || '')}"></label>
        <label class="field">${t('Username *')}<input class="input" name="username" ${isNew ? 'required' : 'readonly'} pattern="[A-Za-z0-9._\\-]{3,40}" autocapitalize="none" value="${esc(u.username || '')}"></label>
        <label class="field">${t('Mobile')}<input class="input" name="phone" type="tel" maxlength="15" value="${esc(u.phone || '')}"></label>
        <label class="field">${t('Role')}<select class="input" name="role">${roles.map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${t(r[0].toUpperCase() + r.slice(1))}</option>`).join('')}</select></label>
        <label class="field">${t(isNew ? 'Password *' : 'New password')}<input class="input" name="password" type="password" minlength="6" autocomplete="new-password" ${isNew ? 'required' : `placeholder="${t('Leave blank to keep')}"`}></label>
        ${isNew ? '' : `<label class="check full"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> ${t('Account active (can log in)')}</label>`}
      </form>`,
      foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" form="uform">${t('Save')}</button>`,
    });
    $('#uform', m.el).onsubmit = async (e) => {
      e.preventDefault();
      const body = formData(e.target);
      if (!isNew) { body.active = e.target.active.checked; delete body.username; if (!body.password) delete body.password; }
      try { await api(isNew ? '/users' : `/users/${u.id}`, { method: isNew ? 'POST' : 'PUT', body }); toast(t('User saved'), 'success'); m.close(); done && done(); }
      catch (err) { fail(err); }
    };
  }

  // ------------------------------------------------------------------ settings
  VIEWS.settings = async (view) => {
    setTitle(t('Settings'));
    const s = state.settings;
    const edit = can('settings.edit');
    view.innerHTML = `
      <div class="two-col">
        <div class="stack">
          ${edit ? `<div class="card"><div class="card-head"><h3>🏪 ${t('Shop details (printed on bills)')}</h3></div><div class="card-pad">
            <form id="sform" class="grid-2">
              <label class="field">${t('Shop name')}<input class="input" name="shop_name" value="${esc(s.shop_name)}" maxlength="80"></label>
              <label class="field">${t('Tagline')}<input class="input" name="shop_tagline" value="${esc(s.shop_tagline)}" maxlength="120"></label>
              <label class="field full">${t('Address')}<input class="input" name="shop_address" value="${esc(s.shop_address)}" maxlength="200"></label>
              <label class="field">${t('Phone')}<input class="input" name="shop_phone" value="${esc(s.shop_phone)}" maxlength="30"></label>
              <label class="field">GSTIN<input class="input" name="gstin" value="${esc(s.gstin)}" maxlength="20"></label>
              <label class="field">${t('UPI ID (for payments)')}<input class="input" name="upi_id" value="${esc(s.upi_id)}" maxlength="60" placeholder="pisekirana@upi"></label>
              <label class="field">${t('Bill footer')}<input class="input" name="bill_footer" value="${esc(s.bill_footer)}" maxlength="120"></label>
              <label class="check full"><input type="checkbox" name="allow_negative_stock" ${s.allow_negative_stock === '1' ? 'checked' : ''}> ${t('Allow billing items even when stock shows 0')}</label>
              <div class="full"><button class="btn primary">${t('Save shop details')}</button></div>
            </form></div></div>` : ''}
          <div class="card"><div class="card-head"><h3>🔑 ${t('Change my password')}</h3></div><div class="card-pad">
            <form id="pwform" class="grid-2">
              <label class="field full">${t('Current password')}<input class="input" name="current" type="password" required autocomplete="current-password"></label>
              <label class="field">${t('New password')}<input class="input" name="password" type="password" minlength="6" required autocomplete="new-password"></label>
              <label class="field">${t('Confirm new password')}<input class="input" name="confirm" type="password" minlength="6" required autocomplete="new-password"></label>
              <div class="full"><button class="btn primary">${t('Update password')}</button></div>
            </form></div></div>
        </div>
        <div class="stack">
          <div class="card"><div class="card-head"><h3>👤 ${t('My account')}</h3></div>
            <div class="list-item"><div class="avatar">${esc(state.user.name[0])}</div><div class="grow"><b>${esc(state.user.name)}</b><div class="small muted">@${esc(state.user.username)}</div></div>${roleBadge(state.user.role)}</div>
            <div class="card-pad"><button class="btn danger block" id="s-logout">${t('Logout')}</button></div></div>
          <div class="card"><div class="card-head"><h3>🌐 ${t('Language')} · भाषा</h3></div><div class="card-pad">${langSelect('set-lang')}</div></div>
          <div class="card"><div class="card-head"><h3>🎨 ${t('Appearance')}</h3></div><div class="card-pad">
            <select class="input" id="theme"><option value="auto">${t('Match device')}</option><option value="light">${t('Light')}</option><option value="dark">${t('Dark')}</option></select></div></div>
          <div class="card card-pad small muted">📱 <b>${t('Install on phone:')}</b> ${t('open this page in Chrome → menu ⋮ → Add to Home screen. On iPhone Safari → Share → Add to Home Screen.')}<br><br>
            🖨️ ${t('Bills print in 80mm thermal format; any normal printer also works.')}<br><br>🔍 ${t('USB / Bluetooth barcode scanners work directly in the billing search box.')}</div>
        </div>
      </div>`;
    $('#theme').value = store.get('theme', 'auto');
    $('#theme').onchange = (e) => { store.set('theme', e.target.value); applyTheme(); };
    $('#s-logout').onclick = logout;
    bindLang($('#set-lang'), () => { renderShell(); route(); });
    $('#sform')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = formData(e.target); body.allow_negative_stock = e.target.allow_negative_stock.checked ? '1' : '0';
      try { state.settings = await api('/settings', { method: 'PUT', body }); toast(t('Shop details saved'), 'success'); renderShell(); route(); } catch (err) { fail(err); }
    });
    $('#pwform').onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      if (f.password !== f.confirm) return toast(t('New passwords do not match'), 'error');
      try { await api('/me/password', { body: f }); toast(t('Password updated'), 'success'); e.target.reset(); } catch (err) { fail(err); }
    };
  };

  // ------------------------------------------------------------------ boot
  async function boot() {
    try {
      const me = await api('/me');
      Object.assign(state, { user: me.user, perms: me.permissions, settings: me.settings });
      try { state.demo = (await (await fetch('/api/public')).json()).demo; } catch { /* ignore */ }
      renderShell();
      route();
    } catch {
      try { state.settings = await (await fetch('/api/public')).json(); state.demo = state.settings.demo; } catch { state.settings = {}; }
      renderLogin();
    }
  }
  boot();
})();
