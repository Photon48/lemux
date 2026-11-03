/* lemux workstation — one canvas per session; nodes are answers; dive into a node and you are in its side quest. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s),
    $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const k of kids.flat())
      if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  };
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const api = async (path, body) => {
    const r = await fetch(
      path,
      body
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : undefined
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };
  const store = {
    get: (k, d) => {
      try {
        const v = localStorage.getItem('lemux.' + k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem('lemux.' + k, JSON.stringify(v));
      } catch {
        /* full */
      }
    },
  };
  const toast = (m) => {
    const t = $('#toast');
    t.textContent = m;
    t.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('on'), 2200);
  };
  const short = (p) => (state.home && p.startsWith(state.home) ? '~' + p.slice(state.home.length) : p);

  // ---------- state ----------
  const state = {
    projects: [],
    project: store.get('project', ''),
    home: '',
    names: [],
    byId: new Map(),
    topics: [],
    taste: null,
    cur: null,
    fresh: null,
    cv: null,
    sel: new Set(),
    selLink: null,
    view: { x: 0, y: 0, k: 1 },
    mode: null,
    hist: [],
    hpos: -1,
    mscope: 'last',
    live: null,
  };
  const node = (id) => state.byId.get(id);
  const crumbs = (id) => {
    const c = [];
    for (let n = node(id); n; n = n.parent ? node(n.parent) : null) c.unshift(n);
    return c;
  };
  const cnode = (id) =>
    state.cv && (state.cv.nodes.find((n) => n.id === id) || state.cv.notes.find((n) => n.id === id));
  const isUser = (id) => !!(state.cv && state.cv.notes.some((n) => n.id === id));
  const allNodes = () => (state.cv ? [...state.cv.nodes, ...state.cv.notes] : []);
  const widthOf = (n) => (n.kind === 'text' ? 300 : n.kind === 'note' ? 260 : 360);
  const vp = $('#vp'),
    world = $('#world'),
    N = $('#nodes'),
    F = $('#frames'),
    E = $('#edges');
  const seen = new Set();

  // ---------- projects & layers ----------
  async function loadProjects() {
    const { projects, home } = await api('/api/projects');
    state.projects = projects;
    state.home = home;
    if (!projects.some((p) => p.dir === state.project)) state.project = projects[0]?.dir || '';
    const sel = $('#project');
    sel.replaceChildren(
      ...projects.map((p) => h('option', { value: p.dir, title: short(p.dir) }, p.name)),
      h('option', { value: '__open__' }, 'open a folder…')
    );
    sel.value = state.project || '__open__';
  }
  $('#project').onchange = async (e) => {
    const v = e.target.value;
    if (v === '__open__') {
      const dir = window.prompt
        ? prompt('Folder to open as a project (absolute path or ~/…):', state.home + '/')
        : null;
      e.target.value = state.project || '__open__';
      if (!dir) return;
      try {
        const r = await api('/api/projects', { dir });
        await loadProjects();
        await switchProject(r.dir);
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    await switchProject(v);
  };
  async function switchProject(dir) {
    state.project = dir;
    store.set('project', dir);
    $('#project').value = dir;
    await loadTree();
    const last = store.get('cur:' + dir, null);
    if (last && node(last)) go(last);
    else showEmpty();
  }
  async function loadTree() {
    const [{ topics, home, taste }, { names }] = await Promise.all([
      api(`/api/tree?dir=${encodeURIComponent(state.project)}`),
      api('/api/names'),
    ]);
    state.home = home;
    state.names = names;
    state.taste = taste;
    state.topics = topics;
    state.byId = new Map();
    for (const t of topics) for (const n of t.nodes) state.byId.set(n.id, n);
    renderLayers();
    if (state.cur && !node(state.cur)) showEmpty();
    else if (state.cur) {
      renderSpine();
      if (state.cv) {
        renderNodes();
      }
    }
  }
  function renderLayers() {
    const el = $('#layers');
    el.replaceChildren();
    if (!state.project) el.append(h('div', { class: 'older' }, 'Open a folder to begin.'));
    else if (!state.topics.length)
      el.append(h('div', { class: 'older' }, 'No canvases yet. Press “+ new” and ask.'));
    const all = [...state.byId.values()];
    const walk = (n, d) => {
      const kids = all.filter((x) => x.parent === n.id).sort((a, b) => a.created - b.created);
      const row = h(
        'div',
        {
          class: `layer d${Math.min(d, 3)}${state.cur === n.id ? ' open' : ''}`,
          title: n.diverge || '',
          onclick: () => go(n.id),
        },
        h(
          'div',
          { class: 'sq' },
          [0, 1, 2, 3].map((i) =>
            h('i', { style: `left:${4 + (i % 2) * 9}px;top:${3 + Math.floor(i / 2) * 7}px` })
          )
        ),
        h(
          'div',
          {},
          h('div', { class: 't' }, n.name || '(unnamed)'),
          h(
            'div',
            { class: 'm' },
            n.state === 'busy'
              ? h('b', {}, 'drawing')
              : n.state === 'waiting'
                ? h('b', {}, 'needs you')
                : n.state === 'done'
                  ? h('b', { class: 'done' }, 'finished while you were away')
                  : n.state === 'error'
                    ? h('b', { class: 'error' }, 'error')
                    : d
                      ? `inside ${node(n.parent)?.name || ''}`
                      : kids.length
                        ? `${kids.length} dive${kids.length > 1 ? 's' : ''}`
                        : ''
          )
        ),
        h(
          'div',
          { class: 'acts' },
          h(
            'button',
            {
              title: 'rename',
              onclick: (e) => {
                e.stopPropagation();
                renameInline(row, n);
              },
            },
            '✎'
          ),
          h(
            'button',
            {
              title: d
                ? 'delete this dive and everything under it'
                : 'take this canvas off the shelf (its transcript stays)',
              onclick: (e) => {
                e.stopPropagation();
                del(n, !d);
              },
            },
            '✕'
          )
        )
      );
      el.append(row);
      kids.forEach((k) => walk(k, d + 1));
    };
    for (const t of state.topics) walk(t.root, 0);
    if (state.fresh)
      el.append(
        h(
          'div',
          { class: 'layer open' },
          h('div', { class: 'sq' }),
          h('div', {}, h('div', { class: 't' }, state.fresh.name), h('div', { class: 'm' }, 'ask to open it'))
        )
      );
    renderOlder();
  }
  let olderOpen = false,
    olderList = [];
  async function renderOlder() {
    const el = $('#older');
    el.replaceChildren();
    if (!state.project) return;
    el.append(
      h(
        'button',
        {
          onclick: async () => {
            olderOpen = !olderOpen;
            if (olderOpen) {
              try {
                olderList = (await api(`/api/unlisted?dir=${encodeURIComponent(state.project)}`)).sessions;
              } catch {
                olderList = [];
              }
            }
            renderOlder();
          },
        },
        olderOpen ? 'older sessions ▾' : 'older sessions ▸'
      )
    );
    if (!olderOpen) return;
    el.append(
      h(
        'div',
        { class: 'pick' },
        ...(olderList.length
          ? olderList.map((x) =>
              h(
                'div',
                {
                  title: x.firstPrompt,
                  onclick: async () => {
                    try {
                      const r = await api('/api/adopt', { id: x.id, dir: state.project });
                      olderOpen = false;
                      await loadTree();
                      go(r.id);
                    } catch (e) {
                      toast(e.message);
                    }
                  },
                },
                x.firstPrompt
              )
            )
          : [h('div', {}, 'none in this folder')])
      )
    );
  }
  function renameInline(row, n) {
    const t = $('.t', row);
    const input = h('input', { class: 'rename-input', value: n.name });
    t.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== n.name) {
        try {
          await api('/api/rename', { id: n.id, name: v });
        } catch (e) {
          toast(e.message);
        }
      }
      loadTree();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }
  async function del(n, isRoot) {
    if (
      !confirm(
        isRoot
          ? `Take “${n.name}” off the shelf? Its dives are deleted; its own transcript stays on disk.`
          : `Delete “${n.name}” and every dive under it?`
      )
    )
      return;
    try {
      await api('/api/delete', { id: n.id });
    } catch (e) {
      toast(e.message);
    }
    if (state.cur && (state.cur === n.id || crumbs(state.cur).some((c) => c.id === n.id))) showEmpty();
    loadTree();
  }
  $('#newc').onclick = () => {
    if (!state.project) {
      $('#project').focus();
      return;
    }
    state.cur = null;
    state.cv = null;
    state.fresh = { name: 'New canvas' };
    state.sel.clear();
    renderSpine();
    renderNodes();
    renderLayers();
    const here = $('#crumbs .here');
    if (here) {
      here.focus();
      document.getSelection().selectAllChildren(here);
    }
    toast('Name it, then ask');
  };

  // ---------- navigation ----------
  function showEmpty() {
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
  async function go(sid, { push = true, focus = null } = {}) {
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
    zoomTarget = state.view.k;
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
  async function loadCanvas() {
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
  function renderSpine() {
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
      $('#pill-text').textContent =
        {
          busy: 'drawing',
          waiting: 'needs you',
          done: 'finished while you were away',
          error: 'ended with an error',
        }[n.state] || n.state;
    } else pill.classList.add('hidden');
    $('#stop').classList.toggle('hidden', !(n && (n.state === 'busy' || n.state === 'waiting')));
  }
  $('#stop').onclick = () => api('/api/interrupt', { sid: state.cur }).catch(() => {});
  window.addEventListener('hashchange', () => {
    const sid = location.hash.slice(1);
    if (sid && node(sid) && sid !== state.cur) go(sid);
  });

  // ---------- the canvas ----------
  function applyView() {
    world.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.k})`;
    $('#z-reset').textContent = Math.round(state.view.k * 100) + '%';
    renderMini();
    if (state.cur) store.set('view:' + state.cur, state.view);
  }
  const FRAME_CSS = `:root{color-scheme:dark}html,body{margin:0;background:transparent}body{font:12px/1.4 "IBM Plex Sans",-apple-system,"Segoe UI",sans-serif;color:#ece7df;padding:2px}svg{width:100%;height:auto;display:block;font-family:inherit}svg text{font-family:inherit}`;
  function frame(n) {
    const f = h('iframe', { sandbox: 'allow-scripts', title: n.id, scrolling: 'no' });
    f.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet"><style>${FRAME_CSS}</style></head><body>${n.art || ''}<script>(function(){var s=function(){parent.postMessage({lemuxH:document.documentElement.scrollHeight,k:${JSON.stringify(n.id)}},'*')};new ResizeObserver(s).observe(document.body);window.addEventListener('load',s);setTimeout(s,50);setTimeout(s,600);})()<\/script></body></html>`;
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
  function doorsFor(id) {
    return (state.cv.doors || []).filter((d) => d.node === id);
  }
  function nodeEl(n) {
    const cv = state.cv;
    const p = cv.pos[n.id] || { x: 60, y: 60 };
    const user = isUser(n.id);
    const d = h('div', {
      class: `node ${n.kind}${state.sel.has(n.id) ? ' sel' : ''}${cv.folded.includes(n.id) ? ' folded' : ''}${cv.aside.includes(n.id) ? ' aside' : ''}${doorsFor(n.id).length ? ' has-portal' : ''}`,
      'data-id': n.id,
      style: `left:${p.x}px;top:${p.y}px`,
    });
    if (!seen.has(state.cur + ':' + n.id)) {
      d.classList.add('land');
      seen.add(state.cur + ':' + n.id);
    }
    const kindLbl =
      { text: 'words', pic: 'picture', note: 'your note', img: 'image', file: 'file' }[n.kind] || n.kind;
    const q = h(
      'q',
      n.kind === 'note'
        ? { contenteditable: 'true', spellcheck: 'false', title: 'click to rename', text: n.q }
        : { text: n.q }
    );
    d.append(
      h('div', { class: 'grip' }),
      h('span', {
        class: 'fold',
        title: 'fold',
        text: cv.folded.includes(n.id) ? '▸' : '▾',
        onmousedown: (e) => {
          e.stopPropagation();
          userOp({ op: 'fold', id: n.id, on: !cv.folded.includes(n.id) });
        },
      }),
      h(
        'span',
        {
          class: 'thread',
          title: 'Drag out to ask from here, or onto another node to pick it too. Double-click to dive in.',
          onmousedown: (e) => {
            e.stopPropagation();
            pullThread(n, e);
          },
        },
        '●'
      ),
      h(
        'div',
        { class: 'eye' },
        h('span', { class: 'n' }, kindLbl),
        q,
        n.origin ? h('span', {}, `· from ${node(state.cur)?.origin?.parentName || 'above'}`) : null,
        n.redrawn && n.redrawn.length
          ? h('span', { style: 'color:var(--lamp)', title: n.redrawn.join('\n') }, '· changed')
          : null
      )
    );
    const twoSided = n.kind === 'pic' && n.art && n.text;
    if (n.kind === 'pic' && n.art) {
      const front = h('div', { class: 'face front' }, frame(n), h('p', { class: 'cap', text: n.cap || '' }));
      d.append(front);
      if (twoSided) {
        d.append(
          h(
            'div',
            { class: 'face back hidden' },
            h('div', { class: 'words', html: esc(n.text).replace(/\n+/g, '<br>') })
          ),
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
      const cap = h('div', {
        class: 'cap',
        contenteditable: 'true',
        spellcheck: 'false',
        html: n.text || '',
      });
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
    for (const dr of doorsFor(n.id)) {
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
      break;
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
      const sx = e.clientX,
        sy = e.clientY;
      const start = [...state.sel].map((id) => {
        const pp = cv.pos[id] || { x: 0, y: 0 };
        return [id, pp.x, pp.y, N.querySelector(`[data-id="${id}"]`)];
      });
      let moved = false;
      const mv = (ev) => {
        const dx = (ev.clientX - sx) / state.view.k,
          dy = (ev.clientY - sy) / state.view.k;
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
          dropIntoZones();
          renderMini();
        }
      };
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    });
    return d;
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
  function renderNodes() {
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
    const role = (f) => (/later|parked|someday/i.test(f.lbl) ? 'later' : '');
    for (const f of cv.frames) {
      const el = h(
        'div',
        {
          class: `frame${role(f) ? ' zone-' + role(f) : ''}`,
          'data-id': f.id,
          style: `left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px`,
        },
        h(
          'span',
          { class: 'lbl' },
          h('span', { class: 'name', contenteditable: 'true', spellcheck: 'false', text: f.lbl }),
          role(f) === 'later' ? h('span', { class: 'role' }, '· sets aside') : null
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
      el.addEventListener('mousedown', (e) => {
        if (e.target.closest('.name, .del, .grip')) return;
        const r = el.getBoundingClientRect();
        const edge = 14 * state.view.k;
        if (!(
          e.clientX - r.left < edge ||
          r.right - e.clientX < edge ||
          e.clientY - r.top < edge ||
          r.bottom - e.clientY < edge
        ))
          return;
        e.stopPropagation();
        e.preventDefault();
        const sx = e.clientX,
          sy = e.clientY,
          fx = f.x,
          fy = f.y;
        const inside = allNodes()
          .filter((n) => {
            const p = cv.pos[n.id];
            return p && p.x > f.x && p.y > f.y && p.x < f.x + f.w && p.y < f.y + f.h;
          })
          .map((n) => [n.id, cv.pos[n.id].x, cv.pos[n.id].y, N.querySelector(`[data-id="${n.id}"]`)]);
        el.classList.add('moving');
        const mv = (ev) => {
          const dx = (ev.clientX - sx) / state.view.k,
            dy = (ev.clientY - sy) / state.view.k;
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
        const sx = e.clientX,
          sy = e.clientY,
          w0 = f.w,
          h0 = f.h;
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
      F.append(el);
    }
    for (const n of allNodes()) N.append(nodeEl(n));
    if (state.live) {
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
        const sx = e.clientX,
          sy = e.clientY,
          x0 = p.x,
          y0 = p.y;
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
      N.append(ph);
    }
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
  function drawEdges() {
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
      const a = box(n.from),
        b = box(n.id);
      if (!a || !b) continue;
      const ax = a.x + a.w,
        ay = a.y + 40,
        bx = b.x,
        by = b.y + 40;
      const right = bx >= ax - 40;
      d += `<path d="M${right ? ax : a.x},${ay} C${right ? ax + 60 : a.x - 60},${ay} ${right ? bx - 60 : bx + 60 + b.w},${by} ${right ? bx : bx + b.w},${by}"/>`;
    }
    (cv.links || []).forEach((l, i) => {
      const a = box(l.a),
        b = box(l.b);
      if (!a || !b) return;
      const ma = { x: a.x + a.w / 2, y: a.y + a.h / 2 },
        mb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
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
  function renderSel() {
    $$('.node').forEach((el) => el.classList.toggle('sel', state.sel.has(el.dataset.id)));
    const names = [...state.sel].map(cnode).filter(Boolean);
    const bar = $('#acts');
    bar.classList.toggle('hid', !names.length);
    $('#act-t').textContent = names.length > 1 ? `${names.length} picked` : names[0] ? names[0].q : '';
    $('#a-frame').style.display = names.length > 1 ? '' : 'none';
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
  function renderMini() {
    const m = $('#mini');
    if (!state.cv) {
      m.replaceChildren();
      return;
    }
    const W = m.clientWidth || 150,
      H = m.clientHeight || 96,
      pad = 8;
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
    const x0 = Math.min(...all.map((r) => r.x)),
      y0 = Math.min(...all.map((r) => r.y)),
      x1 = Math.max(...all.map((r) => r.x + r.w)),
      y1 = Math.max(...all.map((r) => r.y + r.h));
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
    const wx = (e.clientX - r.left - miniMap.ox) / miniMap.s,
      wy = (e.clientY - r.top - miniMap.oy) / miniMap.s;
    state.view.x = vp.clientWidth / 2 - wx * state.view.k;
    state.view.y = vp.clientHeight / 2 - wy * state.view.k;
    applyView();
  });

  // ---------- the person's changes ----------
  let moveTimer = null,
    moveBatch = {};
  async function userOp(op, quiet = false) {
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
  function dropIntoZones() {
    const cv = state.cv;
    for (const id of state.sel) {
      const p = cv.pos[id];
      if (!p) continue;
      for (const f of cv.frames)
        if (
          /later|parked|someday/i.test(f.lbl) &&
          p.x > f.x &&
          p.y > f.y &&
          p.x < f.x + f.w &&
          p.y < f.y + f.h &&
          !cv.aside.includes(id)
        ) {
          userOp({ op: 'aside', id, on: true });
          toast('Set aside');
        }
    }
  }
  async function deleteSel() {
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
  $('#a-bin').onclick = deleteSel;
  $('#a-x').onclick = () => {
    state.sel.clear();
    renderSel();
  };
  $('#a-ask').onclick = () => $('#in').focus();
  $('#a-frame').onclick = () => {
    const ns = [...state.sel].map(cnode).filter(Boolean);
    if (!ns.length) return;
    const ps = ns.map((n) => state.cv.pos[n.id]);
    const x = Math.min(...ps.map((p) => p.x)) - 20,
      y = Math.min(...ps.map((p) => p.y)) - 24;
    const w = Math.max(...ns.map((n, i) => ps[i].x + widthOf(n))) - x + 20,
      hh = Math.max(...ps.map((p) => p.y + 170)) - y + 20;
    userOp({ op: 'frame', frame: { id: 'f-' + Date.now(), x, y, w, h: hh, lbl: 'section' } }).then(() => {
      const name = $$('.frame .name').pop();
      if (name) {
        name.focus();
        document.getSelection().selectAllChildren(name);
      }
    });
    state.sel.clear();
  };
  async function addNote(x, y) {
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
  async function diveInto(n) {
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

  // ---------- asking ----------
  const ta = $('#in'),
    ac = $('#ac');
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
  };
  async function send(opt = {}) {
    const text = (opt.text || ta.value).trim();
    if (!text) return;
    if (state.fresh) {
      ta.value = '';
      autosize();
      try {
        const r = await api('/api/new', {
          dir: state.project,
          text,
          name: state.fresh.name !== 'New canvas' ? state.fresh.name : '',
        });
        state.fresh = null;
        await loadTree();
        await go(r.id);
        state.live = { q: text };
        renderNodes();
      } catch (e) {
        ta.value = text;
        toast(e.message);
      }
      return;
    }
    if (!state.cur) {
      toast('Pick a canvas, or start a new one');
      return;
    }
    const n = node(state.cur);
    if (n && (n.state === 'busy' || n.state === 'waiting')) {
      toast('Still drawing · wait, or press stop');
      return;
    }
    const picked = [...state.sel].filter((id) => !isUser(id));
    const from = opt.from || picked[0] || null;
    ta.value = '';
    autosize();
    scopeVisible();
    try {
      await api('/api/send', { sid: state.cur, text, scope: state.mscope, picked, at: opt.at || null, from });
      state.sel.clear();
      renderSel();
    } catch (e) {
      ta.value = text;
      toast(e.message);
    }
  }
  $('#go').onclick = () => send();
  function askHere(x, y, from = null) {
    $$('.askhere').forEach((a) => a.remove());
    const box = h(
      'div',
      { class: 'askhere', style: `left:${x}px;top:${y}px`, onmousedown: (e) => e.stopPropagation() },
      h('span', { class: 'x', title: 'close' }, '✕'),
      h('input', { placeholder: from ? `Ask, from “${from.q.slice(0, 26)}…”` : 'Ask' }),
      h('div', { class: 'hint' }, 'The answer lands here · click away to close')
    );
    world.append(box);
    const inp = $('input', box);
    inp.focus();
    const close = () => {
      box.remove();
      document.removeEventListener('mousedown', away, true);
    };
    const away = (e) => {
      if (!box.contains(e.target)) close();
    };
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
    $('.x', box).onmousedown = (e) => {
      e.stopPropagation();
      close();
    };
    inp.onkeydown = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && inp.value.trim()) {
        const q = inp.value.trim();
        close();
        if (from) state.sel = new Set([from.id]);
        send({ text: q, at: { x, y }, from: from ? from.id : null });
      }
    };
  }
  function pullThread(n, e) {
    const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tmp.setAttribute('class', 'tmp');
    E.append(tmp);
    const r = vp.getBoundingClientRect();
    const toW = (ev) => ({
      x: (ev.clientX - r.left - state.view.x) / state.view.k,
      y: (ev.clientY - r.top - state.view.y) / state.view.k,
    });
    const el = N.querySelector(`[data-id="${n.id}"]`);
    const p = state.cv.pos[n.id];
    const ax = p.x + el.offsetWidth,
      ay = p.y + el.offsetHeight / 2;
    let over = null;
    const mv = (ev) => {
      const w = toW(ev);
      tmp.setAttribute('d', `M${ax},${ay} C${ax + 60},${ay} ${w.x - 60},${w.y} ${w.x},${w.y}`);
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
      over = hit && hit.dataset.id !== n.id ? hit.dataset.id : null;
      $$('.node').forEach((x) =>
        x.classList.toggle('sel', x.dataset.id === over || state.sel.has(x.dataset.id))
      );
    };
    const up = (ev) => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
      tmp.remove();
      if (over) {
        state.sel = new Set([n.id, over]);
        renderSel();
        $('#in').focus();
        return;
      }
      const w = toW(ev);
      if (Math.hypot(w.x - ax, w.y - ay) < 30) return;
      state.sel = new Set([n.id]);
      renderSel();
      askHere(w.x, w.y, n);
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  }
  // @mentions
  let acItems = [],
    acSel = 0,
    acStart = -1;
  const allNames = () => state.names.map((n) => ({ name: n.name, id: n.id, topic: n.project }));
  const closeAc = () => {
    ac.classList.add('hidden');
    acItems = [];
    acStart = -1;
  };
  const scopeVisible = () =>
    $('#mscope').classList.toggle(
      'hidden',
      !allNames().some((x) =>
        new RegExp('@' + x.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', 'i').test(
          ta.value
        )
      )
    );
  function updateAc() {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/(^|\s)@([^@\n]{0,40})$/);
    if (!m) return closeAc();
    acStart = upto.length - m[2].length - 1;
    const q = m[2].toLowerCase();
    acItems = allNames()
      .filter((x) => x.id !== state.cur && x.name.toLowerCase().includes(q))
      .slice(0, 12);
    if (!acItems.length) return closeAc();
    acSel = 0;
    renderAc();
  }
  function renderAc() {
    ac.replaceChildren(
      ...acItems.map((x, i) =>
        h(
          'div',
          {
            class: i === acSel ? 'sel' : '',
            onmousedown: (e) => {
              e.preventDefault();
              pickAc(i);
            },
          },
          x.name,
          h('small', {}, x.topic)
        )
      )
    );
    ac.classList.remove('hidden');
  }
  function pickAc(i) {
    const x = acItems[i];
    if (!x) return;
    const before = ta.value.slice(0, acStart),
      after = ta.value.slice(ta.selectionStart);
    ta.value = `${before}@${x.name} ${after}`;
    const pos = before.length + x.name.length + 2;
    ta.setSelectionRange(pos, pos);
    closeAc();
    autosize();
    scopeVisible();
    ta.focus();
  }
  ta.addEventListener('input', () => {
    autosize();
    updateAc();
    scopeVisible();
  });
  ta.addEventListener('blur', () => setTimeout(closeAc, 150));
  ta.addEventListener('keydown', (e) => {
    if (!ac.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') {
        acSel = (acSel + 1) % acItems.length;
        renderAc();
        return e.preventDefault();
      }
      if (e.key === 'ArrowUp') {
        acSel = (acSel - 1 + acItems.length) % acItems.length;
        renderAc();
        return e.preventDefault();
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        pickAc(acSel);
        return e.preventDefault();
      }
      if (e.key === 'Escape') {
        closeAc();
        return e.preventDefault();
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  for (const b of $$('#mscope button'))
    b.onclick = () => {
      state.mscope = b.dataset.scope;
      $$('#mscope button').forEach((x) => x.classList.toggle('on', x === b));
    };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  $('#mic').onclick = () => {
    if (!SR) {
      toast('Speech input needs Chrome or Safari');
      return;
    }
    if (rec) {
      rec.stop();
      return;
    }
    rec = new SR();
    rec.lang = navigator.language || 'en-AU';
    rec.interimResults = true;
    const base = ta.value;
    rec.onresult = (ev) => {
      let t = '';
      for (const r of ev.results) t += r[0].transcript;
      ta.value = (base ? base + ' ' : '') + t;
      autosize();
    };
    rec.onend = () => {
      rec = null;
      $('#mic').classList.remove('on');
      ta.focus();
    };
    rec.onerror = () => {
      rec = null;
      $('#mic').classList.remove('on');
    };
    $('#mic').classList.add('on');
    rec.start();
  };
  $('#chat-t').onclick = () => {
    const d = $('#drawer');
    d.classList.toggle('on');
    $('#chat-t').textContent = d.classList.contains('on') ? 'conversation ▾' : 'conversation ▴';
  };
  $('#change-x').onclick = () => $('#change').classList.remove('on');

  // ---------- rail, modes, pan, zoom, lasso, menu, search, drop ----------
  function setMode(m) {
    state.mode = m;
    $$('#rail .tool').forEach((t) => t.classList.toggle('on', t.dataset.tool === (m || 'select')));
    vp.classList.toggle('placing', !!m && m !== 'pan');
    vp.classList.toggle('pan', m === 'pan');
    const hint = $('#modehint');
    hint.classList.toggle('on', !!m);
    hint.textContent =
      {
        ask: 'Click where the answer should land',
        note: 'Click where the note goes',
        frame: 'Click to place a frame, or drag to draw one',
        pan: 'Drag to move around',
      }[m] || '';
  }
  const toW = (e) => {
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
  vp.addEventListener(
    'mousedown',
    (e) => {
      if (state.mode !== 'frame' || e.target.closest('.node, .askhere, .mini') || !state.cur) return;
      e.preventDefault();
      e.stopPropagation();
      const s0 = toW(e);
      const box = h('div', { class: 'lasso' });
      world.append(box);
      let w = 0,
        hh = 0;
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
        const name = $$('.frame .name').pop();
        if (name) {
          name.focus();
          document.getSelection().selectAllChildren(name);
        }
        toast('Name it · “later” sets aside what you drop in');
      };
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    },
    true
  );
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
    const sx = e.clientX - state.view.x,
      sy = e.clientY - state.view.y;
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
      const x = Math.min(s0.x, w.x),
        y = Math.min(s0.y, w.y),
        W = Math.abs(w.x - s0.x),
        H = Math.abs(w.y - s0.y);
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
  function zoomAt(k, mx, my) {
    k = Math.min(2.5, Math.max(0.25, k));
    state.view.x = mx - (mx - state.view.x) * (k / state.view.k);
    state.view.y = my - (my - state.view.y) * (k / state.view.k);
    state.view.k = k;
    applyView();
  }
  let zoomTarget = 1,
    zoomAnchor = null,
    gliding = false;
  function glideZoom(k, mx, my) {
    zoomTarget = Math.min(2.5, Math.max(0.25, k));
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
    const mx = r.width / 2,
      my = r.height / 2;
    const k0 = state.view.k,
      x0 = state.view.x,
      y0 = state.view.y,
      t0 = performance.now();
    const step = (t) => {
      const u = Math.min(1, (t - t0) / 240),
        ee = 1 - Math.pow(1 - u, 3);
      const kk = k0 + (k - k0) * ee;
      state.view.x = mx - (mx - x0) * (kk / k0);
      state.view.y = my - (my - y0) * (kk / k0);
      state.view.k = kk;
      applyView();
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  $('#z-in').onclick = () => zoomTo(Math.min(2.5, state.view.k * 1.2));
  $('#z-out').onclick = () => zoomTo(Math.max(0.25, state.view.k / 1.2));
  $('#z-reset').onclick = () => zoomTo(1);
  function menu(x, y, kind, w) {
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
                    for (let i = 0; i < ids.length - 1; i++)
                      ops.push({ op: 'link', a: ids[i], b: ids[i + 1] });
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
                }).then(() => {
                  const name = $$('.frame .name').pop();
                  if (name) {
                    name.focus();
                    document.getSelection().selectAllChildren(name);
                  }
                }),
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
    setTimeout(
      () =>
        document.addEventListener(
          'mousedown',
          (e) => {
            if (!m.contains(e.target)) m.remove();
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
  async function doUndo() {
    if (!state.cur) return;
    try {
      const r = await api(`/api/canvas/${state.cur}`, { op: 'undo' });
      toast(r.undone ? 'Undone' : 'Nothing to undo');
    } catch (e) {
      toast(e.message);
    }
  }
  function openSearch() {
    $$('.search').forEach((x) => x.remove());
    const box = h('div', { class: 'search' }, h('input', { placeholder: 'Find' }), h('div', { class: 'rs' }));
    document.body.append(box);
    const inp = $('input', box),
      rs = $('.rs', box);
    inp.focus();
    let on = 0,
      hits = [],
      timer = null;
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
          hits = (
            await api(
              `/api/search?dir=${encodeURIComponent(state.project)}&q=${encodeURIComponent(inp.value)}`
            )
          ).hits.slice(0, 8);
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
    setTimeout(
      () =>
        document.addEventListener(
          'mousedown',
          (e) => {
            if (!box.contains(e.target)) box.remove();
          },
          { once: true }
        ),
      0
    );
  }
  function peek(k, e) {
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
  function hidePeek() {
    document.getElementById('peek')?.remove();
  }
  document.addEventListener('mousedown', hidePeek, true);
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

  // ---------- questions from cc ----------
  function showQuestion(ev) {
    if (!state.cur || ev.sid !== state.cur) return;
    if ($(`#cards [data-req="${ev.reqId}"]`)) return;
    const qs = (ev.input && ev.input.questions) || [];
    if (ev.tool !== 'AskUserQuestion') return;
    const picks = qs.map(() => new Set()),
      others = qs.map(() => '');
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

  // ---------- live events ----------
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
        loadCanvas().then(() => {
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
            clearTimeout(onEvent.t);
            onEvent.t = setTimeout(() => $('#change').classList.remove('on'), 9000);
            for (const n of [...added, ...changed])
              N.querySelector(`[data-id="${n.id}"]`)?.classList.add('changed');
            state.sel = new Set(added.map((n) => n.id));
            renderSel();
          }
          if (!ev.ok && ev.error) toast(ev.error);
        });
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
  function connect() {
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

  // ---------- sidebar width ----------
  (() => {
    const w = store.get('sideW', null);
    if (w) document.documentElement.style.setProperty('--side-w', w + 'px');
    $('#side-split').addEventListener('mousedown', (e) => {
      e.preventDefault();
      const start = e.clientX,
        w0 = $('.lib').getBoundingClientRect().width;
      document.body.classList.add('dragging');
      $('#side-split').classList.add('active');
      const move = (ev) => {
        const ww = Math.max(190, Math.min(window.innerWidth * 0.5, w0 + ev.clientX - start));
        document.documentElement.style.setProperty('--side-w', ww + 'px');
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.classList.remove('dragging');
        $('#side-split').classList.remove('active');
        store.set('sideW', $('.lib').getBoundingClientRect().width);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  })();
  window.addEventListener('resize', renderMini);

  window.__lemux = { state, go, diveInto, cnode }; // for tests and the console

  // ---------- boot ----------
  (async () => {
    await loadProjects();
    const wanted = location.hash.slice(1).split(',')[0];
    if (wanted) {
      const { names } = await api('/api/names');
      const first = names.find((n) => n.id === wanted);
      if (first) {
        state.project = first.dir;
        store.set('project', first.dir);
        $('#project').value = first.dir;
      }
    }
    connect();
    await loadTree();
    const sid = wanted && node(wanted) ? wanted : store.get('cur:' + state.project, null);
    if (sid && node(sid)) go(sid);
    else showEmpty();
  })();
})();
