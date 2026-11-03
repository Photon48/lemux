import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasEnvelope, reminder } from '../server/widgets.js';

test('the envelope lists every node, shows source only for picked ones, and says where to land', () => {
  const env = canvasEnvelope({
    nodes: [
      { id: 'wing', kind: 'pic', q: 'how big', cap: 'Long span.', art: '<svg/>', text: 'back' },
      { id: 'tank', kind: 'text', q: 'wet?', cap: 'Wet wing.', from: 'wing', text: 'words' },
    ],
    picked: ['wing'],
    links: [{ a: 'wing', b: 'tank', lbl: 'same spar' }],
    frames: [{ lbl: 'later', inside: ['tank'] }],
    notes: [{ id: 'u-1', title: 'Budget', text: 'under 20 kg' }],
    files: [{ id: 'u-2', name: 'spec.pdf', path: '/p/spec.pdf' }],
    from: 'wing',
  });
  const lines = env.split('\n');
  assert.equal(lines[0], '<lemux-canvas>');
  assert.equal(lines.at(-1), '</lemux-canvas>');
  assert.ok(env.includes('- wing [pic, PICKED]: asked "how big" → Long span.'));
  assert.ok(env.includes('  art: <svg/>'));
  assert.ok(env.includes('  text: back'));
  assert.ok(env.includes('- tank [text] from wing: asked "wet?" → Wet wing.'));
  assert.ok(!env.includes('  text: words'), 'unpicked nodes do not carry their source');
  assert.ok(env.includes('Links: wing — tank (same spar)'));
  assert.ok(env.includes('Frames: "later" holding tank'));
  assert.ok(env.includes('- Budget: under 20 kg'));
  assert.ok(env.includes('- spec.pdf: /p/spec.pdf'));
  assert.ok(env.includes('Picked: wing. The question is about these.'));
  assert.ok(env.includes('A new node should say from: "wing".'));
});

test('an empty canvas says so', () => {
  const env = canvasEnvelope({ nodes: [], picked: [], links: [], frames: [], notes: [], files: [] });
  assert.ok(env.includes('Nodes (0):'));
  assert.ok(env.includes('Nothing picked.'));
  assert.ok(!env.includes('Links:'));
});

test('the reminder carries the taste signal only when there is one', () => {
  assert.ok(!reminder({ removed: 0, lastRemoved: [] }).includes('removed'));
  const r = reminder({ removed: 2, lastRemoved: ['a', 'b'] });
  assert.ok(r.includes('They have removed 2 nodes so far (last: "a", "b").'));
  assert.ok(reminder({ removed: 1, lastRemoved: [] }).includes('removed 1 node so far.'));
});
