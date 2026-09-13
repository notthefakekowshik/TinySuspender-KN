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

function startServer() {
  const sockets = new Set();

  const server = http.createServer((request, response) => {
    const name = (request.url.split('?')[0].replace(/^\//, '') || 'static').replace(/[^a-z]/gi, '');
    const file = path.join(PAGES_DIR, `${name}.html`);

    if (!fs.existsSync(file)) {
      response.writeHead(404);
      response.end('not found');
      return;
    }

    response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
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

main().catch((error) => {
  console.error('');
  console.error('lab failed: ' + error.message);
  process.exit(1);
});
