import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { periodKey } from '../src/ledger.ts';
import {
  DEFAULT_USAGE_PERIOD,
  attemptsInPeriod,
  rankCredentials,
  usagePeriodKey
} from '../src/selection.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0); // 2026-10-20T12:00:00Z

function candidate(alias, { available = true, period, attemptTimes = [] } = {}) {
  return { alias, available, period: period ?? DEFAULT_USAGE_PERIOD, attemptTimes };
}

function aliases(ranked) {
  return ranked.map((entry) => entry.alias);
}

test('the credential with the fewest attempts in its period ranks first', () => {
  const ranked = rankCredentials(
    [
      candidate('many', { attemptTimes: [NOW, NOW, NOW] }),
      candidate('some', { attemptTimes: [NOW] }),
      candidate('none', { attemptTimes: [] })
    ],
    { now: NOW }
  );
  assert.deepEqual(aliases(ranked), ['none', 'some', 'many']);
});

test('an absent usage period defaults to calendar-month', () => {
  assert.equal(DEFAULT_USAGE_PERIOD.kind, 'calendar-month');
  const config = parseConfig(
    {
      defaultProfile: 'p',
      profiles: { p: { providers: ['exa'] } },
      credentials: { exa: [{ alias: 'exa-main', env: 'EXA_API_KEY' }] }
    },
    'test.json'
  );
  assert.equal(config.credentials.exa[0].period, undefined);
  // The absent declaration is treated as a calendar-month window.
  const lastMonth = Date.UTC(2026, 8, 20, 12, 0, 0);
  assert.equal(attemptsInPeriod([NOW, lastMonth], DEFAULT_USAGE_PERIOD, NOW), 1);
});

test('calendar-day counts only attempts in the same UTC day', () => {
  const period = { kind: 'calendar-day' };
  const yesterday = Date.UTC(2026, 9, 19, 23, 59, 59);
  assert.equal(attemptsInPeriod([NOW, yesterday], period, NOW), 1);
  assert.equal(usagePeriodKey(period, NOW), periodKey(NOW, 'daily'));
});

test('calendar-month counts only attempts in the same UTC month', () => {
  const period = { kind: 'calendar-month' };
  const lastMonth = Date.UTC(2026, 8, 30, 0, 0, 0);
  assert.equal(attemptsInPeriod([NOW, lastMonth], period, NOW), 1);
  assert.equal(usagePeriodKey(period, NOW), periodKey(NOW, 'monthly'));
});

test('rolling-days counts attempts inside the trailing window, inclusive of the boundary', () => {
  const period = { kind: 'rolling-days', days: 7 };
  const insideBoundary = NOW - 7 * DAY;
  const justOutside = insideBoundary - 1;
  assert.equal(attemptsInPeriod([NOW, insideBoundary, justOutside], period, NOW), 2);
});

test('the calendar period boundary is identical to the ledger periodKey for the same instant', () => {
  assert.equal(usagePeriodKey({ kind: 'calendar-day' }, NOW), periodKey(NOW, 'daily'));
  assert.equal(usagePeriodKey({ kind: 'calendar-month' }, NOW), periodKey(NOW, 'monthly'));
});

test('credentials whose environment variable is missing are excluded from the ranking', () => {
  const credentials = {
    exa: [
      { alias: 'exa-main', env: 'EXA_API_KEY' },
      { alias: 'exa-backup', env: 'EXA_API_KEY_BACKUP' }
    ],
    tavily: [],
    brave: []
  };
  const resolved = resolveCredentials(credentials, { EXA_API_KEY: 'present' });
  const ranked = rankCredentials(
    resolved.map((entry) =>
      candidate(entry.alias, { available: entry.available, attemptTimes: [] })
    ),
    { now: NOW }
  );
  assert.deepEqual(aliases(ranked), ['exa-main']);
});

test('cooling credentials are excluded from the ranking', () => {
  const ranked = rankCredentials(
    [candidate('cooling', { attemptTimes: [] }), candidate('ready', { attemptTimes: [NOW, NOW] })],
    { now: NOW, penalties: { cooling: 'cooling' } }
  );
  assert.deepEqual(aliases(ranked), ['ready']);
});

test('demoted credentials remain eligible but rank after every non-demoted credential', () => {
  const ranked = rankCredentials(
    [
      candidate('demoted-fresh', { attemptTimes: [] }),
      candidate('healthy-busy', { attemptTimes: [NOW, NOW, NOW] })
    ],
    { now: NOW, penalties: { 'demoted-fresh': 'demoted' } }
  );
  assert.deepEqual(aliases(ranked), ['healthy-busy', 'demoted-fresh']);
});

test('equal attempt counts are broken deterministically by a data-derived rotation', () => {
  const input = [
    candidate('a', { attemptTimes: [NOW] }),
    candidate('b', { attemptTimes: [NOW] }),
    candidate('c', { attemptTimes: [NOW] })
  ];
  const first = aliases(rankCredentials(input, { now: NOW }));
  const second = aliases(rankCredentials(input, { now: NOW }));
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['a', 'b', 'c']);
});

test('the tie-break rotation advances as provider attempts accumulate', () => {
  const tied = () => [candidate('a', { attemptTimes: [] }), candidate('b', { attemptTimes: [] })];
  // No attempts recorded: declaration order.
  assert.deepEqual(aliases(rankCredentials(tied(), { now: NOW })), ['a', 'b']);
  // One attempt on `a`: `b` now has the fewest, so it leads regardless of rotation.
  const afterOne = tied();
  afterOne[0].attemptTimes = [NOW];
  assert.deepEqual(aliases(rankCredentials(afterOne, { now: NOW })), ['b', 'a']);
  // Both tied at one attempt each: the rotation wraps back to the declaration start.
  const afterTwo = tied();
  afterTwo[0].attemptTimes = [NOW];
  afterTwo[1].attemptTimes = [NOW];
  assert.deepEqual(aliases(rankCredentials(afterTwo, { now: NOW })), ['a', 'b']);
});

test('repeated calls with identical inputs produce identical output', () => {
  const input = [
    candidate('x', { attemptTimes: [NOW, NOW] }),
    candidate('y', { attemptTimes: [NOW] }),
    candidate('z', { attemptTimes: [NOW] })
  ];
  const runs = Array.from({ length: 5 }, () => aliases(rankCredentials(input, { now: NOW })));
  for (const run of runs) assert.deepEqual(run, runs[0]);
});

test('parseConfig accepts explicit usage periods and rejects invalid ones', () => {
  const withPeriods = parseConfig(
    {
      defaultProfile: 'p',
      profiles: { p: { providers: ['exa'] } },
      credentials: {
        exa: [
          { alias: 'day', env: 'A', period: { kind: 'calendar-day' } },
          { alias: 'month', env: 'B', period: { kind: 'calendar-month' } },
          { alias: 'rolling', env: 'C', period: { kind: 'rolling-days', days: 14 } }
        ]
      }
    },
    'test.json'
  );
  assert.deepEqual(withPeriods.credentials.exa.map((credential) => credential.period), [
    { kind: 'calendar-day' },
    { kind: 'calendar-month' },
    { kind: 'rolling-days', days: 14 }
  ]);

  const base = {
    defaultProfile: 'p',
    profiles: { p: { providers: ['exa'] } }
  };
  const withPeriod = (period) => ({
    ...base,
    credentials: { exa: [{ alias: 'exa-main', env: 'EXA_API_KEY', period }] }
  });
  assert.throws(
    () => parseConfig(withPeriod({ kind: 'rolling-days' }), 'test.json'),
    /period\.days.*rolling-days.*integer >= 1/
  );
  assert.throws(
    () => parseConfig(withPeriod({ kind: 'rolling-days', days: 0 }), 'test.json'),
    /period\.days.*rolling-days.*integer >= 1/
  );
  assert.throws(
    () => parseConfig(withPeriod({ kind: 'rolling-days', days: 1.5 }), 'test.json'),
    /period\.days.*rolling-days.*integer >= 1/
  );
  assert.throws(
    () => parseConfig(withPeriod({ kind: 'calendar-day', days: 3 }), 'test.json'),
    /period\.days.*only "rolling-days" may declare days/
  );
  assert.throws(
    () => parseConfig(withPeriod({ kind: 'fortnightly' }), 'test.json'),
    /period\.kind.*expected "calendar-day", "calendar-month", or "rolling-days"/
  );
});