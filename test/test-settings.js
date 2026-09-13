const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// settings.js wires itself to the options page's DOM at load time, so give it
// just enough of one to load before requiring it.
function makeElement() {
  return {
    value: '',
    textContent: '',
    disabled: false,
    files: [],
    style: {},
    attributes: {},
    classList: {add: () => {}, remove: () => {}},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
  };
}

const element = makeElement();

global.document = {
  body: {classList: {add: () => {}, remove: () => {}}, appendChild: () => {}},
  querySelector: () => element,
  createElement: () => makeElement(),
};

global.chrome = {
  runtime: {
    lastError: null,
    getManifest: () => ({version: '0.0.0'}),
  },
  storage: {
    sync: {
      get: (keys, callback) => callback({}),
      set: (items, callback) => { if (callback) callback(); },
    },
  },
  tabs: {create: () => {}},
};

const {sanitizeSettings} = require(path.resolve(__dirname, '../src/tiny-suspender/js/settings.js'));

test('sanitizeSettings keeps known settings and coerces the idle threshold', () => {
  assert.deepStrictEqual(
    sanitizeSettings({
      idleTimeMinutes: '15',
      whitelist: 'https://a.example/\nhttps://b.example/',
      autorestore: true,
      skip_audible: false,
      dark_mode: true,
    }),
    {
      idleTimeMinutes: 15,
      whitelist: 'https://a.example/\nhttps://b.example/',
      autorestore: true,
      skip_audible: false,
      dark_mode: true,
    });

  assert.deepStrictEqual(sanitizeSettings({idleTimeMinutes: 0}), {idleTimeMinutes: 0},
    '0 disables auto-suspension and must survive an import');
});

test('sanitizeSettings drops unknown keys and values of the wrong type', () => {
  // Regression: a whitelist imported as a number makes readSettings throw on
  // .split(), which leaves settingsReady pending and stops auto-suspension.
  assert.deepStrictEqual(
    sanitizeSettings({whitelist: 5, idleTimeMinutes: 'soon', autorestore: 'yes', tabState: {1: {}}, extra: true}),
    {});

  assert.deepStrictEqual(sanitizeSettings({idleTimeMinutes: -1}), {},
    'a negative threshold is not a setting');
  assert.deepStrictEqual(sanitizeSettings(null), {});
  assert.deepStrictEqual(sanitizeSettings('nope'), {});
  assert.deepStrictEqual(sanitizeSettings([1, 2]), {});
});
