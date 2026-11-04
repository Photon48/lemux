// The person's own changes to the canvas, sent to the server as ops.
import { $$, api, toast } from './dom.js';
import { state, cnode, N } from './state.js';
import { loadCanvas, go } from './nav.js';
import { loadTree } from './layers.js';
import { renderSel, doorsFor } from './canvas.js';

// quiet moves are batched: a drag saves once, 300ms after it settles
let moveTimer = null;
let moveBatch = {};
export async function userOp(op, quiet = false) {
  if (!state.cur) return;
  if (op.op === 'move' && quiet) {
    Object.assign(moveBatch, op.pos);
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const pos = moveBatch;
      moveBatch = {};
      api(`/api/canvas/${state.cur}`, { op: 'move', pos, quiet: true }).catch((e) => toast(e.message));
    }, 300);
    return;
  }
  try {
    await api(`/api/canvas/${state.cur}`, { ...op, quiet });
    if (!quiet) await loadCanvas();
  } catch (e) {
    toast(e.message);
  }
}

export async function deleteSel() {
  if (state.selLink != null) {
    const l = state.cv.links[state.selLink];
    state.selLink = null;
    await userOp({ op: 'unlink', a: l.a, b: l.b });
    toast('Link removed · Undo brings it back');
    return;
  }
  const ids = [...state.sel];
  if (!ids.length) return;
  const first = cnode(ids[0]);
  await userOp({ op: 'remove', ids, q: first ? first.q : '' });
  state.sel.clear();
  toast('Deleted · Undo brings it back');
  loadTree();
}

// a new frame's name is selected for typing as soon as it appears
export function nameNewFrame() {
  const name = $$('.frame .name').pop();
  if (name) {
    name.focus();
    document.getSelection().selectAllChildren(name);
  }
}

export async function addNote(x, y) {
  const id = 'u-' + Date.now();
  await userOp({ op: 'note', note: { id, kind: 'note', q: 'Untitled note', text: '', x, y } });
  state.sel = new Set([id]);
  renderSel();
  const t = N.querySelector(`[data-id="${id}"] q`);
  if (t) {
    t.focus();
    document.getSelection().selectAllChildren(t);
  }
}

export async function diveInto(n) {
  const existing = doorsFor(n.id)[0];
  if (existing) {
    go(existing.sid);
    return;
  }
  try {
    const r = await api('/api/branch', { parent: state.cur, node: n.id, question: '' });
    await loadTree();
    await go(r.id);
    toast(`Inside “${r.name}” · ask to go deeper`);
  } catch (e) {
    toast(e.message);
  }
}
