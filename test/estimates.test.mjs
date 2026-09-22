import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import {
  BUILT_IN_ESTIMATORS,
  ESTIMATOR_RESEARCH_DATE,
  estimateAttempt,
  formatEstimate,
  resolveEstimators
} from '../src/estimates.ts';

const base = {
  defaultProfile: 'research',
  profiles: { research: { providers: ['exa', 'tavily', 'brave'] } }
};

test('every built-in estimator rule carries a version and a date', () => {
  for (const provider of ['exa', 'tavily', 'brave']) {
    const rule = BUILT_IN_ESTIMATORS[provider];
    assert.equal(rule.provider, provider);
    assert.equal(typeof rule.version, 'string');
    assert.equal(rule.version.length > 0, true);
    assert.equal(rule.date, ESTIMATOR_RESEARCH_DATE);
  }
});

test('built-in rules reflect the researched provider facts', () => {
  assert.equal(BUILT_IN_ESTIMATORS.exa.unit, 'requests');
  assert.equal(BUILT_IN_ESTIMATORS.exa.costPerUnitUsd, 0.007);
  assert.equal(BUILT_IN_ESTIMATORS.tavily.unit, 'credits');
  assert.equal(BUILT_IN_ESTIMATORS.tavily.unitsPerAttempt, 1);
  assert.equal(BUILT_IN_ESTIMATORS.brave.unit, 'requests');
  assert.equal(BUILT_IN_ESTIMATORS.brave.costPerUnitUsd, 0.005);
});

test('resolveEstimators leaves built-ins untouched without overrides', () => {
  const rules = resolveEstimators();
  assert.deepEqual(rules.exa, BUILT_IN_ESTIMATORS.exa);
  assert.deepEqual(rules.brave, BUILT_IN_ESTIMATORS.brave);
});

test('resolveEstimators applies a partial override and keeps the provider', () => {
  const rules = resolveEstimators({ tavily: { version: '2', unitsPerAttempt: 2 } });
  assert.equal(rules.tavily.version, '2');
  assert.equal(rules.tavily.unitsPerAttempt, 2);
  assert.equal(rules.tavily.date, ESTIMATOR_RESEARCH_DATE);
  assert.equal(rules.tavily.provider, 'tavily');
});

test('configuration overrides estimator rules by provider', () => {
  const config = parseConfig(
    { ...base, estimates: { brave: { version: '7', date: '2027-01-01', costPerUnitUsd: 0.006 } } },
    'test.json'
  );
  assert.equal(config.estimates.brave.version, '7');
  assert.equal(config.estimates.brave.date, '2027-01-01');
  assert.equal(config.estimates.brave.costPerUnitUsd, 0.006);
  assert.equal(config.estimates.exa.version, '1');
});

test('an estimate is always labelled as an estimate with its rule version and date', () => {
  const estimate = estimateAttempt(resolveEstimators().exa);
  const text = formatEstimate(estimate);
  assert.match(text, /estimate/);
  assert.match(text, /rule v1/);
  assert.match(text, /2026-09-22/);
});

test('estimate cost multiplies units by unit cost', () => {
  const estimate = estimateAttempt(resolveEstimators({ exa: { unitsPerAttempt: 2, costPerUnitUsd: 0.007 } }).exa);
  assert.equal(estimate.units, 2);
  assert.equal(estimate.costUsd, 0.014);
});