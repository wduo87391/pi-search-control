import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANYSEARCH_CONTENT_MAX_CHARS,
  ANYSEARCH_MAX_RESULTS,
  ANYSEARCH_MIN_RESULTS,
  clampAnySearchResults,
  sanitizeRequestId,
  searchAnySearch
} from '../src/providers/anysearch.ts';
import { ProviderFailureError } from '../src/provider-failure.ts';
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

test('a 2xx body that is not JSON throws a local error and never surfaces the raw body', async (t) => {
  const canary = 'CANARY-anysearch-200-body-9c3f1a';
  stubFetch(t, () => new Response(`<html>${canary}</html>`, { status: 200 }));

  await assert.rejects(
    () => searchAnySearch('q', 'key', options),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message.includes(canary), false, 'raw 2xx body leaked into the message');
      assert.match(err.message, /unreadable response body/);
      return true;
    }
  );
});

test('a 2xx body that is valid JSON but not an object throws a local error', async (t) => {
  stubFetch(t, () => new Response('null', { status: 200 }));

  await assert.rejects(
    () => searchAnySearch('q', 'key', options),
    (err) => {
      assert.match(err.message, /unreadable response body/);
      return true;
    }
  );
});

test('a success-path request_id that is not allowlisted is dropped', async (t) => {
  stubFetch(t, () => jsonResponse({ code: 0, request_id: 'evil value <script>', data: { results: [] } }));

  const response = await searchAnySearch('q', 'key', options);

  assert.equal(response.extension, undefined, 'a non-allowlisted request_id must not reach the extension');
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

// --- Sensitive error bodies -------------------------------------------------
// Every non-2xx class carries a unique secret canary. The canary stands in for
// the generated credentials a real 402 body can contain; it must never reach a
// thrown message, structured field, ledger event, or health entry.

const CANARY = 'CANARY-anysearch-error-body-4f7c9a2e';

for (const [status, category] of [
  [400, 'unknown'],
  [401, 'auth'],
  [402, 'quota'],
  [403, 'auth'],
  [429, 'rate_limit'],
  [500, 'service'],
  [503, 'service']
]) {
  test(`a ${status} response is reduced to allowlisted fields (${category}) and never exposes the body`, async (t) => {
    stubFetch(t, () => new Response(
      JSON.stringify({ code: status, message: CANARY, request_id: 'req-abc-123', data: { secret: CANARY } }),
      { status, headers: { 'Content-Type': 'application/json' } }
    ));

    await assert.rejects(
      () => searchAnySearch('q', 'key', options),
      (err) => {
        assert.ok(err instanceof ProviderFailureError, 'a structured provider failure is thrown');
        assert.equal(err.status, status);
        assert.equal(err.category, category);
        assert.equal(err.requestId, 'req-abc-123');
        assert.equal(err.message.includes(CANARY), false, `canary leaked into the message for ${status}`);
        assert.equal(JSON.stringify({ status: err.status, category: err.category, requestId: err.requestId }).includes(CANARY), false);
        return true;
      }
    );
  });
}

test('a non-JSON error body yields no request ID and leaks nothing', async (t) => {
  stubFetch(t, () => new Response(`<html>${CANARY}</html>`, { status: 402 }));

  await assert.rejects(
    () => searchAnySearch('q', 'key', options),
    (err) => {
      assert.ok(err instanceof ProviderFailureError);
      assert.equal(err.status, 402);
      assert.equal(err.category, 'quota');
      assert.equal(err.requestId, undefined);
      assert.equal(err.message.includes(CANARY), false);
      return true;
    }
  );
});

test('a request_id that is not allowlisted is dropped rather than surfaced', async (t) => {
  stubFetch(t, () => new Response(
    JSON.stringify({ request_id: `evil ${CANARY} <script>alert(1)</script>` }),
    { status: 402, headers: { 'Content-Type': 'application/json' } }
  ));

  await assert.rejects(
    () => searchAnySearch('q', 'key', options),
    (err) => {
      assert.equal(err.requestId, undefined);
      assert.equal(err.message.includes(CANARY), false);
      assert.equal(err.message.includes('<script>'), false);
      return true;
    }
  );
});

test('sanitizeRequestId keeps only the allowlisted request-ID shape', () => {
  assert.equal(sanitizeRequestId('7d6f4e91-2a83-4c5b-9f10-6e8a3d27b541'), '7d6f4e91-2a83-4c5b-9f10-6e8a3d27b541');
  assert.equal(sanitizeRequestId('  req-1  '), 'req-1');
  assert.equal(sanitizeRequestId('has space'), undefined);
  assert.equal(sanitizeRequestId('<script>'), undefined);
  assert.equal(sanitizeRequestId('x'.repeat(129)), undefined);
  assert.equal(sanitizeRequestId(42), undefined);
  assert.equal(sanitizeRequestId(undefined), undefined);
});