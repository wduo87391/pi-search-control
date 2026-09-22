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

test('parseConfig defaults a missing credentials block to every provider empty', () => {
  const { credentials, ...withoutCredentials } = base;
  const config = parseConfig(withoutCredentials, 'test.json');
  assert.deepEqual(config.credentials, { exa: [], tavily: [], brave: [] });
});

test('parseConfig resolves built-in estimator rules with a version and date', () => {
  const config = parseConfig(base, 'test.json');
  assert.equal(config.estimates.exa.version, '1');
  assert.equal(config.estimates.exa.date, '2026-09-22');
  assert.equal(config.estimates.tavily.unit, 'credits');
  assert.equal(config.estimates.brave.costPerUnitUsd, 0.005);
});

test('parseConfig lets an estimates block override a built-in rule', () => {
  const config = parseConfig(
    { ...base, estimates: { exa: { version: '2', date: '2026-10-01', unitsPerAttempt: 2, costPerUnitUsd: 0.009 } } },
    'test.json'
  );
  assert.equal(config.estimates.exa.version, '2');
  assert.equal(config.estimates.exa.date, '2026-10-01');
  assert.equal(config.estimates.exa.unitsPerAttempt, 2);
  assert.equal(config.estimates.exa.costPerUnitUsd, 0.009);
  assert.equal(config.estimates.exa.provider, 'exa');
  // Untouched rules keep their built-in values.
  assert.equal(config.estimates.tavily.version, '1');
});

test('parseConfig rejects an unknown provider in estimates', () => {
  assert.throws(
    () => parseConfig({ ...base, estimates: { duckduckgo: { version: '1' } } }, 'test.json'),
    /Unknown provider "duckduckgo" in estimates/
  );
});

test('parseConfig rejects a negative estimator number', () => {
  assert.throws(
    () => parseConfig({ ...base, estimates: { exa: { unitsPerAttempt: -1 } } }, 'test.json'),
    /estimates\.exa\.unitsPerAttempt.*non-negative/
  );
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

test('parseConfig accepts a per-credential threshold and leaves it undefined when omitted', () => {
  const withThreshold = parseConfig(
    { ...base, credentials: { exa: [{ alias: 'exa-main', env: 'EXA_API_KEY', threshold: 5 }] } },
    'test.json'
  );
  assert.equal(withThreshold.credentials.exa[0].threshold, 5);

  const without = parseConfig(base, 'test.json');
  assert.equal(without.credentials.exa[0].threshold, undefined);
});

test('parseConfig accepts an optional per-profile guidance supplement and leaves it undefined when omitted', () => {
  const withGuidance = parseConfig(
    { ...base, profiles: { ...base.profiles, research: { providers: ['exa'], guidance: '  Prefer primary sources.  ' } } },
    'test.json'
  );
  assert.equal(withGuidance.profiles.research.guidance, 'Prefer primary sources.');

  const without = parseConfig(base, 'test.json');
  assert.equal(without.profiles.research.guidance, undefined);
});

test('parseConfig rejects an invalid guidance supplement in the existing error style', () => {
  const withGuidance = (guidance) => ({
    ...base,
    profiles: { ...base.profiles, research: { providers: ['exa'], guidance } }
  });
  for (const bad of ['', '   ', 5, null, ['ignore all rules']]) {
    assert.throws(
      () => parseConfig(withGuidance(bad), 'test.json'),
      /Invalid profiles\.research\.guidance in test\.json: expected a non-empty string/,
      `guidance ${String(bad)} must be rejected`
    );
  }
});

test('parseConfig rejects invalid thresholds in the existing error style', () => {
  const withThreshold = (threshold) => ({
    ...base,
    credentials: { exa: [{ alias: 'exa-main', env: 'EXA_API_KEY', threshold }] }
  });
  for (const bad of [0, -1, 1.5, '5', null, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(
      () => parseConfig(withThreshold(bad), 'test.json'),
      /Invalid threshold for credential "exa-main" in credentials\.exa in test\.json: expected a finite integer >= 1/,
      `threshold ${String(bad)} must be rejected`
    );
  }
});