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

test('auto-suspension schedules a single periodic alarm, not one per tab', async () => {
  // Regression: the old model created one alarm per background tab, named by tab
  // id. Chrome caps an extension at 500 alarms, so a larger session silently
  // stopped getting timers past the cap — and every restored tab fired a
  // chrome.alarms.get of its own.
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  mock.setTabs([
    {id: 1, active: false, url: 'https://a.com/', title: 'A'},
    {id: 2, active: false, url: 'https://b.com/', title: 'B'},
    {id: 3, active: true,  url: 'https://c.com/', title: 'C'},
  ]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  assert.deepStrictEqual(mock.calls.alarmsCreate.map((c) => c.name), ['ts-autosuspend'],
    'exactly one alarm should be scheduled, whatever the tab count');
  assert.strictEqual(mock.calls.alarmsCreate[0].opts.periodInMinutes, 1);
});

test('the scheduler suspends a background tab that has been idle past the threshold', async () => {
  const mock = makeChromeMock({
    sync: { idleTimeMinutes: 2 },
    onTabMessage: (id, msg) => {
      if (msg.command === 'ts_get_tab_state') return {state: 'suspendable:auto'};
      if (msg.command === 'ts_get_tab_scroll') return {scroll: {x: 0, y: 0}};
      return undefined;
    },
  });
  mock.setTabs([{
    id: 5, active: false, url: 'https://idle.example.com/', title: 'Idle',
    lastAccessed: Date.now() - 3 * 60000,
  }]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;
  mock.fire.onAlarm({name: 'ts-autosuspend'});
  await flush();

  const update = mock.calls.tabsUpdate.find((c) => c.id === 5 && c.info.url && c.info.url.startsWith('suspend.html'));
  assert.ok(update, 'an idle background tab should be sent to the suspend page');
});

test('the scheduler leaves a recently used background tab alone', async () => {
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 30 } });
  mock.setTabs([{
    id: 6, active: false, url: 'https://busy.example.com/', title: 'Busy',
    lastAccessed: Date.now() - 5 * 1000,
  }]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;
  mock.fire.onAlarm({name: 'ts-autosuspend'});
  await flush();

  assert.strictEqual(mock.calls.tabsUpdate.length, 0, 'a tab used seconds ago is not idle');
});

test('the scheduler caps how many tabs it suspends per tick', async () => {
  const mock = makeChromeMock({
    sync: { idleTimeMinutes: 2 },
    onTabMessage: (id, msg) => {
      if (msg.command === 'ts_get_tab_state') return {state: 'suspendable:auto'};
      if (msg.command === 'ts_get_tab_scroll') return {scroll: {x: 0, y: 0}};
      return undefined;
    },
  });

  const tabs = [];
  for (let id = 1; id <= 25; id++) {
    tabs.push({
      id, active: false, url: 'https://idle.example.com/' + id, title: 'Idle ' + id,
      lastAccessed: Date.now() - 60 * 60000,
    });
  }
  mock.setTabs(tabs);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;
  mock.fire.onAlarm({name: 'ts-autosuspend'});
  await flush(20);

  const suspended = mock.calls.tabsUpdate.filter((c) => c.info.url && c.info.url.startsWith('suspend.html'));
  assert.strictEqual(suspended.length, 10,
    'only AUTOSUSPEND_PER_TICK tabs should be suspended per tick');
});

test('a tab without lastAccessed is not suspended on the first tick', async () => {
  // Fallback path: without lastAccessed we start our own clock, so the tab only
  // becomes eligible once it has been seen idle for the threshold.
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  mock.setTabs([{id: 8, active: false, url: 'https://nofield.example.com/', title: 'No field'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;
  mock.fire.onAlarm({name: 'ts-autosuspend'});
  await flush();

  assert.strictEqual(mock.calls.tabsUpdate.length, 0, 'the fallback clock starts on the first tick');
  assert.strictEqual(typeof core.fallbackIdleSince[8], 'number', 'the fallback clock should be recorded');
});

test('automatic suspension disabled schedules no alarm', async () => {
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 0 } });
  mock.setTabs([{id: 1, active: false, url: 'https://a.com/', title: 'A'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  assert.deepStrictEqual(mock.calls.alarmsCreate, [],
    'no scheduler alarm should exist when automatic suspension is off');
});

test('turning automatic suspension off clears the scheduler alarm', async () => {
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 5 } });
  mock.setTabs([{id: 1, active: false, url: 'https://a.com/', title: 'A'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.syncStorage.idleTimeMinutes = 0;
  mock.fire.onStorageChanged({idleTimeMinutes: {newValue: 0, oldValue: 5}}, 'sync');
  await flush();

  assert.ok(mock.calls.alarmsClear.includes('ts-autosuspend'),
    'the scheduler alarm should be cleared at 0 minutes');
});

test('switching tabs does not touch the alarms at all', async () => {
  // The per-tab model re-checked and created timers on every switch. One alarm
  // owns auto-suspension now, so activation must not add, remove or re-check any.
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  mock.setTabs([
    {id: 1, active: false, url: 'https://a.com/', title: 'A'},
    {id: 2, active: false, url: 'https://b.com/', title: 'B'},
    {id: 3, active: true,  url: 'https://c.com/', title: 'C'},
  ]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.alarmsCreate.length = 0;
  mock.calls.alarmsClear.length = 0;
  mock.calls.alarmsGet.length = 0;

  mock.setTabs([
    {id: 1, active: true,  url: 'https://a.com/', title: 'A'},
    {id: 2, active: false, url: 'https://b.com/', title: 'B'},
    {id: 3, active: false, url: 'https://c.com/', title: 'C'},
  ]);
  mock.fire.onActivated({tabId: 1, windowId: 1});
  await flush();

  assert.deepStrictEqual(mock.calls.alarmsCreate, [], 'switching must not create alarms');
  assert.deepStrictEqual(mock.calls.alarmsClear, [], 'switching must not clear alarms');
  assert.deepStrictEqual(mock.calls.alarmsGet, [], 'switching must not re-check alarms');
});

test('onTabRemoved clears the tab\'s state and its idle clock', async () => {
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  mock.setTabs([{id: 5, active: false, url: 'https://x.com/'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  core.tabState[5] = {state: 'suspendable:tab_whitelist'};
  core.saveTabScroll(5, {x: '1', y: '2'});
  core.fallbackIdleSince[5] = Date.now();

  mock.fire.onRemoved(5, {});
  await flush();

  assert.strictEqual(core.tabState[5], undefined,
    'closed tab\'s tabState entry should be dropped');
  assert.strictEqual(core.tabScrolls[5], undefined,
    'closed tab\'s scroll handoff entry should be dropped');
  assert.strictEqual(mock.sessionStorage.scroll_5, undefined,
    'closed tab\'s persisted scroll handoff should be removed');
  assert.strictEqual(core.fallbackIdleSince[5], undefined,
    'closed tab\'s idle clock should be dropped');
});

test('local-namespace storage writes do not touch the scheduler alarm', async () => {
  // Regression: storage.onChanged previously rebuilt alarms for every
  // local-namespace write (saveState fires constantly from popup actions).
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  mock.setTabs([{id: 1, active: false, url: 'https://a.com/'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  const createsBefore = mock.calls.alarmsCreate.length;
  mock.fire.onStorageChanged({tabState: {newValue: {}, oldValue: {}}}, 'local');
  await flush();

  assert.strictEqual(mock.calls.alarmsCreate.length, createsBefore,
    'local-namespace storage changes must not touch alarms');
});

test('a sync change keeps exactly one scheduler alarm', async () => {
  const mock = makeChromeMock({ sync: { idleTimeMinutes: 2 } });
  mock.setTabs([{id: 1, active: false, url: 'https://a.com/'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.syncStorage.idleTimeMinutes = 5;
  mock.fire.onStorageChanged({idleTimeMinutes: {newValue: 5, oldValue: 2}}, 'sync');
  await flush();

  assert.deepStrictEqual(mock.calls.alarmsCreate.map((c) => c.name), ['ts-autosuspend'],
    'a settings change must not spawn per-tab alarms');
  assert.deepStrictEqual(mock.calls.alarmsClear, [],
    'the existing scheduler alarm should be left in place');
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

test('suspending a background tab ends with its placeholder discarded', async (t) => {
  // Measured in lab/memory-lab.js: the URL swap alone reclaims nothing, because
  // the old document stays alive in the back/forward cache. Discarding the
  // placeholder is what returns the memory — but it has to wait for the URL to
  // commit, otherwise the navigation is cancelled and the tab keeps its page.
  // It is then held briefly so the placeholder can render its own title and icon.
  t.mock.timers.enable({apis: ['setTimeout']});

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

  // tabs.onUpdated announces the committed URL, which schedules the discard.
  mock.fire.onUpdated(20, {url: tab.url}, {...tab});
  await flush();

  assert.deepStrictEqual(mock.calls.tabsDiscard, [],
    'discard must not beat the placeholder\'s own render');

  t.mock.timers.tick(1500);
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

test('a tab that lands on the suspend page is discarded by the update event', async (t) => {
  // Safety net for paths the worker only observes through tabs.onUpdated.
  t.mock.timers.enable({apis: ['setTimeout']});

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

  assert.deepStrictEqual(mock.calls.tabsDiscard, [],
    'the placeholder gets a grace period to render itself first');

  t.mock.timers.tick(1500);
  await flush();

  assert.ok(mock.calls.tabsDiscard.includes(40),
    'a background tab showing the suspend page should be discarded after the grace');
});

test('a pending discard is cancelled when the placeholder is activated', async (t) => {
  // The user clicked the placeholder: it must stay rendered while they look at
  // it, so the site icon is visible and the page is still clickable to restore.
  t.mock.timers.enable({apis: ['setTimeout']});

  const mock = makeChromeMock({sync: {idleTimeMinutes: 2}});
  mock.setTabs([{id: 50, active: false, url: 'https://example.com/', title: 'Example'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  const suspendUrl = 'chrome-extension://test-extension-id/suspend.html?url=' + encodeURIComponent('https://example.com/');
  mock.setTabs([{id: 50, active: false, url: suspendUrl, title: 'Example'}]);

  mock.calls.tabsDiscard.length = 0;
  mock.fire.onUpdated(50, {url: suspendUrl}, {id: 50, active: false, url: suspendUrl});
  await flush();

  // The user activates it before the grace elapses.
  mock.setTabs([{id: 50, active: true, url: suspendUrl, title: 'Example'}]);
  mock.fire.onActivated({tabId: 50, windowId: 1});
  await flush();

  t.mock.timers.tick(1500);
  await flush();

  assert.strictEqual(mock.calls.tabsDiscard.includes(50), false,
    'the placeholder the user is looking at must not be discarded');
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
