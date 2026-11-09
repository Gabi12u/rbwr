import {
  normalize, special, totalDemand, totalNext, joinUrl, matchesQuery, serverFaults, FAULTS,
} from './model.js';

const REFRESH_MS = 15000;
const SNAPSHOT_REFRESH_MS = 60000; // GitHub Pages snapshots change every few minutes
const STALE_HEARTBEAT_S = 180;
const PERIOD_S = 1200; // a demand lasts 20 minutes in RBWR
const SOON_S = 300;
const DUE_S = 60;
const GAUGE_MAX = 1200;
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
  ann: document.getElementById('ann'),
  ack: document.getElementById('ack'),
};

const state = {
  data: null,          // normalized payload
  byId: new Map(),     // jobId -> server
  receivedAt: 0,       // client time of the last successful load
  clockOffset: 0,      // server time minus client time
  snapshotAt: null,    // fetch time of a static snapshot (GitHub Pages), else null
  mode: DEMO ? 'demo' : 'proxy',
  stale: false,
  error: null,
  sort: storeGet(SORT_KEY, 'soonest'),
  publicOnly: storeGet(PUBLIC_KEY, false),
  query: params.get('server') || params.get('q') || '',
  pinned: new Set([].concat(storeGet(PIN_KEY, [])).filter((v) => typeof v === 'string')),
};

const modules = new Map(); // jobId -> { el, refs }
const annunciators = new Map(); // key -> { el, lit, acked }

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
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k === 'className' ? 'class' : k, v === true ? '' : v);
  }
}

function append(el, children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const r2 = (n) => Math.round(n * 100) / 100;
const fmtMW = (v) => String(Math.round(v));

function fmtClock(seconds) {
  const sec = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

function fmtAgo(seconds) {
  const sec = Math.max(0, Math.round(seconds));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
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

// How long the server had been silent when the data was fetched. For a
// snapshot that's measured at snapshot time, so older snapshots don't make
// every server look dead.
function silence(server) {
  if (server.heartbeat === null) return null;
  return ((state.snapshotAt ?? serverNow()) - server.heartbeat) / 1000;
}

function demandOf(server) {
  return server.units.u1?.demand ?? server.units.u2?.demand ?? null;
}

// After the countdown runs out, the API keeps the old demand until the server
// reports again (often 60–90 s later). The new demand is already known (it was
// "next") and starts a fresh 20-minute period, so the board shows that instead.
// Past that period the data is too old to say anything.
function timing(server) {
  const raw = secondsLeft(server);
  if (raw === null) return { left: null, phase: 'none' };
  if (raw > 0) return { left: raw, phase: 'live' };
  if (raw + PERIOD_S > 0) return { left: raw + PERIOD_S, phase: 'projected' };
  return { left: null, phase: 'expired' };
}

function view(server, t) {
  if (t.phase === 'projected') {
    const shift = (u) => (u && u.next !== null ? { ...u, demand: u.next, next: null } : u);
    return { ...server, units: { u1: shift(server.units.u1), u2: shift(server.units.u2) } };
  }
  if (t.phase === 'expired') {
    const blank = (u) => (u ? { ...u, demand: null, next: null } : u);
    return { ...server, units: { u1: blank(server.units.u1), u2: blank(server.units.u2) } };
  }
  return server;
}

// ---- instruments -------------------------------------------------------------

// 7-segment LED: dim "8"s behind the lit digits, like the in-game displays.
function led(size, ghost, extraClass = '') {
  const lit = h('span', { class: 'led-lit' });
  const el = h('span', { class: `led led-${size} ${extraClass}` },
    h('span', { class: 'led-ghost', 'aria-hidden': 'true' }, ghost), lit);
  return { el, lit };
}

// Round gauge, 240° sweep, 0 to 1200 MW.
const G = { cx: 100, cy: 94, r: 78 };
const gaugeAngle = (v) => -120 + 240 * Math.min(1, Math.max(0, v / GAUGE_MAX));
function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [r2(G.cx + r * Math.sin(a)), r2(G.cy - r * Math.cos(a))];
}
function arc(r, a0, a1) {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  return `M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

function gauge(label) {
  const ticks = [];
  const nums = [];
  for (let v = 0; v <= GAUGE_MAX; v += 50) {
    const major = v % 100 === 0;
    const a = gaugeAngle(v);
    const [x0, y0] = polar(G.r - 2, a);
    const [x1, y1] = polar(G.r - (major ? 12 : 7), a);
    ticks.push(s('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: major ? 'tick tick-major' : 'tick' }));
    if (v % 200 === 0) {
      const [tx, ty] = polar(G.r - 25, a);
      nums.push(s('text', { x: tx, y: ty + 4.5, class: 'dial-num' }, String(v / 100)));
    }
  }
  const [lx, ly] = polar(G.r, -120);
  const [rx, ry] = polar(G.r, 120);

  const band = s('path', { class: 'dial-band', d: '' });
  const pointer = s('g', { class: 'dial-pointer' },
    s('polygon', { points: `${G.cx},${G.cy - G.r + 12} ${G.cx - 6},${G.cy - G.r - 2} ${G.cx + 6},${G.cy - G.r - 2}` }));
  const needle = s('g', { class: 'dial-needle' },
    s('polygon', { points: `${G.cx - 2.6},${G.cy + 10} ${G.cx},${G.cy - G.r + 8} ${G.cx + 2.6},${G.cy + 10}` }),
    s('circle', { cx: G.cx, cy: G.cy, r: 7, class: 'dial-hub' }),
    s('circle', { cx: G.cx, cy: G.cy, r: 2.2, class: 'dial-hub-cap' }));

  const svg = s('svg', { viewBox: '0 0 200 150', class: 'dial', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { x: 1, y: 1, width: 198, height: 148, rx: 16, class: 'dial-bezel' }),
    s('rect', { x: 7, y: 7, width: 186, height: 136, rx: 11, class: 'dial-well' }),
    s('path', { d: `M${G.cx} ${G.cy} L${lx} ${ly} A${G.r} ${G.r} 0 1 1 ${rx} ${ry} Z`, class: 'dial-face' }),
    band, ...ticks, ...nums,
    s('text', { x: G.cx, y: G.cy + 24, class: 'dial-unit' }, 'MW ×100'),
    pointer, needle,
    s('rect', { x: 68, y: 127, width: 64, height: 14, rx: 2, class: 'dial-plate' }),
    s('text', { x: 100, y: 137.3, class: 'dial-plate-text' }, label));
  return { svg, band, pointer, needle };
}

function setGauge(g, output, demand) {
  const live = demand !== null && demand >= 0;
  g.svg.classList.toggle('is-off', !live && !(output > 0));
  g.needle.style.transform = `rotate(${gaugeAngle(output > 0 ? output : 0)}deg)`;
  if (live && demand > 0) {
    g.pointer.style.transform = `rotate(${gaugeAngle(demand)}deg)`;
    g.pointer.style.opacity = '1';
    g.band.setAttribute('d', arc(G.r - 5, gaugeAngle(Math.max(0, demand - 25)), gaugeAngle(Math.min(GAUGE_MAX, demand + 25))));
  } else {
    g.pointer.style.opacity = '0';
    g.band.setAttribute('d', '');
  }
}

// Edgewise meter for the countdown: 0 to 20 minutes, red under 1, yellow under 5.
const E = { x0: 20, w: 280 };
const edgeX = (seconds) => r2(E.x0 + E.w * Math.min(1, Math.max(0, seconds / PERIOD_S)));

function edgewise() {
  const parts = [];
  for (let m = 0; m <= 20; m++) {
    const x = edgeX(m * 60);
    const major = m % 5 === 0;
    parts.push(s('line', { x1: x, y1: 14, x2: x, y2: major ? 26 : 21, class: major ? 'tick tick-major' : 'tick' }));
    if (major) parts.push(s('text', { x, y: 37, class: 'edge-num' }, String(m)));
  }
  const pointer = s('g', { class: 'edge-pointer' },
    s('line', { x1: 0, y1: 9, x2: 0, y2: 30 }),
    s('polygon', { points: '-4,33 4,33 0,27' }));
  const svg = s('svg', { viewBox: '0 0 320 48', class: 'edge', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { x: 1, y: 1, width: 318, height: 46, rx: 7, class: 'dial-bezel' }),
    s('rect', { x: 6, y: 6, width: 308, height: 36, rx: 3, class: 'edge-face' }),
    s('rect', { x: edgeX(0), y: 9, width: r2(edgeX(60) - edgeX(0)), height: 4, class: 'zone-red' }),
    s('rect', { x: edgeX(60), y: 9, width: r2(edgeX(300) - edgeX(60)), height: 4, class: 'zone-amber' }),
    ...parts,
    s('text', { x: 309, y: 37, class: 'edge-unit' }, 'min'),
    pointer);
  return { svg, pointer };
}

// ---- server modules ----------------------------------------------------------

function unitBlock(label, jobId, unit) {
  const g = gauge(label);
  const out = h('span', { class: 'unit-out' });
  const open = h('button', { class: 'pushbtn unit-open', type: 'button', 'data-open': `${jobId}|${unit}` },
    `Unit ${unit.slice(1)} panel`, h('span', { 'aria-hidden': 'true' }, ' ▸'));
  const el = h('figure', { class: 'unit' }, g.svg, h('figcaption', { class: 'unit-read' }, out, open));
  return { el, g, out };
}

// A demand as a 7-segment LED, or as a lit tile for special states (Maint, LOOP …).
function demandReadout(value, { amber = false, title = '' } = {}) {
  const sp = special(value);
  if (sp) return h('span', { class: `annun tone-${sp.tone}`, title: sp.label }, sp.code);
  const l = led('lg', '8888', amber ? 'led-amber' : '');
  l.lit.textContent = value === null || value === undefined ? '----' : fmtMW(value);
  if (title) l.el.title = title;
  return l.el;
}

// "Demand now ▶ Next demand": one row when both units share the demand
// (almost always), one row per unit when they differ.
function updateDemand(rows, v, t) {
  if (t.phase === 'expired') {
    rows.replaceChildren(h('p', { class: 'dem-note' },
      'No current demand: the last report from this server is older than a full demand period (20 min).',
      state.snapshotAt !== null ? ' The website copy refreshes every few minutes; the app on your PC is live.' : ''));
    return;
  }
  const projected = t.phase === 'projected';
  const d1 = v.units.u1?.demand ?? null;
  const d2 = v.units.u2?.demand ?? null;
  const n1 = v.units.u1?.next ?? null;
  const n2 = v.units.u2?.next ?? null;
  const same = d1 === d2 && n1 === n2;
  const row = (unit, d, n) => [
    unit ? h('span', { class: 'dem-unit' }, unit) : null,
    h('span', { class: 'dem-now' }, demandReadout(d)),
    h('span', { class: 'dem-arrow', 'aria-hidden': 'true' }, '▶'),
    h('span', { class: 'dem-next' }, n === null && projected
      ? h('span', { class: 'dem-wait' }, 'Shows with the server’s next report')
      : demandReadout(n, { amber: true })),
  ];
  const cells = [
    h('span', { class: 'dem-label dem-label-now' }, 'Demand now [MW]'),
    h('span', { class: 'dem-label dem-label-next' }, 'Next demand [MW]'),
    ...(same ? row(null, d1, n1) : [...row('U1', d1, n1), ...row('U2', d2, n2)]),
  ];
  rows.replaceChildren(...cells.filter(Boolean));
}

function createModule(server) {
  const lampG = h('i', { class: 'lamp lamp-g' });
  const lampY = h('i', { class: 'lamp lamp-y' });
  const lampR = h('i', { class: 'lamp lamp-r' });
  const lamps = h('span', { class: 'lamps' }, lampR, lampY, lampG);
  const id = h('button', { class: 'tag tag-id', type: 'button', 'data-copy': server.jobId, title: `Copy job ID ${server.jobId}` }, server.shortId);
  const pin = h('button', { class: 'pushbtn pin', type: 'button', 'data-pin': server.jobId }, h('i', { class: 'key-lamp' }), 'Pin');
  const who = h('span', { class: 'mod-who' });
  const seen = h('span', { class: 'mod-seen' });
  const u1 = unitBlock('UNIT 1 MWe', server.jobId, 'u1');
  const u2 = unitBlock('UNIT 2 MWe', server.jobId, 'u2');
  const demandRows = h('div', { class: 'dem-grid' });
  const count = led('lg', '88:88');
  const edge = edgewise();
  const due = h('span', { class: 'timer-note' });
  const total = h('p', { class: 'mod-total' });
  const action = h('div', { class: 'mod-action' });
  const faultTiles = new Map();
  const faults = h('ul', { class: 'fault-grid', 'aria-label': 'Faults' }, FAULTS.map((f) => {
    const tile = h('li', { class: 'ann-tile ann-sm', 'data-tone': f.tone }, h('span', {}, f.label), h('small', { class: 'fault-units' }));
    faultTiles.set(f.key, tile);
    return tile;
  }));
  const events = h('ul', { class: 'mod-events' });

  const el = h('li', { class: 'module', 'data-id': server.jobId },
    h('div', { class: 'mod-head' }, id, lamps, pin),
    h('p', { class: 'mod-meta' }, who, seen),
    h('section', { class: 'dem-box', 'aria-label': 'Demand' },
      demandRows,
      h('div', { class: 'mod-timer' },
        h('div', { class: 'timer-read' }, h('span', { class: 'dem-label' }, 'Changes in'), count.el, due),
        edge.svg)),
    h('div', { class: 'mod-units' }, u1.el, u2.el),
    faults,
    events,
    h('div', { class: 'mod-foot' }, total, action));

  return { el, refs: { lampG, lampY, lampR, lamps, id, pin, who, seen, u1, u2, demandRows, count, edge, due, total, action, faultTiles, events } };
}

// Units that aren't running report a small negative output (their own house load).
function updateOutput(block, unit) {
  const out = unit?.output ?? null;
  block.out.textContent = out === null ? 'No data yet' : out >= 0.5 ? `Output ${fmtMW(out)} MW` : 'Not generating';
  block.out.classList.toggle('is-idle', !(out >= 0.5));
}

function updateModule(entry, server) {
  const { refs } = entry;
  const t = timing(server);
  entry.phase = t.phase;
  const v = view(server, t);
  const pinned = state.pinned.has(server.jobId);
  entry.el.classList.toggle('is-pinned', pinned);
  refs.pin.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  refs.pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} server ${server.shortId}`);
  refs.pin.title = pinned ? 'Unpin' : 'Pin to top';

  if (server.privateKind === 'owner') refs.who.textContent = 'Private server';
  else if (server.privateKind === 'unlisted') refs.who.textContent = 'Not in the public list';
  else if (server.players !== null) refs.who.textContent = `${server.players} / ${server.maxPlayers || 12} players`;
  else refs.who.textContent = 'Public server';

  updateDemand(refs.demandRows, v, t);
  updateOutput(refs.u1, v.units.u1);
  updateOutput(refs.u2, v.units.u2);

  const total = totalDemand(v);
  const next = totalNext(v);
  refs.total.replaceChildren(
    h('span', { class: 'tag tag-sm' }, 'Total'),
    ' ',
    total === null ? '–' : h('b', {}, `${fmtMW(total)} MW`),
    next !== null && total !== null && next !== total ? ` → ${fmtMW(next)} MW` : '');

  let action;
  if (server.privateKind === 'owner') action = h('span', { class: 'hang-tag hang-tag-red', title: 'Private server: join through an invite' }, 'Private', h('small', {}, 'Invite only'));
  else if (server.privateKind === 'unlisted') action = h('span', { class: 'hang-tag', title: 'Not in Roblox’s public server list' }, 'Not public', h('small', {}, 'Can’t join'));
  else action = h('a', { class: 'pushbtn go', href: joinUrl(server.jobId), target: '_blank', rel: 'noopener' }, 'Join');
  refs.action.replaceChildren(action);

  const active = serverFaults(server);
  for (const f of FAULTS) {
    const tile = refs.faultTiles.get(f.key);
    const a = active[f.key];
    tile.classList.toggle('is-lit', Boolean(a));
    tile.lastChild.textContent = a ? [a.units.join('+'), f.key === 'turbdmg' ? a.details.join(' ') : ''].filter(Boolean).join(' ') : '';
    tile.title = a ? [f.label, a.units.join(' and '), f.key === 'turbdmg' ? `health ${a.details.join(', ')}` : a.details.join(', ')].filter(Boolean).join(': ') : `${f.label}: normal`;
  }

  const lines = [];
  for (const [name, unit] of [['U1', server.units.u1], ['U2', server.units.u2]]) {
    const fl = unit?.faults;
    if (!fl) continue;
    if (fl.lastScram) lines.push(`Last scram ${name}: ${fl.lastScram}`);
    if (fl.lastTrip) lines.push(`Last turbine trip ${name}: ${fl.lastTrip}`);
    if (fl.dieselRunning) lines.push(`Emergency diesel running on ${name}`);
  }
  refs.events.replaceChildren(...lines.map((line) => h('li', {}, line)));
  refs.events.hidden = !lines.length;
}

// Sets the gauges; called after the module is in the document so the needles swing.
function updateGauges(entry, server) {
  const { refs } = entry;
  const v = view(server, timing(server));
  setGauge(refs.u1.g, v.units.u1?.output ?? null, v.units.u1?.demand ?? null);
  setGauge(refs.u2.g, v.units.u2?.output ?? null, v.units.u2?.demand ?? null);
}

function tickModule(entry, server) {
  const { el, refs } = entry;
  const age = heartbeatAge(server);
  const quiet = silence(server);
  const stale = quiet !== null && quiet > STALE_HEARTBEAT_S;
  refs.seen.textContent = age === null ? '' : stale ? `No signal for ${fmtAgo(quiet)}` : `Reported ${fmtAgo(age)} ago`;
  refs.seen.classList.toggle('is-warn', stale);
  el.classList.toggle('is-stale', stale);

  const t = timing(server);
  if (t.phase !== entry.phase) {
    updateModule(entry, server);
    updateGauges(entry, server);
  }
  const left = t.left;
  const soon = left !== null && left <= SOON_S;
  const dueNow = left !== null && left <= DUE_S;
  el.classList.toggle('is-soon', soon);
  el.classList.toggle('is-due', dueNow);
  refs.lampG.classList.toggle('is-on', !stale && server.heartbeat !== null);
  refs.lampY.classList.toggle('is-on', soon && !dueNow);
  refs.lampR.classList.toggle('is-on', dueNow);
  refs.lamps.title = dueNow ? 'Demand changes within 1 minute' : soon ? 'Demand changes within 5 minutes' : stale ? 'No recent report' : 'Reporting';

  refs.count.lit.textContent = left === null ? '--:--' : fmtClock(left);
  refs.edge.pointer.style.transform = `translateX(${edgeX(left ?? 0)}px)`;
  refs.edge.svg.classList.toggle('is-off', left === null);
  refs.due.textContent = t.phase === 'none' ? 'Waiting for first report'
    : t.phase === 'expired' ? 'No recent data'
      : t.phase === 'projected' ? 'New demand, report pending'
        : dueNow ? 'Changing soon' : '';
  el.classList.toggle('is-projected', t.phase === 'projected');
}

// ---- unit panel ----------------------------------------------------------------

// Everything the game reports per unit, laid out like the control room.
// Readouts only appear for fields the unit actually sends.
const BOARD_SECTIONS = [
  { title: 'Reactor control panel', items: [
    { key: 'APRM', label: 'Average power range monitor [%]', kind: 'seg', digits: 5, dec: 1 },
    { key: 'RTP', label: 'Rated thermal power [%]', kind: 'seg', digits: 5, dec: 1 },
    { key: 'Avg. Rod', label: 'Avg. rod position', kind: 'lcd', unit: '%', dec: 2 },
    { key: 'APRM Setpoint', label: 'APRM setpoint', kind: 'lcd', unit: '%', dec: 0 },
    { key: 'Xenon', label: 'Xenon', kind: 'lcd', dec: 3 },
    { key: 'Iodine', label: 'Iodine', kind: 'lcd', dec: 3 },
    { key: 'Reactor Scram State', label: 'Reactor scram', kind: 'lamp', on: 'r' },
    { key: ['DoAutoScramU1', 'DoAutoScramU2'], label: 'Auto scram armed', kind: 'lamp', on: 'g' },
    { key: 'RPS Trip State A', label: 'RPS trip A', kind: 'lamp', on: 'r' },
    { key: 'RPS Trip State B', label: 'RPS trip B', kind: 'lamp', on: 'r' },
  ] },
  { title: 'Reactor vessel', items: [
    { key: 'Pressure', label: 'Reactor pressure [kPa]', kind: 'seg', digits: 4, dec: 0 },
    { key: 'Reactor Temp', label: 'Reactor temperature [°C]', kind: 'seg', digits: 4, dec: 1 },
    { key: 'ReactorLevel', label: 'Reactor level', kind: 'lcd', unit: 'm', dec: 2 },
    { key: 'Recirc1', label: 'Recirc pump 1', kind: 'bar' },
    { key: 'Recirc2', label: 'Recirc pump 2', kind: 'bar' },
    { key: 'AutoPressure', label: 'Auto pressure control', kind: 'lamp', on: 'g' },
  ] },
  { title: 'Feedwater & condensate', items: [
    { key: 'FWP1', label: 'Feedwater pump 1', kind: 'bar' },
    { key: 'FWP2', label: 'Feedwater pump 2', kind: 'bar' },
    { key: 'Hotwell Level', label: 'Hotwell level', kind: 'lcd', unit: 'm', dec: 2 },
    { key: 'Deareator Level', label: 'Deaerator level', kind: 'lcd', unit: 'm', dec: 2 },
    { key: 'FWP1 Temp', label: 'FWP 1 temperature', kind: 'lcd', unit: '°C', dec: 1 },
    { key: 'FWP2 Temp', label: 'FWP 2 temperature', kind: 'lcd', unit: '°C', dec: 1 },
  ] },
  { title: 'Turbine & generator', items: [
    { key: 'Turbine RPM', label: 'Turbine speed [rpm]', kind: 'seg', digits: 4, dec: 0 },
    { key: 'TurbineHealth', label: 'Turbine health', kind: 'lcd', unit: '%', dec: 0 },
    { key: 'GeneratorTemperature', label: 'Generator temperature', kind: 'lcd', unit: '°C', dec: 1 },
    { key: 'CasingTemperature', label: 'Casing temperature', kind: 'lcd', unit: '°C', dec: 1 },
    { key: 'Vibrations', label: 'Vibration', kind: 'lcd', dec: 2 },
    { key: 'TurbineTrip', label: 'Turbine trip', kind: 'lamp', on: 'r' },
    { key: 'BypassTurbineAutoTrip', label: 'Bypass turbine auto trip', kind: 'lamp', on: 'y' },
    { key: 'Disk Ruptured', label: 'Rupture disk', kind: 'lamp', on: 'r' },
  ] },
  { title: 'Electrical distribution panel', items: [
    { key: ['Output (MW)', 'PradDoSieci'], label: 'Sent to grid [MW]', kind: 'seg', color: 'green', digits: 5, dec: 1 },
    { key: 'DieselRPM', label: 'Diesel generator [rpm]', kind: 'seg', color: 'green', digits: 4, dec: 0 },
    { key: 'Offsite Power', label: 'Offsite power', kind: 'lamp', on: 'g' },
    { key: 'Startup XFMR', label: 'Startup transformer', kind: 'lamp', on: 'g' },
    { key: 'BusA', label: 'Bus A', kind: 'lamp', on: 'g' },
    { key: 'BusB', label: 'Bus B', kind: 'lamp', on: 'g' },
    { key: 'DCBus', label: 'DC bus', kind: 'lamp', on: 'g' },
  ] },
];

function fmtNum(v, dec = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(dec) : '----';
}

function boardItem(item) {
  const keys = [].concat(item.key);
  const read = (raw) => {
    for (const k of keys) if (raw && raw[k] !== undefined && raw[k] !== null) return raw[k];
    return undefined;
  };
  if (item.kind === 'seg') {
    const l = led('lg', '8'.repeat(item.digits), item.color === 'green' ? 'led-green' : '');
    return {
      el: h('div', { class: 'inst inst-seg' }, l.el, h('span', { class: 'inst-plate' }, item.label)),
      has: (raw) => typeof read(raw) === 'number',
      update: (raw) => { l.lit.textContent = fmtNum(read(raw), item.dec); },
    };
  }
  if (item.kind === 'lcd') {
    const value = h('span', { class: 'lcd-value' });
    return {
      el: h('div', { class: 'inst lcd' }, value, h('span', { class: 'lcd-label' }, item.label)),
      has: (raw) => typeof read(raw) === 'number',
      update: (raw) => { value.textContent = `${fmtNum(read(raw), item.dec)}${item.unit ? ` ${item.unit}` : ''}`; },
    };
  }
  if (item.kind === 'bar') {
    const fill = h('i');
    const value = h('span', { class: 'hbar-value' });
    return {
      el: h('div', { class: 'inst hbar-meter' }, h('span', { class: 'inst-name' }, item.label), h('span', { class: 'hbar' }, fill), value),
      has: (raw) => typeof read(raw) === 'number',
      update: (raw) => {
        const v = read(raw);
        fill.style.width = `${Math.min(100, Math.max(0, v))}%`;
        value.textContent = `${fmtNum(v, 0)} %`;
      },
    };
  }
  const lamp = h('i', { class: `lamp lamp-${item.on}` });
  return {
    el: h('div', { class: 'inst lamp-row' }, lamp, h('span', { class: 'inst-name' }, item.label)),
    has: (raw) => typeof read(raw) === 'boolean',
    update: (raw) => { lamp.classList.toggle('is-on', read(raw) === true); },
  };
}

const boardEl = document.getElementById('unit-board');
const board = { jobId: null, unit: 'u1', items: [], refs: null, pushed: false };

function buildBoard(server) {
  const unitNo = board.unit.slice(1);
  const raw = server.units[board.unit]?.raw || null;
  boardEl.classList.toggle('theme-u1', board.unit === 'u1');
  boardEl.classList.toggle('theme-u2', board.unit === 'u2');

  const switchKeys = ['u1', 'u2'].map((u) => h('button', {
    class: 'pushbtn board-key', type: 'button', 'data-open': `${server.jobId}|${u}`, 'aria-pressed': u === board.unit ? 'true' : 'false',
  }, h('i', { class: 'key-lamp' }), `Unit ${u.slice(1)}`));

  const g = gauge(`UNIT ${unitNo} MWe`);
  const demandRows = h('div', { class: 'dem-grid' });
  const count = led('lg', '88:88');
  const due = h('span', { class: 'timer-note' });
  const edge = edgewise();
  const events = h('ul', { class: 'event-log' });
  const site = h('div', { class: 'site-row' });

  board.items = [];
  const sections = raw ? BOARD_SECTIONS.map((sec) => {
    const items = sec.items.map(boardItem).filter((it) => it.has(raw));
    if (!items.length) return null;
    board.items.push(...items);
    return h('section', { class: 'bsec' }, h('h3', { class: 'bsec-title' }, sec.title), h('div', { class: 'bsec-body' }, items.map((it) => it.el)));
  }).filter(Boolean) : [h('p', { class: 'board-empty' }, 'This unit hasn’t reported any readings yet.')];

  boardEl.replaceChildren(
    h('header', { class: 'board-head' },
      h('h2', { class: 'board-unit', id: 'board-title' }, `Unit 0${unitNo}`),
      h('button', { class: 'tag tag-id', type: 'button', 'data-copy': server.jobId, title: `Copy job ID ${server.jobId}` }, server.shortId),
      h('div', { class: 'board-keys' }, switchKeys),
      h('button', { class: 'pushbtn board-close', type: 'button', 'data-close': '' }, 'Close')),
    h('div', { class: 'board-body' },
      h('div', { class: 'board-top' },
        h('section', { class: 'dem-box', 'aria-label': 'Demand' },
          demandRows,
          h('div', { class: 'mod-timer' },
            h('div', { class: 'timer-read' }, h('span', { class: 'dem-label' }, 'Changes in'), count.el, due),
            edge.svg)),
        h('figure', { class: 'board-gauge' }, g.svg),
        h('section', { class: 'events-box', 'aria-label': 'Recent events' },
          h('h3', { class: 'events-title' }, 'Recent events logger'), events)),
      h('div', { class: 'board-grid' }, sections),
      h('section', { class: 'bsec bsec-site' }, h('h3', { class: 'bsec-title' }, 'Site'), site)));

  board.refs = { g, demandRows, count, due, edge, events, site };
}

function updateBoard() {
  if (!boardEl.open || !board.refs) return;
  const server = state.byId.get(board.jobId);
  if (!server) {
    board.refs.events.replaceChildren(h('li', { class: 'is-alert' }, 'This server stopped reporting. It may have shut down.'));
    return;
  }
  const t = timing(server);
  const v = view(server, t);
  const unit = server.units[board.unit];
  const raw = unit?.raw || null;
  if (raw) board.items.forEach((it) => it.update(raw));

  const single = { ...v, units: { u1: v.units[board.unit], u2: v.units[board.unit] } };
  updateDemand(board.refs.demandRows, single, t);
  setGauge(board.refs.g, v.units[board.unit]?.output ?? null, v.units[board.unit]?.demand ?? null);

  const lines = [];
  const f = unit?.faults;
  if (f?.scram) lines.push(['is-alert', 'Reactor scram active']);
  if (f?.turbineTrip) lines.push(['is-alert', 'Turbine tripped']);
  if (f?.offsiteLost) lines.push(['is-alert', 'Offsite power lost']);
  if (f?.ruptureDisk) lines.push(['is-alert', 'Rupture disk ruptured']);
  if (server.fire) lines.push(['is-alert', 'Fire alarm: smoke detected']);
  if (f?.dieselRunning) lines.push(['is-warn', 'Emergency diesel generator running']);
  if (f?.turbineHealth !== null && f?.turbineHealth !== undefined && f.turbineHealth < 100) lines.push(['is-warn', `Turbine damaged: ${Math.round(f.turbineHealth)} % health`]);
  if (f?.lastScram) lines.push(['', `Last scram: ${f.lastScram}`]);
  if (f?.lastTrip) lines.push(['', `Last turbine trip: ${f.lastTrip}`]);
  if (!lines.length) lines.push(['is-quiet', 'No events reported']);
  board.refs.events.replaceChildren(...lines.map(([cls, text]) => h('li', { class: cls }, text)));

  const m = server.misc || {};
  const siteItems = [
    ['Outside temperature', typeof m['Outside Temperature'] === 'number' ? `${fmtNum(m['Outside Temperature'], 0)} °C` : null],
    ['EDG diesel storage', typeof m['EDG Diesel Storage'] === 'number' ? fmtNum(m['EDG Diesel Storage'], 0) : null],
    ['Evacuation cooldown', typeof m['Evacuation Cooldown'] === 'number' ? (m['Evacuation Cooldown'] > 0 ? fmtClock(m['Evacuation Cooldown']) : 'None') : null],
    ['Points per second', typeof m['Total points/second'] === 'number' ? fmtNum(m['Total points/second'], 2) : null],
  ].filter(([, value]) => value !== null);
  board.refs.site.replaceChildren(...siteItems.map(([label, value]) =>
    h('div', { class: 'inst lcd' }, h('span', { class: 'lcd-value' }, value), h('span', { class: 'lcd-label' }, label))));
  tickBoard();
}

function tickBoard() {
  if (!boardEl.open || !board.refs) return;
  const server = state.byId.get(board.jobId);
  if (!server) return;
  const t = timing(server);
  if (t.phase !== board.phase) {
    board.phase = t.phase;
    updateBoard();
    return;
  }
  const left = t.left;
  board.refs.count.lit.textContent = left === null ? '--:--' : fmtClock(left);
  board.refs.edge.pointer.style.transform = `translateX(${edgeX(left ?? 0)}px)`;
  board.refs.due.textContent = t.phase === 'projected' ? 'New demand, report pending' : left !== null && left <= DUE_S ? 'Changing soon' : '';
  boardEl.classList.toggle('is-due', left !== null && left <= DUE_S);
}

function openBoard(jobId, unit) {
  const server = state.byId.get(jobId);
  if (!server) return;
  board.jobId = jobId;
  board.unit = unit;
  board.phase = timing(server).phase;
  buildBoard(server);
  if (!boardEl.open) boardEl.showModal();
  updateBoard();
}

// The panel lives in the URL (#unit/<job id>/u1) so the back button closes it
// and a panel can be shared as a link.
function boardHash(jobId, unit) { return `#unit/${jobId}/${unit}`; }

function routeFromHash() {
  const m = location.hash.match(/^#unit\/([0-9a-fA-F-]+)\/(u[12])$/);
  if (m && state.data) {
    const server = state.data.servers.find((sv) => sv.jobId === m[1] || sv.shortId === m[1]);
    if (server) { openBoard(server.jobId, m[2]); return; }
  }
  if (!m && boardEl.open) boardEl.close();
}

window.addEventListener('hashchange', routeFromHash);

boardEl.addEventListener('close', () => {
  board.refs = null;
  if (location.hash.startsWith('#unit/')) {
    if (board.pushed) history.back();
    else history.replaceState(null, '', location.pathname + location.search);
  }
  board.pushed = false;
});

boardEl.addEventListener('click', (e) => {
  if (e.target === boardEl) boardEl.close(); // click on the backdrop
  if (e.target.closest('[data-close]')) boardEl.close();
});

// ---- data loading ------------------------------------------------------------

// The RBWR API sends no CORS headers, so browsers can't call it directly.
// The RBWR Demands app fetches it and serves it at /api/servers; on GitHub
// Pages a workflow publishes a snapshot at api/servers.json instead.
async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) return null;
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function fetchLive() {
  if (state.snapshotAt === null) {
    const body = await fetchJson('api/servers');
    if (body) return body;
  }
  const snapshot = await fetchJson('api/servers.json');
  if (snapshot) return snapshot;
  throw new Error(NO_PROXY);
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
    const body = state.mode === 'demo' ? await fetchDemo() : await fetchLive();
    if (body.source === 'demo') state.mode = 'demo';
    state.snapshotAt = body.snapshot ? body.fetchedAt : null;
    state.data = normalize(body.upstream, body.roblox);
    state.byId = new Map(state.data.servers.map((sv) => [sv.jobId, sv]));
    state.receivedAt = Date.now();
    // A snapshot's "now" is its fetch time, so trust this computer's clock instead.
    state.clockOffset = !body.snapshot && typeof body.now === 'number' ? body.now - Date.now() : 0;
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

function sortServers(list) {
  const nullsLast = (v, dir) => (v === null || v === undefined ? Infinity : dir * v);
  const by = {
    soonest: (sv) => nullsLast(timing(sv).left, 1),
    demand: (sv) => nullsLast(totalDemand(view(sv, timing(sv))), -1),
    players: (sv) => nullsLast(sv.players, -1),
  }[state.sort] || ((sv) => nullsLast(timing(sv).left, 1));

  return [...list].sort((a, b) => {
    const pa = state.pinned.has(a.jobId) ? 0 : 1;
    const pb = state.pinned.has(b.jobId) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const d = by(a) - by(b);
    if (d !== 0 && !Number.isNaN(d)) return d;
    return a.shortId.localeCompare(b.shortId);
  });
}

function setLed(el, value) {
  el.textContent = value === null ? '-'.repeat(el.previousElementSibling.textContent.length) : String(Math.round(value));
}

function renderReadouts() {
  const d = state.data;
  if (!d) return;
  setLed(els.gridU1, d.grid.u1);
  setLed(els.gridU2, d.grid.u2);
  setLed(els.serverCount, d.servers.length);
  const known = d.servers.filter((sv) => sv.players !== null);
  setLed(els.playerCount, known.length ? known.reduce((sum, sv) => sum + sv.players, 0) : null);
}

function showEmpty(...nodes) {
  els.empty.replaceChildren(...nodes);
  els.empty.hidden = false;
}

function renderModules() {
  const d = state.data;
  if (!d) {
    els.rows.replaceChildren();
    modules.clear();
    if (state.error === NO_PROXY) {
      showEmpty(h('p', {}, 'This page gets its data from the RBWR Demands app. Start the app and open the address it shows.'));
    } else if (state.error) {
      showEmpty(
        h('p', {}, 'The RBWR server API isn’t answering, so there are no demands to show yet. The board retries every 15 seconds.'),
        h('p', {}, h('button', { class: 'pushbtn', type: 'button', 'data-action': 'retry' }, 'Retry now')),
      );
    }
    return;
  }

  let list = d.servers;
  if (state.publicOnly) list = list.filter((sv) => !sv.isPrivate);
  list = list.filter((sv) => matchesQuery(sv, state.query));
  list = sortServers(list);

  // Reuse existing modules so needles move instead of being redrawn.
  const fresh = [];
  const ordered = list.map((sv) => {
    let entry = modules.get(sv.jobId);
    if (!entry) {
      entry = createModule(sv);
      modules.set(sv.jobId, entry);
      fresh.push(entry);
    }
    updateModule(entry, sv);
    return entry;
  });
  for (const [id, entry] of modules) {
    if (!state.byId.has(id)) { entry.el.remove(); modules.delete(id); }
  }

  let cursor = els.rows.firstChild;
  for (const entry of ordered) {
    if (entry.el === cursor) cursor = cursor.nextSibling;
    else els.rows.insertBefore(entry.el, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }

  const setAll = () => list.forEach((sv) => updateGauges(modules.get(sv.jobId), sv));
  if (fresh.length) requestAnimationFrame(() => requestAnimationFrame(setAll));
  else setAll();

  if (list.length) {
    els.empty.hidden = true;
  } else if (!d.servers.length) {
    showEmpty(h('p', {}, 'No RBWR servers are reporting right now. The list refreshes on its own.'));
  } else if (state.query) {
    showEmpty(
      h('p', {}, `No server matches “${state.query}”. Server IDs look like 7b4f-4460; a full job ID works too.`),
      h('p', {}, h('button', { class: 'pushbtn', type: 'button', 'data-action': 'clear' }, 'Clear search')),
    );
  } else {
    showEmpty(
      h('p', {}, 'None of the reporting servers are public right now.'),
      h('p', {}, h('button', { class: 'pushbtn', type: 'button', 'data-action': 'show-private' }, 'Show all servers')),
    );
  }
}

function renderStatus() {
  const ago = state.receivedAt ? fmtAgo((Date.now() - state.receivedAt) / 1000) : null;
  let st = 'connecting';
  let text = 'Connecting to the server list…';
  if (state.mode === 'demo' && state.data) {
    st = 'demo';
    text = `Demo data, updated ${ago} ago`;
  } else if (state.data && state.error) {
    st = 'stale';
    text = `Showing data from ${ago} ago. The RBWR API isn’t answering; retrying.`;
  } else if (state.data && state.snapshotAt !== null) {
    const age = (Date.now() - state.snapshotAt) / 1000;
    st = age < 1800 ? 'live' : 'stale';
    text = `Snapshot from ${fmtAgo(age)} ago, refreshed about every 10 minutes`;
  } else if (state.data) {
    st = 'live';
    text = `Live, updated ${ago} ago`;
  } else if (state.error === NO_PROXY) {
    st = 'error';
    text = 'App not running';
  } else if (state.error) {
    st = 'error';
    text = 'Can’t reach the RBWR server API. Retrying every 15 seconds.';
  }
  els.status.dataset.state = st;
  if (els.statusText.textContent !== text) els.statusText.textContent = text;
}

function renderAnnunciator() {
  const servers = state.data ? state.data.servers : [];
  const lefts = servers.map((sv) => [sv, timing(sv).left]);
  const demands = servers.map(demandOf);
  const faults = servers.map(serverFaults);
  const any = (key) => faults.some((f) => f[key]);
  const lit = {
    link: Boolean(state.data) && !state.error,
    apifault: Boolean(state.error),
    soon: lefts.some(([, l]) => l !== null && l > DUE_S && l <= SOON_S),
    due: lefts.some(([, l]) => l !== null && l <= DUE_S),
    pinned: lefts.some(([sv, l]) => state.pinned.has(sv.jobId) && l !== null && l <= DUE_S),
    scram: any('scram'),
    trip: any('trip'),
    loop: any('loop'),
    disk: any('disk'),
    fire: any('fire'),
    maint: demands.includes(-1),
    evac: demands.includes(-4),
  };
  for (const [key, a] of annunciators) {
    const on = Boolean(lit[key]);
    if (on && !a.lit) a.acked = key === 'link'; // new alarms flash until acknowledged
    a.lit = on;
    a.el.classList.toggle('is-lit', on);
    a.el.classList.toggle('is-flash', on && !a.acked);
  }
  els.ack.classList.toggle('is-armed', [...annunciators.values()].some((a) => a.lit && !a.acked));
}

function tick() {
  for (const [id, entry] of modules) {
    const sv = state.byId.get(id);
    if (sv) tickModule(entry, sv);
  }
  renderStatus();
  renderAnnunciator();
  tickBoard();
}

let routed = false;

function render() {
  renderReadouts();
  renderModules();
  tick();
  updateBoard();
  if (!routed && state.data) {
    routed = true;
    routeFromHash();
  }
}

// ---- interaction -------------------------------------------------------------

for (const tile of els.ann.querySelectorAll('[data-key]')) {
  annunciators.set(tile.dataset.key, { el: tile, lit: false, acked: true });
}

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
  renderModules();
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
  renderModules();
  tick();
});

els.ack.addEventListener('click', () => {
  for (const a of annunciators.values()) if (a.lit) a.acked = true;
  renderAnnunciator();
});

document.addEventListener('click', async (e) => {
  const pin = e.target.closest('[data-pin]');
  if (pin) {
    const id = pin.dataset.pin;
    if (state.pinned.has(id)) state.pinned.delete(id); else state.pinned.add(id);
    storeSet(PIN_KEY, [...state.pinned]);
    renderModules();
    tick();
    pin.focus();
    return;
  }

  const open = e.target.closest('[data-open]');
  if (open) {
    const [jobId, unit] = open.dataset.open.split('|');
    const hash = boardHash(jobId, unit);
    if (location.hash === hash) openBoard(jobId, unit);
    else if (boardEl.open) {
      history.replaceState(null, '', hash);
      openBoard(jobId, unit);
    } else {
      board.pushed = true;
      location.hash = hash.slice(1); // adds a history entry; hashchange opens the panel
    }
    return;
  }

  const copy = e.target.closest('[data-copy]');
  if (copy) {
    if (copy.dataset.busy) return;
    const label = copy.textContent;
    copy.dataset.busy = '1';
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy failed';
    }
    setTimeout(() => { copy.textContent = label; delete copy.dataset.busy; }, 1200);
    return;
  }

  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'clear') {
    state.query = '';
    els.q.value = '';
    syncUrl();
    renderModules();
    tick();
    els.q.focus();
  } else if (action === 'show-private') {
    state.publicOnly = false;
    els.publicOnly.checked = false;
    storeSet(PUBLIC_KEY, false);
    renderModules();
    tick();
  } else if (action === 'retry') {
    load();
  }
});

// ---- start -------------------------------------------------------------------

load();
setInterval(() => {
  if (document.hidden) return;
  if (state.snapshotAt !== null && Date.now() - state.receivedAt < SNAPSHOT_REFRESH_MS) return;
  load();
}, REFRESH_MS);
setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - state.receivedAt > REFRESH_MS) load();
});
