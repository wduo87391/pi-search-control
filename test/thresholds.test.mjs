import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { resolveCredentials } from '../src/credentials.ts';
import {
  createThresholdWarner,
  describeThresholds,
  formatThresholdWarning,
  mergePenalties,
  thresholdCrossings,
  thresholdPenalties
} from '../src/thresholds.ts';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0); // 2026-10-20T12:00:00Z
const LAST_MONTH = Date.UTC(2026, 8, 15, 12, 0, 0); // 2026-09-15
const NEXT_MONTH = Date.UTC(2026, 10, 5, 12, 0, 0); // 2026-11-05

const config = parseConfig(
  {
    defaultProfile: 'p',
    profiles: { p: { providers: ['exa', 'tavily'] } },
    credentials: {
      exa: [
        { alias: 'exa-threshold', env: 'EXA_THRESHOLD', threshold: 3 },
        { alias: 'exa-open', env: 'EXA_OPEN' }
      ],
      tavily: [{ alias: 'tvly-cap', env: 'TVLY_CAP', threshold: 1 }]
    }
  },
  'test.json'
);
const resolved = resolveCredentials(config.credentials, {
  EXA_THRESHOLD: 'exa-secret',
  EXA_OPEN: 'exa-open-secret',
  TVLY_CAP: 'tvly-secret'
});

test('a credential below its threshold is neither demoted nor reported', () => {
  const attempts = { 'exa-threshold': [NOW, NOW] };
  assert.deepEqual(thresholdCrossings(resolved, attempts, NOW), []);
  assert.deepEqual(thresholdPenalties(resolved, attempts, NOW), {});
});

test('an unavailable credential never produces a threshold crossing', () => {
  const withMissingEnv = resolveCredentials(config.credentials, {
    EXA_OPEN: 'exa-open-secret',
    TVLY_CAP: 'tvly-secret'
  });
  const attempts = { 'exa-threshold': [NOW, NOW, NOW, NOW] };

  assert.deepEqual(thresholdCrossings(withMissingEnv, attempts, NOW), []);
});

test('reaching the threshold demotes the credential without excluding it', () => {
  const attempts = { 'exa-threshold': [NOW, NOW, NOW] };
  const crossings = thresholdCrossings(resolved, attempts, NOW);
  assert.deepEqual(crossings.map((crossing) => [crossing.alias, crossing.attempts, crossing.threshold]), [
    ['exa-threshold', 3, 3]
  ]);
  assert.deepEqual(thresholdPenalties(resolved, attempts, NOW), { 'exa-threshold': 'demoted' });
});

test('a credential with no configured threshold is never demoted', () => {
  const attempts = { 'exa-open': [NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW] };
  assert.deepEqual(thresholdCrossings(resolved, attempts, NOW), []);
  assert.deepEqual(thresholdPenalties(resolved, attempts, NOW), {});
});

test('threshold counts reset when the usage period rolls over', () => {
  const lastPeriod = { 'exa-threshold': [LAST_MONTH, LAST_MONTH, LAST_MONTH] };
  assert.deepEqual(thresholdPenalties(resolved, lastPeriod, NOW), {}, 'September attempts do not count in October');

  const thisPeriod = { 'exa-threshold': [NOW, NOW, NOW] };
  assert.deepEqual(thresholdPenalties(resolved, thisPeriod, NOW), { 'exa-threshold': 'demoted' });
});

test('the threshold is scoped to a rolling window when the credential declares one', () => {
  const rolling = parseConfig(
    {
      defaultProfile: 'p',
      profiles: { p: { providers: ['exa'] } },
      credentials: {
        exa: [{ alias: 'exa-roll', env: 'EXA_ROLL', period: { kind: 'rolling-days', days: 7 }, threshold: 2 }]
      }
    },
    'test.json'
  );
  const credentials = resolveCredentials(rolling.credentials, { EXA_ROLL: 'k' });
  const inside = { 'exa-roll': [NOW, NOW - 6 * 24 * 60 * 60 * 1000] };
  const outside = { 'exa-roll': [NOW - 8 * 24 * 60 * 60 * 1000, NOW - 9 * 24 * 60 * 60 * 1000] };
  assert.deepEqual(thresholdPenalties(credentials, inside, NOW), { 'exa-roll': 'demoted' });
  assert.deepEqual(thresholdPenalties(credentials, outside, NOW), {});
});

test('mergePenalties lets a cooldown win over threshold demotion', () => {
  const merged = mergePenalties(
    { 'exa-threshold': 'cooling' },
    { 'exa-threshold': 'demoted', 'tvly-cap': 'demoted' }
  );
  assert.deepEqual(merged, { 'exa-threshold': 'cooling', 'tvly-cap': 'demoted' });
});

test('the warning names the credential alias and no key material', () => {
  const attempts = { 'exa-threshold': [NOW, NOW, NOW] };
  const [crossing] = thresholdCrossings(resolved, attempts, NOW);
  const message = formatThresholdWarning(crossing);
  assert.match(message, /"exa-threshold"/);
  assert.match(message, /3 Provider Attempts this period \(threshold 3\)/);
  assert.ok(!message.includes('exa-secret'), 'must not leak key material');
  assert.ok(!message.includes('EXA_THRESHOLD'), 'must not leak the environment-variable name');
});

test('the warning is deduplicated within a period and reappears in the next period', () => {
  const warner = createThresholdWarner();
  const thisPeriod = thresholdCrossings(resolved, { 'exa-threshold': [NOW, NOW, NOW] }, NOW);
  assert.equal(warner.warningsFor(thisPeriod).length, 1, 'first crossing warns');
  assert.equal(warner.warningsFor(thisPeriod).length, 0, 'a repeat search in the same period does not warn again');

  const nextPeriod = thresholdCrossings(resolved, { 'exa-threshold': [NEXT_MONTH, NEXT_MONTH, NEXT_MONTH] }, NEXT_MONTH);
  assert.equal(warner.warningsFor(nextPeriod).length, 1, 'the next period warns again');
});

test('describeThresholds reports per-credential counts against the period and never key material', () => {
  const lines = describeThresholds(resolved, { 'exa-threshold': [NOW, NOW, NOW], 'tvly-cap': [NOW] }, NOW);
  assert.deepEqual(lines, [
    'exa-threshold: 3/3 attempts this period (demoted)',
    'tvly-cap: 1/1 attempts this period (demoted)'
  ]);
  assert.ok(!lines.join('\n').includes('exa-secret'));
  assert.ok(!lines.join('\n').includes('EXA_THRESHOLD'));

  const below = describeThresholds(resolved, { 'exa-threshold': [NOW] }, NOW);
  assert.deepEqual(below, [
    'exa-threshold: 1/3 attempts this period (ok)',
    'tvly-cap: 0/1 attempts this period (ok)'
  ]);
});