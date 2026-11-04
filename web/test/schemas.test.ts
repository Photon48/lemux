import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import {
  parseCanvasPost,
  parseFenceOps,
  SendBody,
  PermissionBody,
  jsonIn,
  BriefJson,
} from '../server/schemas.js';

test('a canvas post is one op with flags beside it, or a batch', () => {
  assert.deepEqual(parseCanvasPost({ op: 'move', pos: { a: { x: 1, y: 2 } }, quiet: true }), {
    ops: [{ op: 'move', pos: { a: { x: 1, y: 2 } } }],
    noHistory: false,
    quiet: true,
  });
  const batch = parseCanvasPost({
    ops: [{ op: 'undo' }, { op: 'restore', id: 'a' }],
    noHistory: true,
  });
  assert.equal(batch.ops.length, 2);
  assert.equal(batch.noHistory, true);
});

test('a canvas post with a wrong shape is refused', () => {
  assert.throws(() => parseCanvasPost({ op: 'move', pos: { a: { x: '1', y: 2 } } }), ZodError);
  assert.throws(() => parseCanvasPost({ op: 'explode' }), ZodError);
  assert.throws(() => parseCanvasPost({ op: 'restore' }), ZodError);
  assert.throws(() => parseCanvasPost('nope'), ZodError);
});

test('send fills defaults and forgives a bad scope', () => {
  const b = SendBody.parse({ sid: 's', text: 'hi', scope: 'everything' });
  assert.deepEqual(b, { sid: 's', text: 'hi', scope: 'last', picked: [], at: null, from: null });
  assert.throws(() => SendBody.parse({ text: 'hi' }), ZodError);
});

test('a permission reply must be one of the three kinds', () => {
  assert.ok(
    PermissionBody.safeParse({ sid: 's', reqId: 'p1', reply: { kind: 'allow', always: true } }).success
  );
  assert.ok(
    PermissionBody.safeParse({ sid: 's', reqId: 'p1', reply: { kind: 'answers', answers: { q: 'a' } } })
      .success
  );
  assert.equal(PermissionBody.safeParse({ sid: 's', reqId: 'p1', reply: { kind: 'maybe' } }).success, false);
});

test('fence ops: a trailing comma is forgiven, a bad field is dropped, a bad op is skipped', () => {
  const ops = parseFenceOps(
    '[{"op":"add","id":"a","cap":42,"kind":"pic"},{"op":"add"},{"op":"link","a":"a","b":"b"},]'
  );
  assert.deepEqual(ops, [
    { op: 'add', id: 'a', cap: undefined, kind: 'pic' },
    { op: 'link', a: 'a', b: 'b' },
  ]);
  assert.deepEqual(parseFenceOps('{"op":"add","id":"a"}'), []);
  assert.deepEqual(parseFenceOps('not json'), []);
});

test('jsonIn finds the object in a reply and checks it', () => {
  assert.deepEqual(jsonIn('Sure:\n{"name":"wing","diverge":"probing lift"}', BriefJson), {
    name: 'wing',
    diverge: 'probing lift',
  });
  assert.equal(jsonIn('no object here', BriefJson), undefined);
  assert.equal(jsonIn('{"name": 5}', BriefJson), undefined);
});
