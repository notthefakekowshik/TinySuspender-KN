#!/usr/bin/env node
'use strict';

// Tiny Suspender memory lab.
//
// Answers, with a real browser and real measurements, the questions the
// extension cannot answer from inside: what does suspension actually reclaim,
// do same-site tabs share a renderer process, does suspending one of two
// same-site tabs free anything, and does the busy sensor block suspension?
//
// Zero dependencies: it launches a Chromium-based browser with this extension
// loaded, serves local test pages over http/ws, drives the extension's service
// worker over the DevTools protocol, and samples renderer processes with `ps`.
//
//   node lab/memory-lab.js              headless (default)
//   node lab/memory-lab.js --headed     visible window
//   node lab/memory-lab.js --keep      leave the browser running afterwards
//
// Branded Chrome >= 137 refuses --load-extension, so this prefers Brave,
// Chromium or Chrome for Testing, and says so if none of them is installed.

const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const EXTENSION_DIR = path.resolve(__dirname, '../src/tiny-suspender');
const PAGES_DIR = path.join(__dirname, 'pages');
const PORT = 8123;

const BASE_A = `http://localhost:${PORT}`;
const BASE_B = `http://127.0.0.1:${PORT}`;

const argv = process.argv.slice(2);
const HEADLESS = !argv.includes('--headed');
const KEEP = argv.includes('--keep');

const measurements = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Never leave a browser behind, even when output is piped into something that
// closes early (EPIPE) or the run is interrupted.
let activeBrowser = null;
let activeProfile = null;

function killBrowser() {
  if (activeBrowser && !KEEP) {
    try {
      activeBrowser.kill('SIGTERM');
    }
    catch (error) {
      // already gone
    }
    activeBrowser = null;
  }
}

function cleanUp() {
  killBrowser();
  if (activeProfile && !KEEP) {
    try {
      // The browser may still be shutting down and holding files.
      fs.rmSync(activeProfile, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    }
    catch (error) {
      // best effort
    }
    activeProfile = null;
  }
}

process.on('exit', cleanUp);
process.on('SIGINT', () => { cleanUp(); process.exit(1); });
process.on('SIGTERM', () => { cleanUp(); process.exit(1); });
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') {
    cleanUp();
    process.exit(0);
  }
});

function record(scenario, what, value) {
  measurements.push({scenario, what, value});
  console.log(`  -> ${what}: ${value}`);
}

// ---------------------------------------------------------------- browser ---

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('no Chromium-based browser found; set CHROME_PATH');
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

// -------------------------------------------------------- test page server ---

// A real favicon for the test pages, so Chrome's favicon store has something to
// hand back through /_favicon/ — which is where the suspend page reads the icon
// it dims. 16x16 solid PNG, built here so the lab stays file-free.
const FAVICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4oxFFEmIY1TCqYfhqAACUeF4Q+VWXnAAAAABJRU5ErkJggg==',
  'base64');

function startServer() {
  const sockets = new Set();

  const server = http.createServer((request, response) => {
    const [pathPart, queryPart] = request.url.split('?');

    if (pathPart === '/favicon.ico') {
      response.writeHead(200, {'content-type': 'image/png', 'cache-control': 'no-cache'});
      response.end(FAVICON_PNG);
      return;
    }

    const name = (pathPart.replace(/^\//, '') || 'static').replace(/[^a-z]/gi, '');
    const query = new URLSearchParams(queryPart || '');
    const file = path.join(PAGES_DIR, `${name}.html`);

    if (!fs.existsSync(file)) {
      response.writeHead(404);
      response.end('not found');
      return;
    }

    // no-store keeps a document out of the back/forward cache, so the probe
    // pages ask for it explicitly with ?cache=no; everything else revalidates.
    const cacheControl = query.get('cache') === 'no' ? 'no-store' : 'no-cache';

    response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': cacheControl});
    response.end(fs.readFileSync(file));
  });

  // Minimal RFC6455 handshake: enough for the socket page to hold an open
  // connection. Frames are never exchanged, so no framing code is needed.
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);

    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      // A close frame (opcode 0x8) must tear the connection down too, otherwise
      // the page's socket stays in CLOSING and never fires its close event.
      if ((chunk[0] & 0x0f) === 0x8) socket.destroy();
    });
  });

  return new Promise((resolve) => {
    server.listen(PORT, () => {
      resolve({
        close: () => {
          sockets.forEach((socket) => socket.destroy());
          server.close();
        },
      });
    });
  });
}

// ------------------------------------------------------------------- cdp ---

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;

      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, {once: true});
      socket.addEventListener('error', () => reject(new Error('devtools socket failed: ' + url)), {once: true});
    });
    return new Cdp(socket);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const message = {id, method, params};
    if (sessionId) message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.socket.send(JSON.stringify(message));
    });
  }

  async attach(targetId) {
    const {sessionId} = await this.send('Target.attachToTarget', {targetId, flatten: true});
    return sessionId;
  }

  async evaluate(sessionId, expression) {
    const result = await this.send('Runtime.evaluate',
      {expression, awaitPromise: true, returnByValue: true}, sessionId);

    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new Error('evaluate failed: ' + (detail || result.exceptionDetails.text));
    }

    return result.result.value;
  }

  async targets() {
    const {targetInfos} = await this.send('Target.getTargets');
    return targetInfos;
  }

  close() {
    try {
      this.socket.close();
    }
    catch (error) {
      // already closed
    }
  }
}

async function launchBrowser(userDataDir) {
  const binary = findBrowser();
  const port = await freePort();

  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${EXTENSION_DIR}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    // Keep the browser from discarding tabs on its own; that would silently
    // reclaim memory in the middle of the comparison and hide the difference.
    '--disable-features=MemorySaver,HighEfficiencyModeAvailable',
    '--window-size=1100,700',
  ];

  if (HEADLESS) args.unshift('--headless=new');
  args.push('about:blank');

  console.log(`Browser: ${binary}`);
  console.log(`Mode: ${HEADLESS ? 'headless' : 'headed'}${KEEP ? ', kept open' : ''}`);

  const proc = spawn(binary, args, {stdio: 'ignore'});

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return {proc, port, binary, userDataDir};
    }
    catch (error) {
      // not up yet
    }
    await sleep(200);
  }

  throw new Error('browser never exposed a devtools endpoint');
}

// -------------------------------------------------------------- extension ---

async function findServiceWorker(cdp) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const targets = await cdp.targets();
    const worker = targets.find((target) =>
      target.url.startsWith('chrome-extension://') && target.url.endsWith('/js/core.js'));

    if (worker) return worker;
    await sleep(250);
  }

  throw new Error('extension service worker never appeared — the browser may refuse --load-extension '
    + '(Chrome branded builds >= 137 do); try Brave, Chromium or --headed');
}

const EXPRESSION_TABS = '(async () => (await chrome.tabs.query({})).map((tab) => '
  + '({id: tab.id, url: tab.url, active: tab.active, discarded: tab.discarded})))()';

async function chromeTabs(cdp, swSession) {
  return cdp.evaluate(swSession, EXPRESSION_TABS);
}

async function findChromeTabId(cdp, swSession, url) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const tabs = await chromeTabs(cdp, swSession);
    const match = tabs.find((tab) => tab.url === url);
    if (match) return match.id;
    await sleep(150);
  }
  throw new Error('no chrome tab found for ' + url);
}

async function tabUrl(cdp, swSession, tabId) {
  // Query rather than get(): discarding a tab replaces its WebContents, so the
  // old tab id stops resolving (no events are fired for that either).
  const tabs = await chromeTabs(cdp, swSession);
  const tab = tabs.find((candidate) => candidate.id === tabId);
  return tab ? tab.url : null;
}

async function findTabId(cdp, swSession, urlPart) {
  const tabs = await chromeTabs(cdp, swSession);
  const match = tabs.find((tab) => tab.url && tab.url.includes(urlPart));
  return match ? match.id : null;
}

async function openTab(cdp, swSession, url, options = {}) {
  const {targetId} = await cdp.send('Target.createTarget', {url, background: !!options.background});
  const sessionId = await cdp.attach(targetId);
  await waitForReady(cdp, sessionId);

  const tabId = await findChromeTabId(cdp, swSession, url);
  return {targetId, sessionId, tabId, url};
}

async function waitForReady(cdp, sessionId) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if (await cdp.evaluate(sessionId, 'document.readyState') === 'complete') return;
    }
    catch (error) {
      // navigation in flight
    }
    await sleep(150);
  }
  throw new Error('page never finished loading');
}

async function tabState(cdp, swSession, tabId) {
  const state = await cdp.evaluate(swSession, `(async () => {
    try {
      return await ts.getTabState(${tabId});
    }
    catch (error) {
      return {state: 'error: ' + error.message};
    }
  })()`);

  return state && state.state;
}

async function refreshAfterDiscard(cdp, swSession, tabId, urlPart) {
  const current = await tabUrl(cdp, swSession, tabId);
  if (current !== null) return tabId;
  return (await findTabId(cdp, swSession, urlPart)) || tabId;
}

async function suspend(cdp, swSession, tabId) {
  const url = await tabUrl(cdp, swSession, tabId);
  console.log(`    state before suspend: ${await tabState(cdp, swSession, tabId)}`);

  await cdp.evaluate(swSession, `(async () => { ts.suspendTab(${tabId}); return true; })()`);
  const suspendedId = await waitForSuspension(cdp, swSession, url);

  if (!suspendedId) {
    console.log('    suspension did not happen');
    return {suspended: false, tabId};
  }

  // Suspension discards the tab, which replaces its WebContents and therefore
  // its tab id; the marker lookup above already returned the live id.
  return {suspended: true, tabId: suspendedId};
}

async function autoSuspend(cdp, swSession, tabId, timeoutMs = 4000) {
  const url = await tabUrl(cdp, swSession, tabId);
  console.log(`    state before auto suspend: ${await tabState(cdp, swSession, tabId)}`);

  await cdp.evaluate(swSession, `(async () => { ts.autoSuspendTab(${tabId}); return true; })()`);
  const suspendedId = await waitForSuspension(cdp, swSession, url, timeoutMs);

  return {suspended: !!suspendedId, tabId: suspendedId || tabId};
}

// Finds the placeholder carrying this tab's original URL, so the lookup keeps
// working when discarding swaps the tab id underneath us.
async function waitForSuspension(cdp, swSession, originalUrl, timeoutMs = 8000) {
  if (!originalUrl) return null;

  const marker = encodeURIComponent(originalUrl);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const tabs = await chromeTabs(cdp, swSession);
    const match = tabs.find((tab) => tab.url && tab.url.includes('suspend.html') && tab.url.includes(marker));
    if (match) return match.id;
    await sleep(150);
  }

  return null;
}

async function closeTab(cdp, swSession, tabId) {
  const result = await cdp.evaluate(swSession, `(async () => {
    try {
      await chrome.tabs.remove(${tabId});
      return 'ok';
    }
    catch (error) {
      return 'failed: ' + error.message;
    }
  })()`);

  if (result !== 'ok') {
    console.log(`    close ${tabId}: ${result}`);
    const tabs = await chromeTabs(cdp, swSession);
    console.log('    live tabs: ' + tabs
      .map((tab) => `${tab.id}${tab.discarded ? '(discarded)' : ''} ${String(tab.url).slice(0, 40)}`)
      .join(' | '));
  }

  return result === 'ok';
}

async function activate(cdp, swSession, tabId) {
  await cdp.evaluate(swSession, `(async () => { await chrome.tabs.update(${tabId}, {active: true}); return true; })()`);
  await sleep(300);
}

async function discardTab(cdp, swSession, tabId) {
  const result = await cdp.evaluate(swSession, `(async () => {
    try {
      await chrome.tabs.discard(${tabId});
      return 'ok';
    }
    catch (error) {
      return 'failed: ' + error.message;
    }
  })()`);

  console.log(`    discard: ${result}`);
  await sleep(2000);
  return result === 'ok';
}

async function waitForState(cdp, swSession, tabId, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await tabState(cdp, swSession, tabId);
    if (predicate(state)) return state;
    await sleep(250);
  }

  return tabState(cdp, swSession, tabId);
}

// ------------------------------------------------------------- measurement ---

function rendererStats(userDataDir) {
  const output = execFileSync('ps', ['-ww', '-Ao', 'pid=,rss=,command='], {encoding: 'utf8'});

  const mine = output.split('\n').filter((line) => line.includes(userDataDir));
  const renderers = mine.filter((line) => line.includes('--type=renderer'));

  let rssKb = 0;
  renderers.forEach((line) => {
    rssKb += parseInt(line.trim().split(/\s+/)[1], 10) || 0;
  });

  return {
    renderers: renderers.length,
    rssMb: Math.round(rssKb / 1024),
  };
}

async function stableStats(userDataDir, label) {
  let previous = rendererStats(userDataDir);

  for (let attempt = 0; attempt < 12; attempt++) {
    await sleep(500);
    const current = rendererStats(userDataDir);
    if (current.renderers === previous.renderers && current.rssMb === previous.rssMb) {
      previous = current;
      break;
    }
    previous = current;
  }

  console.log(`  (${label}: ${previous.renderers} renderers, ${previous.rssMb} MB)`);
  return previous;
}

// ---------------------------------------------------------------- scenarios ---

async function closeAllExcept(cdp, swSession, keepTabId) {
  await cdp.evaluate(swSession, `(async () => {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id === ${keepTabId}) continue;
      try {
        await chrome.tabs.remove(tab.id);
      }
      catch (error) {
        // already gone
      }
    }
    return true;
  })()`);
  await sleep(2000);
}

// The headline comparison: N tabs, first live, then suspended the way the
// upstream extension does it (URL swap only), then suspended our way
// (swap + discard). Same browser, same session, same pages.
async function compareTabs(cdp, swSession, userDataDir, control, config) {
  const {name, urlFor, count} = config;

  console.log('');
  console.log(`Comparison — ${name}: ${count} tabs live vs upstream vs ours`);

  await closeAllExcept(cdp, swSession, control.tabId);
  const base = await stableStats(userDataDir, 'control tab only');

  const tabIds = [];
  for (let index = 0; index < count; index++) {
    const tab = await openTab(cdp, swSession, urlFor(index));
    tabIds.push(tab.tabId);
  }

  await activate(cdp, swSession, control.tabId);
  await sleep(2000);

  const live = await stableStats(userDataDir, `${count} live tabs`);
  record(`compare-${name}`, `baseline (browser + control tab)`, `${base.rssMb} MB`);
  record(`compare-${name}`, `${count} live tabs`, `${live.rssMb} MB (${live.renderers - base.renderers} renderers)`);
  record(`compare-${name}`, `per live tab`, `${Math.round((live.rssMb - base.rssMb) / count)} MB`);

  // Neutralize the discard paths to reproduce the upstream algorithm exactly:
  // the tab is sent to the suspend page, but nothing ever discards it.
  await cdp.evaluate(swSession, `(() => {
    ts.discardSuspendedTab = () => {};
    ts.discardInactiveSuspendedTabs = () => {};
    return true;
  })()`);

  await cdp.evaluate(swSession, `(async () => {
    for (const id of ${JSON.stringify(tabIds)}) {
      try {
        const tab = await chrome.tabs.get(id);
        await chrome.tabs.update(id, {
          url: 'suspend.html?url=' + encodeURIComponent(tab.url) + '&title=' + encodeURIComponent(tab.title),
        });
      }
      catch (error) {
        // tab id changed underneath us
      }
    }
    return true;
  })()`);

  await sleep(3000);
  const upstream = await stableStats(userDataDir, `${count} suspended the upstream way`);
  record(`compare-${name}`, `${count} suspended — upstream (swap only)`,
    `${upstream.rssMb} MB (${upstream.renderers - base.renderers} renderers)`);
  record(`compare-${name}`, `reclaimed by upstream suspension`, `${live.rssMb - upstream.rssMb} MB`);

  // Put our discard paths back and let the extension sweep them.
  await cdp.evaluate(swSession, `(() => {
    delete ts.discardSuspendedTab;
    delete ts.discardInactiveSuspendedTabs;
    return true;
  })()`);
  await cdp.evaluate(swSession, `(async () => { ts.discardInactiveSuspendedTabs(); return true; })()`);

  await sleep(3000);
  const ours = await stableStats(userDataDir, `${count} suspended our way`);
  record(`compare-${name}`, `${count} suspended — ours (swap + discard)`,
    `${ours.rssMb} MB (${ours.renderers - base.renderers} renderers)`);
  record(`compare-${name}`, `reclaimed by our suspension`, `${live.rssMb - ours.rssMb} MB`);
  record(`compare-${name}`, `our advantage over upstream`, `${upstream.rssMb - ours.rssMb} MB`);

  await closeAllExcept(cdp, swSession, control.tabId);
}

const PATCH_DISCARD = `(() => {
  ts.discardSuspendedTab = () => {};
  ts.discardInactiveSuspendedTabs = () => {};
  return true;
})()`;

const RESTORE_DISCARD = `(() => {
  delete ts.discardSuspendedTab;
  delete ts.discardInactiveSuspendedTabs;
  return true;
})()`;

// Per-renderer detail, so we can tell whether a process is the page's own
// renderer, the extension's renderer, or something else entirely.
function rendererDetails(userDataDir) {
  const output = execFileSync('ps', ['-ww', '-Ao', 'pid=,rss=,command='], {encoding: 'utf8'});

  return output.split('\n')
    .filter((line) => line.includes(userDataDir) && line.includes('--type=renderer'))
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        pid: parts[0],
        rssMb: Math.round((parseInt(parts[1], 10) || 0) / 1024),
        extension: line.includes('--extension-process'),
        client: (line.match(/--renderer-client-id=(\d+)/) || [])[1] || '?',
      };
    })
    .sort((a, b) => b.rssMb - a.rssMb);
}

function describeRenderers(userDataDir) {
  return rendererDetails(userDataDir)
    .map((entry) => `${entry.pid} ${entry.rssMb}MB ${entry.extension ? 'ext' : 'page'}#${entry.client}`)
    .join(' | ');
}

// Where does the retained memory actually live, and what releases it?
async function retentionAnatomyProbe(cdp, swSession, userDataDir, control, config) {
  const {label, query} = config;

  console.log('');
  console.log(`Scenario 11 — what holds the memory after the swap? (${label})`);

  await closeAllExcept(cdp, swSession, control.tabId);

  const tab = await openTab(cdp, swSession, `${BASE_A}/marked?tag=anatomy&${query}`);
  await activate(cdp, swSession, control.tabId);
  await sleep(1500);

  record('retention', `${label}: renderers while live`, describeRenderers(userDataDir));

  try {
    await cdp.evaluate(swSession, PATCH_DISCARD);
    await upstreamSwap(cdp, swSession, tab.tabId);
    await sleep(3000);

    record('retention', `${label}: renderers after the swap`, describeRenderers(userDataDir));

    const historyLength = await cdp.evaluate(tab.sessionId, 'history.length');
    record('retention', `${label}: history.length on the placeholder`, String(historyLength));

    // A plain navigation away from the placeholder: does that release it?
    await cdp.evaluate(swSession, `(async () => { await chrome.tabs.update(${tab.tabId}, {url: 'about:blank'}); return true; })()`);
    await sleep(3000);
    record('retention', `${label}: renderers after navigating to about:blank`, describeRenderers(userDataDir));
  }
  finally {
    await cdp.evaluate(swSession, RESTORE_DISCARD);
  }

  await closeAllExcept(cdp, swSession, control.tabId);
}

async function tabTitle(cdp, swSession, tabId) {
  return cdp.evaluate(swSession, `(async () => (await chrome.tabs.get(${tabId})).title)()`);
}

// Suspend exactly the way upstream does: swap the URL and never discard.
// The placeholder gets a fixed title so it cannot be confused with the page.
async function upstreamSwap(cdp, swSession, tabId) {
  await cdp.evaluate(swSession, `(async () => {
    const tab = await chrome.tabs.get(${tabId});
    await chrome.tabs.update(${tabId}, {
      url: 'suspend.html?url=' + encodeURIComponent(tab.url) + '&title=' + encodeURIComponent('suspended by lab'),
    });
    return true;
  })()`);
}

// Does the original document survive the URL swap? The page stamps its identity
// into the tab title, so this needs no debugger attached to the page (which can
// itself disable the cache). Navigating back either restores that same document
// or reloads a fresh one — and if goBack finds no history entry, we see the
// placeholder still in place.
async function bfcacheProbe(cdp, swSession, userDataDir, control, config) {
  const {label, query} = config;

  console.log('');
  console.log(`Scenario 9 — back/forward cache probe: ${label}`);

  await closeAllExcept(cdp, swSession, control.tabId);

  const tab = await openTab(cdp, swSession, `${BASE_A}/marked?tag=bfcache&${query}`);
  await activate(cdp, swSession, control.tabId);
  await sleep(1500);

  const before = await tabTitle(cdp, swSession, tab.tabId);

  try {
    await cdp.evaluate(swSession, PATCH_DISCARD);
    await upstreamSwap(cdp, swSession, tab.tabId);
    await sleep(2500);

    const swapped = await tabTitle(cdp, swSession, tab.tabId);
    const swappedUrl = await tabUrl(cdp, swSession, tab.tabId);

    await activate(cdp, swSession, tab.tabId);
    await sleep(700);

    // chrome.tabs.goBack refuses to navigate from the extension placeholder back
    // to the page ("Cannot find a next page in history") even though the entry
    // exists; the protocol can walk the same history, so use that instead.
    const goBack = await cdp.evaluate(swSession, `(async () => {
      try {
        await chrome.tabs.goBack(${tab.tabId});
        return 'ok';
      }
      catch (error) {
        return 'failed: ' + error.message;
      }
    })()`);

    const history = await cdp.send('Page.getNavigationHistory', {}, tab.sessionId);

    if (history.currentIndex > 0) {
      const previous = history.entries[history.currentIndex - 1];
      await cdp.send('Page.navigateToHistoryEntry', {entryId: previous.id}, tab.sessionId);
      await sleep(3000);
    }

    const after = await tabTitle(cdp, swSession, tab.tabId);
    const afterUrl = await tabUrl(cdp, swSession, tab.tabId);

    record('bfcache', `${label}: title while live`, String(before));
    record('bfcache', `${label}: title after the swap`, String(swapped).slice(0, 50));
    record('bfcache', `${label}: chrome.tabs.goBack`, String(goBack));
    record('bfcache', `${label}: history entries after the swap`, String(history.entries.length));
    record('bfcache', `${label}: title after going back`, String(after).slice(0, 50));
    record('bfcache', `${label}: url after going back`, String(afterUrl).slice(0, 55));
    record('bfcache', `${label}: verdict`,
      after === before ? 'SAME document — kept alive (back/forward cache)'
        : after === swapped ? 'still on the placeholder — goBack did not navigate'
          : 'freshly loaded document — not kept');
  }
  finally {
    await cdp.evaluate(swSession, RESTORE_DISCARD);
  }

  await closeAllExcept(cdp, swSession, control.tabId);
}

// Upstream's swap often looks like it reclaims nothing — but does the memory
// come back on its own if we simply wait? Samples the processes over a minute.
async function swapDurabilityProbe(cdp, swSession, userDataDir, control, config) {
  const {label, query, seconds} = config;

  console.log('');
  console.log(`Scenario 10 — does the swap reclaim anything by itself? (${label})`);

  await closeAllExcept(cdp, swSession, control.tabId);

  const tab = await openTab(cdp, swSession, `${BASE_A}/marked?tag=durability&${query}`);
  await activate(cdp, swSession, control.tabId);
  await sleep(1500);

  const live = rendererStats(userDataDir);
  record('swap-durability', `${label}: renderers / RSS while live`, `${live.renderers} / ${live.rssMb} MB`);

  try {
    await cdp.evaluate(swSession, PATCH_DISCARD);
    await upstreamSwap(cdp, swSession, tab.tabId);

    const samples = [];
    for (let elapsed = 5; elapsed <= seconds; elapsed += 5) {
      await sleep(5000);
      const stats = rendererStats(userDataDir);
      samples.push(`${elapsed}s ${stats.renderers}/${stats.rssMb}MB`);
    }

    record('swap-durability', `${label}: after the swap, over ${seconds}s`, samples.join(' | '));
  }
  finally {
    await cdp.evaluate(swSession, RESTORE_DISCARD);
  }

  await closeAllExcept(cdp, swSession, control.tabId);
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-suspender-lab-'));
  const server = await startServer();
  const browser = await launchBrowser(userDataDir);
  let cdp = null;

  activeBrowser = browser.proc;
  activeProfile = userDataDir;

  try {
    const version = await (await fetch(`http://127.0.0.1:${browser.port}/json/version`)).json();
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    const worker = await findServiceWorker(cdp);
    const extensionId = new URL(worker.url).hostname;
    const swSession = await cdp.attach(worker.targetId);

    console.log(`Extension id: ${extensionId}`);
    console.log('');

    // A control tab keeps every test tab in the background, so native discard
    // is allowed (Chrome refuses to discard the active tab).
    const control = await openTab(cdp, swSession, 'about:blank');
    const baseline = await stableStats(userDataDir, 'control tab only');

    // --- 9. is the old document really kept alive? --------------------------
    await bfcacheProbe(cdp, swSession, userDataDir, control, {
      label: 'light document, cacheable',
      query: 'mb=0',
    });

    await bfcacheProbe(cdp, swSession, userDataDir, control, {
      label: 'light document, cache-control: no-store',
      query: 'mb=0&cache=no',
    });

    await bfcacheProbe(cdp, swSession, userDataDir, control, {
      label: '100 MB document, cacheable',
      query: 'mb=100',
    });

    await retentionAnatomyProbe(cdp, swSession, userDataDir, control, {
      label: '100 MB document',
      query: 'mb=100',
    });

    await swapDurabilityProbe(cdp, swSession, userDataDir, control, {
      label: '100 MB document, no-store',
      query: 'mb=100&cache=no',
      seconds: 30,
    });

    // --- 0. what does discard do to the tab list? ---------------------------
    console.log('Scenario 0: how does the tab list behave around a discard?');

    const debugTab = await openTab(cdp, swSession, `${BASE_A}/static?tag=debug`);
    await activate(cdp, swSession, control.tabId);

    const describe = (tabs) => tabs
      .map((tab) => `#${tab.id}${tab.active ? '(active)' : ''}${tab.discarded ? '(discarded)' : ''} `
        + String(tab.url).replace(BASE_A, '').slice(0, 24))
      .join(' | ');

    await cdp.evaluate(swSession, `(() => {
      self.__labEvents = [];
      chrome.tabs.onCreated.addListener((tab) => self.__labEvents.push('created #' + tab.id + ' ' + String(tab.url).slice(0, 40)));
      chrome.tabs.onRemoved.addListener((tabId) => self.__labEvents.push('removed #' + tabId));
      return true;
    })()`);

    console.log(`  before: ${describe(await chromeTabs(cdp, swSession))}`);

    await discardTab(cdp, swSession, debugTab.tabId);
    console.log(`  after:  ${describe(await chromeTabs(cdp, swSession))}`);

    const events = await cdp.evaluate(swSession, 'self.__labEvents');
    console.log(`  events: ${events.length ? events.join(' ; ') : '(none)'}`);

    await closeTab(cdp, swSession, await refreshAfterDiscard(cdp, swSession, debugTab.tabId, 'tag=debug'));

    // --- 1. reclaim ladder: suspend, then discard, then close --------------
    console.log('Scenario 1: a 200 MB page — does suspending it give the memory back?');

    const heavyTab = await openTab(cdp, swSession, `${BASE_A}/heavy?tag=heavy&mb=200`);
    await activate(cdp, swSession, control.tabId);
    const withHeavy = await stableStats(userDataDir, 'heavy tab loaded');

    record('heavy page', 'renderer RSS added by a 200 MB page',
      `${withHeavy.rssMb - baseline.rssMb} MB (${withHeavy.renderers - baseline.renderers} renderers)`);

    const heavySuspension = await suspend(cdp, swSession, heavyTab.tabId);
    heavyTab.tabId = heavySuspension.tabId;

    const afterSuspend = await stableStats(userDataDir, 'heavy tab suspended');

    record('heavy page', 'RSS reclaimed by suspending it',
      `${withHeavy.rssMb - afterSuspend.rssMb} MB (${withHeavy.renderers - afterSuspend.renderers} renderers)`);

    const suspendedTab = (await chromeTabs(cdp, swSession)).find((tab) => tab.id === heavyTab.tabId);
    record('heavy page', 'suspended tab state',
      suspendedTab
        ? `${suspendedTab.discarded ? 'discarded' : 'NOT discarded'}, url is `
          + `${String(suspendedTab.url).includes('suspend.html') ? 'the placeholder' : 'THE ORIGINAL PAGE (bad)'}`
        : 'tab not found');

    // The placeholder has to survive being discarded and still restore.
    await cdp.evaluate(swSession, `(async () => { ts.restoreTab(${heavyTab.tabId}); return true; })()`);
    await sleep(4000);

    const restoredUrl = await tabUrl(cdp, swSession, heavyTab.tabId);
    record('heavy page', 'URL after restoring the suspended tab',
      restoredUrl && restoredUrl.startsWith(BASE_A) ? 'restored to the original page (expected)' : String(restoredUrl));

    await closeTab(cdp, swSession, heavyTab.tabId);

    // --- 1b. native discard, no URL swap ------------------------------------
    console.log('Scenario 1b: the same page, discarded natively without any URL swap.');

    const nativeTab = await openTab(cdp, swSession, `${BASE_A}/heavy?tag=native&mb=200`);
    await activate(cdp, swSession, control.tabId);
    await sleep(1000);
    const withNative = await stableStats(userDataDir, 'native heavy tab loaded');

    await discardTab(cdp, swSession, nativeTab.tabId);
    const afterNativeDiscard = await stableStats(userDataDir, 'native heavy tab discarded');

    record('heavy page', 'RSS reclaimed by native discard (no URL swap)',
      `${withNative.rssMb - afterNativeDiscard.rssMb} MB`);

    await closeTab(cdp, swSession, await refreshAfterDiscard(cdp, swSession, nativeTab.tabId, 'tag=native'));

    // --- 2. same-site tabs --------------------------------------------------
    console.log('');
    console.log('Scenario 2: do two same-site tabs share a renderer, and does suspending one free anything?');

    const sameA = await openTab(cdp, swSession, `${BASE_A}/heavy?tag=same-a&mb=150`);
    const sameB = await openTab(cdp, swSession, `${BASE_A}/heavy?tag=same-b&mb=150`);
    await activate(cdp, swSession, control.tabId);
    const withTwoSameSite = await stableStats(userDataDir, 'two same-site heavy tabs');

    record('same-site pair', 'renderer RSS for two 150 MB tabs on one site',
      `${withTwoSameSite.rssMb} MB across ${withTwoSameSite.renderers} renderers`);

    const sameSuspension = await suspend(cdp, swSession, sameA.tabId);
    const afterOneSuspended = await stableStats(userDataDir, 'one of two suspended');

    record('same-site pair', 'RSS freed by suspending one of the two',
      `${withTwoSameSite.rssMb - afterOneSuspended.rssMb} MB (0 would mean they shared a renderer)`);

    await closeTab(cdp, swSession, sameSuspension.tabId);
    await closeTab(cdp, swSession, sameB.tabId);
    await sleep(1500);

    // --- 3. cross-site pair -------------------------------------------------
    console.log('');
    console.log('Scenario 3: two different sites, suspend one.');

    const crossA = await openTab(cdp, swSession, `${BASE_A}/heavy?tag=cross-a&mb=150`);
    const crossB = await openTab(cdp, swSession, `${BASE_B}/heavy?tag=cross-b&mb=150`);
    await activate(cdp, swSession, control.tabId);
    const withTwoSites = await stableStats(userDataDir, 'two sites');

    const crossSuspension = await suspend(cdp, swSession, crossA.tabId);
    const afterCrossSuspend = await stableStats(userDataDir, 'one site suspended');

    record('cross-site pair', 'RSS freed by suspending one of two different sites',
      `${withTwoSites.rssMb - afterCrossSuspend.rssMb} MB`);

    await closeTab(cdp, swSession, crossSuspension.tabId);
    await closeTab(cdp, swSession, crossB.tabId);
    await sleep(1500);

    // --- 4. opener tabs -----------------------------------------------------
    console.log('');
    console.log('Scenario 4: a tab opened by the page itself (same browsing instance).');

    const opener = await openTab(cdp, swSession, `${BASE_A}/static?tag=opener`);

    const openedUrl = `${BASE_A}/static?tag=opened-by-page`;
    let openedTabId = null;

    await cdp.evaluate(opener.sessionId, `window.open('${openedUrl}', '_blank')`);

    for (let attempt = 0; attempt < 20 && openedTabId === null; attempt++) {
      const tabs = await chromeTabs(cdp, swSession);
      const match = tabs.find((tab) => tab.url === openedUrl);
      if (match) openedTabId = match.id;
      else await sleep(150);
    }

    if (openedTabId === null) {
      record('opener pair', 'result', 'skipped: window.open did not create a tab in this mode');
    }
    else {
      const withOpener = await stableStats(userDataDir, 'opener pair');

      record('opener pair', 'renderers for an opener pair', String(withOpener.renderers));

      await suspend(cdp, swSession, openedTabId);
      const afterOpenerSuspend = await stableStats(userDataDir, 'opened tab suspended');

      record('opener pair', 'RSS freed by suspending the opened tab',
        `${withOpener.rssMb - afterOpenerSuspend.rssMb} MB`);

      await closeTab(cdp, swSession, openedTabId);
    }

    await closeTab(cdp, swSession, opener.tabId);

    // --- 5. busy sensor -----------------------------------------------------
    console.log('');
    console.log('Scenario 5: the busy sensor against a real open WebSocket.');

    const socketTab = await openTab(cdp, swSession, `${BASE_A}/socket?tag=socket`);
    await activate(cdp, swSession, control.tabId);
    await waitForState(cdp, swSession, socketTab.tabId, (state) => state === 'suspendable:busy');

    const whileOpen = await autoSuspend(cdp, swSession, socketTab.tabId);
    record('busy sensor', 'auto-suspend while a socket is open',
      whileOpen.suspended ? 'SUSPENDED (unexpected)' : 'blocked (expected)');

    await cdp.evaluate(socketTab.sessionId, 'window.closeSocket()');

    const settled = await waitForState(cdp, swSession, socketTab.tabId, (state) => state !== 'suspendable:busy');
    record('busy sensor', 'state once the socket closed', String(settled));

    const afterSocketClose = await autoSuspend(cdp, swSession, socketTab.tabId);
    record('busy sensor', 'auto-suspend after the socket closed',
      afterSocketClose.suspended ? 'suspended (expected)' : 'NOT suspended (unexpected)');

    await closeTab(cdp, swSession, afterSocketClose.tabId);

    // --- 6. diagnostics page ------------------------------------------------
    console.log('');
    console.log('Scenario 6: the diagnostics page renders in a real browser.');

    const diagnostics = await openTab(cdp, swSession, `chrome-extension://${extensionId}/diagnostics.html`);
    await sleep(1000);

    const rows = await cdp.evaluate(diagnostics.sessionId,
      `Array.from(document.querySelectorAll('#environment tr')).map((row) => row.textContent)`);

    record('diagnostics page', 'environment rows rendered', String(rows.length));
    rows.slice(0, 3).forEach((row) => console.log(`    ${row}`));

    await closeTab(cdp, swSession, diagnostics.tabId);

    // --- 7. alarm budget ----------------------------------------------------
    console.log('');
    console.log('Scenario 7: alarm growth with background tabs.');

    const alarmsBefore = await cdp.evaluate(swSession, '(async () => (await chrome.alarms.getAll()).length)()');

    await cdp.evaluate(swSession, `(async () => {
      for (let i = 0; i < 12; i++) {
        await chrome.tabs.create({url: '${BASE_A}/static?tag=bg-' + i, active: false});
      }
      return true;
    })()`);

    await sleep(3000);

    const tabsNow = (await chromeTabs(cdp, swSession)).length;
    const alarmsAfter = await cdp.evaluate(swSession, '(async () => (await chrome.alarms.getAll()).length)()');

    record('alarm budget', 'alarms used by the whole extension',
      `${alarmsBefore} before, ${alarmsAfter} with ${tabsNow} tabs open (cap is 500)`);

    // --- 8. the headline comparison -----------------------------------------
    await compareTabs(cdp, swSession, userDataDir, control, {
      name: 'light pages',
      count: 20,
      urlFor: (index) => `${BASE_A}/static?tag=cmp-light-${index}`,
    });

    await compareTabs(cdp, swSession, userDataDir, control, {
      name: '50 MB pages',
      count: 20,
      urlFor: (index) => `${BASE_A}/heavy?mb=50&tag=cmp-50-${index}`,
    });

    await compareTabs(cdp, swSession, userDataDir, control, {
      name: '200 MB pages',
      count: 20,
      urlFor: (index) => `${BASE_A}/heavy?mb=200&tag=cmp-200-${index}`,
    });

    // --- summary ------------------------------------------------------------
    console.log('');
    console.log('| Scenario | Measurement | Value |');
    console.log('| --- | --- | --- |');
    measurements.forEach((entry) => {
      console.log(`| ${entry.scenario} | ${entry.what} | ${entry.value} |`);
    });
  }
  finally {
    if (cdp && !KEEP) cdp.close();
    if (!KEEP) {
      browser.proc.kill('SIGTERM');
      await sleep(500);
      fs.rmSync(userDataDir, {recursive: true, force: true});
    }
    else {
      console.log('');
      console.log(`Browser kept open (pid ${browser.proc.pid}), profile: ${userDataDir}`);
    }
    server.close();
  }
}

// Focused run: one tab, kept in the foreground, so chrome.tabs.goBack is allowed.
async function bfcacheOnly() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-suspender-lab-'));
  const server = await startServer();
  const browser = await launchBrowser(userDataDir);
  activeBrowser = browser.proc;
  activeProfile = userDataDir;

  let cdp = null;
  let swSession = null;

  try {
    const version = await (await fetch(`http://127.0.0.1:${browser.port}/json/version`)).json();
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    const worker = await findServiceWorker(cdp);
    swSession = await cdp.attach(worker.targetId);

    const cacheQuery = argv.includes('--no-store') ? 'mb=100&cache=no' : 'mb=100';
    console.log(`Document: marked?${cacheQuery}`);

    const tab = await openTab(cdp, swSession, `${BASE_A}/marked?tag=bfcache-only&${cacheQuery}`);
    await sleep(1500);

    const before = await tabTitle(cdp, swSession, tab.tabId);
    console.log(`title while live: ${before}`);
    console.log(`history.length while live: ${await cdp.evaluate(tab.sessionId, 'history.length')}`);

    await cdp.evaluate(swSession, PATCH_DISCARD);
    await upstreamSwap(cdp, swSession, tab.tabId);
    await sleep(2500);

    console.log(`title after the swap: ${await tabTitle(cdp, swSession, tab.tabId)}`);
    console.log(`history.length on the placeholder: ${await cdp.evaluate(tab.sessionId, 'history.length')}`);

    const goBack = await cdp.evaluate(swSession, `(async () => {
      try {
        await chrome.tabs.goBack(${tab.tabId});
        return 'ok';
      }
      catch (error) {
        return 'failed: ' + error.message;
      }
    })()`);
    console.log(`goBack with the tab active: ${goBack}`);

    // chrome.tabs refuses, so ask the protocol for the real history and walk it.
    const history = await cdp.send('Page.getNavigationHistory', {}, tab.sessionId);
    console.log(`cdp history: currentIndex=${history.currentIndex}, entries=`
      + history.entries.map((entry) => entry.url.slice(0, 40)).join(' -> '));

    if (history.currentIndex > 0) {
      const previous = history.entries[history.currentIndex - 1];
      await cdp.send('Page.navigateToHistoryEntry', {entryId: previous.id}, tab.sessionId);
      await sleep(3000);
    }

    const after = await tabTitle(cdp, swSession, tab.tabId);
    console.log(`title after going back: ${after}`);
    console.log(`url after going back: ${await tabUrl(cdp, swSession, tab.tabId)}`);
    console.log('verdict: ' + (after === before
      ? 'SAME document — kept alive (back/forward cache)'
      : after === 'suspended by lab'
        ? 'still on the placeholder — goBack did not navigate'
        : 'freshly loaded document — not kept'));
  }
  finally {
    if (cdp && swSession) {
      try {
        await cdp.evaluate(swSession, RESTORE_DISCARD);
      }
      catch (error) {
        // session already gone
      }
    }
    if (cdp) cdp.close();
    browser.proc.kill('SIGTERM');
    await sleep(500);
    try {
      fs.rmSync(userDataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    }
    catch (error) {
      // best effort
    }
    server.close();
  }
}

// What a suspended tab ends up showing in the tab strip: the site's title and
// dimmed favicon, or the placeholder's default "Suspended" and the extension's
// power icon. Separates the two things that can go wrong — the favicon lookup
// itself, and discarding the placeholder before it has rendered.
const RESTART_TABS = 25;

async function renderOnly() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-suspender-lab-'));
  const server = await startServer();
  const browser = await launchBrowser(userDataDir);
  activeBrowser = browser.proc;
  activeProfile = userDataDir;

  let cdp = null;

  try {
    const version = await (await fetch(`http://127.0.0.1:${browser.port}/json/version`)).json();
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    const worker = await findServiceWorker(cdp);
    const swSession = await cdp.attach(worker.targetId);

    const control = await openTab(cdp, swSession, `${BASE_A}/static?tag=render-control`);

    // --- 1. does the favicon lookup work at all? ----------------------------
    console.log('');
    console.log('Probe 1 — the suspend page, with discarding disabled: does it render the site icon?');

    const pageUrl = `${BASE_A}/static?tag=render-a`;
    const page = await openTab(cdp, swSession, pageUrl);
    await sleep(1500);

    const liveIcon = await cdp.evaluate(swSession,
      `(async () => { const t = await chrome.tabs.get(${page.tabId}); return String(t.favIconUrl || ''); })()`);
    record('render', 'favIconUrl chrome reports for the live page', liveIcon ? liveIcon.slice(0, 60) : '(none)');

    await activate(cdp, swSession, control.tabId);
    await cdp.evaluate(swSession, PATCH_DISCARD);
    await cdp.evaluate(swSession, `(async () => { ts.suspendTab(${page.tabId}); return true; })()`);
    await sleep(2500);

    const placeholder = (await cdp.targets()).find((target) => target.url.includes('suspend.html')
      && target.url.includes(encodeURIComponent(pageUrl)));

    if (!placeholder) throw new Error('the tab never landed on the suspend page');

    const placeholderSession = await cdp.attach(placeholder.targetId);
    const rendered = await cdp.evaluate(placeholderSession, `(async () => {
      const link = document.querySelector('link[rel="shortcut icon"]');
      const pageIcon = document.querySelector('.title .icon img');
      const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
      favicon.searchParams.set('pageUrl', new URL(location.href).searchParams.get('url'));
      favicon.searchParams.set('size', '32');

      let status = 'not attempted';
      let bytes = 0;
      try {
        const response = await fetch(favicon.toString());
        status = String(response.status);
        bytes = (await response.blob()).size;
      }
      catch (error) {
        status = 'threw: ' + error.message;
      }

      return {
        title: document.title,
        linkHref: link ? link.href.slice(0, 24) : '(no link element)',
        pageIcon: pageIcon ? pageIcon.src.slice(0, 40) : '(none)',
        faviconStatus: status,
        faviconBytes: bytes,
      };
    })()`);

    record('render', 'placeholder document.title', rendered.title);
    record('render', '_favicon fetch from the placeholder', `${rendered.faviconStatus}, ${rendered.faviconBytes} bytes`);
    record('render', 'tab icon <link> applied by suspend.js', rendered.linkHref);
    record('render', 'verdict — favicon lookup', rendered.linkHref.startsWith('data:')
      ? 'WORKS (dimmed icon applied)'
      : 'BROKEN (no icon applied)');

    await cdp.evaluate(swSession, RESTORE_DISCARD);
    await closeAllExcept(cdp, swSession, control.tabId);

    // --- 2. a normal suspension, discard and all ----------------------------
    console.log('');
    console.log('Probe 2 — a normal suspension: what does the tab show once it is discarded?');

    const pageUrlB = `${BASE_A}/static?tag=render-b`;
    const pageB = await openTab(cdp, swSession, pageUrlB);
    await sleep(1500);
    const liveTitle = await tabTitle(cdp, swSession, pageB.tabId);

    await activate(cdp, swSession, control.tabId);
    await cdp.evaluate(swSession, `(async () => { ts.suspendTab(${pageB.tabId}); return true; })()`);
    await sleep(5000);

    const afterSuspend = await suspendedTabInfo(cdp, swSession, pageUrlB);
    record('render', 'title while live', String(liveTitle));
    record('render', 'suspended tab: discarded', String(afterSuspend.discarded));
    record('render', 'suspended tab: title', String(afterSuspend.title));
    record('render', 'suspended tab: favIconUrl', String(afterSuspend.favIconUrl).slice(0, 24));
    record('render', 'verdict — fresh suspension', afterSuspend.title === liveTitle
      ? 'keeps the site title'
      : `falls back to "${afterSuspend.title}"`);

    await closeAllExcept(cdp, swSession, control.tabId);

    // --- 3. the restart path ------------------------------------------------
    // A restart reloads every placeholder at once and starts the service
    // worker, which sweeps them. One tab reloads too fast to lose the race, so
    // this reproduces the contention with a batch.
    console.log('');
    console.log(`Probe 3 — ${RESTART_TABS} placeholders reloaded at once, then swept like a browser restart.`);

    const bulkTag = 'bulk';
    await cdp.evaluate(swSession, `(async () => {
      for (let index = 0; index < ${RESTART_TABS}; index++) {
        await chrome.tabs.create({url: '${BASE_A}/static?tag=${bulkTag}-' + index, active: false});
      }
      return true;
    })()`);

    await waitForLoaded(cdp, swSession, bulkTag, RESTART_TABS);

    await cdp.evaluate(swSession, `(async () => {
      const tabs = await chrome.tabs.query({});
      tabs.filter((tab) => tab.url && tab.url.includes('tag=${bulkTag}-'))
        .forEach((tab) => ts.suspendTab(tab.id));
      return true;
    })()`);

    await sleep(8000);

    const beforeRestart = await suspendedTitles(cdp, swSession, bulkTag);
    record('render', `${RESTART_TABS} tabs suspended normally`,
      `${beforeRestart.rendered} of ${beforeRestart.total} show the site title`);

    // The restart itself: every placeholder reloads, and the worker starts and
    // sweeps. Sweeping as soon as the first tab is loading is what setChrome
    // does — it does not wait for any of them to render.
    await cdp.evaluate(swSession, `(async () => {
      const tabs = await chrome.tabs.query({});
      tabs.filter((tab) => tab.url && tab.url.includes('suspend.html'))
        .forEach((tab) => chrome.tabs.reload(tab.id));
      return true;
    })()`);

    await cdp.evaluate(swSession, `(async () => { ts.discardInactiveSuspendedTabs(); return true; })()`);
    await sleep(8000);

    const afterRestart = await suspendedTitles(cdp, swSession, bulkTag);
    record('render', 'after the startup sweep',
      `${afterRestart.rendered} of ${afterRestart.total} show the site title`);
    record('render', 'after the startup sweep: still discarded',
      `${afterRestart.discarded} of ${afterRestart.total}`);
    record('render', 'verdict — startup sweep',
      afterRestart.rendered === afterRestart.total
        ? 'keeps the site title'
        : `${afterRestart.total - afterRestart.rendered} tab(s) fell back to the placeholder default`);

    console.log('');
    console.log('| Measurement | Value |');
    console.log('| --- | --- |');
    measurements.forEach((entry) => console.log(`| ${entry.what} | ${entry.value} |`));
  }
  finally {
    if (cdp && !KEEP) cdp.close();
    if (!KEEP) {
      browser.proc.kill('SIGTERM');
      await sleep(500);
      fs.rmSync(userDataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    }
    else {
      console.log('');
      console.log(`Browser kept open (pid ${browser.proc.pid}), profile: ${userDataDir}`);
    }
    server.close();
  }
}

// How many suspended placeholders actually show the title of the page they
// carry, rather than the static page's own "Suspended".
async function suspendedTitles(cdp, swSession, tag) {
  return cdp.evaluate(swSession, `(async () => {
    const tabs = (await chrome.tabs.query({}))
      .filter((tab) => tab.url && tab.url.includes('suspend.html') && tab.url.includes('tag%3D${tag}-'));

    let rendered = 0;
    let discarded = 0;
    tabs.forEach((tab) => {
      const wanted = new URL(tab.url).searchParams.get('title');
      if (wanted && tab.title === wanted) rendered++;
      if (tab.discarded) discarded++;
    });

    return {total: tabs.length, rendered: rendered, discarded: discarded};
  })()`);
}

async function waitForLoaded(cdp, swSession, tag, expected) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const ready = await cdp.evaluate(swSession, `(async () => (await chrome.tabs.query({}))
      .filter((tab) => tab.url && tab.url.includes('tag=${tag}-') && tab.status === 'complete').length)()`);
    if (ready >= expected) return;
    await sleep(250);
  }
  throw new Error(`only some ${tag} tabs finished loading`);
}

// Looks the placeholder up by the page it carries: discarding replaces the tab
// id, so it cannot be held across a discard.
async function suspendedTabInfo(cdp, swSession, pageUrl) {
  const marker = encodeURIComponent(pageUrl);
  return cdp.evaluate(swSession, `(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url
      && candidate.url.includes('suspend.html')
      && candidate.url.includes(${JSON.stringify(marker)}));
    if (!tab) return null;
    return {id: tab.id, discarded: !!tab.discarded, title: tab.title, favIconUrl: tab.favIconUrl || '(none)'};
  })()`);
}

if (argv.includes('--render-only')) {
  renderOnly().catch((error) => {
    console.error('');
    console.error('lab failed: ' + error.message);
    process.exit(1);
  });
}
else if (argv.includes('--bfcache-only')) {
  bfcacheOnly().catch((error) => {
    console.error('');
    console.error('lab failed: ' + error.message);
    process.exit(1);
  });
}
else {
  main().catch((error) => {
    console.error('');
    console.error('lab failed: ' + error.message);
    process.exit(1);
  });
}
