const { test } = require('node:test');
const assert = require('node:assert');

const ts = require('../src/tiny-suspender/js/core.js');

test('isMatch: prefix match against bare URL', () => {
  assert.strictEqual(ts.isMatch('https://google.com/', 'https://google.com/maps'), true);
  assert.strictEqual(ts.isMatch('https://google.com/', 'https://example.com/'), false);
});

test('isMatch: regex match when pattern is wrapped in slashes', () => {
  assert.strictEqual(ts.isMatch('/google/', 'https://www.google.com/search'), true);
  assert.strictEqual(ts.isMatch('/^https:\\/\\/mail\\./', 'https://mail.example.com'), true);
  assert.strictEqual(ts.isMatch('/google/', 'https://example.com/'), false);
});

test('isMatch: short patterns that look slash-wrapped are not regex', () => {
  // a 2-char "/x" or "/" shouldn't be treated as regex (length > 2 guard).
  assert.strictEqual(ts.isMatch('//', 'https://example.com/'), false);
});

test('isSystemPage recognizes chrome internal URLs', () => {
  assert.strictEqual(ts.isSystemPage({url: 'chrome://extensions', title: 'Extensions'}), true);
  assert.strictEqual(ts.isSystemPage({url: 'chrome-extension://abc/suspend.html', title: 'X'}), true);
  assert.strictEqual(ts.isSystemPage({url: 'edge://settings', title: 'X'}), true);
  assert.strictEqual(ts.isSystemPage({url: 'about:blank', title: 'X'}), true);
});

test('isSystemPage flags empty/missing URLs and new-tab titles', () => {
  assert.strictEqual(ts.isSystemPage({url: '', title: 'X'}), true);
  assert.strictEqual(ts.isSystemPage({url: 'https://example.com/', title: 'New Tab'}), true);
  assert.strictEqual(ts.isSystemPage(null), true);
});

test('isSystemPage accepts regular web pages', () => {
  assert.strictEqual(ts.isSystemPage({url: 'https://example.com/', title: 'Example'}), false);
});

test('isSuspendable splits state string on colon', () => {
  assert.strictEqual(ts.isSuspendable('suspendable:auto'), true);
  assert.strictEqual(ts.isSuspendable('suspendable:audible'), true);
  assert.strictEqual(ts.isSuspendable('suspended:suspended'), false);
  assert.strictEqual(ts.isSuspendable('nonsuspendible:system_page'), false);
  assert.strictEqual(ts.isSuspendable(null), false);
  assert.strictEqual(ts.isSuspendable(''), false);
});

test('isAutoSuspendable only matches the exact suspendable:auto state', () => {
  assert.strictEqual(ts.isAutoSuspendable('suspendable:auto'), true);
  assert.strictEqual(ts.isAutoSuspendable('suspendable:audible'), false);
  assert.strictEqual(ts.isAutoSuspendable('suspendable:form_changed'), false);
  assert.strictEqual(ts.isAutoSuspendable('suspended:suspended'), false);
  assert.strictEqual(ts.isAutoSuspendable(null), false);
});

test('isYoutubeUrl matches YouTube hosts only', () => {
  assert.strictEqual(ts.isYoutubeUrl('https://www.youtube.com/watch?v=abc'), true);
  assert.strictEqual(ts.isYoutubeUrl('https://m.youtube.com/watch?v=abc'), true);
  assert.strictEqual(ts.isYoutubeUrl('https://music.youtube.com/watch?v=abc'), true);
  assert.strictEqual(ts.isYoutubeUrl('https://youtu.be/abc'), true);
  assert.strictEqual(ts.isYoutubeUrl('https://notyoutube.com/watch?v=abc'), false);
  assert.strictEqual(ts.isYoutubeUrl('https://example.com/youtube.com'), false);
  assert.strictEqual(ts.isYoutubeUrl(null), false);
});

test('addMediaStartTime appends a YouTube resume timestamp', () => {
  assert.strictEqual(
    ts.addMediaStartTime('https://www.youtube.com/watch?v=abc', '754'),
    'https://www.youtube.com/watch?v=abc&t=754s');
  assert.strictEqual(
    ts.addMediaStartTime('https://www.youtube.com/watch?v=abc&t=30s', '754'),
    'https://www.youtube.com/watch?v=abc&t=754s');
  assert.strictEqual(
    ts.addMediaStartTime('https://example.com/watch?v=abc', '754'),
    'https://example.com/watch?v=abc');
});

test('package.json version stays in sync with the extension manifest', () => {
  const manifest = require('../src/tiny-suspender/manifest.json');
  const pkg = require('../package.json');
  assert.strictEqual(pkg.version, manifest.version);
});
