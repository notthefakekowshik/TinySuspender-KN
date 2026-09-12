const { test } = require('node:test');
const assert = require('node:assert');

const documentListeners = {};
const windowListeners = {};

function makeNode() {
  return {
    setAttribute: () => {},
    removeAttribute: () => {},
    appendChild: () => {},
    getAttribute: () => null,
    classList: {add: () => {}, remove: () => {}},
    textContent: '',
    value: '',
    href: '',
  };
}

global.document = {
  addEventListener: (type, fn) => {
    (documentListeners[type] = documentListeners[type] || []).push(fn);
  },
  querySelector: () => makeNode(),
};

global.window = {
  addEventListener: (type, fn) => {
    (windowListeners[type] = windowListeners[type] || []).push(fn);
  },
};

const content = require('../src/tiny-suspender/js/content.js');

const sent = [];
content.setChrome({
  runtime: {
    sendMessage: (message) => sent.push(message),
    onMessage: {addListener: () => {}},
  },
});
content.initEventHandlers();

const fireDocument = (type, target) => (documentListeners[type] || []).forEach((fn) => fn({target}));
const fireWindow = (data, source) => {
  const event = {source: source === undefined ? global.window : source, data};
  (windowListeners.message || []).forEach((fn) => fn(event));
};
const reset = () => {
  sent.length = 0;
  content.formUpdated = false;
  content.pageBusy = false;
};

test('isFormField recognizes form controls and contenteditable regions', () => {
  assert.strictEqual(content.isFormField({tagName: 'INPUT'}), true);
  assert.strictEqual(content.isFormField({tagName: 'TEXTAREA'}), true);
  assert.strictEqual(content.isFormField({tagName: 'SELECT'}), true);
  assert.strictEqual(content.isFormField({tagName: 'DIV', isContentEditable: true}), true);
  assert.strictEqual(content.isFormField({tagName: 'DIV', isContentEditable: false}), false);
  assert.strictEqual(content.isFormField({tagName: 'BUTTON'}), false);
  assert.strictEqual(content.isFormField(null), false);
  assert.strictEqual(content.isFormField(undefined), false);
});

test('typing, selects and contenteditable edits mark the tab as form changed', () => {
  reset();

  fireDocument('input', {tagName: 'TEXTAREA'});
  assert.deepStrictEqual(sent, [{command: 'ts_update_tab_icon', state: 'suspendable:form_changed'}]);

  // The flag is sticky: later edits must not spam the worker.
  fireDocument('input', {tagName: 'INPUT'});
  fireDocument('change', {tagName: 'SELECT'});
  assert.strictEqual(sent.length, 1);
});

test('the page agent busy signal becomes suspendable:busy', () => {
  reset();

  fireWindow({__tinySuspenderAgent: true, busy: true});
  assert.deepStrictEqual(sent.at(-1), {command: 'ts_update_tab_icon', state: 'suspendable:busy'});
  assert.strictEqual(content.get_current_state(), 'suspendable:busy');

  sent.length = 0;
  fireWindow({__tinySuspenderAgent: true, busy: false});
  assert.deepStrictEqual(sent.at(-1), {command: 'ts_update_tab_icon', state: 'suspendable:auto'});
  assert.strictEqual(content.get_current_state(), 'suspendable:auto');
});

test('busy takes precedence over unsaved form data', () => {
  reset();

  fireDocument('change', {tagName: 'INPUT'});
  assert.strictEqual(content.get_current_state(), 'suspendable:form_changed');

  fireWindow({__tinySuspenderAgent: true, busy: true});
  assert.strictEqual(content.get_current_state(), 'suspendable:busy');

  fireWindow({__tinySuspenderAgent: true, busy: false});
  assert.strictEqual(content.get_current_state(), 'suspendable:form_changed');
});

test('busy signals from other sources are ignored', () => {
  reset();

  fireWindow({__tinySuspenderAgent: true, busy: true}, {not: 'this window'});
  fireWindow({someOtherAgent: true, busy: true});
  fireWindow({__tinySuspenderAgent: true, busy: false});

  assert.strictEqual(content.pageBusy, false);
  assert.strictEqual(sent.length, 0);
});
