import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, blankCanvas, canvasOf, HISTORY_LIMIT } from '../server/canvas.js';

const ids = () => {
  let i = 0;
  return () => `id${++i}`;
};

test('canvasOf fills fields a stored state predates', () => {
  const c = canvasOf({ pos: { a: { x: 1, y: 2 } } });
  assert.deepEqual(c.pos, { a: { x: 1, y: 2 } });
  assert.deepEqual(c.frames, []);
  assert.deepEqual(c.history, []);
});

test('applyOps does not mutate its input', () => {
  const before = blankCanvas();
  applyOps(before, [{ op: 'move', pos: { a: { x: 1, y: 1 } } }]);
  assert.deepEqual(before, blankCanvas());
});

test('move rounds positions and records one snapshot per batch', () => {
  const r = applyOps(blankCanvas(), [
    { op: 'move', pos: { a: { x: 1.4, y: 2.6 } } },
    { op: 'move', pos: { b: { x: 10, y: 10 } } },
  ]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.state.pos, { a: { x: 1, y: 3 }, b: { x: 10, y: 10 } });
  assert.equal(r.state.history.length, 1);
});

test('noHistory changes the state without a snapshot', () => {
  const r = applyOps(blankCanvas(), [{ op: 'move', pos: { a: { x: 1, y: 1 } } }], { noHistory: true });
  assert.equal(r.state.history.length, 0);
});

test('undo restores the previous snapshot and reports it', () => {
  const first = applyOps(blankCanvas(), [{ op: 'move', pos: { a: { x: 5, y: 5 } } }]).state;
  const second = applyOps(first, [{ op: 'move', pos: { a: { x: 9, y: 9 } } }]).state;
  const r = applyOps(second, [{ op: 'undo' }]);
  assert.equal(r.undone, true);
  assert.deepEqual(r.state.pos, { a: { x: 5, y: 5 } });
  assert.equal(r.state.history.length, 1);
  const again = applyOps(r.state, [{ op: 'undo' }]);
  assert.deepEqual(again.state.pos, {});
  assert.equal(applyOps(again.state, [{ op: 'undo' }]).undone, false);
});

test('history is capped', () => {
  let c = blankCanvas();
  for (let i = 0; i < HISTORY_LIMIT + 5; i++)
    c = applyOps(c, [{ op: 'move', pos: { a: { x: i, y: 0 } } }]).state;
  assert.equal(c.history.length, HISTORY_LIMIT);
});

test('frame: new frames get an id and a collapsed label; same id replaces', () => {
  const newId = ids();
  let c = applyOps(
    blankCanvas(),
    [{ op: 'frame', frame: { x: 0.2, y: 0, w: 100, h: 50, lbl: ' a\n  b ' } }],
    {
      newId,
    }
  ).state;
  assert.deepEqual(c.frames, [{ id: 'id1', x: 0, y: 0, w: 100, h: 50, lbl: 'a b' }]);
  c = applyOps(c, [{ op: 'frame', frame: { id: 'id1', x: 5, y: 5, w: 10, h: 10 } }]).state;
  assert.deepEqual(c.frames, [{ id: 'id1', x: 5, y: 5, w: 10, h: 10, lbl: 'section' }]);
  c = applyOps(c, [{ op: 'unframe', id: 'id1' }]).state;
  assert.deepEqual(c.frames, []);
});

test('link and unlink are undirected and remember what cc drew that the person cut', () => {
  let c = applyOps(blankCanvas(), [{ op: 'link', a: 'x', b: 'y', lbl: 'same spar' }]).state;
  c = applyOps(c, [{ op: 'link', a: 'y', b: 'x' }]).state;
  assert.deepEqual(c.links, [{ a: 'x', b: 'y', lbl: 'same spar' }]);
  c = applyOps(c, [{ op: 'unlink', a: 'y', b: 'x' }]).state;
  assert.deepEqual(c.links, []);
  assert.deepEqual(c.unlinks, [{ a: 'y', b: 'x' }]);
  c = applyOps(c, [{ op: 'link', a: 'x', b: 'y' }]).state;
  assert.deepEqual(c.unlinks, []);
});

test('note: defaults, update keeps text and place, kind is validated', () => {
  const newId = ids();
  let c = applyOps(blankCanvas(), [{ op: 'note', note: { kind: 'bogus', q: '', x: 10, y: 20 } }], {
    newId,
  }).state;
  assert.deepEqual(c.notes, [
    { id: 'u-id1', kind: 'note', q: 'Untitled note', text: '', path: undefined, x: 10, y: 20 },
  ]);
  c = applyOps(c, [{ op: 'note', note: { id: 'u-id1', q: 'Title', text: 'body' } }]).state;
  assert.deepEqual(c.notes[0], {
    id: 'u-id1',
    kind: 'note',
    q: 'Title',
    text: 'body',
    path: undefined,
    x: 10,
    y: 20,
  });
  c = applyOps(c, [{ op: 'note', note: { id: 'u-id1', q: 'Moved', x: 1, y: 2 } }]).state;
  assert.equal(c.notes[0].text, 'body');
  assert.deepEqual([c.notes[0].x, c.notes[0].y], [1, 2]);
  c = applyOps(c, [{ op: 'unnote', id: 'u-id1' }]).state;
  assert.deepEqual(c.notes, []);
});

test('remove: notes vanish, cc nodes are remembered with their captions, restore undoes one', () => {
  let c = applyOps(blankCanvas(), [{ op: 'note', note: { id: 'u-1', q: 'mine' } }]).state;
  c = applyOps(c, [{ op: 'remove', ids: ['u-1', 'wing'], q: 'Only the long span clears the line.' }]).state;
  assert.deepEqual(c.notes, []);
  assert.deepEqual(c.removed, ['wing']);
  assert.deepEqual(c.removedQ, ['Only the long span clears the line.']);
  c = applyOps(c, [{ op: 'remove', id: 'wing', q: 'again' }]).state;
  assert.deepEqual(c.removed, ['wing']);
  assert.deepEqual(c.removedQ, ['Only the long span clears the line.']);
  c = applyOps(c, [{ op: 'restore', id: 'wing' }]).state;
  assert.deepEqual(c.removed, []);
});
