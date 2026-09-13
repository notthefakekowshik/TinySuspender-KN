const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeChromeMock } = require('./helpers/mock-chrome.js');

const CORE_PATH = path.resolve(__dirname, '../src/tiny-suspender/js/core.js');

function freshCore() {
  // core.js is a singleton-at-module-load; drop the cache so each test
  // gets a fresh instance.
  delete require.cache[CORE_PATH];
  return require(CORE_PATH);
}

async function flush(ticks = 8) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const HOUR_MS = 60 * 60 * 1000;
const OWN_ORIGIN = 'chrome-extension://test-extension-id';

function ownSuspendUrl(pageUrl) {
  return OWN_ORIGIN + '/suspend.html?url=' + encodeURIComponent(pageUrl) + '&title=Page';
}

// A background page that has been idle for two hours, plus the message handler
// the automatic suspension path needs to answer.
function idleTab(id, state, overrides) {
  return Object.assign({
    id: id,
    active: false,
    url: 'https://s' + id + '.example.com/',
    title: 'S' + id,
    lastAccessed: Date.now() - (2 * HOUR_MS),
    state: state,
  }, overrides || {});
}

function reclaimMock(tabs) {
  let states = {};
  tabs.forEach((tab) => { states[tab.id] = tab.state; });

  return makeChromeMock({
    sync: {idleTimeMinutes: 30},
    onTabMessage: (id, message) => {
      if (message.command === 'ts_get_tab_state') return {state: states[id] || 'suspendable:auto'};
      if (message.command === 'ts_get_tab_scroll') return {scroll: {x: 0, y: 0}};
      return undefined;
    },
  });
}

test('reclaim suspends idle tabs through the automatic path and reports skips', async (t) => {
  // Fake timers keep the post-sweep history sample from holding the test open.
  t.mock.timers.enable({apis: ['setTimeout']});

  const tabs = [
    idleTab(1, 'suspendable:auto'),
    idleTab(2, 'suspendable:form_changed'),
    idleTab(3, 'suspendable:auto', {lastAccessed: Date.now()}),   // just used
    idleTab(4, 'suspendable:auto', {active: true}),               // in the foreground
  ];

  const mock = reclaimMock(tabs);
  mock.setTabs(tabs);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;

  let stats = null;
  core.reclaimIdleTabs(60, (result) => { stats = result; });
  await flush();

  assert.strictEqual(stats.total, 2, 'only the idle background tabs are candidates');
  assert.strictEqual(stats.processed, 2);
  assert.strictEqual(stats.suspended, 1, 'the tab with unsaved form data must be skipped');
  assert.deepStrictEqual(stats.skipped, {'suspendable:form_changed': 1});

  const suspended = mock.calls.tabsUpdate.filter((call) => call.info.url && call.info.url.startsWith('suspend.html'));
  assert.strictEqual(suspended.length, 1);
  assert.strictEqual(suspended[0].id, 1);
});

test('a reclaim of many tabs is paced instead of firing at once', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});

  const tabs = [];
  for (let id = 1; id <= 7; id++) tabs.push(idleTab(id, 'suspendable:auto'));

  const mock = reclaimMock(tabs);
  mock.setTabs(tabs);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;

  let stats = null;
  assert.strictEqual(core.reclaimIdleTabs(60, (result) => { stats = result; }), true);

  await flush();
  assert.strictEqual(mock.calls.tabsUpdate.length, 5, 'only the first batch runs up front');
  assert.strictEqual(stats, null, 'the sweep must not finish in one burst');

  t.mock.timers.tick(200);
  await flush();
  t.mock.timers.tick(2000);
  await flush();

  assert.strictEqual(mock.calls.tabsUpdate.length, 7, 'the rest follows after the delay');
  assert.strictEqual(stats.suspended, 7);
});

test('a second reclaim is refused while a sweep is running', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});

  const tabs = [];
  for (let id = 1; id <= 7; id++) tabs.push(idleTab(id, 'suspendable:auto'));

  const mock = reclaimMock(tabs);
  mock.setTabs(tabs);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;

  assert.strictEqual(core.reclaimIdleTabs(60, () => {}), true);
  assert.strictEqual(core.reclaimIdleTabs(60, () => {}), false, 'a parallel sweep must not start');

  t.mock.timers.tick(200);
  await flush();
  t.mock.timers.tick(2000);
  await flush();

  assert.strictEqual(mock.calls.tabsUpdate.length, 7, 'each candidate is suspended once');
});

test('the sweep reports itself as running before the tab list is read', async () => {
  // Regression: the sweep used to mark itself in progress only once tabs.query
  // answered, so a progress poll landing in that window saw "not running, no
  // stats" and the dashboard reported that nothing had been reclaimed.
  const mock = makeChromeMock();
  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  let release = null;
  mock.chrome.tabs.query = (query, callback) => { release = () => callback([]); };

  assert.strictEqual(core.reclaimIdleTabs(60, () => {}), true);
  assert.strictEqual(core.reclaimInProgress, true, 'a poll must not see a finished sweep');

  release();
  await flush();

  assert.strictEqual(core.reclaimInProgress, false);
  assert.deepStrictEqual(core.reclaimStats, {total: 0, processed: 0, suspended: 0, skipped: {}});
});

test('the reclaim message rejects an unusable age', async () => {
  const mock = makeChromeMock();
  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  let response = null;
  core.reclaim_idle_tabs({minAgeMinutes: 'soon'}, {}, (result) => { response = result; });

  assert.deepStrictEqual(response, {started: false, error: 'invalid age'});
});

test('the history records one sample and skips repeats inside the interval', async () => {
  const mock = makeChromeMock();
  mock.setTabs([
    {id: 1, active: false, url: ownSuspendUrl('https://a.example.com/'), discarded: true},
    {id: 2, active: false, url: ownSuspendUrl('https://b.example.com/'), discarded: true},
    {id: 3, active: true, url: 'https://live.example.com/'},
  ]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  let recorded = null;
  core.recordSuspendSample(true, (ok) => { recorded = ok; });
  await flush();

  assert.strictEqual(recorded, true);
  assert.strictEqual(mock.localStorage.suspendHistory.length, 1);

  const sample = mock.localStorage.suspendHistory[0];
  assert.strictEqual(sample.own, 2);
  assert.strictEqual(sample.orphaned, 0);
  assert.strictEqual(sample.discarded, 0, 'a discarded suspend page is still a suspended tab');
  assert.strictEqual(sample.live, 1);
  assert.ok(sample.at > 0);

  // The scan ticks every minute; only an hour may add another sample.
  let second = null;
  core.recordSuspendSample(false, (ok) => { second = ok; });
  await flush();

  assert.strictEqual(second, false);
  assert.strictEqual(mock.localStorage.suspendHistory.length, 1, 'no second sample inside the hour');
});

test('the history keeps the newest samples only', async () => {
  const mock = makeChromeMock();
  const history = [];
  for (let i = 0; i < 200; i++) {
    history.push({at: i, own: i, orphaned: 0, discarded: 0, live: 0});
  }
  mock.localStorage.suspendHistory = history;

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  core.recordSuspendSample(true, () => {});
  await flush();

  const stored = mock.localStorage.suspendHistory;
  assert.strictEqual(stored.length, 200, 'the window stays capped');
  assert.strictEqual(stored[0].at, 1, 'the oldest sample is dropped');
  assert.strictEqual(stored[stored.length - 1].own, 0, 'the newest sample is the one just taken');
});

test('a reclaim leaves a sample behind for the dashboard', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});

  const tabs = [idleTab(1, 'suspendable:auto')];
  const mock = reclaimMock(tabs);
  mock.setTabs(tabs);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  core.reclaimIdleTabs(60, () => {});
  await flush();

  t.mock.timers.tick(2000);
  await flush();

  assert.strictEqual(mock.localStorage.suspendHistory.length, 1,
    'the reclaim records a sample so the run shows up in the history');
});
