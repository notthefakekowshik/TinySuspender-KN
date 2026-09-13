const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SUSPEND_PATH = path.resolve(__dirname, '../src/tiny-suspender/js/suspend.js');

const DIM_RESULT = 'data:image/png;base64,DIM';
const EXTENSION_ORIGIN = 'chrome-extension://test-extension-id';

// Everything suspend.js creates or loads, kept so tests can inspect where the
// favicon ended up.
let pendingImages = [];
let failedSources = new Set();
let canvases = [];
let links = [];
let pageIcons = [];

function makeElement(tagName) {
  return {
    tagName,
    attributes: {},
    children: [],
    textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    appendChild(child) { this.children.push(child); return child; },
  };
}

const nodes = {
  '.title .description': makeElement('a'),
  '.title .url': makeElement('a'),
  '.title .icon': makeElement('div'),
  head: makeElement('head'),
};

// Mirrors the browser: an image from another origin taints the canvas, so
// exporting it throws. Same-origin images (the favicon API) and data: images
// do not.
function makeCanvas() {
  let ctx = {
    globalAlpha: 1,
    drawnSource: null,
    drawImage: (img) => { ctx.drawnSource = img.src; },
  };

  let canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL: () => {
      if (/^https?:/i.test(ctx.drawnSource || '')) {
        throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
      }
      return DIM_RESULT;
    },
  };

  canvases.push(canvas);
  return canvas;
}

class FakeImage {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.onload = null;
    this.onerror = null;
    this._src = '';
  }

  set src(value) {
    this._src = value;
    pendingImages.push(this);
  }

  get src() { return this._src; }
}

const documentMock = {
  title: '',
  onclick: null,
  querySelector: (selector) => nodes[selector],
  createElement: (tagName) => {
    if (tagName === 'canvas') return makeCanvas();

    let element = makeElement(tagName);
    if (tagName === 'link') links.push(element);
    if (tagName === 'img') pageIcons.push(element);
    return element;
  },
  getElementsByTagName: (tagName) => (tagName === 'head' ? [nodes.head] : []),
};

const chromeMock = {
  runtime: {
    id: 'test-extension-id',
    getURL: (resource) => EXTENSION_ORIGIN + resource,
    sendMessage: () => {},
  },
  tabs: {
    query: (query, callback) => callback([]),
  },
};

global.document = documentMock;
global.location = { href: EXTENSION_ORIGIN + '/suspend.html' };
global.Image = FakeImage;
global.chrome = chromeMock;

const suspend = require(SUSPEND_PATH);
suspend.setChrome(chromeMock);

// Settles every queued image load, including the ones queued while a failure is
// being handled: the favicon sources are walked one image at a time.
async function flush() {
  for (let round = 0; round < 10 && pendingImages.length; round++) {
    let batch = pendingImages;
    pendingImages = [];

    batch.forEach((img) => {
      if (failedSources.has(img.src)) {
        if (img.onerror) img.onerror();
        return;
      }
      img.width = 32;
      img.height = 32;
      if (img.onload) img.onload();
    });

    await new Promise((resolve) => setImmediate(resolve));
  }
}

function faviconApiUrl(pageUrl) {
  let url = new URL(EXTENSION_ORIGIN + '/_favicon/');
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.toString();
}

function suspendHref(params) {
  let url = new URL(EXTENSION_ORIGIN + '/suspend.html');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function reset(href, failed = []) {
  pendingImages = [];
  failedSources = new Set(failed);
  canvases = [];
  links = [];
  pageIcons = [];
  nodes['.title .icon'].children = [];
  nodes['.title .description'].attributes = {};
  nodes['.title .url'].attributes = {};
  documentMock.title = '';
  global.location = { href };
}

test('a suspended tab keeps the site favicon when the canvas is tainted', async () => {
  // Regression: a cross-origin favicon made canvas.toDataURL() throw inside
  // img.onload, so the icon link was never added and every suspended tab fell
  // back to the extension's power icon.
  reset(suspendHref({
    url: 'https://example.com/page',
    title: 'Example',
    favIconUrl: 'https://example.com/favicon.ico',
  }), [faviconApiUrl('https://example.com/page')]);

  suspend.init();
  await flush();

  assert.strictEqual(links.length, 1, 'the tab icon link must still be added');
  assert.strictEqual(links[0].href, 'https://example.com/favicon.ico',
    'an undimmable favicon should be used as-is instead of no icon at all');
});

test('a same-origin favicon is dimmed before it becomes the tab icon', async () => {
  reset(suspendHref({
    url: 'https://example.com/page',
    title: 'Example',
    favIconUrl: 'https://example.com/favicon.ico',
  }));

  suspend.init();
  await flush();

  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].href, DIM_RESULT, 'the dimmed copy should be used');
  assert.strictEqual(canvases.at(-1).getContext().globalAlpha, 0.5,
    'the dimmed favicon should stay identifiable, not fade out');
  assert.strictEqual(pageIcons[0].getAttribute('src'), faviconApiUrl('https://example.com/page'),
    'the suspended page should show the favicon that actually loaded');
});

test('a suspended tab without a favIconUrl still gets a site icon', async () => {
  // The "open link in new suspended tab" context menu builds its suspend URL
  // without favIconUrl, so the favicon API is the only source for those tabs.
  reset(suspendHref({url: 'https://news.example.com/story', title: 'Story'}));

  suspend.init();
  await flush();

  assert.strictEqual(links.length, 1);
  assert.strictEqual(pageIcons[0].getAttribute('src'), faviconApiUrl('https://news.example.com/story'),
    'the favicon API should be asked for the original page');
});

test('when every favicon source fails, Chrome\'s default icon is left alone', async () => {
  let pageUrl = 'https://example.com/page';
  reset(suspendHref({
    url: pageUrl,
    title: 'Example',
    favIconUrl: 'https://example.com/missing.ico',
  }), [faviconApiUrl(pageUrl), 'https://example.com/missing.ico']);

  suspend.init();
  await flush();

  assert.strictEqual(links.length, 0, 'no icon link should point at a broken favicon');
  assert.strictEqual(pageIcons.length, 0);
});
