import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { buildSearchPlan } from '../src/search.ts';

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

test('a Search Profile builds one target per available credential in provider order', () => {
  const plan = buildSearchPlan(config.profiles.research, resolveCredentials(config.credentials, allSet));
  assert.deepEqual(plan.map((target) => target.provider), ['exa', 'tavily', 'tavily', 'brave', 'brave']);
  assert.deepEqual(
    plan.map((target) => target.alias),
    ['exa-main', 'tvly-work', 'tvly-personal', 'brave-main', 'brave-backup']
  );
  assert.equal(plan.length, 5);
});

test('credentials within a provider keep their declared order', () => {
  const plan = buildSearchPlan(config.profiles.research, resolveCredentials(config.credentials, allSet));
  assert.deepEqual(
    plan.filter((target) => target.provider === 'tavily').map((target) => target.alias),
    ['tvly-work', 'tvly-personal']
  );
});

test('a Search Profile uses only its declared providers', () => {
  const plan = buildSearchPlan(config.profiles.economy, resolveCredentials(config.credentials, allSet));
  assert.deepEqual(plan.map((target) => target.provider), ['brave', 'brave', 'tavily', 'tavily']);
});

test('credentials whose environment variable is missing are excluded from the plan', () => {
  const plan = buildSearchPlan(config.profiles.research, resolveCredentials(config.credentials, { EXA_API_KEY: 'exa-secret' }));
  assert.deepEqual(plan.map((target) => target.alias), ['exa-main']);
});

test('a profile with no available credentials yields an empty plan', () => {
  const plan = buildSearchPlan(config.profiles.research, resolveCredentials(config.credentials, {}));
  assert.deepEqual(plan, []);
});