import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import {
  loadConfigCandidate,
  reloadActiveState,
  swapOnSuccess,
} from '../src/reload.ts';

const base = {
  defaultProfile: 'research',
  profiles: {
    research: { providers: ['exa', 'tavily', 'brave'], guidance: 'Prefer primary sources.' },
    economy: { providers: ['brave', 'tavily'] },
  },
  credentials: {
    exa: [{ alias: 'exa-main', env: 'EXA_API_KEY' }],
    tavily: [{ alias: 'tvly-work', env: 'TAVILY_API_KEY_WORK' }],
    brave: [{ alias: 'brave-main', env: 'BRAVE_API_KEY' }],
  },
};

/** An active state as it would exist after a session started on `research`. */
function activeOnResearch() {
  const config = parseConfig(base, 'test.json');
  return {
    config,
    activeProfileName: 'research',
    activeGuidance: 'guidance-for-research',
    profileWarning: undefined,
  };
}

test('a valid candidate replaces the active configuration', () => {
  const current = activeOnResearch();
  const candidate = { ...base, defaultProfile: 'economy' };

  const { state, error } = reloadActiveState(current, candidate, 'test.json');

  assert.equal(error, undefined);
  assert.deepEqual(state.config, parseConfig(candidate, 'test.json'));
  assert.notEqual(state.config, current.config);
  // The still-present active profile is preserved and its guidance re-derived
  // from the candidate configuration, not from the stale active state.
  assert.equal(state.activeProfileName, 'research');
  assert.match(state.activeGuidance, /Prefer primary sources\./);
});

test('an invalid candidate leaves the active configuration identical', () => {
  const current = activeOnResearch();
  const before = structuredClone(current);
  const candidate = { ...base, defaultProfile: 'does-not-exist' };

  const { state, error } = reloadActiveState(current, candidate, 'test.json');

  assert.ok(error, 'expected a reload error');
  assert.equal(state, current, 'failed reload must return the same state object');
  assert.deepEqual(state, before);
  assert.deepEqual(state.config, current.config);
});

test('a partially-valid document is not partially applied', () => {
  const current = activeOnResearch();
  const before = structuredClone(current);
  // A new, perfectly valid profile is present, but defaultProfile is dangling.
  const candidate = {
    ...base,
    defaultProfile: 'nope',
    profiles: {
      ...base.profiles,
      leaked: { providers: ['exa'] },
    },
  };

  const { state, error } = reloadActiveState(current, candidate, 'test.json');

  assert.ok(error);
  assert.deepEqual(state, before);
  // Nothing from the candidate leaked into the active configuration.
  assert.equal(state.config.profiles.leaked, undefined);
  assert.equal(state.config.defaultProfile, 'research');
  assert.deepEqual(Object.keys(state.config.profiles), ['research', 'economy']);
});

test('a reload error names the specific offending field', () => {
  const current = activeOnResearch();
  const { error } = reloadActiveState(current, { ...base, defaultProfile: 'missing' }, 'test.json');
  assert.match(error, /Unknown defaultProfile "missing".*not declared in profiles/);

  const { error: fieldError } = reloadActiveState(
    current,
    { ...base, profiles: { research: { providers: ['exa', 'duckduckgo'] } } },
    'test.json'
  );
  assert.match(fieldError, /profiles\.research\.providers/);
});

test('a missing active profile falls back to the new defaultProfile', () => {
  const current = activeOnResearch();
  const candidate = {
    ...base,
    defaultProfile: 'economy',
    profiles: { economy: { providers: ['brave', 'tavily'] } },
  };

  const { state, error } = reloadActiveState(current, candidate, 'test.json');

  assert.equal(error, undefined);
  assert.equal(state.activeProfileName, 'economy');
  assert.match(state.profileWarning, /"research" no longer exists/);
  assert.deepEqual(state.config.profiles[state.activeProfileName].providers, ['brave', 'tavily']);
});

test('an active profile that still exists is kept, without a warning', () => {
  const current = activeOnResearch();
  const candidate = { ...base, defaultProfile: 'economy' };

  const { state } = reloadActiveState(current, candidate, 'test.json');

  assert.equal(state.activeProfileName, 'research');
  assert.equal(state.profileWarning, undefined);
});

test('reload adopts the defaultProfile when no profile was active', () => {
  const current = {
    config: undefined,
    activeProfileName: undefined,
    activeGuidance: '',
    profileWarning: undefined,
  };
  const { state, error } = reloadActiveState(current, base, 'test.json');
  assert.equal(error, undefined);
  assert.equal(state.activeProfileName, 'research');
  assert.equal(state.profileWarning, undefined);
  assert.match(state.activeGuidance, /Prefer primary sources\./);
});

test('loadConfigCandidate returns the parsed config or the offending-field error', () => {
  const ok = loadConfigCandidate(base, 'test.json');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.config.defaultProfile, 'research');

  const bad = loadConfigCandidate({ ...base, defaultProfile: 'missing' }, 'test.json');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unknown defaultProfile "missing"/);
});

test('swapOnSuccess only accepts an already-validated configuration', () => {
  const current = activeOnResearch();
  const candidate = parseConfig({ ...base, defaultProfile: 'economy' }, 'test.json');
  const next = swapOnSuccess(current, candidate);
  assert.equal(next.config, candidate);
  assert.equal(next.activeProfileName, 'research');
  assert.deepEqual(next.config, candidate);
});