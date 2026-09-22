import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';

const base = {
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
    brave: [{ alias: 'brave-main', env: 'BRAVE_API_KEY' }]
  }
};

test('parseConfig accepts credential declarations per provider', () => {
  const config = parseConfig(base, 'test.json');
  assert.equal(config.defaultProfile, 'research');
  assert.deepEqual(Object.keys(config.profiles), ['research', 'economy']);
  assert.deepEqual(config.profiles.research.providers, ['exa', 'tavily', 'brave']);
  assert.deepEqual(config.profiles.economy.providers, ['brave', 'tavily']);
  assert.deepEqual(config.credentials.tavily.map((credential) => credential.alias), ['tvly-work', 'tvly-personal']);
  assert.equal(config.credentials.tavily[0].env, 'TAVILY_API_KEY_WORK');
  assert.equal(config.search.numResults, 5);
  assert.equal(config.fetch.maxChars, 30000);
});

test('parseConfig defaults a provider without credential declarations to an empty list', () => {
  const config = parseConfig({ ...base, credentials: { exa: [{ alias: 'exa-main', env: 'EXA_API_KEY' }] } }, 'test.json');
  assert.deepEqual(config.credentials.exa, [{ alias: 'exa-main', env: 'EXA_API_KEY' }]);
  assert.deepEqual(config.credentials.tavily, []);
  assert.deepEqual(config.credentials.brave, []);
});

test('parseConfig rejects a missing credentials block', () => {
  const { credentials, ...withoutCredentials } = base;
  assert.throws(() => parseConfig(withoutCredentials, 'test.json'), /Missing credentials/);
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

test('parseConfig rejects the legacy apiKeys field and points at credentials', () => {
  assert.throws(
    () => parseConfig({ ...base, apiKeys: { exa: ['key'] } }, 'test.json'),
    /legacy fields \(apiKeys\).*credentials/
  );
});

test('parseConfig rejects a duplicate credential alias within a provider', () => {
  assert.throws(
    () => parseConfig({ ...base, credentials: { exa: [{ alias: 'dup', env: 'A' }, { alias: 'dup', env: 'B' }] } }, 'test.json'),
    /Duplicate credential alias "dup"/
  );
});

test('parseConfig rejects a duplicate credential alias across providers', () => {
  assert.throws(
    () => parseConfig(
      { ...base, credentials: { exa: [{ alias: 'shared', env: 'A' }], tavily: [{ alias: 'shared', env: 'B' }] } },
      'test.json'
    ),
    /Duplicate credential alias "shared"/
  );
});

test('parseConfig rejects a credential declaration without an alias', () => {
  assert.throws(
    () => parseConfig({ ...base, credentials: { exa: [{ env: 'EXA_API_KEY' }] } }, 'test.json'),
    /missing alias/
  );
});

test('parseConfig rejects a credential declaration without an env reference', () => {
  assert.throws(
    () => parseConfig({ ...base, credentials: { exa: [{ alias: 'exa-main' }] } }, 'test.json'),
    /alias "exa-main".*missing env/
  );
});

test('parseConfig rejects an unknown provider key in credentials', () => {
  assert.throws(
    () => parseConfig({ ...base, credentials: { duckduckgo: [{ alias: 'ddg', env: 'DDG_KEY' }] } }, 'test.json'),
    /Unknown provider "duckduckgo" in credentials/
  );
});

test('parseConfig rejects a credential entry that is not an object', () => {
  assert.throws(
    () => parseConfig({ ...base, credentials: { exa: ['raw-key'] } }, 'test.json'),
    /expected an object with alias and env/
  );
});