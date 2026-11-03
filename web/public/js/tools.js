// The rail and everything it drives: modes, pan, zoom, lasso, the right-click menu, find, undo, files, keys.
import { $, $$, h, api, toast } from './dom.js';
import { state, cnode, allNodes, widthOf, vp, world } from './state.js';
import { go } from './nav.js';
import { userOp, addNote, deleteSel, diveInto, nameNewFrame } from './ops.js';
import { askHere } from './ask.js';
import { renderSel, drawEdges, applyView, renderMini } from './canvas.js';

const MODE_HINT = {
  ask: 'Click where the answer should land',
  note: 'Click where the note goes',
  frame: 'Click to place a frame, or drag to draw one',
  pan: 'Drag to move around',
};
export function setMode(m) {
  state.mode = m;
  $$('#rail .tool').forEach((t) => t.classList.toggle('on', t.dataset.tool === (m || 'select')));
  vp.classList.toggle('placing', !!m && m !== 'pan');
  vp.classList.toggle('pan', m === 'pan');
  const hint = $('#modehint');
  hint.classList.toggle('on', !!m);
  hint.textContent = MODE_HINT[m] || '';
}

// screen point → world point
export const toW = (e) => {
  const r = vp.getBoundingClientRect();
  return {
    x: (e.clientX - r.left - state.view.x) / state.view.k,
    y: (e.clientY - r.top - state.view.y) / state.view.k,
  };
};

for (const t of $$('#rail .tool'))
  t.onclick = () => {
    const k = t.dataset.tool;
    if (k === 'select') return setMode(null);
    if (['ask', 'note', 'frame', 'pan'].includes(k)) return setMode(state.mode === k ? null : k);
    if (k === 'file') return $('#filepick').click();
    if (k === 'find') openSearch();
    if (k === 'undo') doUndo();
  };

// a click in ask or note mode places the thing
vp.addEventListener('click', (e) => {
  if (
    !state.mode ||
    state.mode === 'pan' ||
    state.mode === 'frame' ||
    e.target.closest('.node, .askhere, .mini')
  )
    return;
  if (!state.cur && !state.fresh) return;
  const w = toW(e);
  if (state.mode === 'ask') askHere(w.x, w.y);
  if (state.mode === 'note') addNote(w.x, w.y);
  setMode(null);
});

// frame mode: click to place, or drag to draw
vp.addEventListener(
  'mousedown',
  (e) => {
    if (state.mode !== 'frame' || e.target.closest('.node, .askhere, .mini') || !state.cur) return;
    e.preventDefault();
    e.stopPropagation();
    const s0 = toW(e);
    const box = h('div', { class: 'lasso' });
    world.append(box);
    let w = 0;
    let hh = 0;
    const mv = (ev) => {
      const p = toW(ev);
      w = p.x - s0.x;
      hh = p.y - s0.y;
      Object.assign(box.style, {
        left: Math.min(s0.x, p.x) + 'px',
        top: Math.min(s0.y, p.y) + 'px',
        width: Math.abs(w) + 'px',
        height: Math.abs(hh) + 'px',
      });
    };
    const up = async () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
      box.remove();
      const f =
        Math.abs(w) > 40 && Math.abs(hh) > 40
          ? { x: Math.min(s0.x, s0.x + w), y: Math.min(s0.y, s0.y + hh), w: Math.abs(w), h: Math.abs(hh) }
          : { x: s0.x, y: s0.y, w: 420, h: 260 };
      setMode(null);
      await userOp({ op: 'frame', frame: { id: 'f-' + Date.now(), ...f, lbl: 'section' } });
      nameNewFrame();
      toast('Name it · “later” sets aside what you drop in');
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  },
  true
);

// empty canvas: lasso in select mode, drag in pan mode
vp.addEventListener('mousedown', (e) => {
  if (e.target.closest('.node, .askhere, .frame .name, .frame .grip, .frame .del')) return;
  if (state.mode && state.mode !== 'pan') return;
  if (state.mode !== 'pan') {
    state.sel.clear();
    state.selLink = null;
    renderSel();
    drawEdges();
    lasso(e);
    return;
  }
  vp.classList.add('panning');
  const sx = e.clientX - state.view.x;
  const sy = e.clientY - state.view.y;
  const mv = (ev) => {
    state.view.x = ev.clientX - sx;
    state.view.y = ev.clientY - sy;
    applyView();
  };
  const up = () => {
    vp.classList.remove('panning');
    window.removeEventListener('mousemove', mv);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', mv);
  window.addEventListener('mouseup', up);
});

function lasso(e) {
  const box = h('div', { class: 'lasso' });
  world.append(box);
  const s0 = toW(e);
  const mv = (ev) => {
    const w = toW(ev);
    const x = Math.min(s0.x, w.x);
    const y = Math.min(s0.y, w.y);
    const W = Math.abs(w.x - s0.x);
    const H = Math.abs(w.y - s0.y);
    Object.assign(box.style, { left: x + 'px', top: y + 'px', width: W + 'px', height: H + 'px' });
    state.sel = new Set(
      allNodes()
        .filter((n) => {
          const p = state.cv.pos[n.id];
          return p && p.x < x + W && p.x + widthOf(n) > x && p.y < y + H && p.y + 120 > y;
        })
        .map((n) => n.id)
    );
    renderSel();
  };
  const up = () => {
    box.remove();
    window.removeEventListener('mousemove', mv);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', mv);
  window.addEventListener('mouseup', up);
}

// ---------- zoom ----------
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const clampZoom = (k) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
function zoomAt(k, mx, my) {
  k = clampZoom(k);
  state.view.x = mx - (mx - state.view.x) * (k / state.view.k);
  state.view.y = my - (my - state.view.y) * (k / state.view.k);
  state.view.k = k;
  applyView();
}
// pinch zoom eases toward a target so it feels like a middle speed
let zoomTarget = 1;
let zoomAnchor = null;
let gliding = false;
export function setZoomTarget(k) {
  zoomTarget = k;
}
function glideZoom(k, mx, my) {
  zoomTarget = clampZoom(k);
  zoomAnchor = { mx, my };
  if (gliding) return;
  gliding = true;
  const step = () => {
    const gap = zoomTarget - state.view.k;
    if (Math.abs(gap) < 0.0015) {
      zoomAt(zoomTarget, zoomAnchor.mx, zoomAnchor.my);
      gliding = false;
      return;
    }
    zoomAt(state.view.k + gap * 0.3, zoomAnchor.mx, zoomAnchor.my);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
// two fingers drag to pan, pinch (ctrl+wheel) to zoom
vp.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      glideZoom(zoomTarget * Math.exp(-e.deltaY * 0.006), e.clientX - r.left, e.clientY - r.top);
      return;
    }
    state.view.x -= e.deltaX;
    state.view.y -= e.deltaY;
    applyView();
  },
  { passive: false }
);
function zoomTo(k) {
  zoomTarget = k;
  const r = vp.getBoundingClientRect();
  const mx = r.width / 2;
  const my = r.height / 2;
  const k0 = state.view.k;
  const x0 = state.view.x;
  const y0 = state.view.y;
  const t0 = performance.now();
  const step = (t) => {
    const u = Math.min(1, (t - t0) / 240);
    const ee = 1 - Math.pow(1 - u, 3);
    const kk = k0 + (k - k0) * ee;
    state.view.x = mx - (mx - x0) * (kk / k0);
    state.view.y = my - (my - y0) * (kk / k0);
    state.view.k = kk;
    applyView();
    if (u < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
$('#z-in').onclick = () => zoomTo(Math.min(ZOOM_MAX, state.view.k * 1.2));
$('#z-out').onclick = () => zoomTo(Math.max(ZOOM_MIN, state.view.k / 1.2));
$('#z-reset').onclick = () => zoomTo(1);

// ---------- the right-click menu ----------
export function menu(x, y, kind, w) {
  $$('.menu').forEach((m) => m.remove());
  const m = h('div', { class: 'menu', style: `left:${x}px;top:${y}px` });
  const one = state.sel.size === 1 ? cnode([...state.sel][0]) : null;
  const items =
    kind === 'node'
      ? [
          ['Ask about', () => $('#in').focus()],
          ['Dive', () => one && diveInto(one)],
          state.sel.size >= 2
            ? [
                'Link these',
                () => {
                  const ids = [...state.sel];
                  const ops = [];
                  for (let i = 0; i < ids.length - 1; i++) ops.push({ op: 'link', a: ids[i], b: ids[i + 1] });
                  userOp({ ops });
                },
              ]
            : null,
          one
            ? ['Set aside', () => userOp({ op: 'aside', id: one.id, on: !state.cv.aside.includes(one.id) })]
            : null,
          one
            ? ['Fold', () => userOp({ op: 'fold', id: one.id, on: !state.cv.folded.includes(one.id) })]
            : null,
          null,
          ['Delete', deleteSel],
        ]
      : [
          ['Ask', () => askHere(w.x, w.y)],
          ['Note', () => addNote(w.x, w.y)],
          [
            'Frame',
            () =>
              userOp({
                op: 'frame',
                frame: { id: 'f-' + Date.now(), x: w.x, y: w.y, w: 420, h: 260, lbl: 'section' },
              }).then(nameNewFrame),
          ],
          null,
          ['Find', openSearch],
        ];
  for (const it of items) {
    if (it === null) {
      m.append(h('hr'));
      continue;
    }
    if (!it) continue;
    m.append(
      h(
        'div',
        {
          onclick: () => {
            m.remove();
            it[1]();
          },
        },
        it[0]
      )
    );
  }
  document.body.append(m);
  closeOnClickAway(m);
}
function closeOnClickAway(el) {
  setTimeout(
    () =>
      document.addEventListener(
        'mousedown',
        (e) => {
          if (!el.contains(e.target)) el.remove();
        },
        { once: true }
      ),
    0
  );
}
vp.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.node')) return;
  e.preventDefault();
  if (!state.cur) return;
  menu(e.clientX, e.clientY, 'canvas', toW(e));
});

export async function doUndo() {
  if (!state.cur) return;
  try {
    const r = await api(`/api/canvas/${state.cur}`, { op: 'undo' });
    toast(r.undone ? 'Undone' : 'Nothing to undo');
  } catch (e) {
    toast(e.message);
  }
}

// ---------- find, across every canvas of the project ----------
export function openSearch() {
  $$('.search').forEach((x) => x.remove());
  const box = h('div', { class: 'search' }, h('input', { placeholder: 'Find' }), h('div', { class: 'rs' }));
  document.body.append(box);
  const inp = $('input', box);
  const rs = $('.rs', box);
  inp.focus();
  let on = 0;
  let hits = [];
  let timer = null;
  const draw = () => {
    rs.replaceChildren(
      ...hits.map((x, i) =>
        h(
          'div',
          { class: 'r' + (i === on ? ' on' : ''), onclick: () => pick(i) },
          h('span', {}, x.q.slice(0, 60)),
          h('small', {}, x.canvas)
        )
      )
    );
  };
  const fetchHits = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const r = await api(
          `/api/search?dir=${encodeURIComponent(state.project)}&q=${encodeURIComponent(inp.value)}`
        );
        hits = r.hits.slice(0, 8);
        on = 0;
        draw();
      } catch {
        /* none */
      }
    }, 150);
  };
  const pick = async (i) => {
    const x = hits[i];
    if (!x) return;
    box.remove();
    await go(x.sid, { focus: x.id });
  };
  inp.oninput = fetchHits;
  inp.onkeydown = (e) => {
    if (e.key === 'Escape') box.remove();
    if (e.key === 'ArrowDown') {
      on = Math.min(on + 1, hits.length - 1);
      draw();
    }
    if (e.key === 'ArrowUp') {
      on = Math.max(on - 1, 0);
      draw();
    }
    if (e.key === 'Enter' && hits[on]) pick(on);
  };
  fetchHits();
  closeOnClickAway(box);
}

// ---------- the peek at a dive, shown over its portal ----------
export function peek(k, e) {
  hidePeek();
  if (!k) return;
  const p = h(
    'div',
    { class: 'peek', id: 'peek' },
    h('b', {}, `inside ${k.name}`),
    h('div', {}, k.diverge || 'a dive from here')
  );
  const r = e.currentTarget.getBoundingClientRect();
  p.style.left = r.left + 'px';
  p.style.top = r.bottom + 6 + 'px';
  document.body.append(p);
}
export function hidePeek() {
  document.getElementById('peek')?.remove();
}
document.addEventListener('mousedown', hidePeek, true);

// ---------- files and images brought onto the canvas ----------
async function bringFile(f, x, y) {
  if (!state.cur) {
    toast('Open a canvas first');
    return;
  }
  const data = await new Promise((res) => {
    const rd = new FileReader();
    rd.onload = () => res(String(rd.result).split(',')[1] || '');
    rd.readAsDataURL(f);
  });
  try {
    const r = await api('/api/upload', { sid: state.cur, name: f.name, data });
    await userOp({
      op: 'note',
      note: {
        id: 'u-' + Date.now(),
        kind: f.type.startsWith('image/') ? 'img' : 'file',
        q: f.name,
        path: r.path,
        x,
        y,
      },
    });
  } catch (e) {
    toast(e.message);
  }
}
vp.addEventListener('dragover', (e) => {
  e.preventDefault();
  vp.classList.add('dropping');
});
vp.addEventListener('dragleave', () => vp.classList.remove('dropping'));
vp.addEventListener('drop', (e) => {
  e.preventDefault();
  vp.classList.remove('dropping');
  const w = toW(e);
  const f = e.dataTransfer.files[0];
  if (f) bringFile(f, w.x, w.y);
});
$('#filepick').onchange = () => {
  const f = $('#filepick').files[0];
  if (!f) return;
  const r = vp.getBoundingClientRect();
  bringFile(
    f,
    (r.width / 2 - state.view.x) / state.view.k - 180,
    (r.height / 2 - state.view.y) / state.view.k - 80
  );
  $('#filepick').value = '';
};

// ---------- keys: escape, undo, delete, back ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.mode) return setMode(null);
    $$('.askhere, .menu, .search').forEach((x) => x.remove());
    if (state.sel.size || state.selLink != null) {
      state.sel.clear();
      state.selLink = null;
      renderSel();
      drawEdges();
    }
    return;
  }
  const typing =
    e.target && e.target.matches && e.target.matches('input, textarea, [contenteditable="true"]');
  if (typing) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    doUndo();
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && (state.sel.size || state.selLink != null)) {
    e.preventDefault();
    deleteSel();
  }
  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    if (state.hpos > 0) {
      state.hpos--;
      go(state.hist[state.hpos], { push: false });
    }
  }
});
window.addEventListener('resize', renderMini);
