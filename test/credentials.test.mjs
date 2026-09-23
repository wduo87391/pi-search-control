import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCredentials } from '../src/credentials.ts';

const credentials = {
  exa: [{ alias: 'exa-main', env: 'EXA_API_KEY' }],
  tavily: [
    { alias: 'tvly-work', env: 'TAVILY_API_KEY_WORK' },
    { alias: 'tvly-personal', env: 'TAVILY_API_KEY' }
  ],
  brave: [{ alias: 'brave-main', env: 'BRAVE_API_KEY' }],
  anysearch: []
};

test('resolveCredentials marks every credential available when its environment variable is set', () => {
  const resolved = resolveCredentials(credentials, {
    EXA_API_KEY: 'exa-secret',
    TAVILY_API_KEY_WORK: 'tvly-work-secret',
    TAVILY_API_KEY: 'tvly-personal-secret',
    BRAVE_API_KEY: 'brave-secret'
  });

  assert.deepEqual(
    resolved.map((credential) => [credential.provider, credential.alias, credential.available]),
    [
      ['exa', 'exa-main', true],
      ['tavily', 'tvly-work', true],
      ['tavily', 'tvly-personal', true],
      ['brave', 'brave-main', true]
    ]
  );
  assert.equal(resolved[0].apiKey, 'exa-secret');
});

test('resolveCredentials marks only the credentials with missing environment variables unavailable', () => {
  const resolved = resolveCredentials(credentials, { EXA_API_KEY: 'exa-secret' });

  assert.deepEqual(
    resolved.map((credential) => [credential.alias, credential.available, credential.apiKey]),
    [
      ['exa-main', true, 'exa-secret'],
      ['tvly-work', false, ''],
      ['tvly-personal', false, ''],
      ['brave-main', false, '']
    ]
  );
});

test('resolveCredentials treats a blank environment variable as unavailable', () => {
  const resolved = resolveCredentials(credentials, { EXA_API_KEY: '   ' });
  assert.equal(resolved[0].available, false);
  assert.equal(resolved[0].apiKey, '');
});

test('resolveCredentials marks every credential unavailable when no environment variable is set', () => {
  const resolved = resolveCredentials(credentials, {});
  assert.equal(resolved.every((credential) => !credential.available), true);
  assert.equal(resolved.every((credential) => credential.apiKey === ''), true);
});

test('resolved credentials are identified by alias and carry no environment-variable name', () => {
  const resolved = resolveCredentials(credentials, {});
  for (const credential of resolved) {
    assert.equal(typeof credential.alias, 'string');
    assert.equal('env' in credential, false);
  }
});

test('resolved credentials carry the declared usage period, defaulting to calendar-month', () => {
  const resolved = resolveCredentials(
    {
      exa: [
        { alias: 'day', env: 'DAY_API_KEY', period: { kind: 'calendar-day' } },
        { alias: 'plain', env: 'PLAIN_API_KEY' }
      ],
      tavily: [],
      brave: [],
      anysearch: []
    },
    { DAY_API_KEY: 'day', PLAIN_API_KEY: 'plain' }
  );
  assert.deepEqual(
    resolved.map((credential) => credential.period),
    [{ kind: 'calendar-day' }, { kind: 'calendar-month' }]
  );
});

test('an AnySearch credential without an override resolves the provider-default allowance', () => {
  const resolved = resolveCredentials(
    { exa: [], tavily: [], brave: [], anysearch: [{ alias: 'any-main', env: 'ANYSEARCH_API_KEY' }] },
    { ANYSEARCH_API_KEY: 'any-secret' }
  );
  const allowance = resolved[0].allowance;
  assert.equal(allowance.units, 1000);
  assert.deepEqual(allowance.period, { kind: 'calendar-day' });
  assert.equal(allowance.source, 'provider-default');
});

test('a credential allowance override replaces units and period but stays separate from threshold', () => {
  const resolved = resolveCredentials(
    {
      exa: [],
      tavily: [],
      brave: [],
      anysearch: [
        {
          alias: 'any-promo',
          env: 'ANYSEARCH_PROMO_KEY',
          threshold: 5,
          allowance: { units: 2000, period: { kind: 'calendar-month' } }
        }
      ]
    },
    { ANYSEARCH_PROMO_KEY: 'promo-secret' }
  );
  assert.equal(resolved[0].allowance.units, 2000);
  assert.deepEqual(resolved[0].allowance.period, { kind: 'calendar-month' });
  assert.equal(resolved[0].allowance.source, 'credential');
  assert.equal(resolved[0].threshold, 5);
});

test('a provider with no built-in allowance and no override carries no allowance', () => {
  const resolved = resolveCredentials(credentials, { EXA_API_KEY: 'exa-secret' });
  assert.equal(resolved[0].allowance, undefined);
});