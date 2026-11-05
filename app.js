'use strict';

const API = 'https://data.mobilites-m.fr/api';
const REFRESH_MS = 20000;
const ALERTS_MS = 5 * 60000;
const NEARBY_RADIUS = 700; // metres

const $ = (id) => document.getElementById(id);
const els = { q: $('q'), results: $('results'), alerts: $('alerts'), stops: $('stops'), empty: $('empty'), status: $('status'), mic: $('mic'), loc: $('loc') };

// ---------- storage ----------

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota or private mode */ }
  },
};

// ---------- state ----------

const state = {
  routes: new Map(),     // 'SEM:A' -> { short, color, text, tram }
  clusters: [],          // [{ code, name, city, lat, lon, key }]
  byCode: new Map(),
  favs: store.get('favs', []),
  viewing: null,         // stop opened from search, not (yet) a favourite
  nearby: [],            // [{ code, dist }]
  locOn: store.get('locOn', false),
  times: new Map(Object.entries(store.get('times', {}))), // code -> { at, rows, err }
  open: new Set(),       // expanded rows
  alerts: [],
  stopRoutes: store.get('stopRoutes', {}), // code -> route ids serving it (for alerts)
  openAlerts: new Set(),
  alertsOpen: false,
  lastOk: store.get('lastOk', 0),
  offline: false,
};

// ---------- data ----------

async function getJSON(path, timeout = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(API + path, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function cached(key, ttl, load) {
  const c = store.get(key);
  if (c && Date.now() - c.t < ttl) return c.d;
  try {
    const d = await load();
    store.set(key, { t: Date.now(), d });
    return d;
  } catch (e) {
    if (c) return c.d; // stale is better than nothing
    throw e;
  }
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function loadRoutes() {
  const list = await cached('routes.v1', 86400000, async () =>
    (await getJSON('/routers/default/index/routes')).map((r) => [r.id, r.shortName, r.color, r.textColor, r.type]));
  for (const [id, short, color, text, type] of list) {
    state.routes.set(id, { short, color: '#' + (color || '888888'), text: '#' + (text || 'FFFFFF'), tram: type === 'TRAM' });
  }
}

async function loadClusters() {
  const list = await cached('clusters.v1', 7 * 86400000, async () =>
    (await getJSON('/findType/json?types=clusters', 20000)).features
      .filter((f) => f.properties.visible)
      .map((f) => [f.properties.code, f.properties.name, f.properties.city || '', f.geometry.coordinates[1], f.geometry.coordinates[0]]));
  state.clusters = list.map(([code, name, city, lat, lon]) => ({ code, name, city, lat, lon, key: norm(name), ckey: norm(city) }));
  state.byCode = new Map(state.clusters.map((c) => [c.code, c]));
}

function routeOf(patternId) {
  const id = patternId.split(':').slice(0, 2).join(':');
  return { id, ...(state.routes.get(id) || { short: id.split(':')[1], color: '#888888', text: '#FFFFFF', tram: false }) };
}

async function loadStopRoutes(code) {
  if (state.stopRoutes[code]) return;
  try {
    state.stopRoutes[code] = (await getJSON('/routers/default/index/clusters/' + encodeURIComponent(code) + '/routes')).map((r) => r.id);
    store.set('stopRoutes', state.stopRoutes);
  } catch { /* retried on next refresh */ }
}

async function loadTimes(code) {
  loadStopRoutes(code);
  try {
    const data = await getJSON('/routers/default/index/clusters/' + encodeURIComponent(code) + '/stoptimes');
    const rows = new Map();
    for (const p of data) {
      const route = routeOf(p.pattern.id);
      const key = route.id + '|' + p.pattern.desc;
      if (!rows.has(key)) rows.set(key, { key, route: route.id, dest: p.pattern.desc, times: [] });
      for (const t of p.times) {
        rows.get(key).times.push({
          ts: t.serviceDay + t.realtimeDeparture,
          rt: t.realtime,
          occ: t.occupancy || '',
        });
      }
    }
    for (const r of rows.values()) r.times.sort((a, b) => a.ts - b.ts);
    state.times.set(code, { at: Date.now(), rows: [...rows.values()] });
    state.lastOk = Date.now();
    state.offline = false;
  } catch {
    const prev = state.times.get(code);
    state.times.set(code, { ...(prev || { rows: [] }), err: true });
    state.offline = true;
  }
}

function visibleCodes() {
  const codes = [];
  if (state.viewing && !state.favs.includes(state.viewing)) codes.push(state.viewing);
  codes.push(...state.favs);
  for (const n of state.nearby) if (!codes.includes(n.code)) codes.push(n.code);
  return codes;
}

let refreshing = false;
async function refresh() {
  if (refreshing || document.hidden) return;
  refreshing = true;
  await Promise.all(visibleCodes().map(loadTimes));
  refreshing = false;
  persistTimes();
  render();
}

function persistTimes() {
  const keep = {};
  for (const code of visibleCodes()) {
    const t = state.times.get(code);
    if (t && t.rows) keep[code] = { at: t.at, rows: t.rows };
  }
  store.set('times', keep);
  store.set('lastOk', state.lastOk);
}

// ---------- alerts ----------

function parseFr(s) {
  const m = /(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d)/.exec(s || '');
  return m ? new Date(+m[3], m[2] - 1, +m[1], +m[4], +m[5]).getTime() : NaN;
}

async function loadAlerts() {
  try {
    const data = await getJSON('/dyn/evtTC/json');
    const now = Date.now();
    const seen = new Set();
    state.alerts = Object.values(data).filter((e) => {
      if (!e.visibleTC || seen.has(e.groupeCode)) return false;
      const a = parseFr(e.dateDebut), b = parseFr(e.dateFin);
      if (!(a <= now && now <= b)) return false;
      seen.add(e.groupeCode);
      return true;
    }).map((e) => ({
      id: e.groupeCode || e.code,
      lines: (e.listeLigne || '').split(/[,;]/).map((s) => s.trim().replace('_', ':')).filter(Boolean),
      title: e.titre || '',
      text: e.description || (e.texte || '').split('|').slice(1).join('\n'),
    }));
    render();
  } catch { /* alerts are optional */ }
}

// ---------- nearby ----------

function dist(a, b, c, d) {
  const R = 6371000, toR = Math.PI / 180;
  const x = (d - b) * toR * Math.cos(((a + c) / 2) * toR), y = (c - a) * toR;
  return Math.sqrt(x * x + y * y) * R;
}

function locate(userAsked) {
  if (!navigator.geolocation) return;
  els.loc.classList.add('on');
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude: la, longitude: lo } = pos.coords;
    const names = new Set();
    state.nearby = state.clusters
      .map((c) => ({ code: c.code, name: c.key, dist: dist(la, lo, c.lat, c.lon) }))
      .filter((c) => c.dist < NEARBY_RADIUS)
      .sort((a, b) => a.dist - b.dist)
      .filter((c) => !state.favs.includes(c.code) && !names.has(c.name) && names.add(c.name))
      .slice(0, 3);
    state.locOn = true;
    store.set('locOn', true);
    render();
    refresh();
    if (userAsked && !state.nearby.length) flash('Aucun arrêt à moins de ' + NEARBY_RADIUS + ' m');
  }, () => {
    els.loc.classList.remove('on');
    state.locOn = false;
    store.set('locOn', false);
    if (userAsked) flash('Localisation refusée');
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

// ---------- search ----------

function search(q) {
  const n = norm(q);
  if (!n) return [];
  const words = n.split(' ');
  const out = [];
  for (const c of state.clusters) {
    const hay = c.key + ' ' + c.ckey;
    if (!words.every((w) => hay.includes(w))) continue;
    let score = c.key.startsWith(n) ? 0 : (' ' + c.key).includes(' ' + words[0]) ? 1 : c.key.includes(words[0]) ? 2 : 3;
    if (!c.code.startsWith('SEM:')) score += 0.5; // urban network first
    out.push({ c, score });
  }
  out.sort((a, b) => a.score - b.score || a.c.name.length - b.c.name.length);
  // the same stop name exists in several networks: keep one per name+city
  const seen = new Set();
  return out.filter(({ c }) => !seen.has(c.key + c.ckey) && seen.add(c.key + c.ckey)).slice(0, 12).map((o) => o.c);
}

function renderResults() {
  const q = els.q.value;
  els.empty.hidden = !!q.trim() || !!els.stops.innerHTML;
  if (!q.trim()) { els.results.hidden = true; return; }
  const list = search(q);
  els.results.hidden = false;
  els.results.innerHTML = list.length
    ? list.map((c) => `<li><button data-open="${esc(c.code)}"><span class="name">${esc(c.name)}</span><span class="city">${esc(c.city)}</span></button></li>`).join('')
    : `<li class="none">${state.clusters.length ? 'Aucun arrêt trouvé' : 'Chargement des arrêts…'}</li>`;
}

function openStop(code) {
  els.q.value = '';
  els.q.blur();
  renderResults();
  state.viewing = state.favs.includes(code) ? null : code;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  return loadTimes(code).then(() => { persistTimes(); render(); });
}

// ---------- favourites ----------

function toggleFav(code) {
  if (state.favs.includes(code)) {
    state.favs = state.favs.filter((c) => c !== code);
  } else {
    state.favs.unshift(code);
    if (state.viewing === code) state.viewing = null;
    state.nearby = state.nearby.filter((n) => n.code !== code);
  }
  store.set('favs', state.favs);
  render();
}

// ---------- render ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

function fmtMain(t, now) {
  const s = t.ts - now;
  const mark = t.rt ? '' : '<span class="sched" title="Horaire théorique">*</span>';
  if (s < 60) return `<span class="now">imminent</span>${mark}`;
  if (s >= 3600) return `${hhmm(t.ts)}${mark}`;
  return `${Math.floor(s / 60)}<small> min</small>${mark}`;
}

function fmtNext(t, now) {
  if (!t) return '';
  const s = t.ts - now;
  return s >= 3600 ? hhmm(t.ts) : Math.max(1, Math.floor(s / 60)) + '′';
}

function badge(routeId, small) {
  const r = state.routes.get(routeId) || routeOf(routeId + ':x');
  return `<span class="badge${r.tram ? ' tram' : ''}${small ? ' sm' : ''}" style="background:${r.color};color:${r.text}">${esc(r.short)}</span>`;
}

function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    const ra = state.routes.get(a.route) || {}, rb = state.routes.get(b.route) || {};
    return (rb.tram ? 1 : 0) - (ra.tram ? 1 : 0)
      || String(ra.short || a.route).localeCompare(String(rb.short || b.route), 'fr', { numeric: true })
      || a.dest.localeCompare(b.dest, 'fr');
  });
}

function renderStop(code, kind, meta) {
  const c = state.byCode.get(code);
  const name = c ? c.name : code;
  const data = state.times.get(code);
  const now = Date.now() / 1000;
  const fav = state.favs.includes(code);
  let body = '';
  if (!data) {
    body = '<div class="msg">Chargement…</div>';
  } else {
    const rows = sortRows(data.rows)
      .map((r) => ({ ...r, times: r.times.filter((t) => t.ts > now - 20) }))
      .filter((r) => r.times.length);
    if (!rows.length) body = `<div class="msg">${data.err ? 'Données indisponibles' : 'Aucun passage prévu'}</div>`;
    for (const r of rows) {
      const k = code + '|' + r.key;
      body += `<button class="row" data-row="${esc(k)}">${badge(r.route)}<span class="dir">${esc(r.dest)}</span><span class="t1">${fmtMain(r.times[0], now)}</span><span class="t2">${fmtNext(r.times[1], now)}</span></button>`;
      if (state.open.has(k)) {
        body += '<div class="more">' + r.times.slice(0, 6).map((t) =>
          `<span>${hhmm(t.ts)}${t.rt ? '' : '*'}${t.occ ? ` <span class="occ">${esc(t.occ.toLowerCase())}</span>` : ''}</span>`).join('') + '</div>';
      }
    }
  }
  const close = kind === 'viewing' ? `<button class="star" data-close aria-label="Fermer">×</button>` : '';
  return `<section class="stop">
    <div class="stop-head">
      <h2>${esc(name)}</h2>${meta ? `<span class="meta">${meta}</span>` : ''}
      <button class="star${fav ? ' on' : ''}" data-fav="${esc(code)}" aria-label="${fav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${fav ? '★' : '☆'}</button>${close}
    </div>${body}</section>`;
}

function render() {
  let html = '';
  if (state.viewing && !state.favs.includes(state.viewing)) html += renderStop(state.viewing, 'viewing');
  for (const code of state.favs) html += renderStop(code, 'fav');
  for (const n of state.nearby) {
    if (state.favs.includes(n.code) || n.code === state.viewing) continue;
    html += renderStop(n.code, 'near', `à ${Math.round(n.dist / 10) * 10} m`);
  }
  els.stops.innerHTML = html;
  els.empty.hidden = !!html || !!els.q.value.trim();
  renderAlerts();
  renderStatus();
}

function renderAlerts() {
  const lines = new Set();
  for (const code of visibleCodes()) {
    for (const r of (state.times.get(code)?.rows || [])) lines.add(r.route);
    for (const id of (state.stopRoutes[code] || [])) lines.add(id);
  }
  // trams first, then the urban network, then the rest
  const rank = (a) => Math.min(...a.lines.filter((l) => lines.has(l)).map((l) =>
    state.routes.get(l)?.tram ? 0 : l.startsWith('SEM:') ? 1 : 2));
  const list = state.alerts
    .filter((a) => a.lines.some((l) => lines.has(l)))
    .map((a) => ({ ...a, rank: rank(a), mine: a.lines.filter((l) => lines.has(l)) }))
    .sort((a, b) => a.rank - b.rank);
  if (!list.length) { els.alerts.innerHTML = ''; return; }

  const item = (a) => {
    const open = state.openAlerts.has(a.id);
    return `<button class="alert-item" data-alert="${esc(a.id)}">${a.mine.map((l) => badge(l, true)).join('')}<span>${esc(a.title)}</span>${open ? `<p>${esc(a.text)}</p>` : ''}</button>`;
  };
  if (list.length === 1) { els.alerts.innerHTML = `<div class="alert">${item(list[0])}</div>`; return; }

  const all = [...new Set(list.flatMap((a) => a.mine))];
  const head = `<button class="alert-head" data-alerts><span class="warn">⚠</span><span class="alert-sum">${list.length} perturbations</span>${all.slice(0, 4).map((l) => badge(l, true)).join('')}${all.length > 4 ? `<span class="alert-more">+${all.length - 4}</span>` : ''}<span class="chev">${state.alertsOpen ? '−' : '+'}</span></button>`;
  els.alerts.innerHTML = `<div class="alert">${head}${state.alertsOpen ? list.map(item).join('') : ''}</div>`;
}

function renderStatus() {
  if (!state.lastOk) { els.status.textContent = ''; return; }
  const ago = Math.max(0, Math.round((Date.now() - state.lastOk) / 1000));
  const txt = ago < 60 ? `il y a ${ago} s` : `il y a ${Math.round(ago / 60)} min`;
  els.status.className = 'status' + (state.offline ? ' off' : '');
  els.status.innerHTML = `<span class="dot">●</span> ${state.offline ? 'Hors ligne · données' : 'Temps réel · mis à jour'} ${txt} · * horaire théorique`;
}

let flashTimer;
function flash(msg) {
  els.status.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(renderStatus, 3000);
}

// ---------- voice ----------

function speakStop(code) {
  if (!('speechSynthesis' in window)) return;
  const c = state.byCode.get(code);
  const data = state.times.get(code);
  const now = Date.now() / 1000;
  const parts = [c ? c.name : ''];
  for (const r of sortRows(data?.rows || []).slice(0, 4)) {
    const ts = r.times.filter((t) => t.ts > now).slice(0, 2).map((t) => Math.max(0, Math.floor((t.ts - now) / 60)));
    if (!ts.length) continue;
    const route = state.routes.get(r.route);
    const kind = route?.tram ? 'Tram' : 'Ligne';
    parts.push(`${kind} ${route?.short || ''} vers ${r.dest} : ${ts[0] < 1 ? 'imminent' : 'dans ' + ts[0] + ' minutes'}${ts[1] != null ? ', puis ' + ts[1] + ' minutes' : ''}.`);
  }
  if (parts.length === 1) parts.push('Aucun passage prévu.');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(parts.join('. '));
  u.lang = 'fr-FR';
  speechSynthesis.speak(u);
}

function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  els.mic.hidden = false;
  let rec = null;
  els.mic.addEventListener('click', () => {
    if (rec) { rec.abort(); return; }
    rec = new SR();
    rec.lang = 'fr-FR';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    els.mic.classList.add('listening');
    rec.onresult = (e) => {
      const r = e.results[e.results.length - 1];
      els.q.value = r[0].transcript.replace(/^(arr[eê]t|station)\s+/i, '');
      renderResults();
      if (r.isFinal) {
        const top = search(els.q.value)[0];
        if (top) openStop(top.code).then(() => speakStop(top.code));
      }
    };
    rec.onerror = (e) => { if (e.error === 'not-allowed') flash('Micro refusé'); };
    rec.onend = () => { els.mic.classList.remove('listening'); rec = null; };
    rec.start();
  });
}

// ---------- events ----------

els.q.addEventListener('input', renderResults);
els.q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const top = search(els.q.value)[0]; if (top) openStop(top.code); }
  if (e.key === 'Escape') { els.q.value = ''; renderResults(); }
});
els.loc.addEventListener('click', () => {
  if (state.locOn && state.nearby.length && els.loc.classList.contains('on')) {
    state.nearby = []; state.locOn = false; store.set('locOn', false);
    els.loc.classList.remove('on'); render();
  } else {
    locate(true);
  }
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-open],[data-fav],[data-close],[data-row],[data-alert],[data-alerts]');
  if (!t) return;
  if (t.dataset.open) openStop(t.dataset.open);
  else if (t.dataset.fav) toggleFav(t.dataset.fav);
  else if ('close' in t.dataset) { state.viewing = null; render(); }
  else if (t.dataset.row) { state.open.has(t.dataset.row) ? state.open.delete(t.dataset.row) : state.open.add(t.dataset.row); render(); }
  else if ('alerts' in t.dataset) { state.alertsOpen = !state.alertsOpen; renderAlerts(); }
  else if (t.dataset.alert) { state.openAlerts.has(t.dataset.alert) ? state.openAlerts.delete(t.dataset.alert) : state.openAlerts.add(t.dataset.alert); renderAlerts(); }
});

// don't swap the DOM under a finger mid-tap
let pressing = false;
document.addEventListener('pointerdown', () => { pressing = true; });
document.addEventListener('pointerup', () => { setTimeout(() => { pressing = false; }, 50); });
document.addEventListener('pointercancel', () => { pressing = false; });

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', refresh);

// ---------- boot ----------

async function boot() {
  // links like  ?stop=SEM:GENVH&speak=1  (for Siri / Google Assistant shortcuts)
  const params = new URLSearchParams(location.search);
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('s');
  if (fromHash) {
    for (const code of fromHash.split(',')) if (code && !state.favs.includes(code)) state.favs.push(code);
    store.set('favs', state.favs);
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (params.get('stop')) state.viewing = state.favs.includes(params.get('stop')) ? null : params.get('stop');

  render(); // instant paint from last cached times
  setupVoice();

  await Promise.all([loadRoutes().catch(() => {}), loadClusters().catch(() => {})]);
  render();
  if (els.q.value) renderResults();
  await refresh();
  loadAlerts();
  if (state.locOn) locate(false);

  if (params.get('speak') && params.get('stop')) speakStop(params.get('stop'));

  setInterval(refresh, REFRESH_MS);
  setInterval(loadAlerts, ALERTS_MS);
  setInterval(() => { if (!document.hidden && !pressing) render(); }, 1000);
}

boot();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
