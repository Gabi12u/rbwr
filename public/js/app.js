import {
  normalize, special, totalDemand, totalNext, joinUrl, matchesQuery,
} from './model.js';

const REFRESH_MS = 15000;
const STALE_HEARTBEAT_S = 180;
const BAR_SCALE_S = 1200; // a demand lasts 20 minutes in RBWR
const SOON_S = 300;
const DUE_S = 60;
const PIN_KEY = 'rbwr-demands:pinned';
const SORT_KEY = 'rbwr-demands:sort';
const PUBLIC_KEY = 'rbwr-demands:public-only';
const NO_PROXY = 'no-proxy';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');

const els = {
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  gridU1: document.getElementById('grid-u1'),
  gridU2: document.getElementById('grid-u2'),
  serverCount: document.getElementById('server-count'),
  playerCount: document.getElementById('player-count'),
  rows: document.getElementById('rows'),
  empty: document.getElementById('empty'),
  q: document.getElementById('q'),
  controls: document.getElementById('controls'),
  publicOnly: document.getElementById('public-only'),
};

const state = {
  data: null,          // normalized payload
  receivedAt: 0,       // client time of the last successful load
  clockOffset: 0,      // server time minus client time
  mode: DEMO ? 'demo' : 'proxy',
  stale: false,
  error: null,
  sort: storeGet(SORT_KEY, 'soonest'),
  publicOnly: storeGet(PUBLIC_KEY, false),
  query: params.get('server') || params.get('q') || '',
  pinned: new Set([].concat(storeGet(PIN_KEY, [])).filter((v) => typeof v === 'string')),
};

// ---- helpers ---------------------------------------------------------------

function storeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

function storeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}


function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role' || k === 'title' || k === 'href' || k === 'target' || k === 'rel' || k === 'type') el.setAttribute(k, v === true ? '' : v);
    else el[k] = v;
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const mwFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, useGrouping: false });
const fmtMW = (v) => mwFmt.format(Math.round(v));

function fmtClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtAgo(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const serverNow = () => Date.now() + state.clockOffset;

function secondsLeft(server) {
  if (server.timeLeft === null) return null;
  const base = server.heartbeat ?? state.receivedAt + state.clockOffset;
  return (base + server.timeLeft * 1000 - serverNow()) / 1000;
}

function heartbeatAge(server) {
  if (server.heartbeat === null) return null;
  return (serverNow() - server.heartbeat) / 1000;
}

// ---- data loading ------------------------------------------------------------

// The RBWR API sends no CORS headers, so browsers can't call it directly;
// server.js fetches it and serves it at /api/servers.
async function fetchProxy() {
  const res = await fetch('api/servers', { cache: 'no-store' });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new Error(NO_PROXY);
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function fetchDemo() {
  const { demoPayload, demoRoblox } = await import('./demo.js');
  return { ok: true, source: 'demo', upstream: demoPayload(), roblox: demoRoblox(), now: Date.now() };
}

let loading = false;

async function load() {
  if (loading) return;
  loading = true;
  try {
    const body = state.mode === 'demo' ? await fetchDemo() : await fetchProxy();
    if (body.source === 'demo') state.mode = 'demo';
    state.data = normalize(body.upstream, body.roblox);
    state.receivedAt = Date.now();
    state.clockOffset = typeof body.now === 'number' ? body.now - Date.now() : 0;
    state.stale = Boolean(body.stale);
    state.error = body.stale ? body.error || 'API not answering' : null;
  } catch (err) {
    state.error = err.message || String(err);
  } finally {
    loading = false;
    render();
  }
}

// ---- rendering ---------------------------------------------------------------

function demandView(value, { big }) {
  if (value === null || value === undefined) return h('span', { class: 'window is-empty' }, '----');
  const sp = special(value);
  if (sp) return h('span', { class: `annun tone-${sp.tone}`, title: sp.label }, sp.code);
  if (!big) return h('b', {}, fmtMW(value));
  return h('span', { class: 'window' }, h('span', { class: 'digits' }, fmtMW(value)), h('span', { class: 'unit' }, 'MW'));
}

function unitCell(unit, cls, label) {
  const td = h('td', { class: `c-unit ${cls}`, 'data-label': label });
  if (!unit) {
    td.append(h('span', { class: 'meta' }, 'No data yet'));
    return td;
  }
  td.append(h('div', { class: 'readout' }, demandView(unit.demand, { big: true })));
  if (unit.next !== null) {
    const same = unit.next === unit.demand;
    td.append(h('div', { class: `next ${same ? 'is-same' : 'is-change'}`, title: 'Next demand' },
      h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'sr-only' }, 'Next demand '),
      demandView(unit.next, { big: false }),
      special(unit.next) ? null : ' MW'));
  }
  // Units that aren't running report a small negative output (their own house load).
  if (unit.output !== null && unit.output >= 0.5) {
    td.append(h('div', { class: 'out' }, `Output ${fmtMW(unit.output)} MW`));
  } else if (unit.output !== null) {
    td.append(h('div', { class: 'out' }, 'Not generating'));
  }
  return td;
}

function totalCell(server) {
  const td = h('td', { class: 'c-total', 'data-label': 'Total' });
  const total = totalDemand(server);
  td.append(total === null
    ? h('span', { class: 'meta' }, '—')
    : h('span', { class: 'total' }, fmtMW(total), h('small', {}, ' MW')));
  const next = totalNext(server);
  if (next !== null && total !== null && next !== total) {
    td.append(h('div', { class: 'next is-change' }, h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'), h('span', { class: 'sr-only' }, 'Next total '), h('b', {}, fmtMW(next)), ' MW'));
  }
  return td;
}

function timeCell(server) {
  const td = h('td', { class: 'c-time', 'data-label': 'Next change in' });
  if (server.timeLeft === null) {
    td.append(h('span', { class: 'meta' }, 'Unknown'));
    return td;
  }
  td.append(
    h('span', { class: 'count', 'data-count': '' }, ''),
    h('span', { class: 'bar', 'aria-hidden': 'true' }, h('i', {})),
    h('span', { class: 'due-note', 'data-due': '' }, ''),
  );
  return td;
}

function serverCell(server) {
  const td = h('td', { class: 'c-server' });
  td.append(h('button', {
    class: 'sid', type: 'button', title: `Copy job ID ${server.jobId}`, 'data-copy': server.jobId,
  }, server.shortId));
  if (server.privateKind === 'owner') td.append(h('span', { class: 'meta' }, 'Private server'));
  else if (server.privateKind === 'unlisted') td.append(h('span', { class: 'meta', title: 'Not in Roblox’s public server list' }, 'Not public'));
  else if (server.players !== null) {
    td.append(h('span', { class: 'meta' }, `${server.players}${server.maxPlayers ? ` / ${server.maxPlayers}` : ''} players`));
  }
  td.append(h('span', { class: 'meta', 'data-seen': '' }, ''));
  return td;
}

function rowFor(server) {
  const pinned = state.pinned.has(server.jobId);
  const tr = h('tr', { 'data-id': server.jobId, class: pinned ? 'is-pinned' : '' });
  tr.append(
    h('td', { class: 'c-pin' }, h('button', {
      class: 'pin', type: 'button', 'aria-pressed': pinned ? 'true' : 'false',
      'aria-label': `${pinned ? 'Unpin' : 'Pin'} server ${server.shortId}`,
      title: pinned ? 'Unpin' : 'Pin to top', 'data-pin': server.jobId,
    }, pinned ? '★' : '☆')),
    serverCell(server),
    unitCell(server.units.u1, 'c-u1', 'Unit 1'),
    unitCell(server.units.u2, 'c-u2', 'Unit 2'),
    totalCell(server),
    timeCell(server),
    h('td', { class: 'c-join' }, server.isPrivate
      ? h('span', { class: 'no-join' }, server.privateKind === 'owner' ? 'Invite only' : 'Can’t join')
      : h('a', { class: 'join', href: joinUrl(server.jobId), target: '_blank', rel: 'noopener' }, 'Join')),
  );
  return tr;
}

function sortServers(list) {
  const nullsLast = (v, dir) => (v === null || v === undefined ? Infinity : dir * v);
  const by = {
    soonest: (s) => nullsLast(secondsLeft(s), 1),
    demand: (s) => nullsLast(totalDemand(s), -1),
    players: (s) => nullsLast(s.players, -1),
  }[state.sort] || ((s) => nullsLast(secondsLeft(s), 1));

  return [...list].sort((a, b) => {
    const pa = state.pinned.has(a.jobId) ? 0 : 1;
    const pb = state.pinned.has(b.jobId) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const d = by(a) - by(b);
    if (d !== 0 && !Number.isNaN(d)) return d;
    return a.shortId.localeCompare(b.shortId);
  });
}

function setMeter(el, value) {
  el.textContent = value === null ? '----' : fmtMW(value);
  el.closest('.window').classList.toggle('is-empty', value === null);
}

function renderMeters() {
  const d = state.data;
  if (!d) return;
  setMeter(els.gridU1, d.grid.u1);
  setMeter(els.gridU2, d.grid.u2);
  els.serverCount.textContent = String(d.servers.length);
  els.serverCount.closest('.window').classList.remove('is-empty');
  const known = d.servers.filter((s) => s.players !== null);
  if (known.length) {
    els.playerCount.textContent = String(known.reduce((sum, s) => sum + s.players, 0));
    els.playerCount.closest('.window').classList.remove('is-empty');
  } else {
    els.playerCount.textContent = '--';
    els.playerCount.closest('.window').classList.add('is-empty');
  }
}

function showEmpty(...nodes) {
  els.empty.replaceChildren(...nodes);
  els.empty.hidden = false;
}

function renderRows() {
  const d = state.data;
  if (!d) {
    els.rows.replaceChildren();
    if (state.error === NO_PROXY) {
      showEmpty(h('p', {}, 'This page loads demands through its own server. Start it with “npm start” and open the address it prints.'));
    } else if (state.error) {
      showEmpty(
        h('p', {}, 'The RBWR server API isn’t answering, so there are no demands to show yet. The board retries every 15 seconds.'),
        h('p', {}, h('button', { type: 'button', 'data-action': 'retry' }, 'Retry now')),
      );
    }
    return;
  }

  let list = d.servers;
  if (state.publicOnly) list = list.filter((s) => !s.isPrivate);
  list = list.filter((s) => matchesQuery(s, state.query));
  list = sortServers(list);

  els.rows.replaceChildren(...list.map(rowFor));

  if (list.length) {
    els.empty.hidden = true;
  } else if (!d.servers.length) {
    showEmpty(h('p', {}, 'No RBWR servers are reporting right now. The list refreshes every 15 seconds.'));
  } else if (state.query) {
    showEmpty(
      h('p', {}, `No server matches “${state.query}”. Server IDs look like 7b4f-4460; a full job ID works too.`),
      h('p', {}, h('button', { type: 'button', 'data-action': 'clear' }, 'Clear search')),
    );
  } else {
    showEmpty(
      h('p', {}, 'None of the reporting servers are public right now.'),
      h('p', {}, h('button', { type: 'button', 'data-action': 'show-private' }, 'Show private servers')),
    );
  }
}

function renderStatus() {
  const ago = state.receivedAt ? fmtAgo((Date.now() - state.receivedAt) / 1000) : null;
  let s = 'connecting';
  let text = 'Connecting to the server list…';
  if (state.mode === 'demo' && state.data) {
    s = 'demo';
    text = `Demo data, updated ${ago} ago`;
  } else if (state.data && state.error) {
    s = 'stale';
    text = `Showing data from ${ago} ago. The RBWR API isn’t answering; retrying.`;
  } else if (state.data) {
    s = 'live';
    text = `Live, updated ${ago} ago`;
  } else if (state.error === NO_PROXY) {
    s = 'error';
    text = 'Server not running';
  } else if (state.error) {
    s = 'error';
    text = 'Can’t reach the RBWR server API. Retrying every 15 seconds.';
  }
  els.status.dataset.state = s;
  if (els.statusText.textContent !== text) els.statusText.textContent = text;
}

// Updates countdowns, bars and heartbeat ages without rebuilding rows.
function tick() {
  if (state.data) {
    const byId = new Map(state.data.servers.map((s) => [s.jobId, s]));
    for (const tr of els.rows.children) {
      const server = byId.get(tr.dataset.id);
      if (!server) continue;

      const age = heartbeatAge(server);
      const seen = tr.querySelector('[data-seen]');
      if (seen) {
        const stale = age !== null && age > STALE_HEARTBEAT_S;
        seen.textContent = age === null ? '' : stale ? `No signal for ${fmtAgo(age)}` : `Reported ${fmtAgo(age)} ago`;
        seen.classList.toggle('is-warn', stale);
        tr.classList.toggle('is-stale', stale);
      }

      const left = secondsLeft(server);
      const count = tr.querySelector('[data-count]');
      if (count && left !== null) {
        count.textContent = fmtClock(left);
        tr.querySelector('.bar i').style.setProperty('--p', String(Math.min(1, Math.max(0, left / BAR_SCALE_S))));
        tr.classList.toggle('is-soon', left <= SOON_S);
        tr.classList.toggle('is-due', left <= DUE_S);
        const note = tr.querySelector('[data-due]');
        note.textContent = left <= 0 ? 'Changing now' : left <= DUE_S ? 'Changing soon' : '';
      }
    }
  }
  renderStatus();
}

function render() {
  renderMeters();
  renderRows();
  tick();
}

// ---- interaction -------------------------------------------------------------

function syncUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('server');
  if (state.query) url.searchParams.set('q', state.query);
  else url.searchParams.delete('q');
  history.replaceState(null, '', url);
}

els.q.value = state.query;
els.publicOnly.checked = state.publicOnly;
const sortInput = els.controls.querySelector(`input[name="sort"][value="${state.sort}"]`);
if (sortInput) sortInput.checked = true;

els.controls.addEventListener('submit', (e) => e.preventDefault());

els.q.addEventListener('input', () => {
  state.query = els.q.value.trim();
  syncUrl();
  renderRows();
  tick();
});

els.controls.addEventListener('change', (e) => {
  if (e.target.name === 'sort') {
    state.sort = e.target.value;
    storeSet(SORT_KEY, state.sort);
  } else if (e.target === els.publicOnly) {
    state.publicOnly = els.publicOnly.checked;
    storeSet(PUBLIC_KEY, state.publicOnly);
  }
  renderRows();
  tick();
});

document.addEventListener('click', async (e) => {
  const pin = e.target.closest('[data-pin]');
  if (pin) {
    const id = pin.dataset.pin;
    if (state.pinned.has(id)) state.pinned.delete(id); else state.pinned.add(id);
    storeSet(PIN_KEY, [...state.pinned]);
    renderRows();
    tick();
    const again = els.rows.querySelector(`[data-pin="${CSS.escape(id)}"]`);
    if (again) again.focus();
    return;
  }

  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const label = copy.textContent;
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy failed';
    }
    setTimeout(() => { copy.textContent = label; }, 1200);
    return;
  }

  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'clear') {
    state.query = '';
    els.q.value = '';
    syncUrl();
    renderRows();
    tick();
    els.q.focus();
  } else if (action === 'show-private') {
    state.publicOnly = false;
    els.publicOnly.checked = false;
    storeSet(PUBLIC_KEY, false);
    renderRows();
    tick();
  } else if (action === 'retry') {
    load();
  }
});

// ---- start -------------------------------------------------------------------

load();
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - state.receivedAt > REFRESH_MS) load();
});
