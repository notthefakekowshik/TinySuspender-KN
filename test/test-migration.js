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

const OWN_SUSPEND = OWN_ORIGIN + '/suspend.html?url=' + encodeURIComponent('https://example.com/') + '&title=Example';
const FOREIGN_SUSPEND = FOREIGN_ORIGIN + '/suspend.html?url=' + encodeURIComponent('https://example.com/')
  + '&title=Example&scroll_x=0&scroll_y=120';
const FOREIGN_YOUTUBE = FOREIGN_ORIGIN + '/suspend.html?url=' + encodeURIComponent('https://www.youtube.com/watch?v=abc123')
  + '&title=Video&scroll_x=0&scroll_y=120&media_t=754';
const LEGACY_SUSPEND = FOREIGN_ORIGIN + '/suspend.html#uri=' + encodeURIComponent('https://example.com/') + '&title=Example';

test('isSuspendPageUrl matches suspend pages from any install', () => {
  const core = freshCore();

  assert.strictEqual(core.isSuspendPageUrl(OWN_SUSPEND), true);
  assert.strictEqual(core.isSuspendPageUrl(FOREIGN_SUSPEND), true);
  assert.strictEqual(core.isSuspendPageUrl(LEGACY_SUSPEND), true);

  assert.strictEqual(core.isSuspendPageUrl('https://example.com/'), false);
  assert.strictEqual(core.isSuspendPageUrl(OWN_ORIGIN + '/popup.html'), false);
  assert.strictEqual(core.isSuspendPageUrl(null), false);
  assert.strictEqual(core.isSuspendPageUrl(''), false);
});

test('isSuspendedUrl still matches only this install', () => {
  const mock = makeChromeMock();
  const core = freshCore();
  core.setChrome(mock.chrome);

  assert.strictEqual(core.isSuspendedUrl(OWN_SUSPEND), true);
  assert.strictEqual(core.isSuspendedUrl(FOREIGN_SUSPEND), false);
});

test('a suspend page owned by another install counts as suspended', async () => {
  const mock = makeChromeMock();
  mock.setTabs([{id: 1, active: true, url: FOREIGN_SUSPEND, title: 'Example'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  const state = await core.getTabState(1);
  assert.strictEqual(state.state, 'suspended:suspended');
});

test('restoreTab restores a tab suspended by another install, replaying media time', async () => {
  const mock = makeChromeMock();
  mock.setTabs([{id: 7, active: true, url: FOREIGN_YOUTUBE, title: 'Video'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  core.restoreTab(7);
  await flush();

  const update = mock.calls.tabsUpdate.find((c) => c.id === 7);
  assert.ok(update, 'the foreign suspended tab should be restored');
  assert.strictEqual(new URL(update.info.url).host, 'www.youtube.com');
  assert.ok(update.info.url.includes('t=754s'), 'YouTube resume time should be re-applied');
  assert.deepStrictEqual(mock.sessionStorage.scroll_7, {x: '0', y: '120'},
    'scroll handoff should be captured for the restored tab');
});

test('adoptOrphanedSuspendedTabs re-homes only foreign suspend pages', async () => {
  const mock = makeChromeMock();
  mock.setTabs([
    {id: 1, active: false, url: FOREIGN_SUSPEND, title: 'Foreign'},
    {id: 2, active: false, url: OWN_SUSPEND, title: 'Own'},
    {id: 3, active: false, url: 'https://example.com/', title: 'Normal'},
  ]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;

  let adopted = -1;
  core.adoptOrphanedSuspendedTabs((n) => { adopted = n; });
  await flush();

  assert.strictEqual(adopted, 1, 'only the foreign suspend page should be adopted');

  const rehomed = mock.calls.tabsUpdate.filter((c) => c.info.url && c.info.url.startsWith(OWN_ORIGIN + '/suspend.html'));
  assert.strictEqual(rehomed.length, 1);
  assert.strictEqual(rehomed[0].id, 1);
  assert.ok(rehomed[0].info.url.includes('scroll_y=120'), 'params must be preserved on adoption');
});

test('countOrphanedSuspendedTabs counts only foreign suspend pages', async () => {
  const mock = makeChromeMock();
  mock.setTabs([
    {id: 1, active: false, url: FOREIGN_SUSPEND},
    {id: 2, active: false, url: OWN_SUSPEND},
    {id: 3, active: false, url: 'https://example.com/'},
  ]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  let count = -1;
  core.countOrphanedSuspendedTabs((n) => { count = n; });
  await flush();

  assert.strictEqual(count, 1);
});

test('collectSuspendedTabs parses the suspend params for export', async () => {
  const mock = makeChromeMock();
  mock.setTabs([
    {id: 1, active: false, url: FOREIGN_YOUTUBE},
    {id: 2, active: false, url: 'https://example.com/'},
  ]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  let entries = [];
  core.collectSuspendedTabs((e) => { entries = e; });
  await flush();

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].url, 'https://www.youtube.com/watch?v=abc123');
  assert.strictEqual(entries[0].title, 'Video');
  assert.strictEqual(entries[0].scroll_x, '0');
  assert.strictEqual(entries[0].scroll_y, '120');
  assert.strictEqual(entries[0].media_t, '754');
  assert.strictEqual(entries[0].raw, FOREIGN_YOUTUBE);
});

test('importSuspendedTabs recreates tabs under this install from urls and exported entries', async () => {
  const mock = makeChromeMock();
  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsCreate.length = 0;

  let imported = -1;
  core.importSuspendedTabs([FOREIGN_YOUTUBE, {raw: LEGACY_SUSPEND}], (n) => { imported = n; });
  await flush();

  assert.strictEqual(imported, 2);
  assert.strictEqual(mock.calls.tabsCreate.length, 2);

  mock.calls.tabsCreate.forEach((info) => {
    assert.ok(info.url.startsWith(OWN_ORIGIN + '/suspend.html'), 'imported tab must be owned by this install');
    assert.strictEqual(info.active, false, 'imported tabs must open in the background');
  });

  assert.ok(mock.calls.tabsCreate[0].url.includes('media_t=754'), 'query params must survive import');
  assert.ok(mock.calls.tabsCreate[1].url.includes('#uri='), 'legacy hash format must be preserved');
});

test('importSuspendedTabs ignores entries without a recoverable url', async () => {
  const mock = makeChromeMock();
  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsCreate.length = 0;

  let imported = -1;
  core.importSuspendedTabs(['https://example.com/', {raw: FOREIGN_ORIGIN + '/suspend.html'}, null, ''], (n) => { imported = n; });
  await flush();

  assert.strictEqual(imported, 0);
  assert.strictEqual(mock.calls.tabsCreate.length, 0);
});

test('onPluginInstalled adopts orphaned tabs only when the opt-in is set', async () => {
  const mock = makeChromeMock({ sync: { auto_adopt: true } });
  mock.setTabs([{id: 1, active: false, url: FOREIGN_SUSPEND}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;
  core.onPluginInstalled();
  await flush();

  assert.strictEqual(mock.calls.tabsUpdate.length, 1, 'opt-in adoption should re-home the orphan');
});

test('onPluginInstalled leaves orphaned tabs alone without the opt-in', async () => {
  const mock = makeChromeMock();
  mock.setTabs([{id: 1, active: false, url: FOREIGN_SUSPEND}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;
  core.onPluginInstalled();
  await flush();

  assert.strictEqual(mock.calls.tabsUpdate.length, 0, 'adoption must stay off by default');
});

function foreignTab(id, active) {
  return {
    id,
    active: !!active,
    url: FOREIGN_ORIGIN + '/suspend.html?url=' + encodeURIComponent('https://example.com/' + id) + '&position=' + id,
  };
}

test('adoption is paced so a large set does not flood the browser', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});

  const mock = makeChromeMock();
  mock.setTabs([foreignTab(1), foreignTab(2), foreignTab(3), foreignTab(4), foreignTab(5)]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;

  let adopted = -1;
  assert.strictEqual(core.adoptOrphanedSuspendedTabs((n) => { adopted = n; }), true);

  await flush();
  assert.strictEqual(mock.calls.tabsUpdate.length, 3, 'only the first batch should run up front');
  assert.strictEqual(adopted, -1, 'the sweep must not finish in one burst');

  t.mock.timers.tick(250);
  await flush();

  assert.strictEqual(mock.calls.tabsUpdate.length, 5, 'the remaining batch should run after the delay');
  assert.strictEqual(adopted, 5, 'the callback reports the adopted count when the sweep finishes');
});

test('adoption leaves the active tab until last', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});

  const mock = makeChromeMock();
  mock.setTabs([foreignTab(1, true), foreignTab(2), foreignTab(3), foreignTab(4)]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;
  core.adoptOrphanedSuspendedTabs(() => {});

  await flush();
  assert.deepStrictEqual(mock.calls.tabsUpdate.map((c) => c.id), [2, 3, 4],
    'background tabs are adopted first');

  t.mock.timers.tick(250);
  await flush();
  assert.deepStrictEqual(mock.calls.tabsUpdate.map((c) => c.id), [2, 3, 4, 1],
    'the tab the user is looking at is adopted last');
});

test('a second adoption request is ignored while a sweep is running', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});

  const mock = makeChromeMock();
  mock.setTabs([foreignTab(1), foreignTab(2), foreignTab(3), foreignTab(4), foreignTab(5)]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;

  let first = -1;
  let second = -1;
  assert.strictEqual(core.adoptOrphanedSuspendedTabs((n) => { first = n; }), true);
  assert.strictEqual(core.adoptOrphanedSuspendedTabs((n) => { second = n; }), false,
    'a sweep must not start while one is already running');

  t.mock.timers.tick(250);
  await flush();

  assert.strictEqual(first, 5);
  assert.strictEqual(second, -1, 'the ignored sweep must not run its callback');
  assert.strictEqual(mock.calls.tabsUpdate.length, 5, 'each tab must be adopted exactly once');
});

test('the adopt message reports a running sweep instead of starting another', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});

  const mock = makeChromeMock();
  mock.setTabs([foreignTab(1), foreignTab(2), foreignTab(3), foreignTab(4), foreignTab(5)]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;

  let second;
  core.adopt_orphaned_suspended_tabs({}, {}, () => {});
  core.adopt_orphaned_suspended_tabs({}, {}, (response) => { second = response; });

  assert.ok(second, 'a second request must be answered immediately');
  assert.strictEqual(second.running, true);
  assert.strictEqual(mock.calls.tabsUpdate.length, 3, 'the second request must not trigger extra adoptions');

  t.mock.timers.tick(250);
  await flush();
  assert.strictEqual(mock.calls.tabsUpdate.length, 5);
});

const CRAFTED_TARGETS = [
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
];

test('importSuspendedTabs refuses anything that is not a suspend page', async () => {
  // A redirect url with its own url= param is not ours to turn into a tab.
  const mock = makeChromeMock();
  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsCreate.length = 0;

  let imported = -1;
  core.importSuspendedTabs([
    'https://example.com/?url=' + encodeURIComponent('https://evil.example/steal'),
    FOREIGN_ORIGIN + '/popup.html?url=' + encodeURIComponent('https://example.com/'),
    'https://example.com/',
  ], (n) => { imported = n; });
  await flush();

  assert.strictEqual(imported, 0, 'only suspend pages may be imported');
  assert.strictEqual(mock.calls.tabsCreate.length, 0);
});

test('a suspend url cannot smuggle a script-bearing target in', async () => {
  const mock = makeChromeMock();
  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsCreate.length = 0;

  let imported = -1;
  core.importSuspendedTabs(CRAFTED_TARGETS.map((target) =>
    OWN_ORIGIN + '/suspend.html?url=' + encodeURIComponent(target)), (n) => { imported = n; });
  await flush();

  assert.strictEqual(imported, 0, 'a crafted target must not be imported');
  assert.strictEqual(mock.calls.tabsCreate.length, 0);
});

test('restoreTab refuses a target that is not a page and keeps the tab suspended', async () => {
  const mock = makeChromeMock();
  mock.setTabs(CRAFTED_TARGETS.map((target, index) => ({
    id: index + 1,
    active: false,
    url: FOREIGN_ORIGIN + '/suspend.html?url=' + encodeURIComponent(target) + '&title=x',
  })));

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;

  CRAFTED_TARGETS.forEach((unused, index) => core.restoreTab(index + 1));
  await flush();

  assert.strictEqual(mock.calls.tabsUpdate.length, 0, 'nothing may be navigated to a crafted target');
});

test('restoreTab restores the legacy hash format', async () => {
  const mock = makeChromeMock();
  mock.setTabs([{id: 4, active: true, url: LEGACY_SUSPEND, title: 'Example'}]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  core.restoreTab(4);
  await flush();

  const update = mock.calls.tabsUpdate.find((c) => c.id === 4);
  assert.ok(update, 'a #uri= suspend url is restorable now that the importer accepts them');
  assert.strictEqual(update.info.url, 'https://example.com/');
});

test('adoption leaves a foreign suspend page with a crafted target alone', async () => {
  const mock = makeChromeMock();
  mock.setTabs(CRAFTED_TARGETS.map((target, index) => ({
    id: index + 1,
    active: false,
    url: FOREIGN_ORIGIN + '/suspend.html?url=' + encodeURIComponent(target),
  })));

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;

  let adopted = -1;
  core.adoptOrphanedSuspendedTabs((n) => { adopted = n; });
  await flush();

  assert.strictEqual(adopted, 0);
  assert.strictEqual(mock.calls.tabsUpdate.length, 0);
});

test('a legacy hash target is validated before adoption', async () => {
  const mock = makeChromeMock();
  mock.setTabs([
    {id: 1, active: false, url: FOREIGN_ORIGIN + '/suspend.html#uri=' + encodeURIComponent('javascript:alert(1)')},
    {id: 2, active: false, url: LEGACY_SUSPEND},
  ]);

  const core = freshCore();
  core.setChrome(mock.chrome);
  await flush();

  mock.calls.tabsUpdate.length = 0;

  let adopted = -1;
  core.adoptOrphanedSuspendedTabs((n) => { adopted = n; });
  await flush();

  assert.strictEqual(adopted, 1, 'the restorable legacy tab is adopted, the crafted one is not');
  assert.strictEqual(mock.calls.tabsUpdate[0].id, 2);
});
