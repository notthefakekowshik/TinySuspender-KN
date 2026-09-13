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
  core.saveTabScroll(5, {x: '1', y: '2'});

  mock.calls.alarmsClear.length = 0;
  mock.fire.onRemoved(5, {});
  await flush();

  assert.ok(mock.calls.alarmsClear.includes('5'),
    'closed tab\'s alarm should be cleared');
  assert.strictEqual(core.tabState[5], undefined,
    'closed tab\'s tabState entry should be dropped');
  assert.strictEqual(core.tabScrolls[5], undefined,
    'closed tab\'s scroll handoff entry should be dropped');
  assert.strictEqual(mock.sessionStorage.scroll_5, undefined,
    'closed tab\'s persisted scroll handoff should be removed');
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

test('scroll restore handoff is persisted and survives a service-worker restart', async () => {
  // Regression: the tabId -> scroll handoff used to live only in this.tabScrolls.
  // If the MV3 worker was torn down between tabs.update and the page reaching
  // 'complete', the scroll position was silently dropped.
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  const suspendUrl = 'chrome-extension://test-extension-id/suspend.html'
    + '?url=' + encodeURIComponent('https://example.com/')
    + '&title=' + encodeURIComponent('Example')
    + '&favIconUrl=&scroll_x=120&scroll_y=340';
  mock.setTabs([{id: 7, active: true, url: suspendUrl, title: 'Example'}]);

  let core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  core.restoreTab(7);
  await flush();

  assert.deepStrictEqual(core.tabScrolls[7], {x: '120', y: '340'});
  assert.deepStrictEqual(mock.sessionStorage.scroll_7, {x: '120', y: '340'},
    'scroll handoff should be written to storage.session');

  // Simulate the worker being torn down and restarted before the page loads.
  core = freshCore();
  core.setChrome(mock.chrome);
  await flush();
  assert.strictEqual(core.tabScrolls[7], undefined,
    'a restarted worker has no in-memory scroll state');

  mock.calls.tabsSendMessage.length = 0;
  core.onTabUpdated(7, {status: 'complete'}, {id: 7, active: false, url: suspendUrl});
  await flush();

  const scrollMessage = mock.calls.tabsSendMessage.find((c) => c.msg.command === 'ts_set_tab_scroll');
  assert.ok(scrollMessage, 'scroll command should be sent once the page finishes loading');
  assert.deepStrictEqual(scrollMessage.msg.scroll, {x: '120', y: '340'});
  assert.strictEqual(mock.sessionStorage.scroll_7, undefined,
    'consumed handoff should be removed from session storage');
});

test('getTabState refuses to auto-suspend when the content script does not answer', async (t) => {
  // Regression: the 2s content-script timeout used to fall back to
  // 'suspendable:auto', so a page that blocks its main thread could be
  // suspended while holding form data we never got to detect.
  t.mock.timers.enable({apis: ['setTimeout']});

  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  mock.setTabs([{id: 3, active: false, url: 'https://slow.example.com/', title: 'Slow'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  // The content script never answers.
  mock.chrome.tabs.sendMessage = () => {};

  const pending = core.getTabState(3);
  await flush();
  t.mock.timers.tick(2000);
  const state = await pending;

  assert.strictEqual(state.state, 'suspendable:no_response');
  assert.strictEqual(core.isAutoSuspendable(state.state), false,
    'a tab that did not answer must not be auto-suspended');
  assert.strictEqual(core.isSuspendable(state.state), true,
    'manual suspension should still be possible');
});

test('suspending a YouTube tab stores the playback position in the suspend URL', async () => {
  const mock = makeChromeMock({
    sync: { idleTimeMinutes: 2 },
    onTabMessage: (id, msg) => {
      if (msg.command === 'ts_get_tab_state') return {state: 'suspendable:auto'};
      if (msg.command === 'ts_get_tab_scroll') return {scroll: {x: 0, y: 120}};
      if (msg.command === 'ts_get_tab_media') return {media: {currentTime: 754}};
      return undefined;
    },
  });
  mock.setTabs([{id: 11, active: true, url: 'https://www.youtube.com/watch?v=abc123', title: 'Video'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  core.suspendTab(11);
  await flush();

  const update = mock.calls.tabsUpdate.find((c) => c.id === 11 && c.info.url && c.info.url.startsWith('suspend.html'));
  assert.ok(update, 'tab should be suspended');
  const suspendUrl = new URL(update.info.url, 'chrome-extension://test-extension-id/');
  assert.strictEqual(suspendUrl.searchParams.get('media_t'), '754');
});

test('restoring a suspended YouTube tab seeks back to the stored position', async () => {
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  const suspendUrl = 'chrome-extension://test-extension-id/suspend.html'
    + '?url=' + encodeURIComponent('https://www.youtube.com/watch?v=abc123')
    + '&title=' + encodeURIComponent('Video')
    + '&scroll_x=0&scroll_y=120'
    + '&media_t=754';
  mock.setTabs([{id: 11, active: true, url: suspendUrl, title: 'Video'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  core.restoreTab(11);
  await flush();

  const update = mock.calls.tabsUpdate.find((c) => c.id === 11);
  assert.ok(update, 'tab should be restored');
  const restored = new URL(update.info.url);
  assert.strictEqual(restored.hostname, 'www.youtube.com');
  assert.strictEqual(restored.searchParams.get('v'), 'abc123');
  assert.strictEqual(restored.searchParams.get('t'), '754s');
});

test('media position is not requested for non-YouTube tabs', async () => {
  const mock = makeChromeMock({
    sync: { idleTimeMinutes: 2 },
    onTabMessage: (id, msg) => {
      if (msg.command === 'ts_get_tab_state') return {state: 'suspendable:auto'};
      if (msg.command === 'ts_get_tab_scroll') return {scroll: {x: 0, y: 0}};
      return undefined;
    },
  });
  mock.setTabs([{id: 12, active: true, url: 'https://example.com/', title: 'Example'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  core.suspendTab(12);
  await flush();

  assert.strictEqual(
    mock.calls.tabsSendMessage.some((c) => c.msg.command === 'ts_get_tab_media'), false,
    'non-YouTube tabs should not be asked for a playback position');
  const update = mock.calls.tabsUpdate.find((c) => c.id === 12 && c.info.url && c.info.url.startsWith('suspend.html'));
  assert.ok(update, 'tab should still be suspended');
  assert.ok(!update.info.url.includes('media_t'), 'suspend URL should not carry a media timestamp');
});

test('suspending a background tab ends with its placeholder discarded', async () => {
  // Measured in lab/memory-lab.js: the URL swap alone reclaims nothing, because
  // the old document stays alive in the back/forward cache. Discarding the
  // placeholder is what returns the memory — but it has to wait for the URL to
  // commit, otherwise the navigation is cancelled and the tab keeps its page.
  const mock = makeChromeMock({
    sync: { idleTimeMinutes: 2 },
    onTabMessage: (id, msg) => {
      if (msg.command === 'ts_get_tab_state') return {state: 'suspendable:auto'};
      if (msg.command === 'ts_get_tab_scroll') return {scroll: {x: 0, y: 0}};
      return undefined;
    },
  });
  mock.setTabs([{id: 20, active: false, url: 'https://example.com/', title: 'Example'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsDiscard.length = 0;
  core.suspendTab(20);
  await flush();

  const tab = mock.getTabs().find((candidate) => candidate.id === 20);
  assert.ok(tab.url.includes('suspend.html'), 'tab should be sent to the suspend page');
  assert.deepStrictEqual(mock.calls.tabsDiscard, [],
    'discard must wait until the placeholder URL has committed');

  // tabs.onUpdated announces the committed URL, which is what triggers discard.
  mock.fire.onUpdated(20, {url: tab.url}, {...tab});
  await flush();

  assert.ok(mock.calls.tabsDiscard.includes(20),
    'the suspended tab should then be discarded so its renderer goes away');
});

test('a tab suspended while active is discarded once it goes to the background', async () => {
  const mock = makeChromeMock({
    sync: { idleTimeMinutes: 2 },
    onTabMessage: (id, msg) => {
      if (msg.command === 'ts_get_tab_state') return {state: 'suspendable:auto'};
      if (msg.command === 'ts_get_tab_scroll') return {scroll: {x: 0, y: 0}};
      return undefined;
    },
  });
  mock.setTabs([{id: 21, active: true, url: 'https://example.com/', title: 'Example'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsDiscard.length = 0;
  core.suspendTab(21);
  await flush();

  assert.strictEqual(mock.calls.tabsDiscard.includes(21), false,
    'Chrome refuses to discard the active tab');

  // The user switches away: the suspended tab is now in the background.
  mock.setTabs([
    {id: 21, active: false, url: 'chrome-extension://test-extension-id/suspend.html?url=https%3A%2F%2Fexample.com%2F', title: 'Example'},
    {id: 22, active: true, url: 'https://other.com/', title: 'Other'},
  ]);

  mock.fire.onActivated({tabId: 22, windowId: 1});
  await flush();

  assert.ok(mock.calls.tabsDiscard.includes(21),
    'the backgrounded suspended tab should be discarded on activation');
});

test('a tab that lands on the suspend page is discarded by the update event', async () => {
  // Safety net for paths the worker only observes through tabs.onUpdated.
  const mock = makeChromeMock({sync: {idleTimeMinutes: 2}});
  mock.setTabs([{id: 40, active: false, url: 'https://example.com/', title: 'Example'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  const suspendUrl = 'chrome-extension://test-extension-id/suspend.html?url=' + encodeURIComponent('https://example.com/');
  mock.setTabs([
    {id: 40, active: false, url: suspendUrl, title: 'Example'},
    {id: 41, active: true, url: 'https://other.com/', title: 'Other'},
  ]);

  mock.calls.tabsDiscard.length = 0;
  mock.fire.onUpdated(40, {url: suspendUrl}, {id: 40, active: false, url: suspendUrl});
  await flush();

  assert.ok(mock.calls.tabsDiscard.includes(40),
    'a background tab showing the suspend page should be discarded');
});

test('unrelated background tabs are never discarded', async () => {
  const mock = makeChromeMock({sync: {idleTimeMinutes: 2}});
  mock.setTabs([
    {id: 30, active: false, url: 'https://example.com/', title: 'Example'},
    {id: 31, active: true, url: 'https://other.com/', title: 'Other'},
  ]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  assert.deepStrictEqual(mock.calls.tabsDiscard, [],
    'only tabs showing the suspend page may be discarded');
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
    'suspendable:no_response':           'icon-yellow-38.png',
    'suspendable:busy':                  'icon-yellow-38.png',
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

test('switching tabs does not re-scan every background tab for alarms', async () => {
  // Regression: onTabActivated called initTimersForBackgroundTabs, which issued
  // one chrome.alarms.get per background tab on every switch. At a few hundred
  // tabs that alone made the browser feel stuck. Only the tab that just left the
  // foreground needs a timer, and we know which one that was.
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  const tabs = [];
  for (let id = 1; id <= 40; id++) {
    tabs.push({ id, active: false, url: 'https://example.com/' + id, title: 'Tab ' + id });
  }
  tabs.push({ id: 41, active: true, url: 'https://example.com/active', title: 'Active' });
  mock.setTabs(tabs);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.alarmsGet.length = 0;
  mock.calls.alarmsCreate.length = 0;
  mock.fire.onActivated({ tabId: 2, windowId: 1 });
  await flush();

  assert.ok(mock.calls.alarmsGet.length <= 1,
    `activation should only check the tab that left the foreground, checked ${mock.calls.alarmsGet.length}`);
  assert.ok(mock.calls.alarmsCreate.some((c) => c.name === '41'),
    'the tab that just went to the background should get its timer');
});

test('discarding inactive suspended tabs is paced', async (t) => {
  // Regression: startup discarded every suspended tab in one pass, churning a
  // renderer per tab at once. A large session looked like a freeze.
  t.mock.timers.enable({apis: ['setTimeout']});

  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  const tabs = [];
  for (let id = 1; id <= 12; id++) {
    tabs.push({
      id,
      active: false,
      url: 'chrome-extension://test-extension-id/suspend.html?url=' + encodeURIComponent('https://example.com/' + id),
      title: 'Tab ' + id,
    });
  }
  mock.setTabs(tabs);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  assert.strictEqual(mock.calls.tabsDiscard.length, 5, 'only the first batch is discarded up front');

  t.mock.timers.tick(200);
  await flush();
  assert.strictEqual(mock.calls.tabsDiscard.length, 10, 'the second batch follows after the delay');

  t.mock.timers.tick(200);
  await flush();
  assert.strictEqual(mock.calls.tabsDiscard.length, 12, 'the last batch finishes the sweep');
});
