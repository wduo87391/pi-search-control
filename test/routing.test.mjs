import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { buildSearchPlan } from '../src/search.ts';

const config = parseConfig({
  provider: 'balanced',
  providers: ['exa', 'tavily', 'brave'],
  apiKeys: {
    exa: ['exa1'],
    tavily: ['tvly1', 'tvly2'],
    brave: ['brave1', 'brave2']
  }
}, 'test.json');

test('balanced builds one flat target per provider key', () => {
  const plan = buildSearchPlan(config, 'balanced');
  const counts = Object.fromEntries(['exa', 'tavily', 'brave'].map((p) => [p, 0]));
  for (const target of plan) counts[target.provider]++;
  assert.equal(plan.length, 5);
  assert.deepEqual(counts, { exa: 1, tavily: 2, brave: 2 });
});

test('auto preserves provider priority while shuffling keys within each provider', () => {
  const plan = buildSearchPlan({ ...config, provider: 'auto', providers: ['tavily', 'exa', 'brave'] }, 'auto');
  assert.deepEqual(plan.map((target) => target.provider), ['tavily', 'tavily', 'exa', 'brave', 'brave']);
});

test('direct provider only uses that provider keys', () => {
  const plan = buildSearchPlan(config, 'brave');
  assert.equal(plan.length, 2);
  assert.ok(plan.every((target) => target.provider === 'brave'));
});
