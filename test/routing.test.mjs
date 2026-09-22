import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { buildSearchPlan } from '../src/search.ts';

const raw = {
  defaultProfile: 'research',
  profiles: {
    research: { providers: ['exa', 'tavily', 'brave'] },
    economy: { providers: ['brave', 'tavily'] }
  },
  apiKeys: {
    exa: ['exa1'],
    tavily: ['tvly1', 'tvly2'],
    brave: ['brave1', 'brave2']
  }
};

const config = parseConfig(raw, 'test.json');

test('a Search Profile builds one target per key in provider order', () => {
  const plan = buildSearchPlan(config, config.profiles.research);
  assert.deepEqual(plan.map((target) => target.provider), ['exa', 'tavily', 'tavily', 'brave', 'brave']);
  assert.equal(plan.length, 5);
});

test('keys within a provider keep their declared order', () => {
  const plan = buildSearchPlan(config, config.profiles.research);
  assert.deepEqual(
    plan.filter((target) => target.provider === 'tavily').map((target) => target.apiKey),
    ['tvly1', 'tvly2']
  );
});

test('a Search Profile uses only its declared providers', () => {
  const plan = buildSearchPlan(config, config.profiles.economy);
  assert.deepEqual(plan.map((target) => target.provider), ['brave', 'brave', 'tavily', 'tavily']);
});

test('a profile with no keys for its providers yields an empty plan', () => {
  const empty = parseConfig({ ...raw, apiKeys: { exa: [], tavily: [], brave: [] } }, 'test.json');
  assert.deepEqual(buildSearchPlan(empty, empty.profiles.research), []);
});