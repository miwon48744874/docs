const $ = selector => document.querySelector(selector);
const formatPrice = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
function parsePrice(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Enter a price with up to two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 100_000_000) throw new Error('Price must not exceed $1,000,000.00.');
  return cents;
}
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
async function api(path, options = {}) {
  const headers = options.body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'flash-app' } : {};
  const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}
function message(text, success = false) {
  const target = $('#message');
  if (!target) return;
  target.hidden = false;
  target.className = `message${success ? ' success' : ''}`;
  target.textContent = text;
}
function showPage() { $('#home-page').hidden = true; $('#page-content').hidden = false; }
function setupNav(user) {
  const nav = $('#auth-nav');
  if (user) nav.innerHTML = `${user.role === 'admin' ? '<a href="/admin">Admin</a>' : ''}<a href="/dashboard">Dashboard</a><button class="logout" id="nav-logout" type="button">Sign out</button>`;
  $('#nav-logout')?.addEventListener('click', signOut);
}
async function signOut() {
  await api('/api/logout', { method: 'POST', body: {} });
  location.href = '/';
}
function authPage(mode) {
  showPage();
  const signup = mode === 'signup';
  const selectedProduct = new URLSearchParams(location.search).get('product');
  const productQuery = selectedProduct ? `?product=${encodeURIComponent(selectedProduct)}` : '';
  $('#page-content').innerHTML = `<div class="auth-shell"><a href="/" class="text-link">← Back to home</a><div class="auth-card"><span class="section-tag">SECURE CUSTOMER ACCESS</span><h1>${signup ? 'Create your account' : 'Welcome back'}</h1><p>${signup ? 'Sign up to submit a test request and track its review.' : 'Sign in to manage your test requests.'}</p><form id="auth-form"><div id="message" hidden role="alert"></div><label class="field"><span>Email</span><input type="email" name="email" placeholder="you@example.com" autocomplete="email" required maxlength="254"></label><label class="field"><span>Password</span><input type="password" name="password" placeholder="At least 12 characters" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="12" maxlength="256"></label><button class="gradient-btn wide" type="submit">${signup ? 'Create account' : 'Sign in'}</button></form><div class="form-note">${signup ? `Already have an account? <a href="/sign-in${productQuery}">Sign in</a>` : `New customer? <a href="/sign-up${productQuery}">Create account</a>`}</div></div></div>`;
  $('#auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form), button = form.querySelector('button');
    button.disabled = true;
    try {
      const result = await api(signup ? '/api/signup' : '/api/login', { method: 'POST', body: { email: data.get('email'), password: data.get('password') } });
      location.href = selectedProduct ? `/dashboard${productQuery}` : (result.user.role === 'admin' ? '/admin' : '/dashboard');
    } catch (error) { message(error.message); button.disabled = false; }
  });
}
function orderMarkup(order, admin = false) {
  const options = ['pending', 'reviewing', 'completed', 'rejected'].map(status => `<option value="${status}"${order.status === status ? ' selected' : ''}>${status[0].toUpperCase() + status.slice(1)}</option>`).join('');
  return `<article class="order"><div class="order-head"><strong>${escapeHtml(order.plan)} <span class="subtext">· ${escapeHtml(order.network)}</span></strong><span class="status">${escapeHtml(order.status)}</span></div>${order.price_cents == null ? '' : `<p>Price at request: ${escapeHtml(formatPrice(order.price_cents))} (simulation)</p>`}<p>Test address: ${escapeHtml(order.address)}</p>${admin ? `<p>Customer: ${escapeHtml(order.email)}</p>` : ''}<p>Reference: ${escapeHtml(order.id)}</p><p>Created: ${escapeHtml(new Date(order.created_at).toLocaleString())}</p>${admin ? `<label class="field"><span>Update review status</span><select class="status-select" data-id="${escapeHtml(order.id)}">${options}</select></label>` : ''}</article>`;
}
async function dashboard(user) {
  showPage();
  if (!user) { const product = new URLSearchParams(location.search).get('product'); location.replace(product ? `/sign-in?product=${encodeURIComponent(product)}` : '/sign-in'); return; }
  $('#page-content').innerHTML = `<div class="page-shell"><div class="page-top"><div><span class="section-tag">CUSTOMER DASHBOARD</span><h1>Your test requests</h1><p class="subtext">Submit a simulation and follow its review status.</p></div>${user.role === 'admin' ? '<a class="outline-btn" href="/admin">Open admin panel →</a>' : ''}</div><div class="dashboard-grid"><section class="panel"><h2>New test request</h2><p>Test requests only. No payment, balances, or transactions will be created. The free demo is limited to one per account.</p><p>Questions about a test request? <a class="text-link" href="https://t.me/DarkVault114" target="_blank" rel="noopener noreferrer">Telegram @DarkVault114</a></p><form id="order-form"><div id="message" hidden role="alert"></div><label class="field"><span>Product</span><select name="productId" id="order-product" required disabled><option value="">Loading products…</option></select></label><label class="field"><span>Receiving network</span><select name="network" required><option value="BEP20">BEP20</option><option value="ERC20">ERC20</option><option value="TRC20">TRC20</option><option value="Solana">Solana</option></select></label><label class="field"><span>Test wallet address</span><input name="address" placeholder="e.g. 0x… for BEP20" required minlength="8" maxlength="128"></label><button class="gradient-btn wide" type="submit" disabled>Submit test request</button></form></section><section class="panel"><h2>Recent requests</h2><p>Each submission is reviewed by an administrator.</p><div id="orders" class="order-list"></div></section></div></div>`;
  async function refresh() {
    const data = await api('/api/orders');
    $('#orders').innerHTML = data.orders.length ? data.orders.map(order => orderMarkup(order)).join('') : '<div class="empty">No requests yet. Create your first test request.</div>';
  }
  async function loadProducts() {
    const { products } = await api('/api/products');
    $('#order-product').innerHTML = products.length ? products.map(product => `<option value="${escapeHtml(product.id)}" data-price="${product.price_cents}">${escapeHtml(product.name)} · ${escapeHtml(formatPrice(product.price_cents))}</option>`).join('') : '<option value="">No products available</option>';
    const selectedProduct = new URLSearchParams(location.search).get('product');
    if (products.some(product => product.id === selectedProduct)) $('#order-product').value = selectedProduct;
    $('#order-product').disabled = !products.length;
    $('#order-form button').disabled = !products.length;
  }
  $('#order-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form), button = form.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/orders', { method: 'POST', body: { productId: data.get('productId'), expectedPriceCents: Number($('#order-product').selectedOptions[0].dataset.price), network: data.get('network'), address: data.get('address') } });
      form.reset(); await refresh(); message('Test request submitted for review.', true);
    } catch (error) { message(error.message); try { await loadProducts(); } catch { /* Preserve the original error. */ } }
    button.disabled = $('#order-product').disabled;
  });
  try { await Promise.all([refresh(), loadProducts()]); } catch (error) { message(error.message); }
}
async function adminPage(user) {
  showPage();
  if (!user) { location.replace('/sign-in'); return; }
  if (user.role !== 'admin') { $('#page-content').innerHTML = '<div class="auth-shell"><div class="auth-card"><h1>Access denied</h1><p>Administrator access is required.</p><a class="text-link" href="/dashboard">← Back to dashboard</a></div></div>'; return; }
  $('#page-content').innerHTML = `<div class="page-shell"><div class="page-top"><div><span class="admin-badge">ADMINISTRATOR</span><h1>Request management</h1><p class="subtext">Review and update customer test requests.</p></div><a class="outline-btn" href="/dashboard">Customer dashboard →</a></div><section class="panel"><div id="message" hidden role="alert"></div><h2>All requests</h2><p>Changing status records a review decision. It does not transfer tokens.</p><div class="order-filters"><label class="field"><span>Search requests</span><input id="order-search" type="search" placeholder="Reference, email, or test address" autocomplete="off"></label><label class="field"><span>Status</span><select id="order-status-filter"><option value="">All statuses</option><option value="pending">Pending</option><option value="reviewing">Reviewing</option><option value="completed">Completed</option><option value="rejected">Rejected</option></select></label></div><p id="order-count" role="status" aria-live="polite"></p><div id="orders" class="order-list"></div></section><section class="panel visit-panel"><h2>방문자 IP · Visitor IP addresses</h2><p>최근 30일 방문 기록 중 최대 200개를 표시합니다. Up to 200 visits from the last 30 days.</p><button id="visit-refresh" class="logout" type="button">새로고침 · Refresh</button><div id="visit-list" class="order-list" aria-live="polite"></div></section><section class="panel product-panel"><h2>Products and prices</h2><p>Prices are for simulated requests only; no payment is collected. Existing requests keep their original name and price.</p><div id="product-message" hidden role="alert"></div><form id="new-product" class="product-form"><label class="field"><span>Product name</span><input name="name" required maxlength="80" placeholder="Product name"></label><label class="field"><span>Price (USD)</span><input name="price" required inputmode="decimal" placeholder="0.00"></label><label class="availability"><input name="active" type="checkbox" checked> Available</label><button class="gradient-btn" type="submit">Add product</button></form><div id="products" class="product-list"></div></section></div>`;
  let orders = [];
  function renderOrders() {
    const query = $('#order-search').value.trim().toLowerCase();
    const status = $('#order-status-filter').value;
    const matches = orders.filter(order => (!status || order.status === status) && [order.id, order.email, order.address].some(value => value.toLowerCase().includes(query)));
    $('#order-count').textContent = `${matches.length} of ${orders.length} requests`;
    $('#orders').innerHTML = matches.length ? matches.map(order => orderMarkup(order, true)).join('') : `<div class="empty">${orders.length ? 'No requests match your filters.' : 'No test requests have been submitted.'}</div>`;
    document.querySelectorAll('.status-select').forEach(select => select.addEventListener('change', async () => {
      select.disabled = true;
      try { await api(`/api/admin/orders/${encodeURIComponent(select.dataset.id)}`, { method: 'PATCH', body: { status: select.value } }); await refresh(); message('Request status updated.', true); }
      catch (error) { message(error.message); try { await refresh(); } catch { renderOrders(); } }
    }));
  }
  async function refresh() {
    const result = await api('/api/admin/orders');
    orders = result.orders;
    renderOrders();
  }
  $('#order-search').addEventListener('input', renderOrders);
  $('#order-status-filter').addEventListener('change', renderOrders);
  function productMessage(text, success = false) {
    const target = $('#product-message');
    target.hidden = false;
    target.className = `message${success ? ' success' : ''}`;
    target.textContent = text;
  }
  function productValues(form) {
    const values = new FormData(form);
    return { name: values.get('name'), priceCents: parsePrice(String(values.get('price'))), active: values.has('active') };
  }
  async function refreshProducts() {
    const result = await api('/api/admin/products');
    $('#products').innerHTML = result.products.map(product => {
      if (product.id === 'free-demo') return `<article class="product-fixed"><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(formatPrice(product.price_cents))} · Always available</span></article>`;
      return `<form class="product-form product-edit" data-id="${escapeHtml(product.id)}"><label class="field"><span>Product name</span><input name="name" required maxlength="80" value="${escapeHtml(product.name)}"></label><label class="field"><span>Price (USD)</span><input name="price" required inputmode="decimal" value="${(product.price_cents / 100).toFixed(2)}"></label><label class="availability"><input name="active" type="checkbox"${product.active ? ' checked' : ''}> Available</label><button class="secondary-btn" type="submit">Save changes</button></form>`;
    }).join('');
    document.querySelectorAll('.product-edit').forEach(form => form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button'); button.disabled = true;
      try { await api(`/api/admin/products/${encodeURIComponent(form.dataset.id)}`, { method: 'PATCH', body: productValues(form) }); await refreshProducts(); productMessage('Product updated.', true); }
      catch (error) { productMessage(error.message); button.disabled = false; }
    }));
  }
  $('#new-product').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true;
    try { await api('/api/admin/products', { method: 'POST', body: productValues(form) }); form.reset(); await refreshProducts(); productMessage('Product added.', true); }
    catch (error) { productMessage(error.message); }
    button.disabled = false;
  });
  async function refreshVisits() {
    const result = await api('/api/admin/visits');
    $('#visit-list').innerHTML = result.visits.length ? result.visits.map(visit => `<article class="order"><strong>${escapeHtml(visit.ip)}</strong><p>접속 시간 · Visited: ${escapeHtml(new Date(visit.visited_at).toLocaleString())}</p></article>`).join('') : '<div class="empty">방문 기록이 없습니다. No visits yet.</div>';
  }
  $('#visit-refresh').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { await refreshVisits(); } catch (error) { $('#visit-list').textContent = error.message; }
    event.currentTarget.disabled = false;
  });
  try { await Promise.all([refresh(), refreshProducts(), refreshVisits()]); } catch (error) { message(error.message); }
}
async function showCatalog(user) {
  const target = $('#public-products');
  try {
    const { products } = await api('/api/products');
    target.innerHTML = products.map(product => `<article class="card catalog-card"><span class="card-label">TEST PRODUCT</span><h3>${escapeHtml(product.name)}</h3><strong>${escapeHtml(formatPrice(product.price_cents))}</strong><p>Simulated request only. No payment is collected.</p><a class="outline-btn" href="${user ? '/dashboard' : '/sign-up'}?product=${encodeURIComponent(product.id)}">Select product →</a></article>`).join('');
  } catch { target.textContent = 'Products are temporarily unavailable.'; }
}
const toggle = $('.menu-toggle');
toggle.addEventListener('click', () => { const open = $('.navigation').classList.toggle('open'); toggle.setAttribute('aria-expanded', String(open)); });
try {
  const { user } = await api('/api/session');
  setupNav(user);
  if (location.pathname === '/') await showCatalog(user);
  else if (location.pathname === '/sign-in') authPage('login');
  else if (location.pathname === '/sign-up') authPage('signup');
  else if (location.pathname === '/dashboard') await dashboard(user);
  else if (location.pathname === '/admin') await adminPage(user);
} catch { showPage(); $('#page-content').innerHTML = '<div class="auth-shell"><div class="auth-card"><h1>Unable to connect</h1><p>Please try again later.</p></div></div>'; }
