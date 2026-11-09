// Fake data in exactly the upstream API format, modelled on real responses:
// demands last 20 minutes, both units usually share the same demand (500 to
// 1100 MW in steps of 10), heartbeats arrive every ~30 s, units that aren't
// running report a small negative output, and many servers are private.
// Used by `npm run demo` (server side) and by opening the page with ?demo.

const JOB_IDS = [
  '3f2a9c41-7b4f-4460-9a1e-2c6d8e0f1a23',
  '9d0e5b72-77f6-4b2f-8c3d-5e7f9a1b2c34',
  'a14c6e83-2e9d-41c7-b5a0-6f8d1c2e3b45',
  '5b7d9f04-c3a1-4e86-9d2b-7a0e3f4c5d56',
  'e6f8a015-0d4b-47e9-a1c3-8b2f5d6e7f67',
  '27c9b126-9e5c-4a0f-b2d4-9c3a6e7f8078',
  'c8dac237-1f6d-4b1a-83e5-0d4b7f8a9189',
  '4e1bd348-a07e-4c2b-94f6-1e5c8a9b0a9a',
  'f02ce459-3b8f-4d3c-a507-2f6d9bac1bab',
  '6a3df56a-b19a-4e4d-b618-3a7eacbd2cbc',
  '81e4a67b-5c2d-4f90-a729-4b8fbdce3dcd',
  'd7f5b78c-e83a-4a1b-b83a-5c90cedf4ede',
];

const PERIOD_S = 1200;
const OWNED = new Set([1, 3, 6, 9, 11]); // private servers with an owner
const UNLISTED = 10;                       // no owner, but not in the public list
const STARTING = 11;                       // just started, no state yet
const MAINT = 7;
const LOOP = 8;

function hash(...values) {
  let h = 2166136261;
  for (const v of values) {
    h ^= v | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

function demandFor(server, cycle) {
  if (server === MAINT) return -1;
  if (server === LOOP) return -2;
  return 500 + (hash(server, cycle) % 61) * 10;
}

// Which units are actually generating on this server
const U1_IDLE = new Set([0, 5]);
const U2_RUNNING = new Set([0, 2, 4, 6, 10]);

function running(server, unit) {
  return unit === 1 ? !U1_IDLE.has(server) : U2_RUNNING.has(server);
}

function outputFor(server, unit, demand, tick) {
  if (demand <= 0 || !running(server, unit)) return -(2 + (hash(server, unit) % 25)) / 1.3;
  return demand + (hash(server, unit, tick) % 41) - 20 + (hash(server, unit, tick, 7) % 100) / 100;
}

export function demoPayload(now = Date.now()) {
  const servers = JOB_IDS.map((jobId, i) => {
    const heartbeat = now - (3000 + (hash(i, 1) % 30) * 1000);
    const base = {
      id: `${jobId.slice(0, 8)}-0000-4000-8000-${jobId.slice(-12)}`,
      jobId,
      lastHeartbeat: new Date(heartbeat).toISOString(),
      privateServerOwnerId: OWNED.has(i) ? 100000000 + hash(i, 5) % 900000000 : null,
    };
    if (i === STARTING) return { ...base, state: {} };

    const t = Math.floor(heartbeat / 1000) + (hash(i, 3) % PERIOD_S);
    const cycle = Math.floor(t / PERIOD_S);
    const left = PERIOD_S - (t - cycle * PERIOD_S);
    const tick = Math.floor(heartbeat / 30000);

    const demand = demandFor(i, cycle);
    const next = demandFor(i, cycle + 1);
    const o1 = outputFor(i, 1, demand, tick);
    const o2 = outputFor(i, 2, demand, tick);
    const pps1 = o1 > 0 ? 1.2 : 0;
    const pps2 = o2 > 0 ? 1.7 : 0;

    return {
      ...base,
      state: {
        Unit1: {
          DemandU1: demand,
          NextDemandU1: next,
          'Demand Time Left': left,
          'Output (MW)': o1,
          APRM: o1 > 0 ? Math.round(o1 / 11.6 * 10) / 10 : 0,
          PointsPerSecond: pps1,
          'Offsite Power': i !== LOOP,
        },
        Unit2: {
          DemandU2: demand,
          NextDemandU2: next,
          'Demand Time Left': left,
          PradDoSieci: o2,
          APRM: o2 > 0 ? Math.round(o2 / 11.2 * 10) / 10 : 0,
          PointsPerSecond: pps2,
          'Offsite Power': i !== LOOP,
        },
        Misc: { 'Total points/second': pps1 + pps2 },
      },
    };
  });

  return { success: true, data: { servers, stats: { unit1: { megawatts: 0 }, unit2: { megawatts: 0 } } } };
}

export function demoRoblox(now = Date.now()) {
  const servers = {};
  JOB_IDS.forEach((jobId, i) => {
    if (OWNED.has(i) || i === UNLISTED) return;
    servers[jobId] = { playing: 3 + (hash(i, Math.floor(now / 120000)) % 10), maxPlayers: 12 };
  });
  return { complete: true, servers };
}
