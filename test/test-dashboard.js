const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { makeChromeMock } = require('./helpers/mock-chrome');

const DASHBOARD_PATH = path.resolve(__dirname, '../src/tiny-suspender/js/dashboard.js');

const OWN_ID = 'test-extension-id';
const OTHER_ID = 'other-extension-id';
const BYTES_PER_TAB = 150 * 1024 * 1024;

// Requiring the module must not touch the DOM: init() is only reached when a
// `chrome` global exists, so a bare require in Node leaves the page alone and
// the pure methods can be exercised directly.
const dashboard = require(DASHBOARD_PATH);

const mock = makeChromeMock();
dashboard.setChrome(mock.chrome);

function suspendUrl(extensionId, pageUrl, title) {
  let url = new URL('chrome-extension://' + extensionId + '/suspend.html');
  url.searchParams.set('url', pageUrl);
  url.searchParams.set('title', title || '');
  return url.toString();
}

function legacySuspendUrl(extensionId, pageUrl) {
  return 'chrome-extension://' + extensionId + '/suspend.html#uri=' + encodeURIComponent(pageUrl) + '&title=Legacy';
}

test('classifyTabs partitions every tab into exactly one bucket', () => {
  const tabs = [
    {id: 1, url: suspendUrl(OWN_ID, 'https://a.example.com/1'), discarded: true},
    {id: 2, url: suspendUrl(OTHER_ID, 'https://b.example.com/2'), discarded: true},
    {id: 3, url: 'https://c.example.com/', discarded: true},
    {id: 4, url: 'https://d.example.com/'},
    {id: 5, url: 'chrome://settings/'},
  ];

  const buckets = dashboard.classifyTabs(tabs);

  assert.strictEqual(buckets.own, 1);
  assert.strictEqual(buckets.orphaned, 1);
  assert.strictEqual(buckets.discarded, 1);
  assert.strictEqual(buckets.live, 2);
  assert.strictEqual(buckets.own + buckets.orphaned + buckets.discarded + buckets.live, tabs.length);
});

test('own suspended tabs are not double-counted as discarded', () => {
  // Regression: own suspended tabs are discarded too (swap, then discard), so a
  // plain tab.discarded count subtracts them twice and drives "live" negative.
  const tabs = [
    {id: 1, url: suspendUrl(OWN_ID, 'https://a.example.com/'), discarded: true},
    {id: 2, url: suspendUrl(OWN_ID, 'https://b.example.com/'), discarded: true},
    {id: 3, url: 'https://live.example.com/'},
  ];

  const buckets = dashboard.classifyTabs(tabs);

  assert.strictEqual(buckets.own, 2);
  assert.strictEqual(buckets.discarded, 0, 'a discarded suspend page is still a suspended tab');
  assert.strictEqual(buckets.live, 1, 'live must never go negative');
  assert.strictEqual(buckets.own + buckets.orphaned + buckets.discarded + buckets.live, tabs.length);
});

test('classifyTabs treats an empty list as four empty buckets', () => {
  const buckets = dashboard.classifyTabs([]);
  assert.deepStrictEqual(buckets, {own: 0, orphaned: 0, discarded: 0, live: 0});
});

test('suspendedPages returns own and orphaned suspend tabs only', () => {
  const tabs = [
    {id: 1, url: suspendUrl(OWN_ID, 'https://a.example.com/')},
    {id: 2, url: suspendUrl(OTHER_ID, 'https://b.example.com/')},
    {id: 3, url: 'https://c.example.com/', discarded: true},
    {id: 4, url: 'https://d.example.com/'},
  ];

  const suspended = dashboard.suspendedPages(tabs);

  assert.strictEqual(suspended.length, 2);
  assert.ok(suspended.every((tab) => tab.url.includes('/suspend.html')));
  assert.deepStrictEqual(suspended.map((tab) => tab.id), [1, 2]);
});

test('groupByDomain counts domains and orders them by suspended-tab count', () => {
  const tabs = [
    {url: suspendUrl(OWN_ID, 'https://news.example.com/a')},
    {url: suspendUrl(OWN_ID, 'https://news.example.com/b')},
    {url: suspendUrl(OTHER_ID, 'https://shop.example.org/c')},
    {url: suspendUrl(OWN_ID, 'https://docs.example.net/d')},
  ];

  const groups = dashboard.groupByDomain(tabs);

  assert.deepStrictEqual(groups.map((group) => group.domain),
    ['news.example.com', 'docs.example.net', 'shop.example.org']);
  assert.deepStrictEqual(groups.map((group) => group.count), [2, 1, 1]);
});

test('groupByDomain falls back to the legacy #uri= hash param', () => {
  const tabs = [
    {url: legacySuspendUrl(OWN_ID, 'https://legacy.example.com/page')},
    {url: legacySuspendUrl(OTHER_ID, 'https://legacy.example.com/other')},
  ];

  assert.deepStrictEqual(dashboard.groupByDomain(tabs), [{domain: 'legacy.example.com', count: 2}]);
});

test('groupByDomain puts unrecoverable entries in the (unknown) bucket', () => {
  const tabs = [
    {url: 'chrome-extension://' + OWN_ID + '/suspend.html'},
    {url: 'chrome-extension://' + OWN_ID + '/suspend.html?url=' + encodeURIComponent('/relative-only')},
  ];

  assert.deepStrictEqual(dashboard.groupByDomain(tabs), [{domain: '(unknown)', count: 2}]);
});

test('estimateReclaimedBytes multiplies the count by the per-tab constant', () => {
  assert.strictEqual(dashboard.estimateReclaimedBytes(0), 0);
  assert.strictEqual(dashboard.estimateReclaimedBytes(1), BYTES_PER_TAB);
  assert.strictEqual(dashboard.estimateReclaimedBytes(7), 7 * BYTES_PER_TAB);
});

test('formatBytes renders MB and GB', () => {
  assert.strictEqual(dashboard.formatBytes(150 * 1024 * 1024), '150 MB');
  assert.strictEqual(dashboard.formatBytes(320 * 1024 * 1024), '320 MB');
  assert.strictEqual(dashboard.formatBytes(1024 * 1024 * 1024), '1 GB');
  assert.strictEqual(dashboard.formatBytes(10 * BYTES_PER_TAB), '1.5 GB');
  assert.strictEqual(dashboard.formatBytes(0), '0 MB');
});

test('historyRows lists the newest samples first with the same estimate', () => {
  const samples = [
    {at: 1, own: 2, orphaned: 0, discarded: 3, live: 5},
    {at: 2, own: 4, orphaned: 1, discarded: 0, live: 2},
  ];

  const rows = dashboard.historyRows(samples);

  assert.deepStrictEqual(rows.map((row) => row.at), [2, 1], 'newest first');
  assert.deepStrictEqual(rows.map((row) => row.suspended), [5, 2],
    'suspended means own plus orphaned, not the discarded bucket');
  assert.strictEqual(rows[0].estimated, 5 * BYTES_PER_TAB);
});

test('historyRows caps the table and tolerates an empty window', () => {
  const samples = [];
  for (let i = 0; i < 30; i++) samples.push({at: i, own: i, orphaned: 0, discarded: 0, live: 0});

  const rows = dashboard.historyRows(samples, 5);

  assert.strictEqual(rows.length, 5);
  assert.deepStrictEqual(rows.map((row) => row.at), [29, 28, 27, 26, 25]);
  assert.deepStrictEqual(dashboard.historyRows([]), []);
});

test('reclaimSummary explains what the reclaim skipped', () => {
  assert.strictEqual(
    dashboard.reclaimSummary({total: 5, processed: 5, suspended: 3, skipped: {'suspendable:form_changed': 2}}),
    'Suspended 3 of 5 idle tab(s). Skipped unsaved form data (2).');

  assert.strictEqual(
    dashboard.reclaimSummary({total: 2, processed: 2, suspended: 2, skipped: {}}),
    'Suspended 2 of 2 idle tab(s).');

  assert.strictEqual(
    dashboard.reclaimSummary({total: 0, processed: 0, suspended: 0, skipped: {}}),
    'No background tab has been idle that long.');

  // An unmapped state still says something instead of printing nothing.
  assert.strictEqual(
    dashboard.reclaimSummary({total: 1, processed: 1, suspended: 0, skipped: {'suspendable:new_state': 1}}),
    'Suspended 0 of 1 idle tab(s). Skipped suspendable:new_state (1).');
});
