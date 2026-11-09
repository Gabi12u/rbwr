import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, shortId, special, totalDemand, totalNext, matchesQuery, joinUrl, serverFaults,
} from '../public/js/model.js';
import { demoPayload, demoRoblox } from '../public/js/demo.js';
import { readFileSync } from 'node:fs';

const live = JSON.parse(readFileSync(new URL('./fixtures/live-sample.json', import.meta.url), 'utf8'));

const sample = {
  data: {
    servers: [
      {
        jobId: '68c4aeb7-7b4f-4460-81ca-309f94ab4bd9',
        lastHeartbeat: '2026-11-08T12:00:00.000Z',
        privateServerOwnerId: null,
        state: {
          Unit1: { DemandU1: 850, NextDemandU1: 900, 'Demand Time Left': 245.5, 'Output (MW)': 846.2 },
          Unit2: { DemandU2: '600', NextDemandU2: 450, 'Demand Time Left': 245.5, PradDoSieci: 603 },
          Misc: { 'Total points/second': 2.4 },
        },
      },
      {
        jobId: '11111111-2222-3333-4444-555555555555',
        lastHeartbeat: '2026-11-08T12:00:30.000Z',
        privateServerOwnerId: 987,
        state: { Unit1: { DemandU1: -2, NextDemandU1: -2 }, Unit2: { DemandU2: -1 } },
      },
      { state: {} },
    ],
    stats: { unit1: { megawatts: 1234.5 }, unit2: { megawatts: 999 } },
  },
};

test('reads demand, next demand, countdown and output from the API format', () => {
  const { servers, grid } = normalize(sample);
  assert.equal(servers.length, 2, 'entries without a job ID are skipped');
  const [a] = servers;
  assert.equal(a.shortId, '7b4f-4460');
  assert.equal(a.heartbeat, Date.parse('2026-11-08T12:00:00.000Z'));
  assert.equal(a.timeLeft, 245.5);
  const pickBasics = ({ demand, next, timeLeft, output }) => ({ demand, next, timeLeft, output });
  assert.deepEqual(pickBasics(a.units.u1), { demand: 850, next: 900, timeLeft: 245.5, output: 846.2 });
  assert.deepEqual(pickBasics(a.units.u2), { demand: 600, next: 450, timeLeft: 245.5, output: 603 });
  assert.equal(a.pointsPerSecond, 2.4);
  assert.equal(a.units.u1.raw['Output (MW)'], 846.2, 'raw fields are kept for the unit panel');
  assert.deepEqual(a.misc, { 'Total points/second': 2.4 });
  assert.equal(a.isPrivate, false);
  assert.deepEqual(grid, { u1: 846.2, u2: 603 }, 'grid = summed outputs, negatives count as 0');
});

test('totals ignore special states', () => {
  const [a, b] = normalize(sample).servers;
  assert.equal(totalDemand(a), 1450);
  assert.equal(totalNext(a), 1350);
  assert.equal(totalDemand(b), null);
  assert.equal(totalNext(b), null);
});

test('special demand codes', () => {
  assert.equal(special(-1).code, 'Maint');
  assert.equal(special(-2).code, 'LOOP');
  assert.equal(special(-3).code, 'RST');
  assert.equal(special(-4).code, 'Evac');
  assert.equal(special(500), null);
  assert.equal(special(null), null);
});

test('private detection uses owner ID and the Roblox public list', () => {
  const roblox = { complete: true, servers: { '68c4aeb7-7b4f-4460-81ca-309f94ab4bd9': { playing: 7, maxPlayers: 12 } } };
  const [a, b] = normalize(sample, roblox).servers;
  assert.equal(a.isPrivate, false);
  assert.equal(a.privateKind, null);
  assert.equal(a.players, 7);
  assert.equal(a.maxPlayers, 12);
  assert.equal(b.isPrivate, true);
  assert.equal(b.privateKind, 'owner');

  const notInList = normalize({ data: { servers: [{ jobId: 'aaaa-bbbb-cccc-dddd', state: {} }] } }, roblox).servers[0];
  assert.equal(notInList.privateKind, 'unlisted', 'missing from a complete public list means not joinable');
  const partial = normalize({ data: { servers: [{ jobId: 'aaaa-bbbb-cccc-dddd', state: {} }] } }, { ...roblox, complete: false }).servers[0];
  assert.equal(partial.isPrivate, false, 'an incomplete public list proves nothing');
});

test('search matches short ID, full job ID and IDs without dashes', () => {
  const [a] = normalize(sample).servers;
  for (const q of ['7b4f-4460', '7B4F4460', '68c4aeb7-7b4f-4460-81ca-309f94ab4bd9', ' 4460 ', '']) {
    assert.ok(matchesQuery(a, q), q);
  }
  assert.ok(!matchesQuery(a, 'ffff-0000'));
  assert.equal(shortId('abc'), 'abc');
});

test('join link points at the RBWR place and server', () => {
  assert.equal(
    joinUrl('68c4aeb7-7b4f-4460-81ca-309f94ab4bd9'),
    'https://www.roblox.com/games/start?placeId=11765852158&gameInstanceId=68c4aeb7-7b4f-4460-81ca-309f94ab4bd9',
  );
});

test('reads a real API response', () => {
  const { servers, grid } = normalize(live.upstream, live.roblox);
  assert.equal(servers.length, 5);
  const byShort = Object.fromEntries(servers.map((s) => [s.shortId, s]));

  const pub = byShort['e0cb-438c'];
  assert.equal(pub.units.u1.demand, 870);
  assert.equal(pub.units.u1.next, 1090);
  assert.equal(pub.units.u2.demand, 870);
  assert.equal(pub.timeLeft, 146);
  assert.equal(pub.heartbeat, Date.parse('2026-11-09T00:22:07.096Z'));
  assert.equal(pub.players, 11);
  assert.equal(pub.privateKind, null);
  assert.equal(totalDemand(pub), 1740);
  assert.equal(totalNext(pub), 2180);

  assert.equal(byShort['95f6-47c8'].privateKind, 'owner');
  assert.equal(byShort['f72a-4d87'].privateKind, 'unlisted');
  assert.equal(byShort['f72a-4d87'].units.u1.output, -7, 'idle units report negative output');

  const empty = servers.find((s) => s.jobId.startsWith('cb6154a8'));
  assert.equal(empty.units.u1, null, 'servers without state yet');
  assert.equal(empty.timeLeft, null);
  assert.equal(totalDemand(empty), null);

  assert.ok(grid.u1 > 2000 && grid.u2 > 1000);
});

test('demo data has the upstream shape', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const { servers, grid } = normalize(demoPayload(now), demoRoblox(now));
  assert.equal(servers.length, 12);
  assert.ok(grid.u1 > 0 && grid.u2 > 0);
  for (const s of servers) {
    if (s.units.u1 === null) continue; // the server that's still starting
    assert.ok(s.timeLeft > 0 && s.timeLeft <= 1200);
    assert.ok(s.units.u1.demand !== null && s.units.u1.next !== null);
  }
  assert.equal(servers.filter((s) => s.privateKind === 'owner').length, 5);
  assert.equal(servers.filter((s) => s.privateKind === 'unlisted').length, 1);
  assert.equal(servers.filter((s) => s.units.u1 === null).length, 1);
});

test('reads faults: active scram and trip, lost offsite power, rupture disk, fire, turbine damage', () => {
  const raw = {
    data: {
      servers: [{
        jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        state: {
          Unit1: { DemandU1: 500, 'Reactor Scram State': true, SCRAMreason: 'APRM Upscale', 'Offsite Power': false, DieselRPM: 1800 },
          Unit2: { DemandU2: 500, TurbineTrip: true, TRIPreason: 'Manual trip', 'Disk Ruptured': true, TurbineHealth: 77, 'Offsite Power': true },
          Misc: { 'FSS Smoke Detected': true },
        },
      }, {
        jobId: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee',
        state: {
          Unit1: { DemandU1: 500, 'Reactor Scram State': false, SCRAMreason: 'Manual Trip Relay', TurbineTrip: false, TRIPreason: 'No Reason Given', 'Offsite Power': true },
          Unit2: { DemandU2: 500, TurbineHealth: 100 },
          Misc: { 'FSS Smoke Detected': false },
        },
      }],
    },
  };
  const [bad, ok] = normalize(raw).servers;
  const f = serverFaults(bad);
  assert.deepEqual(Object.keys(f).sort(), ['disk', 'fire', 'loop', 'scram', 'trip', 'turbdmg']);
  assert.deepEqual(f.scram, { units: ['U1'], details: ['APRM Upscale'] });
  assert.deepEqual(f.trip, { units: ['U2'], details: ['Manual trip'] });
  assert.deepEqual(f.loop.units, ['U1']);
  assert.deepEqual(f.turbdmg.details, ['77 %']);
  assert.equal(bad.units.u1.faults.dieselRunning, true);

  assert.deepEqual(serverFaults(ok), {}, 'an old scram reason alone is not an active fault');
  assert.equal(ok.units.u1.faults.lastScram, 'Manual Trip Relay');
  assert.equal(ok.units.u1.faults.lastTrip, null);
});

test('faults in the real response', () => {
  const { servers } = normalize(live.upstream, live.roblox);
  const loop = servers.find((s) => s.jobId.startsWith('e9789848'));
  assert.deepEqual(serverFaults(loop).loop?.units, ['U1']);
});
