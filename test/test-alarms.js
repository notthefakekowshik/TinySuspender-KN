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

test('alarm for a new background tab uses the user\'s idleTimeMinutes, not the constructor default', async () => {
  // Regression: previously, onTabCreated/onTabActivated used this.idleTimeMinutes
  // synchronously, but readSettings is async — so after a service-worker wake
  // alarms were created with the constructor default (30 min) instead of the
  // user's setting.
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  mock.setTabs([{id: 1, active: true, url: 'https://example.com/', title: 'X'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.alarmsCreate.length = 0;
  mock.fire.onCreated({id: 2, active: false, url: 'https://other.com/', title: 'Y'});
  await flush();

  const created = mock.calls.alarmsCreate.find((c) => c.name === '2');
  assert.ok(created, 'alarm should be created for new background tab');
  assert.strictEqual(created.opts.delayInMinutes, 2,
    'alarm must use user-set idleTimeMinutes (2), not constructor default (30)');
});

test('switching tabs ensures alarms for every background tab', async () => {
  // Regression: previously relied on activeInfo.previousTabId which is a
  // Firefox WebExtensions field and is always undefined in Chrome. So tabs
  // that became background via tab-switching never got an alarm.
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  mock.setTabs([
    {id: 1, active: false, url: 'https://a.com/'},
    {id: 2, active: false, url: 'https://b.com/'},
    {id: 3, active: true,  url: 'https://c.com/'},
  ]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  const initialNames = mock.calls.alarmsCreate.map((c) => c.name).sort();
  assert.deepStrictEqual(initialNames, ['1', '2'],
    'boot should create alarms for all background tabs');

  // User switches: tab 1 becomes active; tab 3 was just deactivated.
  mock.calls.alarmsCreate.length = 0;
  mock.calls.alarmsClear.length = 0;
  mock.setTabs([
    {id: 1, active: true,  url: 'https://a.com/'},
    {id: 2, active: false, url: 'https://b.com/'},
    {id: 3, active: false, url: 'https://c.com/'},
  ]);
  mock.fire.onActivated({tabId: 1, windowId: 1});  // Chrome's onActivated has NO previousTabId
  await flush();

  assert.ok(mock.calls.alarmsClear.includes('1'),
    'new active tab\'s alarm should be cancelled');
  const tab3 = mock.calls.alarmsCreate.find((c) => c.name === '3');
  assert.ok(tab3, 'just-deactivated tab should get an alarm');
  assert.strictEqual(tab3.opts.delayInMinutes, 2);
  assert.strictEqual(mock.calls.alarmsCreate.find((c) => c.name === '2'), undefined,
    'tab that already had an alarm should not be re-created');
});

test('onTabRemoved cancels the tab\'s alarm and clears its tabState', async () => {
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  mock.setTabs([{id: 5, active: false, url: 'https://x.com/'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  core.tabState[5] = {state: 'suspendable:tab_whitelist'};

  mock.calls.alarmsClear.length = 0;
  mock.fire.onRemoved(5, {});
  await flush();

  assert.ok(mock.calls.alarmsClear.includes('5'),
    'closed tab\'s alarm should be cleared');
  assert.strictEqual(core.tabState[5], undefined,
    'closed tab\'s tabState entry should be dropped');
});

test('local-namespace storage writes do not rebuild alarms', async () => {
  // Regression: storage.onChanged previously fired resetAutoSuspensionTimers
  // for every local-namespace write (saveState fires constantly from popup
  // actions), causing every tab's alarm to be cancelled and re-created.
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  mock.setTabs([{id: 1, active: false, url: 'https://a.com/'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  const clearsBefore = mock.calls.alarmsClear.length;
  mock.fire.onStorageChanged({tabState: {newValue: {}, oldValue: {}}}, 'local');
  await flush();

  assert.strictEqual(mock.calls.alarmsClear.length, clearsBefore,
    'local-namespace storage changes must not trigger alarm rebuild');
});

test('sync-namespace change to idleTimeMinutes rebuilds alarms', async () => {
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  mock.setTabs([{id: 1, active: false, url: 'https://a.com/'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  const clearsBefore = mock.calls.alarmsClear.length;
  mock.syncStorage.idleTimeMinutes = 5;
  mock.fire.onStorageChanged({idleTimeMinutes: {newValue: 5, oldValue: 2}}, 'sync');
  await flush();

  assert.ok(mock.calls.alarmsClear.length > clearsBefore,
    'relevant sync key change should rebuild alarms');
});

test('icon contract: every documented state maps to its intended icon', async () => {
  // If you add a new state to getTabState, add it here too. Without this
  // contract, a forgotten state silently falls through to the 'red' default
  // (which is how Tier 1 #6 missed `nonsuspendible:discarded` and
  // `suspendable:offline` before).
  const STATES = {
    'suspended:suspended':               'icon-default-38.png',
    'suspendable:auto':                  'icon-green-38.png',
    'suspendable:auto_disabled':         'icon-yellow-38.png',
    'suspendable:form_changed':          'icon-yellow-38.png',
    'suspendable:audible':               'icon-yellow-38.png',
    'suspendable:pinned':                'icon-yellow-38.png',
    'suspendable:offline':               'icon-yellow-38.png',
    'suspendable:tab_whitelist':         'icon-yellow-38.png',
    'suspendable:url_whitelist':         'icon-yellow-38.png',
    'suspendable:domain_whitelist':      'icon-yellow-38.png',
    'nonsuspendible:temporary_disabled': 'icon-yellow-38.png',
    'nonsuspendible:system_page':        'icon-gray-38.png',
    'nonsuspendible:discarded':          'icon-default-38.png',
    'nonsuspendible:not_running':        'icon-red-38.png',
    'nonsuspendible:error':              'icon-red-38.png',
  };

  const mock = makeChromeMock();
  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  for (const [state, file] of Object.entries(STATES)) {
    mock.calls.setIcon.length = 0;
    core.setIconFromStateString(state, 1);
    const last = mock.calls.setIcon.at(-1);
    assert.ok(last && last.path.endsWith(file),
      `state '${state}' should map to ${file}, got ${last && last.path}`);
  }
});
