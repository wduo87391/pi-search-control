import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { buildStatusSnapshot, formatStatusText, periodLabel } from '../src/status.ts';
import { DETAIL_RETENTION_MS, pruneLedger } from '../src/ledger.ts';
import { emptyHealth, enterCooldowns } from '../src/health.ts';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0); // 2026-10-20T12:00:00Z
const DAY = 24 * 60 * 60 * 1000;

const RAW = {
  defaultProfile: 'research',
  profiles: {
    research: { providers: ['exa', 'tavily'] },
    braveOnly: { providers: ['brave'] }
  },
  credentials: {
    exa: [{ alias: 'exa-main', env: 'EXA_KEY' }],
    tavily: [
      { alias: 'tvly-work', env: 'TVLY_WORK' },
      { alias: 'tvly-personal', env: 'TVLY_PERSONAL' }
    ],
    brave: [{ alias: 'brave-main', env: 'BRAVE_KEY' }]
  }
};

const ENV = { EXA_KEY: 'a', TVLY_WORK: 'b', TVLY_PERSONAL: 'c', BRAVE_KEY: 'd' };

function emptyLedger() {
  return { version: 1, events: [], buckets: [] };
}

function request(at, sessionId = 's1', profile = 'research') {
  return { kind: 'request', at, sessionId, requestId: `r-${at}`, profile };
}

function attempt(at, provider, alias, outcome = 'success', units = 1, sessionId = 's1') {
  const event = {
    kind: 'attempt', at, sessionId, requestId: `r-${at}`, provider, alias, outcome, units, costUsd: 0,
    estimatorVersion: '1', estimatorDate: '2026-09-22'
  };
  if (outcome === 'failure') event.errorCategory = 'service';
  return event;
}

function build(overrides = {}) {
  const config = 'config' in overrides ? overrides.config : parseConfig(RAW, 'test.json');
  const env = overrides.env ?? ENV;
  return buildStatusSnapshot({
    now: NOW,
    sessionId: 's1',
    config,
    credentials: config ? resolveCredentials(config.credentials, env) : [],
    ledger: emptyLedger(),
    health: emptyHealth(),
    ...overrides
  });
}

test('a ready snapshot reports every supported provider and its profile membership', () => {
  const snapshot = build();
  assert.equal(snapshot.kind, 'ready');
  assert.deepEqual(snapshot.providers.map((provider) => provider.provider), ['exa', 'tavily', 'brave', 'anysearch']);
  assert.equal(snapshot.overview.profileName, 'research');
  assert.deepEqual(snapshot.overview.providerOrder, ['exa', 'tavily']);
  assert.equal(snapshot.overview.usableRoute, true);

  const exa = snapshot.providers.find((provider) => provider.provider === 'exa');
  assert.equal(exa.inProfile, true);
  assert.equal(exa.routeUsable, true);
  assert.equal(exa.configurationUnavailable, false);

  const brave = snapshot.providers.find((provider) => provider.provider === 'brave');
  assert.equal(brave.inProfile, false);
  assert.equal(brave.routeUsable, false);
  assert.equal(brave.credentials[0].alias, 'brave-main');
  assert.equal(brave.credentials[0].allowance, undefined, 'no allowance means unknown, not a guessed figure');
});

test('an unavailable-only profile reports No usable route', () => {
  const snapshot = build({ env: {} });
  assert.equal(snapshot.overview.usableRoute, false);
  const tavily = snapshot.providers.find((provider) => provider.provider === 'tavily');
  assert.equal(tavily.routeUsable, false);
  assert.ok(tavily.credentials.every((credential) => !credential.available && !credential.eligible));
  assert.match(formatStatusText(snapshot), /Route: No usable route/);
});

test('a cooldown-only profile reports No usable route and the cooldown cause', () => {
  const health = enterCooldowns(
    emptyHealth(),
    [
      { alias: 'exa-main', errorCategory: 'rate_limit' },
      { alias: 'tvly-work', errorCategory: 'quota' },
      { alias: 'tvly-personal', errorCategory: 'quota' }
    ],
    NOW
  );
  const snapshot = build({ health });
  assert.equal(snapshot.overview.usableRoute, false);
  const exa = snapshot.providers.find((provider) => provider.provider === 'exa');
  assert.equal(exa.credentials[0].eligible, false);
  assert.equal(exa.credentials[0].cooldown.category, 'rate_limit');
  assert.match(formatStatusText(snapshot), /cooling \(rate_limit\)/);
});

test('a mixed unavailable and cooling profile reports No usable route', () => {
  const health = enterCooldowns(emptyHealth(), [{ alias: 'tvly-work', errorCategory: 'quota' }], NOW);
  const snapshot = build({ env: { TVLY_WORK: 'b' }, health });
  assert.equal(snapshot.overview.usableRoute, false);
  const tavily = snapshot.providers.find((provider) => provider.provider === 'tavily');
  const work = tavily.credentials.find((credential) => credential.alias === 'tvly-work');
  const personal = tavily.credentials.find((credential) => credential.alias === 'tvly-personal');
  assert.equal(work.available, true);
  assert.equal(work.eligible, false);
  assert.equal(personal.available, false);
});

test('a threshold-demoted credential keeps the route usable', () => {
  const config = parseConfig(
    {
      defaultProfile: 'research',
      profiles: { research: { providers: ['exa'] } },
      credentials: { exa: [{ alias: 'exa-main', env: 'EXA_KEY', threshold: 1 }] }
    },
    'test.json'
  );
  const ledger = { version: 1, events: [request(NOW), attempt(NOW, 'exa', 'exa-main')], buckets: [] };
  const snapshot = build({ config, ledger });
  const exa = snapshot.providers.find((provider) => provider.provider === 'exa');
  assert.equal(snapshot.overview.usableRoute, true);
  assert.equal(exa.credentials[0].demoted, true);
  assert.equal(exa.credentials[0].eligible, true);
  assert.match(formatStatusText(snapshot), /threshold 1 \(1 attempts this period\), demoted/);
});

test('a configured provider outside the active profile is not a usable route', () => {
  const snapshot = build({ activeProfileName: 'braveOnly' });
  assert.deepEqual(snapshot.overview.providerOrder, ['brave']);
  assert.equal(snapshot.overview.usableRoute, true);
  const brave = snapshot.providers.find((provider) => provider.provider === 'brave');
  assert.equal(brave.routeUsable, true);
  const exa = snapshot.providers.find((provider) => provider.provider === 'exa');
  assert.equal(exa.inProfile, false);
  assert.equal(exa.routeUsable, false);
});

test('a research profile with no usable Exa/Tavily route becomes usable only once AnySearch is both configured and added to the profile', () => {
  const credentials = {
    exa: [{ alias: 'exa-main', env: 'EXA_KEY' }],
    tavily: [{ alias: 'tvly-work', env: 'TVLY_WORK' }],
    anysearch: [{ alias: 'any-main', env: 'ANY_KEY' }]
  };
  // Exa and Tavily credentials are unset; the AnySearch credential is set but
  // AnySearch is not yet part of the research profile.
  const withoutAnySearch = build({
    config: parseConfig(
      {
        defaultProfile: 'research',
        profiles: { research: { providers: ['exa', 'tavily'] } },
        credentials
      },
      'test.json'
    ),
    env: { ANY_KEY: 'z' }
  });
  assert.equal(withoutAnySearch.overview.usableRoute, false);
  assert.match(formatStatusText(withoutAnySearch), /Route: No usable route/);
  const anyOutside = withoutAnySearch.providers.find((provider) => provider.provider === 'anysearch');
  assert.equal(anyOutside.inProfile, false);
  assert.equal(anyOutside.routeUsable, false, 'a configured credential alone is not a usable route');

  // The same credential becomes a usable route only after AnySearch is added.
  const withAnySearch = build({
    config: parseConfig(
      {
        defaultProfile: 'research',
        profiles: { research: { providers: ['exa', 'tavily', 'anysearch'] } },
        credentials
      },
      'test.json'
    ),
    env: { ANY_KEY: 'z' }
  });
  assert.equal(withAnySearch.overview.usableRoute, true);
  const anyInside = withAnySearch.providers.find((provider) => provider.provider === 'anysearch');
  assert.equal(anyInside.inProfile, true);
  assert.equal(anyInside.routeUsable, true);
  assert.match(formatStatusText(withAnySearch), /Route: usable/);
});

test('allowance precedence, provider default, and floor-at-zero remaining', () => {
  const config = parseConfig(
    {
      defaultProfile: 'any',
      profiles: { any: { providers: ['anysearch'] } },
      credentials: {
        anysearch: [
          { alias: 'any-default', env: 'ANY1' },
          { alias: 'any-promo', env: 'ANY2', allowance: { units: 10, period: { kind: 'calendar-day' } } }
        ]
      }
    },
    'test.json'
  );
  const events = [request(NOW)];
  for (let i = 0; i < 12; i++) events.push(attempt(NOW, 'anysearch', 'any-promo'));
  for (let i = 0; i < 3; i++) events.push(attempt(NOW, 'anysearch', 'any-default'));
  const snapshot = build({ config, env: { ANY1: 'a', ANY2: 'b' }, ledger: { version: 1, events, buckets: [] } });

  const anysearch = snapshot.providers.find((provider) => provider.provider === 'anysearch');
  const promo = anysearch.credentials.find((credential) => credential.alias === 'any-promo');
  assert.equal(promo.allowance.source, 'credential');
  assert.equal(promo.allowance.units, 10);
  assert.equal(promo.allowance.estimatedUsed, 12);
  assert.equal(promo.allowance.estimatedRemaining, 0);

  const providerDefault = anysearch.credentials.find((credential) => credential.alias === 'any-default');
  assert.equal(providerDefault.allowance.source, 'provider-default');
  assert.equal(providerDefault.allowance.units, 1000);
  assert.equal(providerDefault.allowance.estimatedRemaining, 997);

  const exa = snapshot.providers.find((provider) => provider.provider === 'exa');
  assert.equal(exa.credentials.length, 0, 'the anysearch-only config declares no exa credential');
  assert.match(formatStatusText(snapshot), /10 units used \(calendar-day, 0 remaining\) \[estimate\]/);
});

test('a rolling-days allowance is unknown when its window reaches before retention', () => {
  const config = parseConfig(
    {
      defaultProfile: 'any',
      profiles: { any: { providers: ['anysearch'] } },
      credentials: {
        anysearch: [{ alias: 'any-roll', env: 'ANY', allowance: { units: 100, period: { kind: 'rolling-days', days: 40 } } }]
      }
    },
    'test.json'
  );
  const events = [request(NOW), attempt(NOW, 'anysearch', 'any-roll')];
  const snapshot = build({ config, env: { ANY: 'a' }, ledger: { version: 1, events, buckets: [] } });
  const credential = snapshot.providers.find((provider) => provider.provider === 'anysearch').credentials[0];
  assert.equal(credential.allowance.coverage, 'unknown');
  assert.equal(credential.allowance.estimatedRemaining, undefined);
  assert.equal(credential.allowance.estimatedUsed, 1);
  assert.match(formatStatusText(snapshot), /remaining unknown/);
});

test('a rolling-days allowance within retention is complete', () => {
  const config = parseConfig(
    {
      defaultProfile: 'any',
      profiles: { any: { providers: ['anysearch'] } },
      credentials: {
        anysearch: [{ alias: 'any-roll', env: 'ANY', allowance: { units: 100, period: { kind: 'rolling-days', days: 5 } } }]
      }
    },
    'test.json'
  );
  const events = [request(NOW), attempt(NOW, 'anysearch', 'any-roll')];
  const snapshot = build({ config, env: { ANY: 'a' }, ledger: { version: 1, events, buckets: [] } });
  const credential = snapshot.providers.find((provider) => provider.provider === 'anysearch').credentials[0];
  assert.equal(credential.allowance.coverage, 'complete');
  assert.equal(credential.allowance.estimatedRemaining, 99);
});

test('current-month totals combine retained events and compacted buckets without double counting', () => {
  const ledger = {
    version: 1,
    events: [request(NOW), attempt(NOW, 'exa', 'exa-main')],
    buckets: [
      {
        granularity: 'monthly', period: '2026-10', requests: 2, attempts: 3, success: 2, failure: 1, units: 3, costUsd: 0,
        byProvider: { tavily: { attempts: 3, success: 2, failure: 1, units: 3, costUsd: 0 } },
        byAlias: { 'tvly-work': { attempts: 3, success: 2, failure: 1, units: 3, costUsd: 0 } }
      },
      {
        granularity: 'daily', period: '2026-10-20', requests: 1, attempts: 1, success: 1, failure: 0, units: 1, costUsd: 0,
        byProvider: { brave: { attempts: 1, success: 1, failure: 0, units: 1, costUsd: 0 } },
        byAlias: { 'brave-main': { attempts: 1, success: 1, failure: 0, units: 1, costUsd: 0 } }
      }
    ]
  };
  const snapshot = build({ ledger });
  assert.equal(snapshot.overview.month.requests, 3);
  assert.equal(snapshot.overview.month.attempts, 4);
  assert.equal(snapshot.overview.month.success, 3);
  assert.equal(snapshot.overview.month.failure, 1);
  assert.equal(snapshot.overview.day.requests, 2);
  assert.equal(snapshot.overview.day.attempts, 2);
  assert.equal(snapshot.overview.session.requests, 1);
  assert.equal(snapshot.overview.session.attempts, 1);

  const tavily = snapshot.providers.find((provider) => provider.provider === 'tavily');
  assert.equal(tavily.month.attempts, 3);
  const brave = snapshot.providers.find((provider) => provider.provider === 'brave');
  assert.equal(brave.day.attempts, 1);
  const exa = snapshot.providers.find((provider) => provider.provider === 'exa');
  assert.equal(exa.month.attempts, 1);
});

test('a session older than the retention horizon is marked partial', () => {
  const partial = build({ sessionStartedAt: NOW - DETAIL_RETENTION_MS - DAY });
  assert.equal(partial.overview.sessionPartial, true);
  assert.match(formatStatusText(partial), /partial: session began before the 30-day detail-retention horizon/);

  const fresh = build({ sessionStartedAt: NOW - DAY });
  assert.equal(fresh.overview.sessionPartial, false);
});

test('quota condition is active only while a quota cooldown is active', () => {
  const health = enterCooldowns(emptyHealth(), [{ alias: 'tvly-work', errorCategory: 'quota' }], NOW);
  const active = build({ health });
  assert.equal(active.overview.quotaCondition, true);
  assert.match(formatStatusText(active), /Quota condition: active \(observed quota cooldown; not provider-authoritative\)/);

  const config = parseConfig(RAW, 'test.json');
  const expired = buildStatusSnapshot({
    now: NOW + 5 * 60 * 1000 + 1,
    sessionId: 's1',
    config,
    credentials: resolveCredentials(config.credentials, ENV),
    ledger: emptyLedger(),
    health
  });
  assert.equal(expired.overview.quotaCondition, false);
});

test('a quota cooldown on an out-of-profile credential does not raise the Overview banner', () => {
  const health = enterCooldowns(emptyHealth(), [{ alias: 'brave-main', errorCategory: 'quota' }], NOW);
  const snapshot = build({ health });
  assert.equal(snapshot.overview.quotaCondition, false);
  // The provider page still reports the cooldown for its own credential.
  const brave = snapshot.providers.find((provider) => provider.provider === 'brave');
  assert.equal(brave.credentials[0].cooldown.category, 'quota');
});

test('a pruned ledger feeds complete month totals without double counting', () => {
  // Late in the month, so the retention cutoff (now - 30 days) falls after the
  // first of the month and early-month detail has already been pruned away.
  const LATE = Date.UTC(2026, 9, 31, 12, 0, 0);
  const earlyThisMonth = Date.UTC(2026, 9, 1, 0, 0, 0);
  const pruned = pruneLedger(
    {
      version: 1,
      events: [
        request(earlyThisMonth),
        attempt(earlyThisMonth, 'exa', 'exa-main'),
        request(LATE),
        attempt(LATE, 'exa', 'exa-main')
      ],
      buckets: []
    },
    LATE
  );
  // The 2026-10-01 event left `events` and was folded into a monthly bucket.
  assert.equal(pruned.events.length, 2);
  assert.ok(pruned.buckets.some((bucket) => bucket.granularity === 'monthly' && bucket.period === '2026-10'));

  const config = parseConfig(RAW, 'test.json');
  const snapshot = buildStatusSnapshot({
    now: LATE,
    sessionId: 's1',
    config,
    credentials: resolveCredentials(config.credentials, ENV),
    ledger: pruned,
    health: emptyHealth()
  });
  // Both the retained event and the bucket are counted exactly once.
  assert.equal(snapshot.overview.month.requests, 2);
  assert.equal(snapshot.overview.month.attempts, 2);
});

test('a missing configuration yields a safe, navigable configuration-error snapshot', () => {
  const snapshot = buildStatusSnapshot({
    now: NOW,
    sessionId: 's1',
    config: undefined,
    configError: 'Missing profiles in test.json.',
    credentials: [],
    ledger: emptyLedger(),
    health: emptyHealth()
  });
  assert.equal(snapshot.kind, 'config-error');
  assert.equal(snapshot.overview.usableRoute, false);
  assert.equal(snapshot.providers.length, 4);
  assert.ok(snapshot.providers.every((provider) => provider.configurationUnavailable && provider.credentials.length === 0));
  const text = formatStatusText(snapshot);
  assert.match(text, /Configuration unavailable/);
  assert.match(text, /Warning: Missing profiles in test\.json\./);
  assert.match(text, /- exa: configuration unavailable/);
});

test('the text formatter labels estimates and never implies provider-authoritative balances', () => {
  const snapshot = build();
  const text = formatStatusText(snapshot);
  assert.match(text, /Route: usable/);
  assert.match(text, /Overview:/);
  assert.match(text, /This session: 0 Search Requests, 0 Provider Attempts \(0 succeeded, 0 failed\)/);
  assert.match(text, /estimate: 1 requests .*\[estimate; rule v1/);
  assert.ok(!text.includes('WIRING_EXA_KEY') && !text.includes('EXA_KEY'));
});

test('periodLabel renders each usage period kind', () => {
  assert.equal(periodLabel({ kind: 'calendar-day' }), 'calendar-day');
  assert.equal(periodLabel({ kind: 'calendar-month' }), 'calendar-month');
  assert.equal(periodLabel({ kind: 'rolling-days', days: 7 }), 'rolling 7 days');
});