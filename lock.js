/* Ц.І.Г.І.Т — керування реальним замком через Firebase Realtime Database (REST, без бібліотек).
   Сайт пише команду в /lock/cmd, ESP32 її виконує і відповідає в /lock/ack, а свій стан пише в /lock/state. */
(() => {
'use strict';
const C = window.CIGIT_CONFIG || {};
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LS = 'cigit-auth-v1';
const POLL_MS = 3000;
const OFFLINE_MS = 60000;   // замок пише стан щонайменше раз на 20 с
const configured = !!(C.apiKey && C.dbUrl && !/ВСТАВ/.test(C.apiKey + C.dbUrl));

let auth = null;            // {idToken, refreshToken, exp, email}
let st = null;              // останній /lock/state
let pollTimer = null, busy = false, lastOk = 0;

function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' alert' : '');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  const r = $('toastRegion'); if (!r) return;
  r.appendChild(t); setTimeout(() => t.remove(), 4500);
}

const AUTH_ERR = {
  INVALID_LOGIN_CREDENTIALS: 'Невірний email або пароль',
  EMAIL_NOT_FOUND: 'Такого акаунта немає',
  INVALID_PASSWORD: 'Невірний пароль',
  INVALID_EMAIL: 'Неправильний email',
  USER_DISABLED: 'Акаунт вимкнено',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Забагато спроб, спробуй пізніше',
  TOKEN_EXPIRED: 'Сесія завершилась, увійди знову',
  INVALID_REFRESH_TOKEN: 'Сесія завершилась, увійди знову',
  API_KEY_INVALID: 'Неправильний apiKey у config.js'
};
const authErr = (code) => AUTH_ERR[String(code).split(' ')[0].split(':')[0]] || ('Помилка входу: ' + code);

function saveAuth(idToken, refreshToken, expiresIn, email) {
  auth = { idToken, refreshToken, exp: Date.now() + (Number(expiresIn || 3600) - 120) * 1000, email };
  try { localStorage.setItem(LS, JSON.stringify({ refreshToken, email })); } catch {}
}

async function signIn(email, password) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(C.apiKey)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(authErr(j?.error?.message || r.status));
  saveAuth(j.idToken, j.refreshToken, j.expiresIn, j.email);
}

async function refresh() {
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(C.apiKey)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(auth.refreshToken)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(authErr(j?.error?.message || r.status)); e.logout = r.status === 400; throw e; }
  saveAuth(j.id_token, j.refresh_token, j.expires_in, auth.email);
}

async function token() {
  if (!auth) throw new Error('Не виконано вхід');
  if (!auth.idToken || Date.now() > auth.exp) await refresh();
  return auth.idToken;
}

async function db(path, method = 'GET', body, retried) {
  const t = await token();
  const r = await fetch(`${C.dbUrl.replace(/\/$/, '')}/${path}.json?auth=${encodeURIComponent(t)}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store'
  });
  if (r.status === 401) {
    if (!retried) { auth.exp = 0; return db(path, method, body, true); }
    const e = new Error('Немає доступу до замка: цей акаунт не додано в «allow» у базі'); e.denied = true; throw e;
  }
  if (!r.ok) throw new Error('База: HTTP ' + r.status);
  return r.json();
}

/* ---------- UI ---------- */
function showLogin(note) {
  $('lockLogin').classList.remove('hidden');
  $('lockPanel').classList.add('hidden');
  if (note !== undefined) $('lockError').textContent = note;
}
function showPanel() {
  $('lockLogin').classList.add('hidden');
  $('lockPanel').classList.remove('hidden');
}

function fmtUp(sec) {
  sec = Number(sec) || 0;
  const d = Math.floor(sec / 86400), h = Math.floor(sec / 3600) % 24, m = Math.floor(sec / 60) % 60;
  return (d ? d + ' д ' : '') + h + ' год ' + m + ' хв';
}

function isOnline() { return !!(st && typeof st.seen === 'number' && Math.abs(Date.now() - st.seen) < OFFLINE_MS); }

function render() {
  const on = isOnline();
  const o = $('lockOnline');
  o.className = 'lock-online ' + (on ? 'on' : 'off');
  o.innerHTML = `<i></i> ${on ? 'замок онлайн' : (st ? 'замок офлайн' : 'немає даних від замка')}`;

  const hero = $('lockHero');
  const alarm = st && (st.fire || st.heat);
  hero.classList.toggle('armed', !!(st && st.armed) && !alarm);
  hero.classList.toggle('alarm', !!alarm);

  let big = '—', sub = 'Чекаю дані від замка…';
  if (st) {
    if (st.fire) big = '🔥 Пожежна тривога';
    else if (st.heat) big = '🌡 Перегрів!';
    else big = st.armed ? '🔒 Під охороною' : '🔓 Охорона вимкнена';
    const parts = [st.door ? '🚪 Двері відчинені' : '🚪 Двері зачинені'];
    if (st.motor) parts.push('мотор працює');
    if (st.airOn && st.air) parts.push('🚀 повітряна тривога');
    if (!on && st.seen) parts.push('востаннє на звʼязку ' + new Date(st.seen).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
    sub = parts.join(' · ');
  }
  $('lockBig').textContent = big;
  $('lockSub').textContent = sub;

  const armBtn = $('lockArmBtn');
  armBtn.dataset.lock = st && st.armed ? 'disarm' : 'arm';
  armBtn.textContent = st && st.armed ? '🔓 Зняти охорону' : '🔒 Поставити на охорону';
  $('lockLightBtn').textContent = st && st.light ? '🔦 Вимкнути ліхтар' : '🔦 Ліхтар';
  const dis = busy || !on || !!alarm;
  document.querySelectorAll('.lock-btn').forEach((b) => { b.disabled = dis; });
  $('lockOpenBtn').disabled = dis || !!(st && st.armed);
  $('lockOpenBtn').title = st && st.armed ? 'Спершу зніміть охорону' : '';

  const stats = [
    ['🌡 Температура', st && st.t != null ? `${Number(st.t).toFixed(1)} <span>°C</span>` : '—', 'датчик SHT'],
    ['💧 Вологість', st && st.h != null ? `${Math.round(st.h)} <span>%</span>` : '—', 'у приміщенні'],
    ['📶 Wi-Fi', st && st.rssi ? `${st.rssi} <span>dBm</span>` : '—', st && st.heap ? `памʼять ${st.heap} КБ` : ''],
    ['⏳ Працює', st ? esc(fmtUp(st.up)) : '—', st && st.fp ? 'відбитки ✅' : 'відбитки —']
  ];
  $('lockStats').innerHTML = stats.map((s) => `<div class="summary-card card"><div class="metric-top"><span>${esc(s[0])}</span></div><strong>${s[1]}</strong><small>${esc(s[2])}</small></div>`).join('');

  const log = st && Array.isArray(st.log) ? st.log : [];
  if (window.AURA_REAL) window.AURA_REAL(on ? st : null);   // справжні дані на «Панелі», поки замок онлайн
  $('lockLogList').innerHTML = log.length ? log.map((l) => `<div>${esc(l)}</div>`).join('') : '<div class="muted">Подій ще немає.</div>';
}

async function poll() {
  clearTimeout(pollTimer);
  if (!auth) return;
  try {
    const data = await db('lock/state');
    st = data && typeof data === 'object' ? data : null;
    lastOk = Date.now();
    showPanel();
    render();
  } catch (e) {
    if (e.logout || e.denied) { logout(e.message); return; }
    if (Date.now() - lastOk > 15000) { $('lockOnline').className = 'lock-online off'; $('lockOnline').innerHTML = '<i></i> немає інтернету'; }
  }
  if (!document.hidden) pollTimer = setTimeout(poll, POLL_MS);
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function send(action) {
  if (busy || !auth) return;
  busy = true; render();
  const id = newId();
  try {
    await db('lock/cmd', 'PUT', { id, a: action, by: (auth.email || '').slice(0, 40), at: { '.sv': 'timestamp' } });
    let ack = null;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const a = await db('lock/ack');
      if (a && a.id === id) { ack = a; break; }
    }
    if (ack) toast(ack.msg || (ack.ok ? 'Готово' : 'Не виконано'), !ack.ok);
    else toast('Замок не відповів. Перевір, чи він у мережі.', true);
  } catch (e) {
    toast(e.message, true);
  }
  busy = false;
  poll();
}

function logout(msg) {
  clearTimeout(pollTimer);
  auth = null; st = null;
  try { localStorage.removeItem(LS); } catch {}
  showLogin(msg || '');
}

function init() {
  if (!$('page-lock')) return;
  if (!configured) {
    $('lockLoginNote').textContent = 'Сайт ще не підключено до бази: заповни config.js (apiKey і dbUrl).';
    $('lockLoginBtn').disabled = true;
  }
  $('lockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!configured) return;
    const btn = $('lockLoginBtn');
    btn.disabled = true; $('lockError').textContent = '';
    try {
      await signIn($('lockEmail').value.trim(), $('lockPass').value);
      $('lockPass').value = '';
      showPanel(); render(); poll();
    } catch (err) { $('lockError').textContent = err.message; }
    btn.disabled = false;
  });
  $('lockLogout').addEventListener('click', () => logout(''));
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lock]');
    if (!b || b.disabled) return;
    const a = b.dataset.lock;
    if (a === 'open' && !confirm('Відкрити двері?')) return;
    send(a);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && auth) poll(); });
  setInterval(() => { if (auth && st) render(); }, 10000);   // оновлює «онлайн/офлайн», навіть якщо дані не змінились

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS) || 'null'); } catch {}
  if (configured && saved && saved.refreshToken) {
    auth = { idToken: '', refreshToken: saved.refreshToken, exp: 0, email: saved.email || '' };
    showPanel(); render(); poll();
  } else showLogin();
  if (window.AURA_NAV) window.AURA_NAV('lock');   // сайт відкривається одразу на замку
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
