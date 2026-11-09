// Fake data in exactly the upstream API format. Used by `npm run demo`
// (server side) and by opening the page with ?demo (browser side), so the
// board can be tried out without a connection to the RBWR API.

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
];

const PRIVATE_INDEX = 6;

function hash(...values) {
  let h = 2166136261;
  for (const v of values) {
    h ^= v | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

function demandFor(server, unit, cycle) {
  if (server === 4 && unit === 2) return -1; // unit in maintenance
  if (server === 8) return -2; // loss of offsite power on both units
  const h = hash(server, unit, cycle);
  if (h % 41 === 0) return -1;
  const [lo, hi] = unit === 1 ? [300, 1000] : [200, 700];
  return lo + (h % ((hi - lo) / 10 + 1)) * 10;
}

function outputFor(demand, server, unit, tick) {
  if (demand < 0) return 0;
  return Math.max(0, demand + (hash(server, unit, tick) % 41) - 20);
}

export function demoPayload(now = Date.now()) {
  let grid1 = 0;
  let grid2 = 0;
  const servers = JOB_IDS.map((jobId, i) => {
    const heartbeat = now - (2000 + (hash(i, 1) % 35) * 1000);
    const period = 480 + (hash(i, 2) % 6) * 60;
    const t = heartbeat / 1000 + (hash(i, 3) % period);
    const cycle = Math.floor(t / period);
    const left = Math.round((period - (t - cycle * period)) * 10) / 10;
    const tick = Math.floor(heartbeat / 30000);

    const d1 = demandFor(i, 1, cycle);
    const d2 = demandFor(i, 2, cycle);
    const o1 = outputFor(d1, i, 1, tick);
    const o2 = outputFor(d2, i, 2, tick);
    grid1 += o1;
    grid2 += o2;

    return {
      jobId,
      lastHeartbeat: new Date(heartbeat).toISOString(),
      privateServerOwnerId: i === PRIVATE_INDEX ? 123456789 : null,
      state: {
        Unit1: {
          DemandU1: d1,
          NextDemandU1: demandFor(i, 1, cycle + 1),
          'Demand Time Left': left,
          'Output (MW)': o1,
          APRM: d1 > 0 ? Math.round((d1 / 11.2) * 10) / 10 : 0,
        },
        Unit2: {
          DemandU2: d2,
          NextDemandU2: demandFor(i, 2, cycle + 1),
          'Demand Time Left': left,
          PradDoSieci: o2,
          APRM: d2 > 0 ? Math.round((d2 / 7.9) * 10) / 10 : 0,
        },
        Misc: { 'Total points/second': Math.round(((o1 + o2) / 600) * 100) / 100 },
      },
    };
  });

  return {
    data: {
      servers,
      stats: { unit1: { megawatts: grid1 }, unit2: { megawatts: grid2 } },
    },
  };
}

export function demoRoblox(now = Date.now()) {
  const servers = {};
  JOB_IDS.forEach((jobId, i) => {
    if (i === PRIVATE_INDEX) return;
    servers[jobId] = { playing: 1 + (hash(i, Math.floor(now / 120000)) % 12), maxPlayers: 12 };
  });
  return { complete: true, servers };
}
