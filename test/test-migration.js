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
