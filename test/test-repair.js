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

const OWN_ORIGIN = 'chrome-extension://test-extension-id';
const FOREIGN_ORIGIN = 'chrome-extension://bbomjaikkcabgmfaomdichgcodnaeecf';

const ownSuspend = (page) => OWN_ORIGIN + '/suspend.html?url=' + encodeURIComponent(page);
const foreignSuspend = (page) => FOREIGN_ORIGIN + '/suspend.html?url=' + encodeURIComponent(page);

// What a legacy placeholder carries: the extension's own power icon, not the
// dimmed site icon (a data: url) the page sets for itself.
const POWER_ICON = OWN_ORIGIN + '/img/browser-icons/icon-default-38.png';
const DIMMED_ICON = 'data:image/png;base64,AAAA';

test('needsIconRepair targets our placeholders that lack the site icon', async () => {
  const mock = makeChromeMock();
  const core = freshCore();
  core.setChrome(mock.chrome);

  assert.strictEqual(core.needsIconRepair({url: ownSuspend('https://example.com/'), favIconUrl: POWER_ICON}), true);
  assert.strictEqual(core.needsIconRepair({url: ownSuspend('https://example.com/')}), true,
    'a placeholder with no icon at all still needs repair');
  assert.strictEqual(core.needsIconRepair({url: ownSuspend('https://example.com/'), favIconUrl: DIMMED_ICON}), false,
    'a placeholder already carrying the dimmed icon is left alone');
  assert.strictEqual(core.needsIconRepair({url: ownSuspend('https://example.com/'), active: true}), false,
    'never reload the tab the user is looking at');
  assert.strictEqual(core.needsIconRepair({url: 'https://example.com/'}), false);
  assert.strictEqual(core.needsIconRepair({url: foreignSuspend('https://example.com/')}), false,
    'another install\'s placeholder is not ours to repair');
  assert.strictEqual(core.needsIconRepair(null), false);
});

test('the repair sweep reloads only the placeholders that need it', async () => {
  const mock = makeChromeMock({sync: {idleTimeMinutes: 2}});
  mock.setTabs([
    {id: 1, active: false, url: ownSuspend('https://example.com/'), title: 'Legacy', favIconUrl: POWER_ICON},
    {id: 2, active: false, url: ownSuspend('https://example.com/'), title: 'Fine', favIconUrl: DIMMED_ICON},
    {id: 3, active: false, url: 'https://example.com/', title: 'Live'},
  ]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsReload.length = 0;

  let stats = null;
  assert.strictEqual(core.repairSuspendedTabIcons((s) => { stats = s; }), true);

  assert.deepStrictEqual(mock.calls.tabsReload, [1],
    'only the placeholder missing its site icon is reloaded');
  assert.strictEqual(stats.total, 1);
  assert.strictEqual(stats.processed, 1);
  assert.notStrictEqual(core.discardTimers[1], undefined,
    'a reloaded placeholder is marked pending so the discard sweep leaves it alone while it renders');
});

test('the repair sweep is paced and reports progress', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});

  const mock = makeChromeMock({sync: {idleTimeMinutes: 2}});
  const tabs = [];
  for (let id = 1; id <= 7; id++) {
    tabs.push({id, active: false, url: ownSuspend('https://example.com/' + id), title: 'Tab ' + id, favIconUrl: POWER_ICON});
  }
  mock.setTabs(tabs);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsReload.length = 0;

  let stats = null;
  core.repairSuspendedTabIcons((s) => { stats = s; });

  assert.strictEqual(mock.calls.tabsReload.length, 3, 'only the first batch reloads up front');
  assert.strictEqual(stats, null, 'the sweep has not finished yet');

  t.mock.timers.tick(250);
  await flush();
  assert.strictEqual(mock.calls.tabsReload.length, 6);

  t.mock.timers.tick(250);
  await flush();
  assert.strictEqual(mock.calls.tabsReload.length, 7);
  assert.strictEqual(stats.total, 7);
  assert.strictEqual(stats.processed, 7);
});

test('a second repair request is ignored while one is running', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});

  const mock = makeChromeMock({sync: {idleTimeMinutes: 2}});
  const tabs = [];
  for (let id = 1; id <= 7; id++) {
    tabs.push({id, active: false, url: ownSuspend('https://example.com/' + id), title: 'Tab ' + id, favIconUrl: POWER_ICON});
  }
  mock.setTabs(tabs);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  assert.strictEqual(core.repairSuspendedTabIcons(() => {}), true);
  assert.strictEqual(core.repairSuspendedTabIcons(() => {}), false,
    'a sweep must not start while one is already running');

  t.mock.timers.tick(250);
  t.mock.timers.tick(250);
  await flush();
});
