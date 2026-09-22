import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';

const base = {
  provider: 'balanced',
  providers: ['exa', 'tavily', 'brave'],
  apiKeys: {
    exa: ['exa1'],
    tavily: ['tvly1', 'tvly2', 'tvly1'],
    brave: ['brave1']
  }
};

test('parseConfig accepts only the new apiKeys format and deduplicates keys', () => {
  const config = parseConfig(base, 'test.json');
  assert.equal(config.provider, 'balanced');
  assert.deepEqual(config.providers, ['exa', 'tavily', 'brave']);
  assert.deepEqual(config.apiKeys.tavily, ['tvly1', 'tvly2']);
  assert.equal(config.search.numResults, 5);
  assert.equal(config.fetch.maxChars, 30000);
});

test('parseConfig rejects legacy key fields', () => {
  assert.throws(() => parseConfig({ ...base, tavilyApiKey: 'old' }, 'test.json'), /legacy fields/);
});

test('parseConfig uses providers as auto priority', () => {
  const config = parseConfig({ ...base, provider: 'auto', providers: ['tavily', 'exa'] }, 'test.json');
  assert.equal(config.provider, 'auto');
  assert.deepEqual(config.providers, ['tavily', 'exa']);
});
