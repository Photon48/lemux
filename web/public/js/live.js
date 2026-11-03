// What the server streams: session state, canvas changes, questions from cc, and the result of an answer.
import { $, h, api, toast } from './dom.js';
import { state, node, N } from './state.js';
import { loadTree, renderLayers } from './layers.js';
import { renderSpine, loadCanvas } from './nav.js';
import { renderNodes, renderSel } from './canvas.js';
import { userOp } from './ops.js';

// cc asked the person something (AskUserQuestion): a card with the options
export function showQuestion(ev) {
  if (!state.cur || ev.sid !== state.cur) return;
  if ($(`#cards [data-req="${ev.reqId}"]`)) return;
  const qs = (ev.input && ev.input.questions) || [];
  if (ev.tool !== 'AskUserQuestion') return;
  const picks = qs.map(() => new Set());
  const others = qs.map(() => '');
  const card = h(
    'div',
    { class: 'card', 'data-req': ev.reqId },
    h('div', { class: 'title' }, 'cc has a question')
  );
  qs.forEach((q, qi) => {
    const box = h('div', { class: 'q' }, h('div', {}, q.question));
    (q.options || []).forEach((o) => {
      const input = h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `q${ev.reqId}-${qi}` });
      input.onchange = () => {
        if (!q.multiSelect) picks[qi].clear();
        input.checked ? picks[qi].add(o.label) : picks[qi].delete(o.label);
      };
      box.append(h('label', { class: 'opt' }, input, ' ', o.label, h('small', {}, o.description || '')));
    });
    const other = h('input', { type: 'text', placeholder: 'or type your own answer' });
    other.oninput = () => (others[qi] = other.value);
    box.append(other);
    card.append(box);
  });
  card.append(
    h(
      'div',
      { class: 'acts' },
      h(
        'button',
        {
          class: 'primary',
          onclick: () => {
            const answers = {};
            qs.forEach((q, qi) => {
              answers[q.question] = others[qi].trim() || [...picks[qi]].join(', ');
            });
            api('/api/permission', {
              sid: ev.sid,
              reqId: ev.reqId,
              reply: { kind: 'answers', answers },
            }).catch(() => {});
            card.remove();
          },
        },
        'Send answers'
      )
    )
  );
  $('#cards').append(card);
}

// after an answer: compare the canvas before and after, place new nodes where asked, say what changed
let changeTimer = null;
function afterAnswer(ev, before, landing) {
  if (!before || !state.cv) return;
  const after = state.cv;
  const added = after.nodes.filter((n) => !before.ids.has(n.id));
  const removed = [...before.ids].filter((id) => !after.nodes.some((n) => n.id === id));
  const changed = after.nodes.filter(
    (n) => before.ids.has(n.id) && (n.redrawn || []).length > (before.redrawn[n.id] || 0)
  );
  if (landing && added.length) {
    const pos = {};
    added.forEach((n, i) => {
      pos[n.id] = { x: landing.x, y: landing.y + i * 260 };
      after.pos[n.id] = pos[n.id];
    });
    userOp({ op: 'move', pos }, true);
    renderNodes();
  }
  const linked = after.links.length - before.links;
  const parts = [];
  if (added.length) parts.push(`added ${added.length}`);
  if (changed.length) parts.push(`changed ${changed.length}`);
  if (removed.length) parts.push(`removed ${removed.length}`);
  if (linked > 0) parts.push(`linked ${linked}`);
  if (linked < 0) parts.push(`unlinked ${-linked}`);
  if (parts.length) {
    $('#change-t').textContent = ' · ' + parts.join(' · ');
    $('#change').classList.add('on');
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => $('#change').classList.remove('on'), 9000);
    for (const n of [...added, ...changed]) N.querySelector(`[data-id="${n.id}"]`)?.classList.add('changed');
    state.sel = new Set(added.map((n) => n.id));
    renderSel();
  }
  if (!ev.ok && ev.error) toast(ev.error);
}

function onEvent(ev) {
  if (ev.type === 'tree') {
    loadTree();
    return;
  }
  if (ev.type === 'state') {
    const n = node(ev.sid);
    if (n) {
      n.state = ev.state;
      renderLayers();
      if (ev.sid === state.cur) renderSpine();
    }
    return;
  }
  if (ev.type === 'canvas') {
    if (ev.sid === state.cur && !ev.quiet) loadCanvas();
    return;
  }
  if (ev.sid !== state.cur) return;
  switch (ev.type) {
    case 'user':
      state.live = { q: ev.text, from: [...state.sel][0] || null };
      renderNodes();
      break;
    case 'result': {
      const before = state.cv
        ? {
            ids: new Set(state.cv.nodes.map((n) => n.id)),
            redrawn: Object.fromEntries(state.cv.nodes.map((n) => [n.id, (n.redrawn || []).length])),
            links: (state.cv.links || []).length,
          }
        : null;
      const landing = state.live && state.live.moved ? state.live.at : null;
      state.live = null;
      loadCanvas().then(() => afterAnswer(ev, before, landing));
      break;
    }
    case 'permission':
      showQuestion(ev);
      break;
    case 'permission_resolved':
      $(`#cards [data-req="${ev.reqId}"]`)?.remove();
      break;
    case 'error':
      toast(ev.message);
      break;
  }
}

export function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
