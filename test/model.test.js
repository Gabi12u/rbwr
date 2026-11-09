import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, shortId, special, totalDemand, totalNext, matchesQuery, joinUrl,
} from '../public/js/model.js';
import { demoPayload, demoRoblox } from '../public/js/demo.js';

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
  assert.deepEqual(a.units.u1, { demand: 850, next: 900, timeLeft: 245.5, output: 846.2 });
  assert.deepEqual(a.units.u2, { demand: 600, next: 450, timeLeft: 245.5, output: 603 });
  assert.equal(a.pointsPerSecond, 2.4);
  assert.equal(a.isPrivate, false);
  assert.deepEqual(grid, { u1: 1234.5, u2: 999 });
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
  assert.equal(a.players, 7);
  assert.equal(a.maxPlayers, 12);
  assert.equal(b.isPrivate, true);

  const notInList = normalize({ data: { servers: [{ jobId: 'aaaa-bbbb-cccc-dddd', state: {} }] } }, roblox).servers[0];
  assert.equal(notInList.isPrivate, true, 'missing from a complete public list means private');
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

test('demo data has the upstream shape', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const { servers, grid } = normalize(demoPayload(now), demoRoblox(now));
  assert.equal(servers.length, 10);
  assert.ok(grid.u1 > 0 && grid.u2 > 0);
  for (const s of servers) {
    assert.ok(s.timeLeft > 0);
    assert.ok(s.units.u1.demand !== null && s.units.u1.next !== null);
  }
  assert.equal(servers.filter((s) => s.isPrivate).length, 1);
});
