import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RATE_LIMIT_COOLDOWN_MS,
  TRANSIENT_COOLDOWN_MS,
  activeCooldowns,
  cooldownDurationFor,
  createMemoryHealthStore,
  describeCooldowns,
  emptyHealth,
  enterCooldowns,
  loadHealth,
  parseHealthState,
  penaltiesFromHealth,
  pruneHealth,
  recordCooldowns
} from '../src/health.ts';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0); // 2026-10-20T12:00:00Z

test('rate limiting enters the longer cooldown window', () => {
  const state = enterCooldowns(emptyHealth(), [{ alias: 'exa-main', errorCategory: 'rate_limit' }], NOW);
  assert.equal(state.cooldowns['exa-main'].category, 'rate_limit');
  assert.equal(state.cooldowns['exa-main'].until, NOW + RATE_LIMIT_COOLDOWN_MS);
});

test('each transient category enters the short cooldown window', () => {
  for (const category of ['timeout', 'service', 'network']) {
    const state = enterCooldowns(emptyHealth(), [{ alias: 'exa-main', errorCategory: category }], NOW);
    assert.equal(state.cooldowns['exa-main'].until, NOW + TRANSIENT_COOLDOWN_MS, category);
  }
});

test('auth and unclassified failures never enter a cooldown', () => {
  for (const category of ['auth', 'unknown']) {
    assert.equal(cooldownDurationFor(category), undefined, category);
    const state = enterCooldowns(emptyHealth(), [{ alias: 'exa-main', errorCategory: category }], NOW);
    assert.deepEqual(state.cooldowns, {}, category);
  }
});

test('a cooldown expires as soon as the injected clock reaches its expiry', () => {
  const state = enterCooldowns(emptyHealth(), [{ alias: 'exa-main', errorCategory: 'rate_limit' }], NOW);
  assert.ok(activeCooldowns(state, NOW)[ 'exa-main' ], 'cooling immediately');
  assert.ok(activeCooldowns(state, NOW + RATE_LIMIT_COOLDOWN_MS - 1)['exa-main'], 'cooling just before expiry');
  assert.deepEqual(activeCooldowns(state, NOW + RATE_LIMIT_COOLDOWN_MS), {}, 'available at expiry');
});

test('a still-active longer cooldown is not shortened by a later failure', () => {
  const first = enterCooldowns(emptyHealth(), [{ alias: 'exa-main', errorCategory: 'rate_limit' }], NOW);
  const second = enterCooldowns(first, [{ alias: 'exa-main', errorCategory: 'network' }], NOW + 1000);
  assert.equal(second.cooldowns['exa-main'].category, 'rate_limit');
  assert.equal(second.cooldowns['exa-main'].until, NOW + RATE_LIMIT_COOLDOWN_MS);
});

test('prune drops expired entries and keeps live ones', () => {
  const state = enterCooldowns(
    emptyHealth(),
    [
      { alias: 'expired', errorCategory: 'network' },
      { alias: 'live', errorCategory: 'rate_limit' }
    ],
    NOW
  );
  const pruned = pruneHealth(state, NOW + TRANSIENT_COOLDOWN_MS);
  assert.deepEqual(Object.keys(pruned.cooldowns), ['live']);
});

test('active cooldowns become cooling penalties for the selector', () => {
  const state = enterCooldowns(emptyHealth(), [{ alias: 'exa-main', errorCategory: 'rate_limit' }], NOW);
  assert.deepEqual(penaltiesFromHealth(state, NOW), { 'exa-main': 'cooling' });
  assert.deepEqual(penaltiesFromHealth(state, NOW + RATE_LIMIT_COOLDOWN_MS), {});
});

test('cooldown state round-trips through the injected store and is visible to a new session', () => {
  const store = createMemoryHealthStore();
  recordCooldowns(store, [{ alias: 'exa-main', errorCategory: 'rate_limit' }], NOW);
  // A fresh read models a new session over the same shared store.
  const read = loadHealth(store, NOW);
  assert.equal(read.state.cooldowns['exa-main'].until, NOW + RATE_LIMIT_COOLDOWN_MS);
  assert.deepEqual(penaltiesFromHealth(read.state, NOW), { 'exa-main': 'cooling' });
  // ...and it expires without any further write.
  assert.deepEqual(loadHealth(store, NOW + RATE_LIMIT_COOLDOWN_MS).state.cooldowns, {});
});

test('status lines name the alias and the expiry, never key material', () => {
  const state = enterCooldowns(emptyHealth(), [{ alias: 'exa-main', errorCategory: 'rate_limit' }], NOW);
  const lines = describeCooldowns(state, NOW);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^exa-main: cooling until /);
  assert.match(lines[0], new RegExp(new Date(NOW + RATE_LIMIT_COOLDOWN_MS).toISOString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(lines[0], /\(rate_limit\)$/);
});

test('parseHealthState rejects a foreign or malformed document', () => {
  assert.throws(() => parseHealthState({ version: 99 }), /unsupported health store version/);
  assert.throws(
    () => parseHealthState({ version: 1, cooldowns: { 'exa-main': { category: 'nope', enteredAt: 1, until: 2 } } }),
    /invalid category/
  );
});