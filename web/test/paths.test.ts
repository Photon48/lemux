import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { insideDir, expandHome } from '../server/paths.js';

test('insideDir accepts the root and its descendants', () => {
  assert.equal(insideDir('/p/.lemux/files/a.png', '/p/.lemux/files'), true);
  assert.equal(insideDir('/p/.lemux/files', '/p/.lemux/files'), true);
  assert.equal(insideDir('/p/.lemux/files/deep/er/x', '/p/.lemux/files/'), true);
});

test('insideDir refuses what only looks like it is inside', () => {
  assert.equal(insideDir('/p/.lemux/files/../../tree.json', '/p/.lemux/files'), false);
  assert.equal(insideDir('/p/.lemux/files2/x', '/p/.lemux/files'), false);
  assert.equal(insideDir('/etc/passwd', '/p/.lemux/files'), false);
  assert.equal(insideDir('', '/p/.lemux/files'), false);
});

test('expandHome swaps a leading ~ for the home dir and leaves the rest alone', () => {
  assert.equal(expandHome('~/x'), os.homedir() + '/x');
  assert.equal(expandHome('/abs/~/x'), '/abs/~/x');
});
