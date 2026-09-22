import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';

const base = {
  defaultProfile: 'research',
  profiles: {
    research: { providers: ['exa', 'tavily', 'brave'] },
    economy: { providers: ['brave', 'tavily'] }
  },
  apiKeys: {
    exa: ['exa1'],
    tavily: ['tvly1', 'tvly2', 'tvly1'],
    brave: ['brave1']
  }
};

test('parseConfig accepts declared Search Profiles and deduplicates keys', () => {
  const config = parseConfig(base, 'test.json');
  assert.equal(config.defaultProfile, 'research');
  assert.deepEqual(Object.keys(config.profiles), ['research', 'economy']);
  assert.deepEqual(config.profiles.research.providers, ['exa', 'tavily', 'brave']);
  assert.deepEqual(config.profiles.economy.providers, ['brave', 'tavily']);
  assert.deepEqual(config.apiKeys.tavily, ['tvly1', 'tvly2']);
  assert.equal(config.search.numResults, 5);
  assert.equal(config.fetch.maxChars, 30000);
});

test('parseConfig rejects an unknown defaultProfile', () => {
  assert.throws(
    () => parseConfig({ ...base, defaultProfile: 'missing' }, 'test.json'),
    /Unknown defaultProfile "missing".*not declared in profiles/
  );
});

test('parseConfig rejects an unknown provider name in a profile', () => {
  assert.throws(
    () => parseConfig({ ...base, profiles: { research: { providers: ['exa', 'duckduckgo'] } } }, 'test.json'),
    /duckduckgo.*profiles\.research\.providers/
  );
});

test('parseConfig rejects an empty providers array', () => {
  assert.throws(
    () => parseConfig({ ...base, profiles: { research: { providers: [] } } }, 'test.json'),
    /profiles\.research\.providers.*non-empty/
  );
});

test('parseConfig rejects a missing profiles block', () => {
  const { profiles, ...withoutProfiles } = base;
  assert.throws(() => parseConfig(withoutProfiles, 'test.json'), /Missing profiles/);
});

test('parseConfig rejects the legacy top-level provider and providers keys', () => {
  assert.throws(() => parseConfig({ ...base, provider: 'balanced' }, 'test.json'), /legacy fields \(provider\)/);
  assert.throws(() => parseConfig({ ...base, providers: ['exa'] }, 'test.json'), /legacy fields \(providers\)/);
});

test('parseConfig rejects legacy key fields', () => {
  assert.throws(() => parseConfig({ ...base, tavilyApiKey: 'old' }, 'test.json'), /legacy fields/);
});