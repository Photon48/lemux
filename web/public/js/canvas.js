// Drawing the open canvas: nodes, frames, edges, the selection and the minimap.
import { $, $$, h, esc, store, toast } from './dom.js';
import { state, node, cnode, allNodes, widthOf, vp, world, N, F, E } from './state.js';
import { go } from './nav.js';
import { userOp, diveInto } from './ops.js';
import { pullThread, send } from './ask.js';
import { menu, peek, hidePeek } from './tools.js';

export function applyView() {
  world.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.k})`;
  $('#z-reset').textContent = Math.round(state.view.k * 100) + '%';
  renderMini();
  if (state.cur) store.set('view:' + state.cur, state.view);
}

// cc's pictures live in sandboxed iframes that report their height back.
const FRAME_CSS = `:root{color-scheme:dark}html,body{margin:0;background:transparent}body{font:12px/1.4 "IBM Plex Sans",-apple-system,"Segoe UI",sans-serif;color:#ece7df;padding:2px}svg{width:100%;height:auto;display:block;font-family:inherit}svg text{font-family:inherit}`;
function frame(n) {
  const f = h('iframe', { sandbox: 'allow-scripts', title: n.id, scrolling: 'no' });
  f.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet"><style>${FRAME_CSS}</style></head><body>${n.art || ''}<script>(function(){var s=function(){parent.postMessage({lemuxH:document.documentElement.scrollHeight,k:${JSON.stringify(n.id)}},'*')};new ResizeObserver(s).observe(document.body);window.addEventListener('load',s);setTimeout(s,50);setTimeout(s,600);})()</script></body></html>`;
  return f;
}
window.addEventListener('message', (e) => {
  const m = e.data || {};
  if (typeof m.lemuxH !== 'number') return;
  const f = $$('.node iframe').find((x) => x.contentWindow === e.source);
  if (f) {
    f.style.height = Math.min(700, Math.max(60, m.lemuxH + 4)) + 'px';
    drawEdges();
  }
});

export function doorsFor(id) {
  return (state.cv.doors || []).filter((d) => d.node === id);
}

// nodes seen on this canvas already, so only new ones get the landing animation
const seen = new Set();
const KIND_LABEL = { text: 'words', pic: 'picture', note: 'your note', img: 'image', file: 'file' };

function nodeEl(n) {
  const cv = state.cv;
  const p = cv.pos[n.id] || { x: 60, y: 60 };
  const d = h('div', {
    class: `node ${n.kind}${state.sel.has(n.id) ? ' sel' : ''}${doorsFor(n.id).length ? ' has-portal' : ''}`,
    'data-id': n.id,
    style: `left:${p.x}px;top:${p.y}px`,
  });
  if (!seen.has(state.cur + ':' + n.id)) {
    d.classList.add('land');
    seen.add(state.cur + ':' + n.id);
  }
  const q = h(
    'q',
    n.kind === 'note'
      ? { contenteditable: 'true', spellcheck: 'false', title: 'click to rename', text: n.q }
      : { text: n.q }
  );
  d.append(
    h('div', { class: 'grip' }),
    h(
      'span',
      {
        class: 'thread',
        title: 'Drag out to ask from here, or onto another node to pick it too. Double-click to dive in.',
        onmousedown: (e) => {
          e.stopPropagation();
          pullThread(n);
        },
      },
      '●'
    ),
    h(
      'div',
      { class: 'eye' },
      h('span', { class: 'n' }, KIND_LABEL[n.kind] || n.kind),
      q,
      n.origin ? h('span', {}, `· from ${node(state.cur)?.origin?.parentName || 'above'}`) : null,
      n.redrawn && n.redrawn.length
        ? h('span', { style: 'color:var(--lamp)', title: n.redrawn.join('\n') }, '· changed')
        : null
    )
  );
  // every picture has two sides: the picture, and the same idea in words
  if (n.kind === 'pic' && n.art) {
    d.append(
      h('div', { class: 'face front' }, frame(n), h('p', { class: 'cap', text: n.cap || '' })),
      h('div', { class: 'face back hidden' }, backOf(n)),
      h(
        'button',
        {
          class: 'flip',
          title: 'turn the card over',
          onmousedown: (e) => e.stopPropagation(),
          onclick: (e) => {
            e.stopPropagation();
            flipCard(d);
          },
        },
        '↻ words'
      )
    );
  }
  if (n.kind === 'text')
    d.append(h('div', { class: 'words', html: esc(n.text || '').replace(/\n+/g, '<br>') }));
  if (n.kind === 'img')
    d.append(h('img', { src: `/api/file?sid=${state.cur}&path=${encodeURIComponent(n.path)}`, alt: n.q }));
  if (n.kind === 'file')
    d.append(
      h(
        'p',
        { class: 'cap' },
        h(
          'a',
          { href: `/api/file?sid=${state.cur}&path=${encodeURIComponent(n.path)}`, target: '_blank' },
          n.q
        ),
        ' · cc reads it when asked'
      )
    );
  if (n.kind === 'note') {
    const cap = h('div', { class: 'cap', contenteditable: 'true', spellcheck: 'false', html: n.text || '' });
    cap.onmousedown = (e) => e.stopPropagation();
    cap.onblur = () => {
      if (cap.innerHTML !== (n.text || '')) {
        n.text = cap.innerHTML;
        userOp({ op: 'note', note: { ...n, text: n.text } }, true);
      }
    };
    d.append(cap);
    q.onmousedown = (e) => e.stopPropagation();
    q.ondblclick = (e) => e.stopPropagation();
    q.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        q.blur();
      }
      if (e.key === 'Escape') {
        q.textContent = n.q;
        q.blur();
      }
    };
    q.onblur = () => {
      const v = q.textContent.trim() || 'Untitled note';
      if (v !== n.q) {
        n.q = v;
        userOp({ op: 'note', note: { ...n, q: v } }, true);
      }
      q.textContent = n.q;
    };
  } else if (n.kind === 'text' && n.cap) d.append(h('p', { class: 'cap', text: n.cap }));
  // the first dive from this node is its portal
  const dr = doorsFor(n.id)[0];
  if (dr) {
    const k = node(dr.sid);
    const el = h(
      'span',
      {
        class: 'portal',
        onclick: (e) => {
          e.stopPropagation();
          go(dr.sid);
        },
      },
      h('i', { class: dr.state }),
      `${dr.name} · dive ⤵`
    );
    el.addEventListener('mouseenter', (e) => peek(k, e));
    el.addEventListener('mouseleave', hidePeek);
    d.append(el);
  }
  d.addEventListener('dblclick', (e) => {
    if (e.target.closest('[contenteditable], .portal')) return;
    diveInto(n);
  });
  d.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!state.sel.has(n.id)) {
      state.sel = new Set([n.id]);
      renderSel();
    }
    menu(e.clientX, e.clientY, 'node');
  });
  d.addEventListener('mousedown', (e) => {
    if (e.target.closest('.portal, [contenteditable]')) return;
    e.stopPropagation();
    if (!e.shiftKey && !state.sel.has(n.id)) state.sel = new Set([n.id]);
    else if (e.shiftKey) state.sel.has(n.id) ? state.sel.delete(n.id) : state.sel.add(n.id);
    state.selLink = null;
    renderSel();
    dragNodes(d, cv, e);
  });
  return d;
}

// Drag the selection; positions are saved once on release.
function dragNodes(d, cv, e) {
  const sx = e.clientX;
  const sy = e.clientY;
  const start = [...state.sel].map((id) => {
    const pp = cv.pos[id] || { x: 0, y: 0 };
    return [id, pp.x, pp.y, N.querySelector(`[data-id="${id}"]`)];
  });
  let moved = false;
  const mv = (ev) => {
    const dx = (ev.clientX - sx) / state.view.k;
    const dy = (ev.clientY - sy) / state.view.k;
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      moved = true;
      d.classList.add('dragging');
    }
    for (const [id, x0, y0, el] of start) {
      cv.pos[id] = { x: Math.round(x0 + dx), y: Math.round(y0 + dy) };
      if (el) {
        el.style.left = cv.pos[id].x + 'px';
        el.style.top = cv.pos[id].y + 'px';
      }
    }
    drawEdges();
  };
  const up = () => {
    window.removeEventListener('mousemove', mv);
    window.removeEventListener('mouseup', up);
    d.classList.remove('dragging');
    if (moved) {
      const pos = {};
      for (const [id] of start) pos[id] = cv.pos[id];
      userOp({ op: 'move', pos }, true);
      renderMini();
    }
  };
  window.addEventListener('mousemove', mv);
  window.addEventListener('mouseup', up);
}

// the back of a picture: its words, or, for a picture drawn before words were
// required, a way to ask cc for them
function backOf(n) {
  if (n.text) return h('div', { class: 'words', html: esc(n.text).replace(/\n+/g, '<br>') });
  return h(
    'div',
    { class: 'words nowords' },
    h('p', {}, 'No words for this picture yet.'),
    h(
      'button',
      {
        onmousedown: (e) => e.stopPropagation(),
        onclick: (e) => {
          e.stopPropagation();
          state.sel = new Set([n.id]);
          send({
            text: `Write the words for "${n.q}": fill the back of that picture (text, 30 to 80 words).`,
            from: n.id,
          });
        },
      },
      'Write them'
    )
  );
}

// the card turns over: picture on the front, words on the back
function flipCard(d) {
  if (d.classList.contains('flipping')) return;
  d.classList.add('flipping');
  setTimeout(() => {
    const toBack = !d.querySelector('.face.front').classList.contains('hidden');
    d.querySelector('.face.front').classList.toggle('hidden', toBack);
    d.querySelector('.face.back').classList.toggle('hidden', !toBack);
    d.querySelector('.flip').textContent = toBack ? '↻ picture' : '↻ words';
    d.classList.add('flipped');
    setTimeout(() => {
      d.classList.remove('flipping', 'flipped');
      drawEdges();
    }, 160);
  }, 160);
}

function frameEl(f, cv) {
  const el = h(
    'div',
    {
      class: 'frame',
      'data-id': f.id,
      style: `left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px`,
    },
    h(
      'span',
      { class: 'lbl' },
      h('span', { class: 'name', contenteditable: 'true', spellcheck: 'false', text: f.lbl })
    ),
    h('span', { class: 'grip', title: 'resize' }),
    h('span', { class: 'del', title: 'delete frame' }, '✕')
  );
  const name = $('.name', el);
  name.onmousedown = (e) => e.stopPropagation();
  name.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      name.blur();
    }
    if (e.key === 'Escape') {
      name.textContent = f.lbl;
      name.blur();
    }
  };
  name.onblur = () => {
    const v = name.textContent.trim();
    if (v && v !== f.lbl) {
      f.lbl = v;
      userOp({ op: 'frame', frame: f });
    } else name.textContent = f.lbl;
  };
  $('.del', el).onmousedown = (e) => {
    e.stopPropagation();
    userOp({ op: 'unframe', id: f.id });
    toast('Frame deleted · Undo brings it back');
  };
  // drag by the edge: the frame and everything inside move together, no rebuild
  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('.name, .del, .grip')) return;
    const r = el.getBoundingClientRect();
    const edge = 14 * state.view.k;
    const onEdge =
      e.clientX - r.left < edge ||
      r.right - e.clientX < edge ||
      e.clientY - r.top < edge ||
      r.bottom - e.clientY < edge;
    if (!onEdge) return;
    e.stopPropagation();
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const fx = f.x;
    const fy = f.y;
    const inside = allNodes()
      .filter((n) => {
        const p = cv.pos[n.id];
        return p && p.x > f.x && p.y > f.y && p.x < f.x + f.w && p.y < f.y + f.h;
      })
      .map((n) => [n.id, cv.pos[n.id].x, cv.pos[n.id].y, N.querySelector(`[data-id="${n.id}"]`)]);
    el.classList.add('moving');
    const mv = (ev) => {
      const dx = (ev.clientX - sx) / state.view.k;
      const dy = (ev.clientY - sy) / state.view.k;
      f.x = Math.round(fx + dx);
      f.y = Math.round(fy + dy);
      el.style.left = f.x + 'px';
      el.style.top = f.y + 'px';
      for (const [id, x0, y0, ne] of inside) {
        cv.pos[id] = { x: Math.round(x0 + dx), y: Math.round(y0 + dy) };
        if (ne) {
          ne.style.left = cv.pos[id].x + 'px';
          ne.style.top = cv.pos[id].y + 'px';
        }
      }
      drawEdges();
    };
    const up = () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
      el.classList.remove('moving');
      const pos = {};
      for (const [id] of inside) pos[id] = cv.pos[id];
      userOp(
        {
          ops: [
            { op: 'frame', frame: f },
            { op: 'move', pos },
          ],
        },
        true
      );
      renderMini();
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });
  $('.grip', el).addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const w0 = f.w;
    const h0 = f.h;
    const mv = (ev) => {
      f.w = Math.max(160, Math.round(w0 + (ev.clientX - sx) / state.view.k));
      f.h = Math.max(100, Math.round(h0 + (ev.clientY - sy) / state.view.k));
      el.style.width = f.w + 'px';
      el.style.height = f.h + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
      userOp({ op: 'frame', frame: f }, true);
      renderMini();
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });
  return el;
}

// the placeholder for an answer being drawn; it can be dragged to where the answer should land
function drawingEl(cv) {
  const p =
    state.live.at ||
    (state.live.from && cv.pos[state.live.from]
      ? {
          x: cv.pos[state.live.from].x + widthOf(cnode(state.live.from) || {}) + 60,
          y: cv.pos[state.live.from].y,
        }
      : { x: 60, y: 60 + allNodes().length * 40 });
  state.live.at = p;
  const ph = h(
    'div',
    { class: 'node text drawing', style: `left:${p.x}px;top:${p.y}px` },
    h('div', { class: 'grip' }),
    h('div', { class: 'eye' }, h('span', { class: 'n' }, 'cc'), h('q', { text: state.live.q })),
    h('p', { class: 'cap drawing' }, 'drawing')
  );
  ph.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const x0 = p.x;
    const y0 = p.y;
    const mv = (ev) => {
      state.live.at = {
        x: Math.round(x0 + (ev.clientX - sx) / state.view.k),
        y: Math.round(y0 + (ev.clientY - sy) / state.view.k),
      };
      ph.style.left = state.live.at.x + 'px';
      ph.style.top = state.live.at.y + 'px';
      state.live.moved = true;
    };
    const up = () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });
  return ph;
}

export function renderNodes() {
  N.replaceChildren();
  F.replaceChildren();
  E.innerHTML = '';
  $('.empty')?.remove();
  const cv = state.cv;
  if (!state.cur || !cv) {
    vp.append(
      h(
        'div',
        { class: 'empty' },
        h(
          'span',
          {},
          state.fresh
            ? 'An empty canvas. Ask something below and the first node is drawn.'
            : state.project
              ? h('span', {}, 'Pick a canvas on the left, or ', h('b', {}, '+ new'), '.')
              : 'Open a folder to begin.'
        )
      )
    );
    applyView();
    return;
  }
  for (const f of cv.frames) F.append(frameEl(f, cv));
  for (const n of allNodes()) N.append(nodeEl(n));
  if (state.live) N.append(drawingEl(cv));
  requestAnimationFrame(drawEdges);
  renderSel();
  applyView();
  const dr = $('#drawer');
  dr.replaceChildren(
    ...((cv.said || []).length
      ? cv.said.map((s) => h('p', {}, h('b', {}, s.who === 'you' ? 'You' : 'cc'), ' · ', s.text))
      : [h('p', {}, 'nothing said yet')])
  );
  if (state.live)
    dr.append(
      h('p', {}, h('b', {}, 'You'), ' · ', state.live.q),
      h('p', {}, h('b', {}, 'cc'), ' · drawing…')
    );
  dr.scrollTop = dr.scrollHeight;
}

export function drawEdges() {
  const cv = state.cv;
  if (!cv) return;
  let d = '';
  const box = (id) => {
    const el = N.querySelector(`[data-id="${id}"]`);
    const p = cv.pos[id];
    return el && p ? { x: p.x, y: p.y, w: el.offsetWidth, h: el.offsetHeight } : null;
  };
  for (const n of cv.nodes) {
    if (!n.from) continue;
    const a = box(n.from);
    const b = box(n.id);
    if (!a || !b) continue;
    const ax = a.x + a.w;
    const ay = a.y + 40;
    const bx = b.x;
    const by = b.y + 40;
    const right = bx >= ax - 40;
    d += `<path d="M${right ? ax : a.x},${ay} C${right ? ax + 60 : a.x - 60},${ay} ${right ? bx - 60 : bx + 60 + b.w},${by} ${right ? bx : bx + b.w},${by}"/>`;
  }
  (cv.links || []).forEach((l, i) => {
    const a = box(l.a);
    const b = box(l.b);
    if (!a || !b) return;
    const ma = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const mb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    d += `<path class="link${state.selLink === i ? ' on' : ''}" data-i="${i}" d="M${ma.x},${ma.y} L${mb.x},${mb.y}"/>`;
    if (l.lbl)
      d += `<text class="linklbl" x="${(ma.x + mb.x) / 2}" y="${(ma.y + mb.y) / 2 - 6}" text-anchor="middle">${esc(l.lbl)}</text>`;
  });
  E.innerHTML = d;
  E.setAttribute('width', 6000);
  E.setAttribute('height', 4000);
  for (const pth of E.querySelectorAll('path.link'))
    pth.onmousedown = (e) => {
      e.stopPropagation();
      state.selLink = state.selLink === +pth.dataset.i ? null : +pth.dataset.i;
      state.sel.clear();
      renderSel();
      drawEdges();
    };
}

export function renderSel() {
  $$('.node').forEach((el) => el.classList.toggle('sel', state.sel.has(el.dataset.id)));
  const names = [...state.sel].map(cnode).filter(Boolean);
  const sc = $('#scope');
  sc.className = 'scope' + (names.length ? ' on' : '');
  sc.replaceChildren(
    ...(names.length
      ? [
          names.length === 1
            ? names[0].q.slice(0, 30) + (names[0].q.length > 30 ? '…' : '')
            : `${names.length} picked`,
          h(
            'button',
            {
              title: 'clear',
              onclick: () => {
                state.sel.clear();
                renderSel();
              },
            },
            '✕'
          ),
        ]
      : [])
  );
  renderMini();
}

// the minimap fits every node and the current view into its box, then clips
let miniMap = { s: 0.06, ox: 0, oy: 0 };
export function renderMini() {
  const m = $('#mini');
  if (!state.cv) {
    m.replaceChildren();
    return;
  }
  const W = m.clientWidth || 150;
  const H = m.clientHeight || 96;
  const pad = 8;
  const vw = {
    x: -state.view.x / state.view.k,
    y: -state.view.y / state.view.k,
    w: vp.clientWidth / state.view.k,
    h: vp.clientHeight / state.view.k,
  };
  const rects = allNodes().map((n) => {
    const p = state.cv.pos[n.id] || { x: 0, y: 0 };
    return { x: p.x, y: p.y, w: widthOf(n), h: 110, sel: state.sel.has(n.id) };
  });
  const all = [...rects, vw];
  const x0 = Math.min(...all.map((r) => r.x));
  const y0 = Math.min(...all.map((r) => r.y));
  const x1 = Math.max(...all.map((r) => r.x + r.w));
  const y1 = Math.max(...all.map((r) => r.y + r.h));
  const sc = Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0));
  miniMap = {
    s: sc,
    ox: pad - x0 * sc + (W - pad * 2 - (x1 - x0) * sc) / 2,
    oy: pad - y0 * sc + (H - pad * 2 - (y1 - y0) * sc) / 2,
  };
  const at = (r) =>
    `left:${miniMap.ox + r.x * sc}px;top:${miniMap.oy + r.y * sc}px;width:${Math.max(2, r.w * sc)}px;height:${Math.max(2, r.h * sc)}px`;
  m.replaceChildren(
    ...rects.map((r) => h('i', { class: r.sel ? 'sel' : '', style: at(r) })),
    h('div', { class: 'view', style: at(vw) })
  );
}
$('#mini').addEventListener('mousedown', (e) => {
  const r = $('#mini').getBoundingClientRect();
  const wx = (e.clientX - r.left - miniMap.ox) / miniMap.s;
  const wy = (e.clientY - r.top - miniMap.oy) / miniMap.s;
  state.view.x = vp.clientWidth / 2 - wx * state.view.k;
  state.view.y = vp.clientHeight / 2 - wy * state.view.k;
  applyView();
});
