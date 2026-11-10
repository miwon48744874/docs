const $ = selector => document.querySelector(selector);
const formatPrice = cents => `${new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)}달러`;
const productName = (id, name) => id === 'free-demo' ? '무료 데모' : name;
function parsePrice(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('가격은 소수점 둘째 자리까지 숫자로 입력하세요.');
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 100_000_000) throw new Error('가격은 1,000,000달러 이하여야 합니다.');
  return cents;
}
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
async function api(path, options = {}) {
  const headers = options.body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'flash-app' } : {};
  let response, body;
  try {
    response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    body = await response.json();
  } catch { throw new Error('서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.'); }
  if (!response.ok) throw new Error(body.error || '요청을 처리하지 못했습니다. 다시 시도하세요.');
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
  if (user) nav.innerHTML = `<a href="/dashboard">대시보드</a><a href="/account">내 계정</a>${user.role === 'admin' ? '<a href="/admin#visitors">방문자 IP</a><a href="/admin">관리자</a>' : ''}<button class="logout" id="nav-logout" type="button">로그아웃</button>`;
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
  $('#page-content').innerHTML = `<div class="auth-shell"><a href="/" class="text-link">← 홈으로</a><div class="auth-card"><span class="section-tag">계정 접속</span><h1>${signup ? '계정 만들기' : '다시 오셨네요'}</h1><p>${signup ? '테스트 요청을 시작하고 진행 상황을 확인하세요.' : '이메일과 비밀번호로 로그인하세요.'}</p><form id="auth-form"><div id="message" hidden role="alert"></div><label class="field"><span>이메일</span><input type="email" name="email" placeholder="you@example.com" autocomplete="email" required maxlength="254"></label><label class="field"><span>비밀번호</span><input type="password" name="password" placeholder="12자 이상 입력하세요" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="12" maxlength="256"></label><button class="gradient-btn wide" type="submit">${signup ? '계정 만들기' : '로그인'}</button></form><div class="form-note">${signup ? `이미 계정이 있나요? <a href="/sign-in${productQuery}">로그인</a>` : `처음 방문하셨나요? <a href="/sign-up${productQuery}">회원가입</a>`}</div></div></div>`;
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
  const options = ['pending', 'reviewing', 'completed', 'rejected'].map(status => `<option value="${status}"${order.status === status ? ' selected' : ''}>${statusLabel(status)}</option>`).join('');
  return `<article class="order"><div class="order-head"><strong>${escapeHtml(productName(order.product_id, order.plan))} <span class="subtext">· ${escapeHtml(order.network)}</span></strong><span class="status">${statusLabel(order.status)}</span></div>${order.price_cents == null ? '' : `<p>요청 당시 가격: ${escapeHtml(formatPrice(order.price_cents))} (시뮬레이션)</p>`}<p>테스트 주소: ${escapeHtml(order.address)}</p>${admin ? `<p>고객: ${escapeHtml(order.email)}</p>` : ''}<p>요청 번호: ${escapeHtml(order.id)}</p><p>접수 시간: ${escapeHtml(new Date(order.created_at).toLocaleString('ko-KR'))}</p>${admin ? `<label class="field"><span>검토 상태 변경</span><select class="status-select" data-id="${escapeHtml(order.id)}">${options}</select></label>` : ''}</article>`;
}
const statusLabel = value => ({ pending: '접수', reviewing: '검토 중', completed: '완료', rejected: '반려' })[value] || '알 수 없음';
function planCard(product, href) {
  return `<article class="plan-card ${product.id === 'free-demo' ? 'featured' : ''}"><span class="section-tag">${product.id === 'free-demo' ? '무료 데모' : '테스트 상품'}</span><h3>${escapeHtml(productName(product.id, product.name))}</h3><div class="plan-price">${escapeHtml(formatPrice(product.price_cents))}<small>시뮬레이션 가격</small></div><p>테스트 요청 및 진행 상태 관리</p><ul><li>4가지 네트워크 주소 형식</li><li>관리자 수동 검토</li><li>대시보드에서 상태 확인</li></ul><a class="${product.id === 'free-demo' ? 'gradient-btn' : 'outline-btn'}" href="${href}">테스트 선택하기 ↗</a></article>`;
}
async function dashboard(user) {
  showPage();
  if (!user) { const product = new URLSearchParams(location.search).get('product'); location.replace(product ? `/sign-in?product=${encodeURIComponent(product)}` : '/sign-in'); return; }
  $('#page-content').innerHTML = `<div class="page-shell"><div class="workspace-nav"><a href="/dashboard" class="active">대시보드</a><a href="#orders-panel">주문 내역</a><a href="/account">내 계정</a><a href="https://t.me/DarkVault114" target="_blank" rel="noopener noreferrer">지원 ↗</a></div><section class="notice"><span class="notice-icon">◉</span><div><span class="section-tag">진행 알림</span><strong>주문 진행 상황을 한눈에</strong><p>새로고침을 누르면 관리자의 최신 검토 상태를 확인할 수 있습니다.</p></div></section><section class="welcome panel"><div><span class="section-tag">내 작업 공간</span><h1>반갑습니다.</h1><p class="subtext">${escapeHtml(user.email)}</p><a href="#new-request" class="gradient-btn">새 테스트 요청 ↗</a></div><span class="welcome-art" aria-hidden="true">◈</span></section><div class="stats-grid" id="dashboard-stats"></div><div class="demo-banner"><div><span class="section-tag">무료 데모</span><h3>첫 테스트를 시작해 보세요</h3><p>무료 데모는 계정당 한 번 요청할 수 있습니다.</p></div><a class="outline-btn" href="/dashboard?product=free-demo#new-request">무료 데모 선택 ↗</a></div><section class="panel" id="orders-panel"><div class="section-row"><div><span class="section-tag">최근 활동</span><h2>주문 내역</h2></div><button class="logout" id="orders-refresh" type="button">새로고침 ↻</button></div><p id="order-update" role="status" aria-live="polite"></p><div id="orders" class="order-list"></div></section><section class="section" id="plans"><div class="section-heading"><span class="section-tag">테스트 상품</span><h2>테스트 상품을 선택하세요</h2></div><div id="dashboard-plans" class="catalog-grid"></div></section><section class="panel request-panel" id="new-request"><span class="section-tag">새 요청</span><h2>테스트 요청하기</h2><p>실제 결제와 코인 전송이 없는 시뮬레이션입니다.</p><form id="order-form"><div id="message" hidden role="alert"></div><label class="field"><span>상품</span><select name="productId" id="order-product" required disabled><option value="">불러오는 중…</option></select></label><label class="field"><span>수신 네트워크</span><select name="network" required><option value="BEP20">BEP20 · BNB Smart Chain</option><option value="ERC20">ERC20 · Ethereum</option><option value="TRC20">TRC20 · Tron</option><option value="Solana">Solana</option></select></label><label class="field"><span>테스트 지갑 주소</span><input name="address" placeholder="선택한 네트워크의 테스트 주소" required minlength="8" maxlength="128"></label><div class="request-summary"><span>요청 가격 · 시뮬레이션</span><strong id="request-price">—</strong></div><button class="gradient-btn wide" type="submit" disabled>테스트 요청 제출 →</button></form><p>테스트 문의: <a class="text-link" href="https://t.me/DarkVault114" target="_blank" rel="noopener noreferrer">@DarkVault114 ↗</a></p></section></div>`;
  async function refresh() {
    const { orders } = await api('/api/orders');
    const metrics = [['전체 요청', orders.length], ['검토 대기', orders.filter(o => ['pending','reviewing'].includes(o.status)).length], ['완료', orders.filter(o => o.status === 'completed').length], ['총 요청 가격', formatPrice(orders.reduce((sum,o) => sum + (o.price_cents || 0), 0))]];
    $('#dashboard-stats').innerHTML = metrics.map(([name,value]) => `<article class="stat-card"><span>${name}</span><strong>${escapeHtml(value)}</strong></article>`).join('');
    $('#orders').innerHTML = orders.length ? orders.map(o => `<details class="order order-detail"><summary><div><span class="subtext">${escapeHtml(o.id.slice(0,8))}</span><strong>${escapeHtml(productName(o.product_id, o.plan))}</strong><small>${escapeHtml(o.network)} · ${escapeHtml(formatPrice(o.price_cents || 0))}</small></div><span class="status ${escapeHtml(o.status)}">${statusLabel(o.status)}</span><span class="text-link">상세 보기 ＋</span></summary><div class="detail-body"><p>요청 번호: ${escapeHtml(o.id)}</p><p>테스트 주소: ${escapeHtml(o.address)}</p><p>접수 시간: ${escapeHtml(new Date(o.created_at).toLocaleString('ko-KR'))}</p><p>마지막 업데이트: ${escapeHtml(new Date(o.updated_at).toLocaleString('ko-KR'))}</p><a class="text-link" href="https://t.me/DarkVault114" target="_blank" rel="noopener noreferrer">이 요청 문의하기 ↗</a></div></details>`).join('') : '<div class="empty">아직 요청 내역이 없습니다. 첫 테스트를 시작해 보세요.</div>';
  }
  const updatePrice = () => { $('#request-price').textContent = formatPrice(Number($('#order-product').selectedOptions[0]?.dataset.price || 0)); };
  async function loadProducts() {
    const { products } = await api('/api/products');
    $('#order-product').innerHTML = products.length ? products.map(p => `<option value="${escapeHtml(p.id)}" data-price="${p.price_cents}">${escapeHtml(productName(p.id, p.name))} · ${escapeHtml(formatPrice(p.price_cents))}</option>`).join('') : '<option value="">선택 가능한 상품이 없습니다</option>';
    const selected = new URLSearchParams(location.search).get('product');
    if (products.some(p => p.id === selected)) $('#order-product').value = selected;
    $('#order-product').disabled = !products.length;
    $('#order-form button').disabled = !products.length;
    $('#dashboard-plans').innerHTML = products.map(p => planCard(p, `/dashboard?product=${encodeURIComponent(p.id)}#new-request`)).join('');
    updatePrice();
  }
  $('#order-product').addEventListener('change', updatePrice);
  $('#orders-refresh').addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    try { await refresh(); $('#order-update').textContent = '최신 상태로 업데이트했습니다.'; } catch (error) { $('#order-update').textContent = error.message; }
    e.currentTarget.disabled = false;
  });
  $('#order-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form), button = form.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/orders', { method: 'POST', body: { productId: data.get('productId'), expectedPriceCents: Number($('#order-product').selectedOptions[0].dataset.price), network: data.get('network'), address: data.get('address') } });
      form.reset(); updatePrice(); await refresh(); message('테스트 요청이 접수되었습니다.', true);
    } catch (error) { message(error.message); try { await loadProducts(); } catch { /* Preserve the original error. */ } }
    button.disabled = $('#order-product').disabled;
  });
  try { await Promise.all([refresh(), loadProducts()]); if (location.hash) $(location.hash)?.scrollIntoView(); } catch (error) { message(error.message); }
}
function accountPage(user) {
  showPage();
  if (!user) { location.replace('/sign-in'); return; }
  $('#page-content').innerHTML = `<div class="page-shell"><a href="/dashboard" class="text-link">← 대시보드</a><div class="page-top"><div><span class="section-tag">계정</span><h1>내 계정</h1><p class="subtext">로그인 정보와 계정 권한을 확인하세요.</p></div></div><div class="panel account-grid"><div><span>이메일</span><strong>${escapeHtml(user.email)}</strong></div><div><span>계정 번호</span><strong>${escapeHtml(user.id)}</strong></div><div><span>역할</span><strong>${user.role === 'admin' ? '관리자' : '고객'}</strong></div></div><div class="panel account-help"><h2>계정 문의</h2><p>계정 관련 문의는 텔레그램으로 연락해 주세요.</p><a class="outline-btn" href="https://t.me/DarkVault114" target="_blank" rel="noopener noreferrer">지원 연결 ↗</a></div><button class="logout" id="account-logout" type="button">로그아웃</button></div>`;
  $('#account-logout').addEventListener('click', signOut);
}
async function adminPage(user) {
  showPage();
  if (!user) { location.replace('/sign-in'); return; }
  if (user.role !== 'admin') { $('#page-content').innerHTML = '<div class="auth-shell"><div class="auth-card"><h1>접근할 수 없습니다</h1><p>관리자 권한이 필요합니다.</p><a class="text-link" href="/dashboard">← 대시보드로 돌아가기</a></div></div>'; return; }
  $('#page-content').innerHTML = `<div class="page-shell"><div class="page-top"><div><span class="admin-badge">관리자</span><h1>관리자 워크스페이스</h1><p class="subtext">주문과 상품, 방문 기록을 한곳에서 관리하세요.</p></div><a class="outline-btn" href="/dashboard">고객 대시보드 →</a></div><section class="panel"><div id="message" hidden role="alert"></div><h2>주문 관리</h2><p>상태 변경은 테스트 검토 결과를 기록합니다.</p><div class="order-filters"><label class="field"><span>주문 검색</span><input id="order-search" type="search" placeholder="요청 번호, 이메일, 주소" autocomplete="off"></label><label class="field"><span>상태</span><select id="order-status-filter"><option value="">전체 상태</option><option value="pending">접수</option><option value="reviewing">검토 중</option><option value="completed">완료</option><option value="rejected">반려</option></select></label></div><p id="order-count" role="status" aria-live="polite"></p><div id="orders" class="order-list"></div></section><section class="panel visit-panel" id="visitors"><h2>방문자 IP</h2><p>사이트 방문 시 기록됩니다. 이 화면은 5초마다 자동 갱신됩니다. 최근 30일 중 최대 200개를 표시합니다.</p><button id="visit-refresh" class="logout" type="button">새로고침</button><p id="visit-tracking" role="status"></p><div id="visit-list" class="order-list" aria-live="polite"></div></section><section class="panel product-panel"><h2>상품 · 가격 관리</h2><p>가격은 시뮬레이션용입니다. 수정 전 주문의 상품명과 가격은 유지됩니다.</p><div id="product-message" hidden role="alert"></div><form id="new-product" class="product-form"><label class="field"><span>상품명</span><input name="name" required maxlength="80" placeholder="상품명"></label><label class="field"><span>가격 (미국 달러)</span><input name="price" required inputmode="decimal" placeholder="0.00"></label><label class="availability"><input name="active" type="checkbox" checked> 판매 표시</label><button class="gradient-btn" type="submit">상품 추가</button></form><div id="products" class="product-list"></div></section></div>`;
  let orders = [];
  function renderOrders() {
    const query = $('#order-search').value.trim().toLowerCase();
    const status = $('#order-status-filter').value;
    const matches = orders.filter(order => (!status || order.status === status) && [order.id, order.email, order.address].some(value => value.toLowerCase().includes(query)));
    $('#order-count').textContent = `전체 ${orders.length}건 중 ${matches.length}건`;
    $('#orders').innerHTML = matches.length ? matches.map(order => orderMarkup(order, true)).join('') : `<div class="empty">${orders.length ? '검색 조건에 맞는 요청이 없습니다.' : '아직 접수된 테스트 요청이 없습니다.'}</div>`;
    document.querySelectorAll('.status-select').forEach(select => select.addEventListener('change', async () => {
      select.disabled = true;
      try { await api(`/api/admin/orders/${encodeURIComponent(select.dataset.id)}`, { method: 'PATCH', body: { status: select.value } }); await refresh(); message('요청 상태를 변경했습니다.', true); }
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
      if (product.id === 'free-demo') return `<article class="product-fixed"><strong>${escapeHtml(productName(product.id, product.name))}</strong><span>${escapeHtml(formatPrice(product.price_cents))} · 항상 이용 가능</span></article>`;
      return `<form class="product-form product-edit" data-id="${escapeHtml(product.id)}"><label class="field"><span>상품명</span><input name="name" required maxlength="80" value="${escapeHtml(product.name)}"></label><label class="field"><span>가격 (미국 달러)</span><input name="price" required inputmode="decimal" value="${(product.price_cents / 100).toFixed(2)}"></label><label class="availability"><input name="active" type="checkbox"${product.active ? ' checked' : ''}> 판매 표시</label><button class="secondary-btn" type="submit">변경 저장</button></form>`;
    }).join('');
    document.querySelectorAll('.product-edit').forEach(form => form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button'); button.disabled = true;
      try { await api(`/api/admin/products/${encodeURIComponent(form.dataset.id)}`, { method: 'PATCH', body: productValues(form) }); await refreshProducts(); productMessage('상품 정보를 변경했습니다.', true); }
      catch (error) { productMessage(error.message); button.disabled = false; }
    }));
  }
  $('#new-product').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true;
    try { await api('/api/admin/products', { method: 'POST', body: productValues(form) }); form.reset(); await refreshProducts(); productMessage('상품을 추가했습니다.', true); }
    catch (error) { productMessage(error.message); }
    button.disabled = false;
  });
  let visitsLoading = false;
  async function refreshVisits() {
    if (visitsLoading) return;
    visitsLoading = true;
    try {
      const result = await api('/api/admin/visits');
      const tracking = result.tracking;
      $('#visit-tracking').textContent = tracking ? `내 현재 공개 IP: ${tracking.currentIp || '확인 불가'} · 기록 방식: ${({ cloudflare: '보호 프록시', forwarded: '신뢰 프록시', socket: '직접 연결' })[tracking.source] || '확인 불가'} ${tracking.release ? '· 버전 ' + tracking.release : ''} · ${new Date().toLocaleTimeString('ko-KR')}` : '이전 서버 버전입니다. 렌더에서 최신 배포를 확인해 주세요.';
      $('#visit-list').innerHTML = result.visits.length ? result.visits.map(visit => `<article class="order"><strong>${escapeHtml(visit.ip)}</strong><p>접속 시간 · ${escapeHtml(new Date(visit.visited_at).toLocaleString('ko-KR'))}</p></article>`).join('') : '<div class="empty">아직 방문 기록이 없습니다.</div>';
    } finally { visitsLoading = false; }
  }
  async function updateVisits() {
    try { await refreshVisits(); } catch { $('#visit-tracking').textContent = '방문 기록을 가져오지 못했습니다. 로그인 상태와 연결을 확인하세요.'; }
  }
  $('#visit-refresh').addEventListener('click', updateVisits);
  const timer = setInterval(() => { if (!document.hidden) updateVisits(); }, 5000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateVisits(); });
  try { await Promise.all([refresh(), refreshProducts(), refreshVisits()]); if (location.hash === '#visitors') $('#visitors').scrollIntoView(); } catch (error) { message(error.message); }
}
async function showCatalog(user) {
  const target = $('#public-products');
  try {
    const { products } = await api('/api/products');
    target.innerHTML = products.map(product => planCard(product, `${user ? '/dashboard' : '/sign-up'}?product=${encodeURIComponent(product.id)}${user ? '#new-request' : ''}`)).join('');
  } catch { target.textContent = '상품을 불러오지 못했습니다. 잠시 후 다시 시도하세요.'; }
}
document.addEventListener('invalid', event => {
  const field = event.target;
  if (typeof field.setCustomValidity !== 'function') return;
  field.setCustomValidity('');
  const validity = field.validity;
  if (validity.valueMissing) field.setCustomValidity(field.tagName === 'SELECT' ? '항목을 선택하세요.' : '이 항목을 입력하세요.');
  else if (validity.typeMismatch && field.type === 'email') field.setCustomValidity('올바른 이메일 주소를 입력하세요.');
  else if (validity.tooShort) field.setCustomValidity(`${field.minLength}자 이상 입력하세요.`);
  else if (validity.tooLong) field.setCustomValidity(`${field.maxLength}자 이하로 입력하세요.`);
  else field.setCustomValidity('입력값을 확인하세요.');
}, true);
for (const type of ['input', 'change']) document.addEventListener(type, event => event.target.setCustomValidity?.(''));
const toggle = $('.menu-toggle');
toggle.addEventListener('click', () => { const open = $('.navigation').classList.toggle('open'); toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기'); });
try {
  const { user } = await api('/api/session');
  setupNav(user);
  if (location.pathname === '/') await showCatalog(user);
  else if (location.pathname === '/sign-in') authPage('login');
  else if (location.pathname === '/sign-up') authPage('signup');
  else if (location.pathname === '/dashboard') await dashboard(user);
  else if (location.pathname === '/admin') await adminPage(user);
  else if (location.pathname === '/account') accountPage(user);
} catch { showPage(); $('#page-content').innerHTML = '<div class="auth-shell"><div class="auth-card"><h1>연결할 수 없습니다</h1><p>잠시 후 다시 시도하세요.</p></div></div>'; }
