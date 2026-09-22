import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { orchestrateBatch, orchestrateSearch } from '../src/orchestrator.ts';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0); // 2026-10-20T12:00:00Z

const raw = {
  defaultProfile: 'research',
  profiles: {
    research: { providers: ['exa', 'tavily', 'brave'] }
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

const config = parseConfig(raw, 'test.json');
const env = {
  EXA_API_KEY: 'exa-secret',
  TAVILY_API_KEY_WORK: 'tvly-work-secret',
  TAVILY_API_KEY: 'tvly-personal-secret',
  BRAVE_API_KEY: 'brave-secret'
};

const research = { name: 'research', providers: ['exa', 'tavily', 'brave'] };
const tavilyOnly = { name: 'tavily', providers: ['tavily'] };

function okResponse() {
  return { answer: 'an answer', results: [{ title: 't', url: 'https://example.com', snippet: 's' }] };
}

function makeDeps(overrides = {}) {
  const recorded = [];
  let requestCounter = 0;
  const deps = {
    now: () => NOW,
    newRequestId: () => `req-${++requestCounter}`,
    search: async () => okResponse(),
    resolveCredentials: (cfg) => resolveCredentials(cfg.credentials, env),
    ledger: {
      attemptsByAlias: () => ({}),
      record: (events) => { recorded.push(...events); }
    },
    health: { penalties: () => ({}) },
    ...overrides
  };
  return { deps, recorded };
}

function input(overrides = {}) {
  return { query: 'q', config, profile: research, sessionId: 's1', options: {}, ...overrides };
}

test('a failed credential falls back to the next credential of the same provider', async () => {
  const calls = [];
  const { deps } = makeDeps({
    search: async (target) => {
      calls.push(target.alias);
      if (target.alias === 'tvly-work') throw new Error('401 unauthorized');
      return okResponse();
    }
  });

  const result = await orchestrateSearch(input({ profile: tavilyOnly }), deps);

  assert.equal(result.provider, 'tavily');
  assert.equal(result.alias, 'tvly-personal');
  assert.deepEqual(calls, ['tvly-work', 'tvly-personal']);
  assert.deepEqual(result.attempts, [
    { provider: 'tavily', alias: 'tvly-work', error: '401 unauthorized', errorCategory: 'auth' }
  ]);
});

test('after the last credential of a provider fails, the next provider is tried', async () => {
  const calls = [];
  const { deps } = makeDeps({
    search: async (target) => {
      calls.push(target.alias);
      if (target.provider === 'brave') return okResponse();
      throw new Error('503 service unavailable');
    }
  });

  const result = await orchestrateSearch(input(), deps);

  assert.equal(result.provider, 'brave');
  assert.equal(result.alias, 'brave-main');
  assert.deepEqual(calls, ['exa-main', 'tvly-work', 'tvly-personal', 'brave-main']);
  assert.deepEqual(result.attempts.map((attempt) => [attempt.alias, attempt.errorCategory]), [
    ['exa-main', 'service'],
    ['tvly-work', 'service'],
    ['tvly-personal', 'service']
  ]);
});

test('a successful-but-empty response does not fall back', async () => {
  let calls = 0;
  const { deps } = makeDeps({
    search: async () => {
      calls++;
      return { answer: '', results: [] };
    }
  });

  const result = await orchestrateSearch(input(), deps);

  assert.equal(result.alias, 'exa-main');
  assert.equal(calls, 1);
  assert.deepEqual(result.attempts, []);
  assert.deepEqual(result.results, []);
});

test('abort propagates upward and is neither retried nor counted', async () => {
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  let calls = 0;
  const { deps, recorded } = makeDeps({
    search: async () => {
      calls++;
      throw abort;
    }
  });

  await assert.rejects(() => orchestrateSearch(input(), deps), (err) => err === abort);
  assert.equal(calls, 1, 'no fallback attempt after abort');
  assert.equal(recorded.length, 0, 'an aborted query records no attempt accounting');
});

test('each query in a batch routes and falls back independently', async () => {
  const calls = [];
  const { deps } = makeDeps({
    search: async (target, query) => {
      calls.push(`${query}:${target.alias}`);
      if (query === 'first' && target.provider !== 'tavily') throw new Error('500 server error');
      return okResponse();
    }
  });

  const outcomes = await orchestrateBatch(
    { queries: ['first', 'second'], config, profile: research, sessionId: 's1' },
    deps
  );

  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].provider, 'tavily');
  assert.equal(outcomes[0].alias, 'tvly-work');
  assert.equal(outcomes[1].provider, 'exa');
  assert.equal(outcomes[1].alias, 'exa-main');
  assert.deepEqual(calls, ['first:exa-main', 'first:tvly-work', 'second:exa-main']);
});

test('a partially failing batch still returns the successful queries', async () => {
  const { deps } = makeDeps({
    search: async (target, query) => {
      if (query === 'bad') throw new Error('502 bad gateway');
      return okResponse();
    }
  });

  const outcomes = await orchestrateBatch(
    { queries: ['good', 'bad'], config, profile: research, sessionId: 's1' },
    deps
  );

  assert.equal(outcomes.length, 2);
  assert.ok(!('error' in outcomes[0]));
  assert.equal(outcomes[0].query, 'good');
  assert.ok('error' in outcomes[1]);
  assert.equal(outcomes[1].query, 'bad');
  assert.match(outcomes[1].error, /exa exa-main \[service\]/);
});

test('total failure lists every attempted provider and alias with its category and no key material', async () => {
  const { deps } = makeDeps({
    search: async (target) => {
      throw new Error(target.provider === 'exa' ? '401 unauthorized' : '429 rate limit exceeded');
    }
  });

  await assert.rejects(
    () => orchestrateSearch(input(), deps),
    (err) => {
      assert.equal(err.name, 'SearchFailureError');
      assert.deepEqual(
        err.attempts.map((attempt) => [attempt.provider, attempt.alias, attempt.errorCategory]),
        [
          ['exa', 'exa-main', 'auth'],
          ['tavily', 'tvly-work', 'rate_limit'],
          ['tavily', 'tvly-personal', 'rate_limit'],
          ['brave', 'brave-main', 'rate_limit']
        ]
      );
      assert.match(err.message, /- exa exa-main \[auth\]/);
      assert.match(err.message, /- brave brave-main \[rate_limit\]/);
      for (const secret of Object.values(env)) {
        assert.ok(!err.message.includes(secret), `message must not contain key material (${secret})`);
      }
      return true;
    }
  );
});

test('accounting records every failed attempt plus the successful one', async () => {
  const { deps, recorded } = makeDeps({
    search: async (target) => {
      if (target.alias === 'exa-main') throw new Error('401 unauthorized');
      if (target.alias === 'tvly-work') throw new Error('429 rate limit exceeded');
      return okResponse();
    }
  });

  await orchestrateSearch(input(), deps);

  const requests = recorded.filter((event) => event.kind === 'request');
  const attempts = recorded.filter((event) => event.kind === 'attempt');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].profile, 'research');
  assert.deepEqual(
    attempts.map((attempt) => [attempt.alias, attempt.outcome, attempt.errorCategory]),
    [
      ['exa-main', 'failure', 'auth'],
      ['tvly-work', 'failure', 'rate_limit'],
      ['tvly-personal', 'success', undefined]
    ]
  );
});

test('ledger-derived attempt counts steer least-used routing', async () => {
  const calls = [];
  const { deps } = makeDeps({
    ledger: { attemptsByAlias: () => ({ 'tvly-work': [NOW, NOW] }), record: () => {} },
    search: async (target) => {
      calls.push(target.alias);
      return okResponse();
    }
  });

  const result = await orchestrateSearch(input({ profile: tavilyOnly }), deps);

  assert.equal(result.alias, 'tvly-personal');
  assert.deepEqual(calls, ['tvly-personal']);
});

test('health penalties steer routing without any persistence in the orchestrator', async () => {
  const { deps } = makeDeps({
    health: { penalties: () => ({ 'tvly-work': 'cooling' }) }
  });

  const result = await orchestrateSearch(input({ profile: tavilyOnly }), deps);

  assert.equal(result.alias, 'tvly-personal');
});

test('the injected clock and config defaults drive the attempt options', async () => {
  let seen;
  const { deps } = makeDeps({
    search: async (_target, _query, options) => {
      seen = options;
      return okResponse();
    }
  });

  await orchestrateSearch(input(), deps);

  assert.equal(seen.numResults, config.search.numResults);
  assert.equal(seen.timeoutMs, config.search.timeoutMs);
});

test('a profile with no available credentials keeps the existing message style', async () => {
  const { deps } = makeDeps({
    resolveCredentials: (cfg) => resolveCredentials(cfg.credentials, {})
  });

  await assert.rejects(
    () => orchestrateSearch(input({ profile: tavilyOnly }), deps),
    /No available credentials for Search Profile "tavily"\. Unavailable: tvly-work, tvly-personal\./
  );
});