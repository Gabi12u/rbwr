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

// SCRAMreason / TRIPreason keep the last reason after the unit is reset,
// so they're reported as "last scram", not as an active fault.
function reason(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v && v !== 'No Reason Given' ? v : null;
}

function readFaults(raw) {
  return {
    scram: raw['Reactor Scram State'] === true,
    turbineTrip: raw.TurbineTrip === true,
    offsiteLost: raw['Offsite Power'] === false,
    ruptureDisk: raw['Disk Ruptured'] === true,
    turbineHealth: num(raw.TurbineHealth),
    dieselRunning: (num(raw.DieselRPM) ?? 0) > 100,
    lastScram: reason(raw.SCRAMreason),
    lastTrip: reason(raw.TRIPreason),
  };
}

function readUnit(raw, n) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    demand: pick(raw, [`DemandU${n}`, 'Demand', 'demand']),
    next: pick(raw, [`NextDemandU${n}`, 'NextDemand', 'Next Demand', 'next_demand']),
    timeLeft: pick(raw, ['Demand Time Left', 'DemandTimeLeft', 'dtl']),
    output: pick(raw, ['Output (MW)', 'PradDoSieci', 'Output', 'Power', 'megawatts']),
    faults: readFaults(raw),
    raw, // every field the game reports, for the unit panel
  };
}

// Fault types shown on each server panel and on the alarm panel.
export const FAULTS = [
  { key: 'scram', label: 'Reactor scram', tone: 'red' },
  { key: 'trip', label: 'Turbine trip', tone: 'red' },
  { key: 'loop', label: 'Offsite power lost', tone: 'red' },
  { key: 'disk', label: 'Rupture disk', tone: 'red' },
  { key: 'fire', label: 'Fire alarm', tone: 'red' },
  { key: 'turbdmg', label: 'Turbine damage', tone: 'amber' },
];

/** Active faults of a server: { [key]: { units: ['U1','U2'], detail } } */
export function serverFaults(server) {
  const out = {};
  const add = (key, unit, detail = null) => {
    if (!out[key]) out[key] = { units: [], details: [] };
    if (unit && !out[key].units.includes(unit)) out[key].units.push(unit);
    if (detail) out[key].details.push(detail);
  };
  for (const [name, unit] of [['U1', server.units.u1], ['U2', server.units.u2]]) {
    const f = unit?.faults;
    if (!f) continue;
    if (f.scram) add('scram', name, f.lastScram);
    if (f.turbineTrip) add('trip', name, f.lastTrip);
    if (f.offsiteLost || unit.demand === -2) add('loop', name);
    if (f.ruptureDisk) add('disk', name);
    if (f.turbineHealth !== null && f.turbineHealth < 100) add('turbdmg', name, `${Math.round(f.turbineHealth)} %`);
  }
  if (server.fire) add('fire', null);
  return out;
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

    // 'owner': a private server someone owns. 'unlisted': no owner, but missing
    // from Roblox's complete public list (e.g. reserved servers), so not joinable.
    let privateKind = isOwnerSet(s.privateServerOwnerId) ? 'owner' : null;
    if (!privateKind && roblox && roblox.complete && publicInfo && !info) privateKind = 'unlisted';

    servers.push({
      jobId,
      shortId: shortId(jobId),
      heartbeat: Number.isFinite(heartbeat) ? heartbeat : null,
      timeLeft: u1?.timeLeft ?? u2?.timeLeft ?? null,
      units: { u1, u2 },
      isPrivate: privateKind !== null,
      privateKind,
      players: info ? num(info.playing) : null,
      maxPlayers: info ? num(info.maxPlayers) : null,
      pointsPerSecond: pick(state.Misc, ['Total points/second']),
      fire: Boolean(state.Misc && state.Misc['FSS Smoke Detected'] === true),
      misc: state.Misc && typeof state.Misc === 'object' ? state.Misc : {},
    });
  }

  // The API's own stats don't add up to the servers' outputs, so the board
  // sums the current output of every unit itself (non-running units count 0).
  const sumOutput = (key) => servers.reduce((sum, s) => sum + Math.max(0, s.units[key]?.output ?? 0), 0);
  return {
    servers,
    grid: {
      u1: servers.length ? sumOutput('u1') : null,
      u2: servers.length ? sumOutput('u2') : null,
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
