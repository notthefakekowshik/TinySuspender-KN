const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const AGENT_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../src/tiny-suspender/js/page-agent.js'), 'utf8');

async function flush(ticks = 4) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Runs page-agent.js in a vm context with fake platform APIs, so the busy
// logic can be driven deterministically without a browser.
function makeAgentEnv() {
  const messages = [];
  const timers = [];
  const documentListeners = {};
  const pendingFetches = [];
  let fakeNow = 0;

  class FakeEventTarget {
    constructor() {
      this.listeners = {};
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners[type] || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    }
    dispatch(type) {
      (this.listeners[type] || []).slice().forEach((fn) => fn({type, target: this}));
    }
  }

  class FakeXMLHttpRequest extends FakeEventTarget {
    send() {}
  }

  class FakeWebSocket extends FakeEventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
    }
  }

  class FakeEventSource extends FakeEventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
    }
  }

  class FakeRTCPeerConnection extends FakeEventTarget {
    constructor() {
      super();
      this.connectionState = 'new';
    }
  }

  const sandbox = {};
  vm.createContext(sandbox);

  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.Date = {now: () => fakeNow};
  sandbox.setTimeout = (fn, delay) => {
    const timer = {fn, at: fakeNow + (delay || 0)};
    timers.push(timer);
    return timer;
  };
  sandbox.clearTimeout = (timer) => {
    const index = timers.indexOf(timer);
    if (index >= 0) timers.splice(index, 1);
  };
  // Copy into this realm: deepStrictEqual compares prototypes, and objects
  // created inside the vm have a different Object.prototype.
  sandbox.postMessage = (message) => messages.push({...message});
  sandbox.document = {
    pictureInPictureElement: null,
    addEventListener: (type, fn) => {
      (documentListeners[type] = documentListeners[type] || []).push(fn);
    },
  };
  sandbox.fetch = () => new Promise((resolve, reject) => pendingFetches.push({resolve, reject}));
  sandbox.XMLHttpRequest = FakeXMLHttpRequest;
  sandbox.WebSocket = FakeWebSocket;
  sandbox.EventSource = FakeEventSource;
  sandbox.RTCPeerConnection = FakeRTCPeerConnection;

  vm.runInContext(AGENT_SOURCE, sandbox);

  const advance = (ms) => {
    fakeNow += ms;
    let ran = true;
    while (ran) {
      ran = false;
      for (const timer of timers.slice()) {
        if (timer.at <= fakeNow) {
          timers.splice(timers.indexOf(timer), 1);
          timer.fn();
          ran = true;
        }
      }
    }
  };

  return {
    sandbox,
    messages,
    advance,
    resolveFetch: (index = 0) => pendingFetches[index].resolve({ok: true}),
    fireDocument: (type) => (documentListeners[type] || []).forEach((fn) => fn({type})),
  };
}

test('page agent ignores short requests and reports long ones', async () => {
  const env = makeAgentEnv();

  env.sandbox.fetch('https://example.com/beacon');
  env.advance(500);
  await flush();
  assert.deepStrictEqual(env.messages, [], 'short requests are ordinary page chatter');

  env.advance(3000);
  assert.deepStrictEqual(env.messages, [{__tinySuspenderAgent: true, busy: true}]);

  env.resolveFetch();
  await flush();
  assert.deepStrictEqual(env.messages, [
    {__tinySuspenderAgent: true, busy: true},
    {__tinySuspenderAgent: true, busy: false},
  ]);
});

test('page agent reports long-running XHRs', () => {
  const env = makeAgentEnv();

  const xhr = new env.sandbox.XMLHttpRequest();
  xhr.send();
  env.advance(3500);

  assert.deepStrictEqual(env.messages, [{__tinySuspenderAgent: true, busy: true}]);

  xhr.dispatch('loadend');
  assert.deepStrictEqual(env.messages.at(-1), {__tinySuspenderAgent: true, busy: false});
});

test('page agent reports busy while a WebSocket is open', () => {
  const env = makeAgentEnv();

  const socket = new env.sandbox.WebSocket('wss://example.com/live');
  socket.dispatch('open');
  assert.deepStrictEqual(env.messages.at(-1), {__tinySuspenderAgent: true, busy: true});

  socket.dispatch('close');
  assert.deepStrictEqual(env.messages.at(-1), {__tinySuspenderAgent: true, busy: false});
});

test('page agent reports busy for a live peer connection, even when silent', () => {
  const env = makeAgentEnv();

  const peer = new env.sandbox.RTCPeerConnection();
  peer.connectionState = 'connecting';
  peer.dispatch('connectionstatechange');
  assert.deepStrictEqual(env.messages.at(-1), {__tinySuspenderAgent: true, busy: true});

  peer.connectionState = 'connected';
  peer.dispatch('connectionstatechange');
  assert.strictEqual(env.messages.length, 1, 'still busy, so no duplicate report');

  peer.connectionState = 'closed';
  peer.dispatch('connectionstatechange');
  assert.deepStrictEqual(env.messages.at(-1), {__tinySuspenderAgent: true, busy: false});
});

test('page agent reports busy while an EventSource is open', () => {
  const env = makeAgentEnv();

  const stream = new env.sandbox.EventSource('https://example.com/events');
  stream.dispatch('open');
  assert.deepStrictEqual(env.messages.at(-1), {__tinySuspenderAgent: true, busy: true});

  stream.readyState = 0;  // reconnecting
  stream.dispatch('error');
  assert.deepStrictEqual(env.messages.at(-1), {__tinySuspenderAgent: true, busy: true});

  stream.readyState = 2;  // CLOSED
  stream.dispatch('error');
  assert.deepStrictEqual(env.messages.at(-1), {__tinySuspenderAgent: true, busy: false});
});

test('page agent reports busy while picture-in-picture is active', () => {
  const env = makeAgentEnv();

  env.sandbox.document.pictureInPictureElement = {tagName: 'VIDEO'};
  env.fireDocument('enterpictureinpicture');
  assert.deepStrictEqual(env.messages.at(-1), {__tinySuspenderAgent: true, busy: true});

  env.sandbox.document.pictureInPictureElement = null;
  env.fireDocument('leavepictureinpicture');
  assert.deepStrictEqual(env.messages.at(-1), {__tinySuspenderAgent: true, busy: false});
});

test('page agent does not install twice', () => {
  const env = makeAgentEnv();

  vm.runInContext(AGENT_SOURCE, env.sandbox);

  const socket = new env.sandbox.WebSocket('wss://example.com/live');
  socket.dispatch('open');
  assert.strictEqual(env.messages.length, 1, 'double injection must not double-report');
});
