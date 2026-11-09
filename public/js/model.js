// Turns the raw RBWR public server API payload into the shape the board renders.
// Shared by the browser (app.js) and nothing else; kept dependency-free.

export const PLACE_ID = 11765852158;

// Negative demand values are special grid states sent by the game.
export const SPECIAL_DEMANDS = {
  '-1': { code: 'Maint', label: 'Maintenance', tone: 'caution' },
  '-2': { code: 'LOOP', label: 'Loss of offsite power', tone: 'alarm' },
  '-3': { code: 'RST', label: 'RST', tone: 'caution' },
  '-4': { code: 'Evac', label: 'Evacuation', tone: 'alarm' },
};

function num(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (key in obj) {
      const n = num(obj[key]);
      if (n !== null) return n;
    }
  }
  return null;
}

// The in-game server ID is the 2nd and 3rd block of the Roblox job ID.
export function shortId(jobId) {
  const parts = String(jobId || '').split('-');
  return parts.length >= 3 ? `${parts[1]}-${parts[2]}` : String(jobId || '');
}

export function isSpecial(demand) {
  return demand !== null && demand < 0;
}

export function special(demand) {
  if (!isSpecial(demand)) return null;
  return SPECIAL_DEMANDS[String(Math.round(demand))] || { code: String(demand), label: `Status ${demand}`, tone: 'caution' };
}

function readUnit(raw, n) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    demand: pick(raw, [`DemandU${n}`, 'Demand', 'demand']),
    next: pick(raw, [`NextDemandU${n}`, 'NextDemand', 'Next Demand', 'next_demand']),
    timeLeft: pick(raw, ['Demand Time Left', 'DemandTimeLeft', 'dtl']),
    output: pick(raw, ['Output (MW)', 'PradDoSieci', 'Output', 'Power', 'megawatts']),
  };
}

function isOwnerSet(owner) {
  return !(owner === null || owner === undefined || owner === '' || owner === 0 || owner === '0' || owner === 'None' || owner === 'null');
}

export function totalDemand(server) {
  const a = server.units.u1?.demand;
  const b = server.units.u2?.demand;
  if (a === null || a === undefined || b === null || b === undefined) {
    const only = [a, b].filter((v) => v !== null && v !== undefined && v >= 0);
    return only.length ? only.reduce((s, v) => s + v, 0) : null;
  }
  if (a < 0 && b < 0) return null;
  return Math.max(a, 0) + Math.max(b, 0);
}

export function totalNext(server) {
  const a = server.units.u1?.next;
  const b = server.units.u2?.next;
  const vals = [a, b].filter((v) => v !== null && v !== undefined && v >= 0);
  return vals.length ? vals.reduce((s, v) => s + v, 0) : null;
}

/**
 * @param raw      Upstream JSON ({ data: { servers: [...], stats: {...} } })
 * @param roblox   Optional { complete: boolean, servers: { [jobId]: { playing, maxPlayers } } }
 */
export function normalize(raw, roblox = null) {
  const data = (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object') ? raw.data : (raw || {});
  const list = Array.isArray(data.servers) ? data.servers : [];
  const publicInfo = roblox && roblox.servers ? roblox.servers : null;

  const servers = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const jobId = String(s.jobId || s.id || '');
    if (!jobId) continue;
    const state = s.state && typeof s.state === 'object' ? s.state : {};
    const u1 = readUnit(state.Unit1, 1);
    const u2 = readUnit(state.Unit2, 2);
    const heartbeat = Date.parse(s.lastHeartbeat);
    const info = publicInfo ? publicInfo[jobId] : null;

    let isPrivate = isOwnerSet(s.privateServerOwnerId);
    if (!isPrivate && roblox && roblox.complete && publicInfo && !info) isPrivate = true;

    servers.push({
      jobId,
      shortId: shortId(jobId),
      heartbeat: Number.isFinite(heartbeat) ? heartbeat : null,
      timeLeft: u1?.timeLeft ?? u2?.timeLeft ?? null,
      units: { u1, u2 },
      isPrivate,
      players: info ? num(info.playing) : null,
      maxPlayers: info ? num(info.maxPlayers) : null,
      pointsPerSecond: pick(state.Misc, ['Total points/second']),
    });
  }

  const stats = data.stats && typeof data.stats === 'object' ? data.stats : {};
  return {
    servers,
    grid: {
      u1: pick(stats.unit1, ['megawatts']),
      u2: pick(stats.unit2, ['megawatts']),
    },
  };
}

export function joinUrl(jobId) {
  return `https://www.roblox.com/games/start?placeId=${PLACE_ID}&gameInstanceId=${encodeURIComponent(jobId)}`;
}

export function matchesQuery(server, query) {
  const q = String(query || '').trim().toLowerCase().replace(/[\s-]/g, '');
  if (!q) return true;
  return server.jobId.toLowerCase().replace(/-/g, '').includes(q);
}
