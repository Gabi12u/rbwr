// RBWR Demands – tiny web server without dependencies (Node 18+).
//
// Serves the board from ./public and proxies the RBWR public server API at
// /api/servers, because browsers usually aren't allowed to call it directly.
// Upstream is queried at most once per CACHE_SECONDS, no matter how many
// people have the page open.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoPayload, demoRoblox } from './public/js/demo.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DEMO = process.env.DEMO === '1' || process.argv.includes('--demo');
const CACHE_MS = Math.max(5, Number(process.env.CACHE_SECONDS || 15)) * 1000;
const ROBLOX_CACHE_MS = 60 * 1000;
const UPSTREAMS = (process.env.UPSTREAM_URLS ||
  'https://hydrogen.realisticbwr.org/api/public/servers,https://realisticbwr.org/api/public/servers')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ROBLOX_URL = 'https://games.roblox.com/v1/games/11765852158/servers/Public?limit=100';
const USER_AGENT = process.env.USER_AGENT || 'RBWR-Demands/1.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function getJson(url, timeoutMs) {
  const host = new URL(url).host;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'timed out' : (err.cause && (err.cause.code || err.cause.message)) || err.message;
    throw new Error(`${host}: ${reason}`);
  }
  if (!res.ok) throw new Error(`${host} answered HTTP ${res.status}`);
  return res.json();
}

// ---- Roblox public server list (player counts, private detection) ----------

let robloxCache = null;
let robloxInflight = null;

async function loadRoblox() {
  const servers = {};
  let cursor = '';
  let complete = false;
  for (let page = 0; page < 5; page++) {
    const url = cursor ? `${ROBLOX_URL}&cursor=${encodeURIComponent(cursor)}` : ROBLOX_URL;
    const json = await getJson(url, 10000);
    for (const s of json.data || []) {
      if (s && s.id) servers[s.id] = { playing: Number(s.playing) || 0, maxPlayers: Number(s.maxPlayers) || 0 };
    }
    cursor = json.nextPageCursor;
    if (!cursor) { complete = true; break; }
  }
  return { complete, servers };
}

async function getRoblox() {
  if (DEMO) return demoRoblox();
  if (robloxCache && Date.now() - robloxCache.at < ROBLOX_CACHE_MS) return robloxCache.value;
  if (!robloxInflight) {
    robloxInflight = loadRoblox()
      .then((value) => { robloxCache = { at: Date.now(), value }; return value; })
      .catch((err) => { console.warn(`[roblox] ${err.message}`); return robloxCache ? robloxCache.value : null; })
      .finally(() => { robloxInflight = null; });
  }
  return robloxInflight;
}

// ---- RBWR server API -------------------------------------------------------

let cache = null; // { at, body }
let inflight = null;

async function loadUpstream() {
  const errors = [];
  for (const url of UPSTREAMS) {
    try {
      return { source: new URL(url).host, json: await getJson(url, 20000) };
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(errors.join('; ') || 'no upstream configured');
}

async function refresh() {
  if (DEMO) {
    return { ok: true, source: 'demo', fetchedAt: Date.now(), upstream: demoPayload(), roblox: demoRoblox() };
  }
  const [up, roblox] = await Promise.all([loadUpstream(), getRoblox()]);
  return { ok: true, source: up.source, fetchedAt: Date.now(), upstream: up.json, roblox };
}

async function getServers() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.body;
  if (!inflight) {
    inflight = refresh()
      .then((body) => { cache = { at: Date.now(), body }; return body; })
      .finally(() => { inflight = null; });
  }
  try {
    return await inflight;
  } catch (err) {
    console.warn(`[upstream] ${err.message}`);
    if (cache) return { ...cache.body, stale: true, error: err.message };
    throw err;
  }
}

// ---- HTTP ------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
  });
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'Bad request', { 'Content-Type': MIME['.txt'] });
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');
  try {
    const data = await readFile(file);
    send(res, 200, req.method === 'HEAD' ? undefined : data, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': MIME['.txt'] });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`[http] ${req.method} ${req.url}: ${err.stack || err}`);
    if (!res.headersSent) send(res, 500, 'Internal error', { 'Content-Type': MIME['.txt'] });
    else res.destroy();
  });
});

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

  if (pathname === '/api/servers') {
    try {
      const body = await getServers();
      return sendJson(res, 200, { ...body, now: Date.now() });
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: err.message, now: Date.now() });
    }
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, demo: DEMO, cachedAt: cache ? cache.at : null });
  }

  if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });

  return serveStatic(req, res, pathname);
}

server.listen(PORT, HOST, () => {
  console.log(`RBWR Demands running on http://localhost:${PORT}${DEMO ? ' (demo data)' : ''}`);
});
