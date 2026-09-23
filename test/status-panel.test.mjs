import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { StatusPanel } from '../src/status-panel.ts';

// A fake callback theme that emits real ANSI codes, so width assertions exercise
// the same ANSI-aware helpers the panel uses under a live TUI.
const THEME = {
  fg: (color, text) => `\x1b[3${color.length % 8}m${text}\x1b[39m`,
  bg: (color, text) => `\x1b[4${color.length % 8}m${text}\x1b[49m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`
};

function counts(overrides = {}) {
  return { attempts: 0, success: 0, failure: 0, units: 0, costUsd: 0, ...overrides };
}

function summary(overrides = {}) {
  return {
    requests: 0, attempts: 0, success: 0, failure: 0, units: 0, costUsd: 0,
    byProvider: {}, byAlias: {}, ...overrides
  };
}

function provider(overrides = {}) {
  return {
    provider: 'exa',
    inProfile: true,
    configurationUnavailable: false,
    routeUsable: true,
    credentials: [],
    estimate: { units: 1, unit: 'requests', costUsd: 0.007, version: '1', date: '2026-09-22' },
    session: counts(),
    day: counts(),
    month: counts(),
    ...overrides
  };
}

function makeSnapshot(overrides = {}) {
  const { overview: overviewOverride, providers: providersOverride, ...rest } = overrides;
  return {
    kind: 'ready',
    now: Date.UTC(2026, 9, 20, 12, 0, 0),
    overview: {
      profileName: 'research',
      providerOrder: ['exa', 'tavily'],
      usableRoute: true,
      quotaCondition: false,
      session: summary({ requests: 2, attempts: 3, success: 2, failure: 1 }),
      sessionPartial: false,
      day: summary({ requests: 4, attempts: 5, success: 4, failure: 1 }),
      month: summary({ requests: 9, attempts: 12, success: 10, failure: 2 }),
      warnings: [],
      ...(overviewOverride ?? {})
    },
    providers: providersOverride ?? [
      provider({
        provider: 'exa',
        credentials: [{
          alias: 'exa-main',
          provider: 'exa',
          available: true,
          inProfile: true,
          eligible: true,
          threshold: 100,
          periodAttempts: 5,
          demoted: false,
          allowance: {
            units: 1000,
            period: { kind: 'calendar-day' },
            source: 'provider-default',
            estimatedUsed: 5,
            estimatedRemaining: 995,
            coverage: 'complete'
          }
        }],
        session: counts({ attempts: 2, success: 1, failure: 1 }),
        day: counts({ attempts: 3, success: 2, failure: 1 }),
        month: counts({ attempts: 4, success: 3, failure: 1 })
      }),
      provider({ provider: 'tavily', routeUsable: false, credentials: [{
        alias: 'tvly-main',
        provider: 'tavily',
        available: false,
        inProfile: true,
        eligible: false,
        demoted: false
      }] }),
      provider({ provider: 'brave', inProfile: false, routeUsable: false, credentials: [] }),
      provider({ provider: 'anysearch', inProfile: false, routeUsable: false, credentials: [] })
    ],
    ...rest
  };
}

function makePanel(snapshot, options = {}) {
  const closes = [];
  const renders = [];
  const panel = new StatusPanel({
    snapshot,
    theme: options.theme ?? THEME,
    onClose: () => closes.push(true),
    requestRender: () => renders.push(true)
  });
  return { panel, closes, renders };
}

const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';
const TAB = '\t';
const SHIFT_TAB = '\x1b[Z';
const ESCAPE = '\x1b';

function assertWidthSafe(panel, width) {
  for (const line of panel.render(width)) {
    assert.ok(
      visibleWidth(line) <= width,
      `line exceeds width ${width}: ${JSON.stringify(line)}`
    );
  }
}

test('the panel opens on Overview and renders its snapshot values', () => {
  const { panel } = makePanel(makeSnapshot());
  const text = panel.render(120).join('\n');

  assert.equal(panel.activePage, 0);
  assert.match(text, /Overview/);
  assert.match(text, /Search Profile: research/);
  assert.match(text, /Provider order: exa > tavily/);
  assert.match(text, /Route: usable/);
  assert.match(text, /This session: 2 Search Requests, 3 Provider Attempts \(2 succeeded, 1 failed\)/);
  assert.match(text, /Today: 4 Search Requests, 5 Provider Attempts/);
  assert.match(text, /This month: 9 Search Requests, 12 Provider Attempts/);
});

test('provider pages render membership, credentials, counts, estimates, and allowance', () => {
  const { panel } = makePanel(makeSnapshot());
  panel.handleInput(RIGHT); // Exa
  const text = panel.render(200).join('\n');

  assert.match(text, /^.*Exa/);
  assert.match(text, /Profile membership: in profile/);
  assert.match(text, /Route: route usable/);
  assert.match(text, /This session: 1 ok, 1 fail/);
  assert.match(text, /Today: 2 ok, 1 fail/);
  assert.match(text, /This month: 3 ok, 1 fail/);
  assert.match(text, /Estimated use per attempt: 1 requests .*\[estimate; rule v1/);
  assert.match(text, /exa-main: available, eligible/);
  assert.match(text, /threshold: 100 \(5 attempts this period\)/);
  assert.match(text, /allowance: 5\/1000 units used, 995 remaining \(calendar-day\) \[estimate\]/);

  panel.handleInput(RIGHT); // Tavily
  const tavily = panel.render(200).join('\n');
  assert.match(tavily, /Profile membership: in profile/);
  assert.match(tavily, /Route: No usable route/);
  assert.match(tavily, /tvly-main: unavailable, not eligible/);
  assert.match(tavily, /threshold: none/);
  assert.match(tavily, /allowance: unknown \(no allowance configured\) \[estimate\]/);

  panel.handleInput(RIGHT); // Brave
  const brave = panel.render(200).join('\n');
  assert.match(brave, /Profile membership: not in this profile/);
  assert.match(brave, /Route: outside active profile/);
  assert.match(brave, /none configured/);
});

test('all five pages are reachable in both directions with wraparound', () => {
  const { panel } = makePanel(makeSnapshot());
  const titles = () => panel.render(200)[0];

  assert.match(titles(), /Overview/);
  for (const expected of ['Exa', 'Tavily', 'Brave', 'AnySearch']) {
    panel.handleInput(RIGHT);
    assert.match(titles(), new RegExp(expected));
  }
  // Right from the last page wraps back to Overview.
  panel.handleInput(RIGHT);
  assert.equal(panel.activePage, 0);

  // Left from Overview wraps to the last page, and Shift+Tab walks back.
  panel.handleInput(LEFT);
  assert.equal(panel.activePage, 4);
  panel.handleInput(SHIFT_TAB);
  assert.equal(panel.activePage, 3);
  panel.handleInput(TAB);
  assert.equal(panel.activePage, 4);
});

test('navigation invalidates the cache and requests a render', () => {
  const { panel, renders } = makePanel(makeSnapshot());
  const before = panel.render(80);

  panel.handleInput(RIGHT);

  assert.equal(renders.length, 1);
  const after = panel.render(80);
  assert.notEqual(after, before);
  assert.equal(renders.length, 1, 'render itself does not request another render');
});

test('render caches by page and width', () => {
  const { panel } = makePanel(makeSnapshot());
  const first = panel.render(80);
  assert.equal(panel.render(80), first, 'same page and width reuse the cache');
  const other = panel.render(60);
  assert.notEqual(other, first);
  assert.equal(panel.render(60), other);
});

test('Escape and q invoke the close callback', () => {
  for (const key of [ESCAPE, 'q']) {
    const { panel, closes } = makePanel(makeSnapshot());
    panel.handleInput(key);
    assert.equal(closes.length, 1, `${JSON.stringify(key)} closes the panel`);
  }
});

test('every rendered line fits the supplied width, including narrow terminals', () => {
  const longAlias = 'a'.repeat(200);
  const { panel } = makePanel(makeSnapshot({
    providers: [
      provider({ provider: 'exa', credentials: [{
        alias: longAlias,
        provider: 'exa',
        available: true,
        inProfile: true,
        eligible: true,
        demoted: true,
        cooldown: { category: 'quota', enteredAt: 0, until: Date.UTC(2026, 9, 20, 12, 5, 0) }
      }] }),
      provider({ provider: 'tavily' }),
      provider({ provider: 'brave' }),
      provider({ provider: 'anysearch' })
    ]
  }));

  for (const width of [120, 80, 40, 20, 8]) {
    for (let page = 0; page < 5; page++) {
      assertWidthSafe(panel, width);
      panel.handleInput(RIGHT);
    }
  }
});

test('the panel renders an immutable snapshot captured at open time', () => {
  const source = makeSnapshot();
  const { panel } = makePanel(source);
  const before = panel.render(120).join('\n');

  source.overview.profileName = 'mutated';
  source.overview.usableRoute = false;
  source.providers[0].credentials[0].available = false;

  const after = panel.render(120).join('\n');
  assert.equal(after, before, 'later mutation of the caller snapshot does not affect an open panel');
});

test('invalidate rebuilds styled output after a theme change', () => {
  let accent = '\x1b[32m';
  const theme = {
    fg: (color, text) => `${color === 'accent' ? accent : ''}${text}`,
    bg: (color, text) => text,
    bold: (text) => text
  };
  const { panel } = makePanel(makeSnapshot(), { theme });
  const before = panel.render(80).join('\n');

  accent = '\x1b[35m';
  panel.invalidate();
  const after = panel.render(80).join('\n');

  assert.notEqual(after, before);
  assert.match(after, /\x1b\[35m/);
});

test('a configuration-error snapshot stays navigable and invents no credential state', () => {
  const snapshot = makeSnapshot({
    kind: 'config-error',
    overview: {
      profileName: undefined,
      providerOrder: [],
      usableRoute: false,
      quotaCondition: false,
      session: summary(),
      sessionPartial: false,
      day: summary(),
      month: summary(),
      warnings: ['Missing profiles']
    },
    providers: ['exa', 'tavily', 'brave', 'anysearch'].map((name) =>
      provider({ provider: name, inProfile: false, routeUsable: false, configurationUnavailable: true, credentials: [] })
    )
  });
  const { panel } = makePanel(snapshot);

  const overview = panel.render(120).join('\n');
  assert.match(overview, /Route: No usable route/);
  assert.match(overview, /Configuration unavailable/);
  assert.match(overview, /Warning: Missing profiles/);

  for (let page = 0; page < 5; page++) {
    const text = panel.render(120).join('\n');
    if (page > 0) {
      assert.match(text, /Profile membership: unknown \(configuration unavailable\)/);
      assert.match(text, /configuration unavailable/);
      assert.ok(!/- .*: available/.test(text), 'no credential availability is invented');
    }
    panel.handleInput(RIGHT);
  }
});

test('a partial session and a quota condition surface as explicit markers', () => {
  const { panel } = makePanel(makeSnapshot({
    overview: {
      sessionPartial: true,
      quotaCondition: true,
      warnings: ['profile "gone" no longer exists']
    }
  }));
  const text = panel.render(200).join('\n');

  assert.match(text, /\[partial: session began before the 30-day detail-retention horizon\]/);
  assert.match(text, /Quota condition: active \(observed quota cooldown; not provider-authoritative\)/);
  assert.match(text, /Warning: profile "gone" no longer exists/);
});

test('an unknown allowance coverage shows an explicit unknown marker', () => {
  const { panel } = makePanel(makeSnapshot({
    providers: [
      provider({ provider: 'exa', credentials: [{
        alias: 'exa-main',
        provider: 'exa',
        available: true,
        inProfile: true,
        eligible: true,
        demoted: false,
        allowance: {
          units: 1000,
          period: { kind: 'rolling-days', days: 45 },
          source: 'credential',
          estimatedUsed: 12,
          coverage: 'unknown'
        }
      }] }),
      provider({ provider: 'tavily' }),
      provider({ provider: 'brave' }),
      provider({ provider: 'anysearch' })
    ]
  }));
  panel.handleInput(RIGHT);
  const text = panel.render(200).join('\n');

  assert.match(text, /12\/1000 units used, remaining unknown \(coverage incomplete\) \(rolling 45 days\) \[estimate\]/);
});