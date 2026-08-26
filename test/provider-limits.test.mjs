import test from 'node:test';
import assert from 'node:assert/strict';
import { searchBrave } from '../src/providers/brave.ts';
import { searchDoubao } from '../src/providers/doubao.ts';
import { searchExa } from '../src/providers/exa.ts';
import { searchTavily } from '../src/providers/tavily.ts';

const options = { numResults: 500, timeoutMs: 1000 };

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('providers cap requested results to their documented API limits', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ input: String(input), init });
    return jsonResponse({});
  };

  await searchExa('query', 'key', options);
  await searchTavily('query', 'key', options);
  await searchBrave('query', 'key', options);
  await searchDoubao('query', 'key', options);

  const exaBody = JSON.parse(requests[0].init.body);
  assert.equal(exaBody.numResults, 100);

  const tavilyBody = JSON.parse(requests[1].init.body);
  assert.equal(tavilyBody.max_results, 20);

  const braveUrl = new URL(requests[2].input);
  assert.equal(braveUrl.searchParams.get('count'), '50');
  assert.equal(braveUrl.searchParams.get('maximum_number_of_urls'), '50');

  const doubaoBody = JSON.parse(requests[3].init.body);
  assert.equal(doubaoBody.Count, 50);
});
