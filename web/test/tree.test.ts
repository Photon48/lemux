import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// tree.ts reads LEMUX_DIR when it loads, so point it at a scratch dir first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemux-tree-'));
process.env.LEMUX_DIR = dir;
const tree = await import('../server/tree.js');
const lock = path.join(dir, '.tree.lock');

test('updateTree writes the tree atomically and leaves no lock behind', () => {
  tree.addNode({ id: 'a', parent: '', name: 'a', dir: '/x', created: 1 });
  tree.patchNode('a', { name: 'renamed' });
  assert.equal(tree.readTree()[0].name, 'renamed');
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.startsWith('.tree.')),
    []
  );
});

test('a held lock makes the update wait until it is released', async () => {
  fs.mkdirSync(lock);
  // the other process: holds the lock for a moment, then lets go
  const holder = spawn('/bin/sh', ['-c', `sleep 0.3; rmdir "${lock}"`], { stdio: 'ignore' });
  const t0 = Date.now();
  tree.patchNode('a', { name: 'after the wait' });
  const waited = Date.now() - t0;
  assert.ok(waited >= 200, `waited only ${waited}ms`);
  assert.equal(tree.readTree()[0].name, 'after the wait');
  await new Promise((r) => holder.on('exit', r));
});

test('a stale lock is broken instead of waited on', () => {
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - tree.LOCK_STALE_MS - 1000);
  fs.utimesSync(lock, old, old);
  const t0 = Date.now();
  tree.patchNode('a', { name: 'past the stale lock' });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(tree.readTree()[0].name, 'past the stale lock');
  assert.equal(fs.existsSync(lock), false);
});

test('readTree sees a write made by another process', () => {
  const before = tree.readTree();
  assert.equal(before[0].name, 'past the stale lock');
  const other = [{ id: 'a', parent: '', name: 'from bash', dir: '/x', created: 1 }];
  fs.writeFileSync(path.join(dir, 'tree.json'), JSON.stringify(other) + '\n');
  assert.equal(tree.readTree()[0].name, 'from bash');
  // and a cached read hands back the same parse until the file changes
  assert.equal(tree.readTree(), tree.readTree());
});
