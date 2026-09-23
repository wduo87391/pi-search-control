import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANYSEARCH_CONTENT_MAX_CHARS,
  ANYSEARCH_MAX_RESULTS,
  ANYSEARCH_MIN_RESULTS,
  clampAnySearchResults,
  searchAnySearch
} from '../src/providers/anysearch.ts';
import { searchWithTarget } from '../src/search.ts';
import { normalizeResponse } from '../src/normalize.ts';
import { formatSearchMarkdown } from '../src/utils.ts';

const options = { numResults: 10, timeoutMs: 1000 };

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function stubFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return handler(input, init);
  };
  return calls;
}

const payload = {
  code: 0,
  message: 'success',
  request_id: '7d6f4e91-2a83-4c5b-9f10-6e8a3d27b541',
  data: {
    results: [
      {
        title: 'Go 1.26 Release Notes',
        url: 'https://go.dev/doc/go1.26',
        snippet: 'Introduction to the changes in Go 1.26.',
        content: 'Go 1.26 introduces changes to the language, toolchain, runtime, and libraries.'
      },
      { title: '', url: 'https://example.com/no-title', content: 'Only content here' },
      { title: 'Missing url is skipped' }
    ],
    metadata: { total_results: 3, search_time_ms: 312 }
  }
};

test('the adapter sends Bearer authentication and only query and max_results', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(payload));

  await searchAnySearch('go release notes', 'any-secret', options);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://api.anysearch.com/v1/search');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer any-secret');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ['max_results', 'query']);
  assert.equal(body.query, 'go release notes');
  assert.equal(body.max_results, 10);
});

test('requested result counts are clamped to the provider range', async (t) => {
  assert.equal(clampAnySearchResults(500), ANYSEARCH_MAX_RESULTS);
  assert.equal(clampAnySearchResults(0), ANYSEARCH_MIN_RESULTS);
  assert.equal(clampAnySearchResults(-3), ANYSEARCH_MIN_RESULTS);
  assert.equal(clampAnySearchResults(4), 4);
  assert.equal(ANYSEARCH_MIN_RESULTS, 1);
  assert.equal(ANYSEARCH_MAX_RESULTS, 10);

  const calls = stubFetch(t, () => jsonResponse(payload));
  await searchAnySearch('q', 'key', { ...options, numResults: 500 });
  assert.equal(JSON.parse(calls[0].init.body).max_results, 10);
  await searchAnySearch('q', 'key', { ...options, numResults: 0 });
  assert.equal(JSON.parse(calls[1].init.body).max_results, 1);
});

test('the adapter maps the common core and preserves AnySearch-only fields in extensions', async (t) => {
  stubFetch(t, () => jsonResponse(payload));

  const response = await searchAnySearch('q', 'key', options);

  assert.equal(response.answer, '');
  assert.equal(response.results.length, 2);

  assert.deepEqual(
    {
      title: response.results[0].title,
      url: response.results[0].url,
      snippet: response.results[0].snippet
    },
    {
      title: 'Go 1.26 Release Notes',
      url: 'https://go.dev/doc/go1.26',
      snippet: 'Introduction to the changes in Go 1.26.'
    }
  );
  assert.deepEqual(response.results[0].extension, {
    content: 'Go 1.26 introduces changes to the language, toolchain, runtime, and libraries.'
  });

  // An empty title falls back to the URL; content is never promoted into the
  // model-visible snippet, it stays in the extension.
  assert.equal(response.results[1].title, 'https://example.com/no-title');
  assert.equal(response.results[1].snippet, '');
  assert.deepEqual(response.results[1].extension, { content: 'Only content here' });

  assert.deepEqual(response.extension, {
    request_id: '7d6f4e91-2a83-4c5b-9f10-6e8a3d27b541',
    total_results: 3,
    search_time_ms: 312
  });
});

test('a response without metadata omits the response-level extension', async (t) => {
  stubFetch(t, () => jsonResponse({ code: 0, message: 'success', data: { results: [] } }));

  const response = await searchAnySearch('q', 'key', options);

  assert.equal(response.results.length, 0);
  assert.equal(response.extension, undefined);
});

test('preserved content is capped at the documented bound', async (t) => {
  const long = 'x'.repeat(ANYSEARCH_CONTENT_MAX_CHARS + 500);
  stubFetch(t, () => jsonResponse({
    code: 0,
    message: 'success',
    data: { results: [{ title: 't', url: 'https://example.com', snippet: 's', content: long }] }
  }));

  const response = await searchAnySearch('q', 'key', options);

  assert.equal(response.results[0].extension.content.length, ANYSEARCH_CONTENT_MAX_CHARS);
});

test('a non-2xx AnySearch response is surfaced as a failure', async (t) => {
  stubFetch(t, () => new Response('server exploded', { status: 500 }));

  await assert.rejects(() => searchAnySearch('q', 'key', options));
});

test('a malformed successful payload degrades to an empty response instead of throwing', async (t) => {
  stubFetch(t, () => jsonResponse({ code: 0, message: 'success' }));

  const response = await searchAnySearch('q', 'key', options);

  assert.deepEqual(response.results, []);
  assert.equal(response.extension, undefined);
});

test('normalization namespaces AnySearch extensions and markdown never renders them', async (t) => {
  stubFetch(t, () => jsonResponse(payload));

  const response = await searchAnySearch('q', 'key', options);
  const normalized = normalizeResponse('anysearch', response);

  assert.deepEqual(normalized.results[0].extension, {
    anysearch: {
      content: 'Go 1.26 introduces changes to the language, toolchain, runtime, and libraries.'
    }
  });
  assert.deepEqual(normalized.extension, {
    anysearch: {
      request_id: '7d6f4e91-2a83-4c5b-9f10-6e8a3d27b541',
      total_results: 3,
      search_time_ms: 312
    }
  });

  const markdown = formatSearchMarkdown('q', 'anysearch', 'any-main', normalized);
  assert.match(markdown, /Go 1\.26 Release Notes/);
  assert.ok(!markdown.includes('introduces changes to the language'), 'content must not leak into markdown');
  assert.ok(!markdown.includes('search_time_ms'), 'response extension keys must not leak into markdown');
});

test('an aborted request propagates the abort instead of being swallowed', async (t) => {
  const controller = new AbortController();
  stubFetch(t, (_input, init) => {
    if (init.signal?.aborted) {
      return Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    }
    return jsonResponse(payload);
  });
  controller.abort();

  await assert.rejects(
    () => searchAnySearch('q', 'key', { ...options, signal: controller.signal }),
    (err) => err.name === 'AbortError'
  );
});

test('the shared search dispatcher routes an anysearch target to the AnySearch adapter', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(payload));

  const response = await searchWithTarget(
    { provider: 'anysearch', alias: 'any-main', apiKey: 'any-secret' },
    'go release notes',
    options
  );

  assert.equal(calls[0].input, 'https://api.anysearch.com/v1/search');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer any-secret');
  assert.equal(response.results[0].url, 'https://go.dev/doc/go1.26');
});