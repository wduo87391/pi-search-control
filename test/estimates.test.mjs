import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import {
  BUILT_IN_ALLOWANCES,
  BUILT_IN_ESTIMATORS,
  ESTIMATOR_RESEARCH_DATE,
  estimateAttempt,
  formatEstimate,
  resolveAllowance,
  resolveEstimators
} from '../src/estimates.ts';

const base = {
  defaultProfile: 'research',
  profiles: { research: { providers: ['exa', 'tavily', 'brave'] } }
};

test('every built-in estimator rule carries a version and a date', () => {
  for (const provider of ['exa', 'tavily', 'brave', 'anysearch']) {
    const rule = BUILT_IN_ESTIMATORS[provider];
    assert.equal(rule.provider, provider);
    assert.equal(typeof rule.version, 'string');
    assert.equal(rule.version.length > 0, true);
    assert.equal(typeof rule.date, 'string');
    assert.equal(rule.date.length > 0, true);
  }
});

test('the Exa, Tavily, and Brave built-ins share the researched landscape date', () => {
  for (const provider of ['exa', 'tavily', 'brave']) {
    assert.equal(BUILT_IN_ESTIMATORS[provider].date, ESTIMATOR_RESEARCH_DATE);
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

test('the AnySearch estimator is one request unit at zero estimated cost with a first-party basis', () => {
  const rule = BUILT_IN_ESTIMATORS.anysearch;
  assert.equal(rule.unit, 'requests');
  assert.equal(rule.unitsPerAttempt, 1);
  assert.equal(rule.costPerUnitUsd, 0);
  assert.match(rule.basis, /anysearch\.com/);
  assert.ok(rule.date.length > 0);
  assert.ok(rule.version.length > 0);
});

test('the AnySearch provider-default allowance is 1,000 requests per calendar day', () => {
  const allowance = BUILT_IN_ALLOWANCES.anysearch;
  assert.equal(allowance.units, 1000);
  assert.deepEqual(allowance.period, { kind: 'calendar-day' });
  assert.match(allowance.basis, /anysearch\.com/);
  assert.ok(allowance.date.length > 0);
  assert.ok(allowance.version.length > 0);
});

test('resolveAllowance returns the provider default when no credential override is declared', () => {
  assert.deepEqual(resolveAllowance('anysearch'), {
    units: 1000,
    period: { kind: 'calendar-day' },
    version: BUILT_IN_ALLOWANCES.anysearch.version,
    date: BUILT_IN_ALLOWANCES.anysearch.date,
    basis: BUILT_IN_ALLOWANCES.anysearch.basis,
    source: 'provider-default'
  });
});

test('resolveAllowance returns undefined for a provider with no built-in allowance', () => {
  assert.equal(resolveAllowance('exa'), undefined);
});

test('a credential allowance override replaces units and period but keeps the provider basis metadata', () => {
  const resolved = resolveAllowance('anysearch', { units: 2000, period: { kind: 'calendar-month' } });
  assert.equal(resolved.units, 2000);
  assert.deepEqual(resolved.period, { kind: 'calendar-month' });
  assert.equal(resolved.source, 'credential');
  assert.equal(resolved.basis, BUILT_IN_ALLOWANCES.anysearch.basis);
  assert.equal(resolved.version, BUILT_IN_ALLOWANCES.anysearch.version);
});

test('a credential allowance override works for a provider with no built-in allowance', () => {
  const resolved = resolveAllowance('exa', { units: 500, period: { kind: 'calendar-month' } });
  assert.equal(resolved.units, 500);
  assert.equal(resolved.source, 'credential');
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