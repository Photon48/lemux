import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayCanvas, turns, cleanUserText, carried, lastAssistantText } from '../server/transcript.js';
import { writeTranscript, fence } from './helpers.js';

test('replay: add, update, remove with rewiring, link and unlink', () => {
  const f = writeTranscript([
    { type: 'user', text: 'how big a wing' },
    {
      type: 'assistant',
      text: fence(
        [
          { op: 'add', id: 'wing', kind: 'pic', cap: 'Long span.', art: '<svg/>' },
          { op: 'add', id: 'tank', kind: 'text', from: 'wing', cap: 'Wet wing.', text: 'words' },
          { op: 'add', id: 'cost', kind: 'text', from: 'tank', cap: 'One leak test.' },
          { op: 'link', a: 'wing', b: 'cost', lbl: 'same spar' },
        ],
        'Three nodes.'
      ),
    },
    { type: 'user', text: 'drop the tank' },
    {
      type: 'assistant',
      text: fence([
        { op: 'update', id: 'wing', cap: 'Longer span.' },
        { op: 'remove', id: 'tank', rewireTo: 'wing' },
        { op: 'unlink', a: 'cost', b: 'wing' },
      ]),
    },
  ]);
  const r = replayCanvas(f);
  assert.deepEqual(
    r.nodes.map((n) => [n.id, n.kind, n.cap, n.from]),
    [
      ['wing', 'pic', 'Longer span.', null],
      ['cost', 'text', 'One leak test.', 'wing'],
    ]
  );
  assert.deepEqual(r.nodes[0].redrawn, ['drop the tank']);
  assert.equal(r.nodes[0].q, 'how big a wing');
  assert.deepEqual(r.links, []);
  assert.deepEqual(
    r.said.map((s) => [s.who, s.text]),
    [
      ['you', 'how big a wing'],
      ['cc', 'Three nodes.'],
      ['you', 'drop the tank'],
    ]
  );
  assert.deepEqual(
    r.turns.map((t) => t.ops),
    [4, 3]
  );
});

test('replay: a repeated id gets a suffix, an unknown from is dropped', () => {
  const f = writeTranscript([
    { type: 'user', text: 'q1' },
    { type: 'assistant', text: fence([{ op: 'add', id: 'Wing Area', kind: 'pic', cap: 'a' }]) },
    { type: 'user', text: 'q2' },
    { type: 'assistant', text: fence([{ op: 'add', id: 'wing-area', kind: 'pic', cap: 'b', from: 'nope' }]) },
  ]);
  const r = replayCanvas(f);
  assert.deepEqual(
    r.nodes.map((n) => [n.id, n.from]),
    [
      ['wing-area', null],
      ['wing-area-2', null],
    ]
  );
});

test('replay: words without a fence become a text node of their own', () => {
  const f = writeTranscript([
    { type: 'user', text: 'are you sure' },
    { type: 'assistant', text: 'Yes. The number holds at sea level.' },
  ]);
  const r = replayCanvas(f);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, 'text');
  assert.equal(r.nodes[0].cap, 'Yes.');
  assert.equal(r.nodes[0].text, 'Yes. The number holds at sea level.');
});

test('replay: old page fences still add, and redraw=N updates', () => {
  const f = writeTranscript([
    { type: 'user', text: 'draw it' },
    { type: 'assistant', text: '```page\n<svg>1</svg>\n```\nFirst.' },
    { type: 'user', text: 'again' },
    { type: 'assistant', text: '```page redraw=1\n<svg>2</svg>\n```\nSecond.' },
  ]);
  const r = replayCanvas(f);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].id, 'p1');
  assert.equal(r.nodes[0].art, '<svg>2</svg>');
  assert.equal(r.nodes[0].cap, 'Second.');
});

test('replay: a seed node can be updated and linked to', () => {
  const f = writeTranscript([
    { type: 'user', text: 'more on this' },
    {
      type: 'assistant',
      text: fence([
        { op: 'update', id: 'origin', cap: 'Sharper.' },
        { op: 'add', id: 'next', kind: 'text', from: 'origin', cap: 'Next.' },
        { op: 'link', a: 'origin', b: 'next' },
      ]),
    },
  ]);
  const seed = [{ id: 'origin', kind: 'pic' as const, q: 'q', cap: 'Blunt.', from: null, by: 'origin' }];
  const r = replayCanvas(f, 0, seed);
  assert.equal(r.nodes[0].cap, 'Sharper.');
  assert.equal(r.nodes[1].from, 'origin');
  assert.deepEqual(r.links, [{ a: 'origin', b: 'next', lbl: undefined }]);
});

test('replay: since hides the turns a dive copied from its parent', () => {
  const f = writeTranscript([
    { type: 'user', text: 'old', ts: '2026-01-01T00:00:00Z' },
    {
      type: 'assistant',
      text: fence([{ op: 'add', id: 'old', kind: 'pic', cap: 'old' }]),
      ts: '2026-01-01T00:00:01Z',
    },
    { type: 'user', text: 'new', ts: '2026-01-02T00:00:00Z' },
    {
      type: 'assistant',
      text: fence([{ op: 'add', id: 'new', kind: 'pic', cap: 'new' }]),
      ts: '2026-01-02T00:00:01Z',
    },
  ]);
  const since = Date.parse('2026-01-01T12:00:00Z') / 1000;
  assert.deepEqual(
    replayCanvas(f, since).nodes.map((n) => n.id),
    ['new']
  );
});

test('replay: a broken fence adds nothing but the words after it still count', () => {
  const f = writeTranscript([
    { type: 'user', text: 'q' },
    { type: 'assistant', text: '```canvas\n[{"op":"add",\n```\nSorry.' },
  ]);
  const r = replayCanvas(f);
  assert.deepEqual(r.nodes, []);
  assert.deepEqual(r.said[1], { who: 'cc', text: 'Sorry.', key: 'u1' });
});

test('turns: only the newest leaf chain counts; meta records are skipped', () => {
  const f = writeTranscript([
    { type: 'user', text: 'hello' },
    { type: 'user', text: '<local-command-caveat>x</local-command-caveat>', isMeta: true },
    { type: 'assistant', text: 'hi' },
  ]);
  assert.deepEqual(
    turns(f).map((t) => [t.role, t.blocks[0]]),
    [
      ['user', { kind: 'text', text: 'hello' }],
      ['assistant', { kind: 'text', text: 'hi' }],
    ]
  );
  assert.equal(lastAssistantText(f), 'hi');
});

test('cleanUserText strips plumbing; carried lifts the @mention blocks', () => {
  const raw =
    '<lemux-canvas>\nNodes (0)\n</lemux-canvas>\n\n<lemux-context session="fuel tank" about="weighing tanks" scope="brief">\nWhere it stands: full\n</lemux-context>\n\n<system-reminder>ignore</system-reminder>what about weight';
  assert.equal(cleanUserText(raw), 'what about weight');
  assert.deepEqual(carried(raw), [
    { session: 'fuel tank', about: 'weighing tanks', scope: 'brief', text: 'Where it stands: full' },
  ]);
  assert.equal(cleanUserText('<command-name>/clear</command-name>'), '');
});
