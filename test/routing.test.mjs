import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { buildSearchPlan } from '../src/search.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0); // 2026-10-20T12:00:00Z

const raw = {
  defaultProfile: 'research',
  profiles: {
    research: { providers: ['exa', 'tavily', 'brave'] },
    economy: { providers: ['brave', 'tavily'] }
  },
  credentials: {
    exa: [{ alias: 'exa-main', env: 'EXA_API_KEY' }],
    tavily: [
      { alias: 'tvly-work', env: 'TAVILY_API_KEY_WORK' },
      { alias: 'tvly-personal', env: 'TAVILY_API_KEY' }
    ],
    brave: [
      { alias: 'brave-main', env: 'BRAVE_API_KEY' },
      { alias: 'brave-backup', env: 'BRAVE_API_KEY_BACKUP' }
    ]
  }
};

const config = parseConfig(raw, 'test.json');
const allSet = {
  EXA_API_KEY: 'exa-secret',
  TAVILY_API_KEY_WORK: 'tvly-work-secret',
  TAVILY_API_KEY: 'tvly-personal-secret',
  BRAVE_API_KEY: 'brave-secret',
  BRAVE_API_KEY_BACKUP: 'brave-backup-secret'
};

function plan(profile, env, input = { now: NOW }) {
  return buildSearchPlan(profile, resolveCredentials(config.credentials, env), input);
}

test('a Search Profile builds one target per available credential in provider order', () => {
  const targets = plan(config.profiles.research, allSet);
  assert.deepEqual(targets.map((target) => target.provider), ['exa', 'tavily', 'tavily', 'brave', 'brave']);
  assert.deepEqual(
    targets.map((target) => target.alias),
    ['exa-main', 'tvly-work', 'tvly-personal', 'brave-main', 'brave-backup']
  );
  assert.equal(targets.length, 5);
});

test('with no attempt data credentials within a provider keep their declared order', () => {
  const targets = plan(config.profiles.research, allSet);
  assert.deepEqual(
    targets.filter((target) => target.provider === 'tavily').map((target) => target.alias),
    ['tvly-work', 'tvly-personal']
  );
});

test('within a provider the credential with the fewest attempts in its period comes first', () => {
  const targets = plan(config.profiles.research, allSet, {
    now: NOW,
    attemptsByAlias: { 'tvly-work': [NOW, NOW], 'brave-main': [NOW] }
  });
  assert.deepEqual(
    targets.filter((target) => target.provider === 'tavily').map((target) => target.alias),
    ['tvly-personal', 'tvly-work']
  );
  assert.deepEqual(
    targets.filter((target) => target.provider === 'brave').map((target) => target.alias),
    ['brave-backup', 'brave-main']
  );
  // Provider order is unaffected by the within-provider ranking.
  assert.deepEqual(targets.map((target) => target.provider), ['exa', 'tavily', 'tavily', 'brave', 'brave']);
});

test('the plan counts attempts against each credential\'s own declared usage period', () => {
  const dayConfig = parseConfig(
    {
      defaultProfile: 'p',
      profiles: { p: { providers: ['tavily'] } },
      credentials: {
        tavily: [
          { alias: 'day', env: 'DAY_API_KEY', period: { kind: 'calendar-day' } },
          { alias: 'month', env: 'MONTH_API_KEY' }
        ]
      }
    },
    'test.json'
  );
  const yesterday = NOW - DAY;
  const targets = buildSearchPlan(
    dayConfig.profiles.p,
    resolveCredentials(dayConfig.credentials, { DAY_API_KEY: 'day', MONTH_API_KEY: 'month' }),
    { now: NOW, attemptsByAlias: { day: [yesterday, yesterday], month: [NOW] } }
  );
  // `day`'s two attempts fall outside its calendar-day period, so it leads.
  assert.deepEqual(targets.map((target) => target.alias), ['day', 'month']);
});

test('a Search Profile uses only its declared providers', () => {
  const targets = plan(config.profiles.economy, allSet);
  assert.deepEqual(targets.map((target) => target.provider), ['brave', 'brave', 'tavily', 'tavily']);
});

test('credentials whose environment variable is missing are excluded from the plan', () => {
  const targets = plan(config.profiles.research, { EXA_API_KEY: 'exa-secret' });
  assert.deepEqual(targets.map((target) => target.alias), ['exa-main']);
});

test('a profile with no available credentials yields an empty plan', () => {
  assert.deepEqual(plan(config.profiles.research, {}), []);
});

test('cooling credentials are excluded from the plan', () => {
  const targets = plan(config.profiles.research, allSet, {
    now: NOW,
    penalties: { 'tvly-work': 'cooling' }
  });
  assert.deepEqual(
    targets.filter((target) => target.provider === 'tavily').map((target) => target.alias),
    ['tvly-personal']
  );
});

test('demoted credentials stay eligible but rank after non-demoted ones', () => {
  const targets = plan(config.profiles.research, allSet, {
    now: NOW,
    attemptsByAlias: { 'tvly-personal': [NOW, NOW, NOW] },
    penalties: { 'tvly-work': 'demoted' }
  });
  assert.deepEqual(
    targets.filter((target) => target.provider === 'tavily').map((target) => target.alias),
    ['tvly-personal', 'tvly-work']
  );
});

test('repeated calls with identical inputs produce an identical plan', () => {
  const input = { now: NOW, attemptsByAlias: { 'tvly-work': [NOW], 'tvly-personal': [NOW] } };
  const first = plan(config.profiles.research, allSet, input).map((target) => target.alias);
  const second = plan(config.profiles.research, allSet, input).map((target) => target.alias);
  assert.deepEqual(first, second);
});