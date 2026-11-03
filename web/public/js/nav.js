// Moving between canvases, and the spine above the canvas: crumbs, the way up, the state pill.
import { $, h, api, store, toast } from './dom.js';
import { state, node, crumbs, vp } from './state.js';
import { loadTree, renderLayers } from './layers.js';
import { renderNodes, renderSel, applyView } from './canvas.js';
import { hidePeek, setZoomTarget } from './tools.js';
import { showQuestion } from './live.js';

export function showEmpty() {
  state.cur = null;
  state.cv = null;
  state.fresh = null;
  state.sel.clear();
  renderSpine();
  renderNodes();
  renderLayers();
  $('#cards').replaceChildren();
  updateHist();
}

export async function go(sid, { push = true, focus = null } = {}) {
  if (!node(sid)) return;
  if (push && state.hist[state.hpos] !== sid) {
    state.hist.splice(state.hpos + 1);
    state.hist.push(sid);
    state.hpos = state.hist.length - 1;
  }
  hidePeek();
  state.cur = sid;
  state.fresh = null;
  state.sel.clear();
  state.selLink = null;
  state.view = store.get('view:' + sid, { x: 0, y: 0, k: 1 });
  setZoomTarget(state.view.k);
  store.set('cur:' + state.project, sid);
  history.replaceState(null, '', '#' + sid);
  $('#cards').replaceChildren();
  renderSpine();
  renderLayers();
  updateHist();
  await loadCanvas();
  if (focus) {
    state.sel = new Set([focus]);
    const p = state.cv.pos[focus];
    if (p) {
      state.view = { k: 1, x: vp.clientWidth / 2 - p.x - 180, y: vp.clientHeight / 2 - p.y - 100 };
      applyView();
    }
    renderSel();
  }
  $('#in').focus();
}

export async function loadCanvas() {
  if (!state.cur) return;
  const sid = state.cur;
  try {
    const cv = await api(`/api/canvas/${sid}`);
    if (state.cur !== sid) return;
    state.cv = cv;
    renderNodes();
    renderSpine();
    for (const ev of cv.pending || []) showQuestion(ev);
  } catch (e) {
    toast(e.message);
  }
}

function updateHist() {
  $('#up').hidden = !(state.cur && node(state.cur)?.parent);
}
$('#up').onclick = () => {
  const p = state.cur && node(state.cur)?.parent;
  if (p) go(p);
};

const STATE_TEXT = {
  busy: 'drawing',
  waiting: 'needs you',
  done: 'finished while you were away',
  error: 'ended with an error',
};

export function renderSpine() {
  const n = state.cur && node(state.cur);
  const c = n ? crumbs(n.id) : [];
  const cr = $('#crumbs');
  cr.replaceChildren();
  if (n) {
    cr.append(
      ...c.flatMap((x, i) =>
        i === c.length - 1
          ? [
              h('span', {
                class: 'here',
                contenteditable: 'true',
                spellcheck: 'false',
                title: 'click to rename',
                text: x.name,
              }),
            ]
          : [h('a', { onclick: () => go(x.id) }, x.name), h('span', { class: 'sep' }, '›')]
      )
    );
  } else if (state.fresh)
    cr.append(
      h('span', { class: 'here', contenteditable: 'true', spellcheck: 'false', text: state.fresh.name })
    );
  else
    cr.append(
      h(
        'span',
        { class: 'here', style: 'font-weight:400;color:var(--ink-2)' },
        state.projects.find((p) => p.dir === state.project)?.name || ''
      )
    );
  const here = $('#crumbs .here[contenteditable]');
  if (here) {
    here.onkeydown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        here.blur();
      }
      if (ev.key === 'Escape') {
        here.textContent = n ? n.name : state.fresh.name;
        here.blur();
      }
    };
    here.onblur = async () => {
      const v = here.textContent.trim();
      if (!v) {
        here.textContent = n ? n.name : state.fresh.name;
        return;
      }
      if (n) {
        if (v !== n.name) {
          try {
            await api('/api/rename', { id: n.id, name: v });
          } catch (e) {
            toast(e.message);
          }
          loadTree();
        }
      } else state.fresh.name = v;
    };
  }
  const up = $('#up');
  if (n && n.parent) {
    up.hidden = false;
    up.textContent = `↑ Up to ${node(n.parent)?.name || ''}`;
  } else up.hidden = true;
  const ins = $('#inside');
  ins.classList.toggle('on', !!(n && n.parent));
  if (n && n.parent) ins.textContent = `Inside “${n.name}”, a dive from ${node(n.parent)?.name || ''}`;
  const pill = $('#pill');
  if (n && n.state !== 'idle') {
    pill.className = `pill ${n.state}`;
    $('#pill-text').textContent = STATE_TEXT[n.state] || n.state;
  } else pill.classList.add('hidden');
  $('#stop').classList.toggle('hidden', !(n && (n.state === 'busy' || n.state === 'waiting')));
}

$('#stop').onclick = () => api('/api/interrupt', { sid: state.cur }).catch(() => {});
window.addEventListener('hashchange', () => {
  const sid = location.hash.slice(1);
  if (sid && node(sid) && sid !== state.cur) go(sid);
});
