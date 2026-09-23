import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { orchestrateBatch, orchestrateSearch, createHealthPort } from '../src/orchestrator.ts';
import {
  QUOTA_COOLDOWN_MS,
  RATE_LIMIT_COOLDOWN_MS,
  TRANSIENT_COOLDOWN_MS,
  activeCooldowns,
  createMemoryHealthStore,
  emptyHealth,
  enterCooldowns
} from '../src/health.ts';
import { createThresholdWarner } from '../src/thresholds.ts';
import { ProviderFailureError } from '../src/provider-failure.ts';

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
    health: { penalties: () => ({}), record: () => {} },
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

test('each query in a batch records its own Search Request', async () => {
  const { deps, recorded } = makeDeps();

  await orchestrateBatch(
    { queries: ['first', 'second', 'third'], config, profile: research, sessionId: 's1' },
    deps
  );

  const requests = recorded.filter((event) => event.kind === 'request');
  assert.equal(requests.length, 3, 'one Search Request per query in the batch');
  assert.equal(new Set(requests.map((event) => event.requestId)).size, 3, 'each query gets its own request id');
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
  // Failed attempts live in structured details, not in the model-visible text.
  assert.deepEqual(outcomes[1].attempts, [
    { provider: 'exa', alias: 'exa-main', error: '502 bad gateway', errorCategory: 'service' },
    { provider: 'tavily', alias: 'tvly-work', error: '502 bad gateway', errorCategory: 'service' },
    { provider: 'tavily', alias: 'tvly-personal', error: '502 bad gateway', errorCategory: 'service' },
    { provider: 'brave', alias: 'brave-main', error: '502 bad gateway', errorCategory: 'service' }
  ]);
  assert.ok(!outcomes[1].error.includes('exa-main'), 'error text must not name the attempted aliases');
  assert.ok(!outcomes[1].error.includes('service'), 'error text must not carry per-attempt categories');
});

test('a failed query exposes its attempts in structured details and a concise text error', async () => {
  const { deps } = makeDeps({
    search: async () => { throw new Error('401 unauthorized'); }
  });

  const outcomes = await orchestrateBatch(
    { queries: ['only'], config, profile: research, sessionId: 's1' },
    deps
  );

  assert.equal(outcomes.length, 1);
  assert.ok('error' in outcomes[0]);
  assert.equal(outcomes[0].error, 'Search failed for all configured targets.');
  assert.deepEqual(outcomes[0].attempts.map((attempt) => [attempt.provider, attempt.alias, attempt.errorCategory]), [
    ['exa', 'exa-main', 'auth'],
    ['tavily', 'tvly-work', 'auth'],
    ['tavily', 'tvly-personal', 'auth'],
    ['brave', 'brave-main', 'auth']
  ]);
});

test('provider extension data flows through orchestration results', async () => {
  const { deps } = makeDeps({
    search: async () => ({
      answer: '',
      results: [{ title: 't', url: 'https://example.com', snippet: 's', extension: { highlights: ['h1'] } }]
    })
  });

  const result = await orchestrateSearch(input({ profile: { name: 'exa', providers: ['exa'] } }), deps);

  assert.equal(result.results[0].provider, 'exa');
  assert.deepEqual(result.results[0].extension, { exa: { highlights: ['h1'] } });
  assert.ok(!result.markdown.includes('h1'), 'the extension value is not rendered into model-visible markdown');
});

test('a throwing ledger store never fails the search', async () => {
  const { deps } = makeDeps({
    ledger: {
      attemptsByAlias: () => { throw new Error('ledger read exploded'); },
      record: () => { throw new Error('ledger write exploded'); }
    }
  });

  const result = await orchestrateSearch(input(), deps);

  assert.equal(result.provider, 'exa');
  assert.equal(result.alias, 'exa-main');
  assert.ok(!result.markdown.includes('ledger'), 'a ledger failure is not surfaced to the model');
});

test('a ledger port that returns a corrupt shape degrades to no attempt history', async () => {
  const { deps } = makeDeps({
    ledger: {
      attemptsByAlias: () => undefined,
      record: () => { throw new Error('ledger write exploded'); }
    }
  });

  const result = await orchestrateSearch(input(), deps);

  assert.equal(result.alias, 'exa-main');
});

test('a throwing health store never fails the search', async () => {
  const { deps } = makeDeps({
    search: async (target) => {
      if (target.alias === 'exa-main') throw new Error('429 rate limit exceeded');
      return okResponse();
    },
    health: {
      penalties: () => { throw new Error('health read exploded'); },
      record: () => { throw new Error('health write exploded'); }
    }
  });

  const result = await orchestrateSearch(input(), deps);

  assert.equal(result.provider, 'tavily');
  assert.equal(result.alias, 'tvly-work');
  assert.ok(!result.markdown.includes('health'), 'a health failure is not surfaced to the model');
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
    health: { penalties: () => ({ 'tvly-work': 'cooling' }), record: () => {} }
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

test('a query with no usable credentials records a Search Request with zero attempts', async () => {
  const { deps, recorded } = makeDeps({
    resolveCredentials: (cfg) => resolveCredentials(cfg.credentials, {})
  });

  await assert.rejects(() => orchestrateSearch(input({ profile: tavilyOnly }), deps));

  const requests = recorded.filter((event) => event.kind === 'request');
  const attempts = recorded.filter((event) => event.kind === 'attempt');
  assert.equal(requests.length, 1, 'the rejected query was still submitted');
  assert.equal(requests[0].profile, 'tavily');
  assert.equal(attempts.length, 0);
});

test('a request timeout falls back and enters a cooldown instead of being treated as an abort', async () => {
  const store = createMemoryHealthStore();
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const calls = [];
  const { deps, recorded } = makeDeps({
    health: createHealthPort(store),
    search: async (target) => {
      calls.push(target.alias);
      if (target.alias === 'exa-main') throw timeout;
      return okResponse();
    }
  });

  const result = await orchestrateSearch(input(), deps);

  assert.equal(result.provider, 'tavily');
  assert.equal(result.alias, 'tvly-work');
  assert.deepEqual(calls, ['exa-main', 'tvly-work'], 'a timeout falls back instead of propagating');
  assert.ok(recorded.length > 0, 'a timed-out attempt is accounted, not discarded as an abort');
  const cooling = activeCooldowns(store.read().state, NOW);
  assert.equal(cooling['exa-main'].category, 'timeout');
  assert.equal(cooling['exa-main'].until, NOW + TRANSIENT_COOLDOWN_MS);
});

test('a rate-limited credential enters a cooldown with the rate-limit window', async () => {
  const store = createMemoryHealthStore();
  const { deps } = makeDeps({
    health: createHealthPort(store),
    search: async (target) => {
      if (target.alias === 'tvly-work') throw new Error('429 rate limit exceeded');
      return okResponse();
    }
  });

  const result = await orchestrateSearch(input({ profile: tavilyOnly }), deps);

  assert.equal(result.alias, 'tvly-personal');
  const cooling = activeCooldowns(store.read().state, NOW);
  assert.equal(cooling['tvly-work'].category, 'rate_limit');
  assert.equal(cooling['tvly-work'].until, NOW + RATE_LIMIT_COOLDOWN_MS);
});

test('a transiently failing credential enters a cooldown with the short window', async () => {
  const store = createMemoryHealthStore();
  const { deps } = makeDeps({
    health: createHealthPort(store),
    search: async (target) => {
      if (target.alias === 'tvly-work') throw new Error('503 service unavailable');
      return okResponse();
    }
  });

  await orchestrateSearch(input({ profile: tavilyOnly }), deps);

  const cooling = activeCooldowns(store.read().state, NOW);
  assert.equal(cooling['tvly-work'].category, 'service');
  assert.equal(cooling['tvly-work'].until, NOW + TRANSIENT_COOLDOWN_MS);
});

test('an authentication failure does not enter a cooldown', async () => {
  const store = createMemoryHealthStore();
  const { deps } = makeDeps({
    health: createHealthPort(store),
    search: async (target) => {
      if (target.alias === 'tvly-work') throw new Error('401 unauthorized');
      return okResponse();
    }
  });

  await orchestrateSearch(input({ profile: tavilyOnly }), deps);

  assert.deepEqual(activeCooldowns(store.read().state, NOW), {});
});

test('an abort does not enter a cooldown', async () => {
  const store = createMemoryHealthStore();
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const { deps } = makeDeps({
    health: createHealthPort(store),
    search: async () => { throw abort; }
  });

  await assert.rejects(() => orchestrateSearch(input(), deps), (err) => err === abort);

  assert.deepEqual(activeCooldowns(store.read().state, NOW), {});
});

test('a cooling credential is skipped until the clock passes its expiry', async () => {
  const store = createMemoryHealthStore();
  let clock = NOW;
  const calls = [];
  const { deps } = makeDeps({
    health: createHealthPort(store),
    now: () => clock,
    search: async (target) => {
      calls.push(target.alias);
      if (target.alias === 'tvly-work' && clock === NOW) throw new Error('429 rate limit exceeded');
      return okResponse();
    }
  });

  await orchestrateSearch(input({ profile: tavilyOnly }), deps);
  calls.length = 0;

  const during = await orchestrateSearch(input({ profile: tavilyOnly }), deps);
  assert.equal(during.alias, 'tvly-personal', 'cooling credential is skipped');
  assert.deepEqual(calls, ['tvly-personal']);

  clock = NOW + RATE_LIMIT_COOLDOWN_MS + 1;
  calls.length = 0;
  await orchestrateSearch(input({ profile: tavilyOnly }), deps);
  assert.ok(calls.includes('tvly-work'), 'expired credential becomes eligible again');
});

test('cooldown state survives a new session over the same store', async () => {
  const store = createMemoryHealthStore();
  const { deps } = makeDeps({
    health: createHealthPort(store),
    search: async (target) => {
      if (target.alias === 'tvly-work') throw new Error('429 rate limit exceeded');
      return okResponse();
    }
  });
  await orchestrateSearch(input({ profile: tavilyOnly, sessionId: 's1' }), deps);

  const calls = [];
  const { deps: freshSession } = makeDeps({
    health: createHealthPort(store),
    search: async (target) => { calls.push(target.alias); return okResponse(); }
  });
  const result = await orchestrateSearch(input({ profile: tavilyOnly, sessionId: 's2' }), freshSession);

  assert.equal(result.alias, 'tvly-personal');
  assert.deepEqual(calls, ['tvly-personal']);
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

// --- Threshold demotion (ticket 08) ---

const thresholdConfig = parseConfig(
  {
    defaultProfile: 'exa-pair',
    profiles: {
      'exa-pair': { providers: ['exa'] },
      'tvly-solo': { providers: ['tavily'] }
    },
    credentials: {
      exa: [
        { alias: 'exa-fresh', env: 'EXA_FRESH' },
        { alias: 'exa-crossed', env: 'EXA_CROSSED', threshold: 2 }
      ],
      tavily: [{ alias: 'tvly-solo', env: 'TVLY_SOLO', threshold: 1 }],
      brave: []
    }
  },
  'test.json'
);
const thresholdEnv = { EXA_FRESH: 'fresh-secret', EXA_CROSSED: 'crossed-secret', TVLY_SOLO: 'solo-secret' };
const exaPair = { name: 'exa-pair', providers: ['exa'] };
const tvlySolo = { name: 'tvly-solo', providers: ['tavily'] };

function thresholdDeps(attemptsByAlias, overrides = {}) {
  return makeDeps({
    resolveCredentials: (cfg) => resolveCredentials(cfg.credentials, thresholdEnv),
    ledger: { attemptsByAlias: () => attemptsByAlias, record: () => {} },
    ...overrides
  });
}

test('a threshold-crossed credential is demoted behind a non-demoted peer in the same provider', async () => {
  // Without demotion exa-crossed (2 attempts) would lead exa-fresh (5 attempts).
  const { deps } = thresholdDeps({ 'exa-fresh': [NOW, NOW, NOW, NOW, NOW], 'exa-crossed': [NOW, NOW] });
  const calls = [];
  deps.search = async (target) => {
    calls.push(target.alias);
    return okResponse();
  };

  const result = await orchestrateSearch(input({ config: thresholdConfig, profile: exaPair }), deps);

  assert.equal(result.alias, 'exa-fresh');
  assert.deepEqual(calls, ['exa-fresh']);
});

test('a demoted credential is still used when it is the only candidate', async () => {
  const { deps } = thresholdDeps({ 'tvly-solo': [NOW] });
  const calls = [];
  deps.search = async (target) => {
    calls.push(target.alias);
    return okResponse();
  };

  const result = await orchestrateSearch(input({ config: thresholdConfig, profile: tvlySolo }), deps);

  assert.equal(result.alias, 'tvly-solo');
  assert.deepEqual(calls, ['tvly-solo']);
});

test('no configured threshold means no demotion and no warning', async () => {
  const plainConfig = parseConfig(
    {
      defaultProfile: 'solo',
      profiles: { solo: { providers: ['exa'] } },
      credentials: { exa: [{ alias: 'exa-plain', env: 'EXA_PLAIN' }] }
    },
    'test.json'
  );
  const crossings = [];
  const { deps } = makeDeps({
    resolveCredentials: (cfg) => resolveCredentials(cfg.credentials, { EXA_PLAIN: 'plain-secret' }),
    ledger: { attemptsByAlias: () => ({ 'exa-plain': [NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW] }), record: () => {} },
    onThresholdCrossings: (value) => crossings.push(...value)
  });

  const result = await orchestrateSearch(
    input({ config: plainConfig, profile: { name: 'solo', providers: ['exa'] } }),
    deps
  );

  assert.equal(result.alias, 'exa-plain');
  assert.deepEqual(crossings, [], 'no threshold configured, so no crossing is reported');
});

test('cooling beats demotion: a crossed-and-cooling credential is excluded, not merely demoted', async () => {
  const { deps } = thresholdDeps(
    { 'exa-crossed': [NOW, NOW] },
    { health: { penalties: () => ({ 'exa-crossed': 'cooling' }), record: () => {} } }
  );
  const calls = [];
  deps.search = async (target) => {
    calls.push(target.alias);
    throw new Error('401 unauthorized');
  };

  await assert.rejects(
    () => orchestrateSearch(input({ config: thresholdConfig, profile: exaPair }), deps),
    (err) => {
      assert.equal(err.name, 'SearchFailureError');
      assert.deepEqual(err.attempts.map((attempt) => attempt.alias), ['exa-fresh']);
      return true;
    }
  );
  assert.deepEqual(calls, ['exa-fresh'], 'the cooling credential is never attempted');
});

test('threshold crossings reach the edge warning sink, which deduplicates per period', async () => {
  const warner = createThresholdWarner();
  const warnings = [];
  let clock = NOW;
  let attempts = { 'tvly-solo': [NOW] };
  const { deps } = thresholdDeps(attempts, {
    now: () => clock,
    ledger: { attemptsByAlias: () => attempts, record: () => {} },
    onThresholdCrossings: (crossings) => warnings.push(...warner.warningsFor(crossings))
  });

  await orchestrateSearch(input({ config: thresholdConfig, profile: tvlySolo }), deps);
  await orchestrateSearch(input({ config: thresholdConfig, profile: tvlySolo }), deps);
  assert.equal(warnings.length, 1, 'repeat search in the same period warns once');
  assert.match(warnings[0], /"tvly-solo"/);

  clock = Date.UTC(2026, 10, 5, 12, 0, 0);
  attempts = { 'tvly-solo': [clock] };
  await orchestrateSearch(input({ config: thresholdConfig, profile: tvlySolo }), deps);
  assert.equal(warnings.length, 2, 'the next period warns again');
});

// --- AnySearch routing and accounting (ticket 01) ---

const anyConfig = parseConfig(
  {
    defaultProfile: 'any',
    profiles: { any: { providers: ['anysearch'] } },
    credentials: { anysearch: [{ alias: 'any-main', env: 'ANYSEARCH_API_KEY' }] }
  },
  'test.json'
);
const anyProfile = { name: 'any', providers: ['anysearch'] };

function anyDeps(overrides = {}) {
  return makeDeps({
    resolveCredentials: (cfg) => resolveCredentials(cfg.credentials, { ANYSEARCH_API_KEY: 'any-secret' }),
    ...overrides
  });
}

test('a successful AnySearch attempt records one request unit at zero estimated cost with the estimator identity', async () => {
  const { deps, recorded } = anyDeps();

  const result = await orchestrateSearch(input({ config: anyConfig, profile: anyProfile }), deps);

  assert.equal(result.provider, 'anysearch');
  assert.equal(result.alias, 'any-main');
  const attempt = recorded.find((event) => event.kind === 'attempt');
  assert.equal(attempt.outcome, 'success');
  assert.equal(attempt.units, 1);
  assert.equal(attempt.costUsd, 0);
  assert.equal(attempt.estimatorVersion, anyConfig.estimates.anysearch.version);
  assert.equal(attempt.estimatorDate, anyConfig.estimates.anysearch.date);
  // The first-party basis URL lives on the estimator rule the attempt was recorded from.
  assert.match(anyConfig.estimates.anysearch.basis, /anysearch\.com/);
});

test('a profile that omits anysearch never attempts an anysearch credential', async () => {
  const calls = [];
  const exaConfig = parseConfig(
    {
      defaultProfile: 'exa',
      profiles: { exa: { providers: ['exa'] } },
      credentials: {
        exa: [{ alias: 'exa-main', env: 'EXA_API_KEY' }],
        anysearch: [{ alias: 'any-main', env: 'ANYSEARCH_API_KEY' }]
      }
    },
    'test.json'
  );
  const { deps } = makeDeps({
    resolveCredentials: (cfg) =>
      resolveCredentials(cfg.credentials, { EXA_API_KEY: 'exa-secret', ANYSEARCH_API_KEY: 'any-secret' }),
    search: async (target) => {
      calls.push(target.provider);
      return okResponse();
    }
  });

  const result = await orchestrateSearch(
    input({ config: exaConfig, profile: { name: 'exa', providers: ['exa'] } }),
    deps
  );

  assert.equal(result.provider, 'exa');
  assert.deepEqual(calls, ['exa'], 'the configured anysearch credential is never attempted');
});

// --- AnySearch quota safety and fallback (ticket 02) ---

const QUOTA_CANARY = 'CANARY-anysearch-402-body-7b1e5c';

const quotaConfig = parseConfig(
  {
    defaultProfile: 'anyfirst',
    profiles: { anyfirst: { providers: ['anysearch', 'exa'] } },
    credentials: {
      anysearch: [{ alias: 'any-main', env: 'ANYSEARCH_API_KEY' }],
      exa: [{ alias: 'exa-main', env: 'EXA_API_KEY' }]
    }
  },
  'test.json'
);
const quotaProfile = { name: 'anyfirst', providers: ['anysearch', 'exa'] };
const quotaEnv = { ANYSEARCH_API_KEY: 'any-secret', EXA_API_KEY: 'exa-secret' };

function quotaDeps(overrides = {}) {
  return makeDeps({
    resolveCredentials: (cfg) => resolveCredentials(cfg.credentials, quotaEnv),
    ...overrides
  });
}

test('an AnySearch 402 records quota, cools the alias, and falls back to the next route in one request', async () => {
  const calls = [];
  const healthStore = createMemoryHealthStore();
  const { deps, recorded } = quotaDeps({
    health: createHealthPort(healthStore),
    search: async (target) => {
      calls.push(target.alias);
      if (target.provider === 'anysearch') {
        // The adapter's raw body never escapes; the structured error carries
        // only the safe request ID.
        throw new ProviderFailureError({ provider: 'anysearch', status: 402, requestId: 'req-402' });
      }
      return okResponse();
    }
  });

  const result = await orchestrateSearch(
    input({ config: quotaConfig, profile: quotaProfile }),
    deps
  );

  assert.deepEqual(calls, ['any-main', 'exa-main'], 'falls back within the same Search Request');
  assert.equal(result.provider, 'exa');
  assert.deepEqual(result.attempts, [
    { provider: 'anysearch', alias: 'any-main', error: 'anysearch request failed with HTTP 402 (quota) [request req-402]', errorCategory: 'quota' }
  ]);

  const anyAttempt = recorded.find((event) => event.kind === 'attempt' && event.provider === 'anysearch');
  assert.equal(anyAttempt.outcome, 'failure');
  assert.equal(anyAttempt.errorCategory, 'quota');
  assert.equal(anyAttempt.units, 1);
  const exaAttempt = recorded.find((event) => event.kind === 'attempt' && event.provider === 'exa');
  assert.equal(exaAttempt.outcome, 'success');

  const state = healthStore.read().state;
  assert.equal(state.cooldowns['any-main'].category, 'quota');
  assert.equal(state.cooldowns['any-main'].until, NOW + QUOTA_COOLDOWN_MS);

  // No surface may carry the raw body canary.
  assert.equal(JSON.stringify(result.attempts).includes(QUOTA_CANARY), false);
  assert.equal(JSON.stringify(recorded).includes(QUOTA_CANARY), false);
  assert.equal(JSON.stringify(state).includes(QUOTA_CANARY), false);
});

test('a quota-cooling AnySearch alias is excluded until exactly five minutes elapse, then eligible again', async () => {
  const healthStore = createMemoryHealthStore(
    enterCooldowns(emptyHealth(), [{ alias: 'any-main', errorCategory: 'quota' }], NOW)
  );

  async function callsAt(now) {
    const calls = [];
    const { deps } = quotaDeps({
      now: () => now,
      health: createHealthPort(healthStore),
      search: async (target) => {
        calls.push(target.alias);
        return okResponse();
      }
    });
    await orchestrateSearch(input({ config: quotaConfig, profile: quotaProfile }), deps);
    return calls;
  }

  assert.deepEqual(await callsAt(NOW), ['exa-main'], 'cooling immediately after the 402');
  assert.deepEqual(await callsAt(NOW + QUOTA_COOLDOWN_MS - 1), ['exa-main'], 'still cooling one ms before expiry');
  assert.deepEqual(await callsAt(NOW + QUOTA_COOLDOWN_MS), ['any-main'], 'eligible at exactly five minutes');
});

test('only a quota failure enters the five-minute window; auth failures still do not cool', async () => {
  const healthStore = createMemoryHealthStore();
  const { deps } = quotaDeps({
    health: createHealthPort(healthStore),
    search: async () => {
      throw new ProviderFailureError({ provider: 'anysearch', status: 401 });
    }
  });

  await assert.rejects(() => orchestrateSearch(input({ config: quotaConfig, profile: quotaProfile }), deps));

  const state = healthStore.read().state;
  assert.deepEqual(state.cooldowns, {}, 'an auth failure is a configuration problem, not a cooldown');
});