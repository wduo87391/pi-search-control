import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DETAIL_RETENTION_MS,
  classifyError,
  createFileLedgerStore,
  createMemoryLedgerStore,
  emptyLedger,
  loadLedger,
  parseLedgerState,
  periodKey,
  pruneLedger,
  recordLedgerEvents,
  summarizeEvents,
  summarizePeriod
} from '../src/ledger.ts';
import { ProviderFailureError } from '../src/provider-failure.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0); // 2026-10-20T12:00:00Z

function request(at, overrides = {}) {
  return {
    kind: 'request',
    at,
    sessionId: 'session-a',
    requestId: 'req-1',
    profile: 'research',
    ...overrides
  };
}

function attempt(at, overrides = {}) {
  return {
    kind: 'attempt',
    at,
    sessionId: 'session-a',
    requestId: 'req-1',
    provider: 'exa',
    alias: 'exa-main',
    outcome: 'failure',
    units: 1,
    costUsd: 0.007,
    estimatorVersion: '1',
    estimatorDate: '2026-09-22',
    ...overrides
  };
}

test('one Search Request with three failed Provider Attempts counts as 1 request and 3 attempts', () => {
  const events = [
    request(NOW),
    attempt(NOW, { provider: 'exa', alias: 'exa-main' }),
    attempt(NOW, { provider: 'tavily', alias: 'tvly-work' }),
    attempt(NOW, { provider: 'brave', alias: 'brave-main' })
  ];
  const summary = summarizeEvents(events);
  assert.equal(summary.requests, 1);
  assert.equal(summary.attempts, 3);
  assert.equal(summary.failure, 3);
  assert.equal(summary.success, 0);
});

test('attempts are grouped by provider and by credential alias', () => {
  const events = [
    request(NOW),
    attempt(NOW, { provider: 'tavily', alias: 'tvly-work', outcome: 'failure' }),
    attempt(NOW, { provider: 'tavily', alias: 'tvly-work', outcome: 'success', costUsd: 0 }),
    attempt(NOW, { provider: 'brave', alias: 'brave-main', outcome: 'success', units: 1, costUsd: 0.005 })
  ];
  const summary = summarizeEvents(events);
  assert.equal(summary.byProvider.tavily.attempts, 2);
  assert.equal(summary.byProvider.tavily.success, 1);
  assert.equal(summary.byProvider.tavily.failure, 1);
  assert.equal(summary.byProvider.brave.attempts, 1);
  assert.equal(summary.byAlias['tvly-work'].attempts, 2);
  assert.equal(summary.byAlias['brave-main'].success, 1);
  assert.equal(summary.byAlias['brave-main'].costUsd, 0.005);
});

test('the session filter reports only the current session', () => {
  const events = [
    request(NOW, { sessionId: 'session-a' }),
    request(NOW, { sessionId: 'session-b', requestId: 'req-2' }),
    attempt(NOW, { sessionId: 'session-b', requestId: 'req-2' })
  ];
  const summary = summarizeEvents(events, { sessionId: 'session-a' });
  assert.equal(summary.requests, 1);
  assert.equal(summary.attempts, 0);
});

test('period summaries count only events inside the period containing now', () => {
  const today = Date.UTC(2026, 9, 20, 8, 0, 0);
  const yesterday = Date.UTC(2026, 9, 19, 8, 0, 0);
  const events = [request(today), attempt(today), request(yesterday), attempt(yesterday)];
  assert.equal(summarizePeriod(events, NOW, 'daily').attempts, 1);
  assert.equal(summarizePeriod(events, NOW, 'monthly').attempts, 2);
  assert.equal(periodKey(today, 'daily'), '2026-10-20');
  assert.equal(periodKey(today, 'monthly'), '2026-10');
});

test('an event exactly 30 days old is kept; a strictly older one is pruned', () => {
  const boundary = request(NOW - DETAIL_RETENTION_MS);
  const older = attempt(NOW - DETAIL_RETENTION_MS - 1);
  const pruned = pruneLedger({ version: 1, events: [boundary, older], buckets: [] }, NOW);
  assert.equal(pruned.events.length, 1);
  assert.equal(pruned.events[0].kind, 'request');
});

test('pruning drops per-attempt detail but keeps the aggregate', () => {
  const old = attempt(NOW - DETAIL_RETENTION_MS - DAY, {
    provider: 'brave',
    alias: 'brave-main',
    outcome: 'success',
    units: 1,
    costUsd: 0.005
  });
  const recent = request(NOW);
  const state = { version: 1, events: [old, recent], buckets: [] };
  const pruned = pruneLedger(state, NOW);
  assert.deepEqual(pruned.events, [recent]);

  const daily = pruned.buckets.find((bucket) => bucket.granularity === 'daily');
  assert.ok(daily);
  assert.equal(daily.attempts, 1);
  assert.equal(daily.byAlias['brave-main'].success, 1);
  assert.equal(daily.costUsd, 0.005);
  assert.equal(periodKey(old.at, 'daily'), daily.period);
});

test('a memory store round-trips the ledger through the injected persistence seam', () => {
  const store = createMemoryLedgerStore();
  const events = [request(NOW), attempt(NOW)];
  recordLedgerEvents(store, events, NOW);
  const read = loadLedger(store, NOW);
  assert.equal(read.warning, undefined);
  assert.deepEqual(read.state.events, events);
  // Recent detail stays as events; long-term buckets only fill on pruning.
  assert.deepEqual(read.state.buckets, []);
});

test('a file store writes and reads back the ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-ledger-'));
  try {
    const path = join(dir, 'nested', 'ledger.json');
    const store = createFileLedgerStore(path);
    const events = [request(NOW), attempt(NOW, { provider: 'tavily', alias: 'tvly-work' })];
    recordLedgerEvents(store, events, NOW);

    const reread = createFileLedgerStore(path);
    const read = loadLedger(reread, NOW);
    assert.equal(read.warning, undefined);
    assert.deepEqual(read.state.events, events);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing ledger file is treated as an empty ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-ledger-'));
  try {
    const read = createFileLedgerStore(join(dir, 'absent.json')).read();
    assert.equal(read.warning, undefined);
    assert.deepEqual(read.state, emptyLedger());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt ledger file degrades to an empty ledger with a visible warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-ledger-'));
  try {
    const path = join(dir, 'ledger.json');
    writeFileSync(path, '{ this is not json', 'utf8');
    const read = createFileLedgerStore(path).read();
    assert.match(read.warning, /unreadable/);
    assert.deepEqual(read.state, emptyLedger());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a structurally invalid ledger document degrades to an empty ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-ledger-'));
  try {
    const path = join(dir, 'ledger.json');
    writeFileSync(path, JSON.stringify({ version: 1, events: [{ kind: 'mystery' }] }), 'utf8');
    const read = createFileLedgerStore(path).read();
    assert.match(read.warning, /unreadable/);
    assert.deepEqual(read.state, emptyLedger());
    assert.throws(() => parseLedgerState({ version: 2, events: [] }), /unsupported ledger version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persisted ledger state never contains the search query text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psc-ledger-'));
  const secretQuery = 'how-to-rotate-my-super-secret-query-9f3a';
  try {
    const path = join(dir, 'ledger.json');
    const store = createFileLedgerStore(path);
    recordLedgerEvents(store, [request(NOW), attempt(NOW)], NOW);
    const persisted = readFileSync(path, 'utf8');
    assert.equal(persisted.includes(secretQuery), false);
    assert.equal(JSON.stringify(store.read().state).includes(secretQuery), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ledger event shape carries no query field', () => {
  const event = attempt(NOW);
  assert.equal('query' in event, false);
  assert.equal('queries' in event, false);
});

test('the ledger accepts and round-trips the quota error category', () => {
  const state = parseLedgerState({
    version: 1,
    events: [attempt(NOW, { provider: 'anysearch', alias: 'any-main', errorCategory: 'quota' })],
    buckets: []
  });
  assert.equal(state.events[0].errorCategory, 'quota');
  assert.equal(summarizeEvents(state.events).failure, 1);
});

test('the ledger still rejects an unknown error category', () => {
  assert.throws(
    () => parseLedgerState({ version: 1, events: [attempt(NOW, { errorCategory: 'mystery' })], buckets: [] }),
    /invalid errorCategory/
  );
});

test('a structured provider failure keeps its own category instead of re-deriving from text', () => {
  assert.equal(classifyError(new ProviderFailureError({ provider: 'anysearch', status: 402 })), 'quota');
  assert.equal(classifyError(new ProviderFailureError({ provider: 'anysearch', status: 401 })), 'auth');
  assert.equal(classifyError(new ProviderFailureError({ provider: 'anysearch', status: 403 })), 'auth');
  assert.equal(classifyError(new ProviderFailureError({ provider: 'anysearch', status: 429 })), 'rate_limit');
  assert.equal(classifyError(new ProviderFailureError({ provider: 'anysearch', status: 503 })), 'service');
  assert.equal(classifyError(new ProviderFailureError({ provider: 'anysearch', status: 418 })), 'unknown');
});

test('a quota failure is never misclassified by response-body text', () => {
  const err = new ProviderFailureError({ provider: 'anysearch', status: 402, requestId: 'req-1' });
  assert.equal(classifyError(err), 'quota');
});