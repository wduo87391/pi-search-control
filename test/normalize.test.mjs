import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResponse } from '../src/normalize.ts';
import { formatSearchMarkdown } from '../src/utils.ts';
import { searchExa } from '../src/providers/exa.ts';
import { searchTavily } from '../src/providers/tavily.ts';
import { searchBrave } from '../src/providers/brave.ts';

const options = { numResults: 10, timeoutMs: 1000 };

function stubFetch(t, body) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('every successful result exposes the common core plus provider identity', () => {
  const normalized = normalizeResponse('exa', {
    answer: 'an answer',
    results: [{ title: 'Title', url: 'https://example.com/a', snippet: 'A snippet' }]
  });

  assert.equal(normalized.provider, 'exa');
  assert.equal(normalized.answer, 'an answer');
  assert.equal(normalized.results.length, 1);
  assert.deepEqual(
    {
      title: normalized.results[0].title,
      url: normalized.results[0].url,
      snippet: normalized.results[0].snippet,
      provider: normalized.results[0].provider
    },
    { title: 'Title', url: 'https://example.com/a', snippet: 'A snippet', provider: 'exa' }
  );
});

test('a provider response without extension data yields no extension field', () => {
  const normalized = normalizeResponse('tavily', {
    answer: '',
    results: [{ title: 't', url: 'https://example.com', snippet: 's' }]
  });

  assert.equal(normalized.results[0].extension, undefined);
  assert.equal(normalized.extension, undefined);
});

test('Exa highlights are preserved under the exa namespace after normalization', async (t) => {
  stubFetch(t, {
    results: [
      { title: 'Exa', url: 'https://exa.ai', text: 'full text', highlights: ['first highlight', 'second highlight'] }
    ]
  });

  const response = await searchExa('q', 'key', options);
  const normalized = normalizeResponse('exa', response);

  assert.deepEqual(normalized.results[0].extension, {
    exa: { highlights: ['first highlight', 'second highlight'] }
  });
});

test("Tavily's per-result score is preserved under the tavily namespace", async (t) => {
  stubFetch(t, {
    answer: 'tavily answer',
    results: [{ title: 'Tavily', url: 'https://tavily.com', content: 'content', score: 0.87 }]
  });

  const response = await searchTavily('q', 'key', options);
  const normalized = normalizeResponse('tavily', response);

  assert.equal(normalized.answer, 'tavily answer');
  assert.deepEqual(normalized.results[0].extension, { tavily: { score: 0.87 } });
});

test("Brave's snippets, age, and hostname are preserved under the brave namespace", async (t) => {
  stubFetch(t, {
    grounding: {
      generic: [{ title: 'Brave', url: 'https://brave.com', snippets: ['one', 'two'] }]
    },
    sources: { 'https://brave.com': { title: 'Brave', hostname: 'brave.com', age: '3 days ago' } }
  });

  const response = await searchBrave('q', 'key', options);
  const normalized = normalizeResponse('brave', response);

  assert.deepEqual(normalized.results[0].extension, {
    brave: { snippets: ['one', 'two'], age: '3 days ago', hostname: 'brave.com' }
  });
});

test('model-visible markdown carries only the common core, never the extension payload', async (t) => {
  stubFetch(t, {
    grounding: {
      generic: [{ title: 'Brave', url: 'https://brave.com', snippets: ['one', 'two'] }]
    },
    sources: { 'https://brave.com': { hostname: 'brave.com', age: '3 days ago' } }
  });

  const response = await searchBrave('q', 'key', options);
  const normalized = normalizeResponse('brave', response);
  const markdown = formatSearchMarkdown('q', 'brave', 'brave-main', normalized);

  assert.match(markdown, /Brave/);
  assert.match(markdown, /https:\/\/brave\.com/);
  assert.ok(!markdown.includes('3 days ago'), 'markdown must not include the age extension value');
  assert.ok(!markdown.includes('"extension"'), 'markdown must not include the extension structure');
  assert.ok(!markdown.includes('hostname'), 'markdown must not include extension keys');
});