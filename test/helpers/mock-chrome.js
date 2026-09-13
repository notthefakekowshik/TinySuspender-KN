// Minimal chrome API mock for testing core.js. Each call to makeChromeMock()
// returns an isolated chrome surface plus hooks to fire events and inspect
// outgoing calls. The mock intentionally only covers the API surface core.js
// actually touches — extend as needed.

function makeListenerHub() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    fire: (...args) => listeners.forEach((fn) => fn(...args)),
  };
}

function pickKeys(obj, keys) {
  const out = {};
  (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
    if (k in obj) out[k] = obj[k];
  });
  return out;
}

function makeChromeMock(initial = {}) {
  const syncStorage = { ...(initial.sync || {}) };
  const localStorage = { ...(initial.local || {}) };
  const sessionStorage = { ...(initial.session || {}) };
  const alarms = new Map();
  const tabs = new Map();
  let nextTabId = 1;

  const hubs = {
    onMessage: makeListenerHub(),
    onSuspend: makeListenerHub(),
    onInstalled: makeListenerHub(),
    onUpdated: makeListenerHub(),
    onActivated: makeListenerHub(),
    onRemoved: makeListenerHub(),
    onCreated: makeListenerHub(),
    onContextMenuClick: makeListenerHub(),
    onCommand: makeListenerHub(),
    onStorageChanged: makeListenerHub(),
    onAlarm: makeListenerHub(),
  };

  const calls = {
    alarmsCreate: [],
    alarmsClear: [],
    tabsUpdate: [],
    tabsCreate: [],
    tabsDiscard: [],
    tabsSendMessage: [],
    setIcon: [],
  };

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      getURL: (path) => 'chrome-extension://test-extension-id/' + path,
      lastError: null,
      onMessage:   { addListener: hubs.onMessage.addListener },
      onSuspend:   { addListener: hubs.onSuspend.addListener },
      onInstalled: { addListener: hubs.onInstalled.addListener },
    },
    tabs: {
      onUpdated:   { addListener: hubs.onUpdated.addListener },
      onActivated: { addListener: hubs.onActivated.addListener },
      onRemoved:   { addListener: hubs.onRemoved.addListener },
      onCreated:   { addListener: hubs.onCreated.addListener },
      query: (q, cb) => {
        const out = [...tabs.values()].filter((t) =>
          q.active === undefined || t.active === q.active
        );
        cb(out);
      },
      get: (id, cb) => cb(tabs.get(id)),
      update: (id, info, cb) => {
        calls.tabsUpdate.push({id, info});
        const t = tabs.get(id);
        if (t && info.url) {
          // Chrome resolves relative URLs against the extension's base URL.
          t.url = info.url.startsWith('chrome-extension://')
            ? info.url
            : 'chrome-extension://test-extension-id/' + info.url;
        }
        if (cb) cb(t);
      },
      sendMessage: (id, msg, ...rest) => {
        calls.tabsSendMessage.push({id, msg});
        const cb = rest.find((x) => typeof x === 'function');
        // Respond through the optional initial.onTabMessage(id, msg) handler;
        // without one, pretend no content script is listening (undefined).
        const response = initial.onTabMessage ? initial.onTabMessage(id, msg) : undefined;
        if (cb) setImmediate(() => cb(response));
      },
      discard: (id, cb) => {
        calls.tabsDiscard.push(id);
        const t = tabs.get(id);
        if (t) t.discarded = true;
        if (cb) cb();
      },
      create: (info, cb) => {
        calls.tabsCreate.push(info);
        while (tabs.has(nextTabId)) nextTabId++;
        const created = {id: nextTabId, url: info.url, active: !!info.active, title: '', discarded: false};
        tabs.set(nextTabId, created);
        nextTabId++;
        if (cb) cb(created);
      },
    },
    storage: {
      sync: {
        get: (keys, cb) => setImmediate(() => cb(pickKeys(syncStorage, keys))),
        set: (items, cb) => { Object.assign(syncStorage, items); if (cb) cb(); },
      },
      local: {
        get: (keys, cb) => setImmediate(() => cb(pickKeys(localStorage, keys))),
        set: (items, cb) => { Object.assign(localStorage, items); if (cb) cb(); },
      },
      session: {
        get: (keys, cb) => setImmediate(() => cb(pickKeys(sessionStorage, keys))),
        set: (items, cb) => { Object.assign(sessionStorage, items); if (cb) cb(); },
        remove: (keys, cb) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete sessionStorage[k]; });
          if (cb) cb();
        },
      },
      onChanged: { addListener: hubs.onStorageChanged.addListener },
    },
    alarms: {
      create: (name, opts) => {
        calls.alarmsCreate.push({name, opts});
        alarms.set(name, {
          name,
          scheduledTime: Date.now() + opts.delayInMinutes * 60000,
        });
      },
      clear: (name, cb) => {
        calls.alarmsClear.push(name);
        const had = alarms.delete(name);
        if (cb) cb(had);
      },
      get: (name, cb) => setImmediate(() => cb(alarms.get(name))),
      onAlarm: { addListener: hubs.onAlarm.addListener },
    },
    contextMenus: {
      onClicked: { addListener: hubs.onContextMenuClick.addListener },
      removeAll: (cb) => { if (cb) cb(); },
      create: (info) => info.id,
    },
    commands: {
      onCommand: { addListener: hubs.onCommand.addListener },
    },
    action: {
      setIcon: (param) => calls.setIcon.push(param),
    },
  };

  return {
    chrome,
    fire: {
      onCreated:        hubs.onCreated.fire,
      onActivated:      hubs.onActivated.fire,
      onRemoved:        hubs.onRemoved.fire,
      onUpdated:        hubs.onUpdated.fire,
      onStorageChanged: hubs.onStorageChanged.fire,
      onAlarm:          hubs.onAlarm.fire,
    },
    setTabs: (list) => {
      tabs.clear();
      list.forEach((t) => tabs.set(t.id, t));
    },
    getTabs: () => [...tabs.values()],
    syncStorage,
    localStorage,
    sessionStorage,
    alarms,
    calls,
  };
}

module.exports = { makeChromeMock };
