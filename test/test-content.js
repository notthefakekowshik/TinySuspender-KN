const { test } = require('node:test');
const assert = require('node:assert');

const content = require('../src/tiny-suspender/js/content.js');

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
