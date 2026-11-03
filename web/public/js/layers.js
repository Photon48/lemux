// The left panel: the project picker and the stack of canvases.
import { $, h, api, store, toast } from './dom.js';
import { state, node, crumbs, short } from './state.js';
import { go, showEmpty, renderSpine } from './nav.js';
import { renderNodes } from './canvas.js';

export async function loadProjects() {
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
    e.target.value = state.project || '__open__';
    openFolder();
    return;
  }
  await switchProject(v);
};

// Open a folder as a project: an input in the shelf, named in place.
function openFolder() {
  $('.openfolder')?.remove();
  const inp = h('input', { class: 'rename-input', value: state.home + '/', spellcheck: 'false' });
  const row = h(
    'div',
    { class: 'openfolder' },
    h('div', { class: 'hint' }, 'Folder to open · a path, or ~/…'),
    inp
  );
  $('#layers').before(row);
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
  let done = false;
  const finish = async (open) => {
    if (done) return;
    done = true;
    const dir = inp.value.trim();
    row.remove();
    if (!open || !dir) return;
    try {
      const r = await api('/api/projects', { dir });
      await loadProjects();
      await switchProject(r.dir);
    } catch (err) {
      toast(err.message);
    }
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  };
  inp.onblur = () => finish(false);
}

export async function switchProject(dir) {
  state.project = dir;
  store.set('project', dir);
  $('#project').value = dir;
  await loadTree();
  const last = store.get('cur:' + dir, null);
  if (last && node(last)) go(last);
  else showEmpty();
}

export async function loadTree() {
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
    if (state.cv) renderNodes();
  }
}

const stateLabel = (n, depth, kids) =>
  n.state === 'busy'
    ? h('b', {}, 'drawing')
    : n.state === 'waiting'
      ? h('b', {}, 'needs you')
      : n.state === 'done'
        ? h('b', { class: 'done' }, 'finished while you were away')
        : n.state === 'error'
          ? h('b', { class: 'error' }, 'error')
          : depth
            ? `inside ${node(n.parent)?.name || ''}`
            : kids.length
              ? `${kids.length} dive${kids.length > 1 ? 's' : ''}`
              : '';

export function renderLayers() {
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
        h('div', { class: 'm' }, stateLabel(n, d, kids))
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
              confirmDelete(row, n, !d);
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

let olderOpen = false;
let olderList = [];
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

// Delete asks in place: the row's actions become the question and its answers.
function confirmDelete(row, n, isRoot) {
  const acts = $('.acts', row);
  acts.classList.add('asking');
  acts.replaceChildren(
    h(
      'span',
      {
        class: 'ask-del',
        title: isRoot
          ? 'Its dives are deleted; its own transcript stays on disk.'
          : 'Everything under it goes too.',
      },
      isRoot ? 'Off the shelf?' : 'Delete it and its dives?'
    ),
    h(
      'button',
      {
        class: 'yes',
        onclick: (e) => {
          e.stopPropagation();
          del(n);
        },
      },
      'Delete'
    ),
    h(
      'button',
      {
        onclick: (e) => {
          e.stopPropagation();
          renderLayers();
        },
      },
      'No'
    )
  );
  setTimeout(
    () =>
      document.addEventListener(
        'mousedown',
        (e) => {
          if (!acts.contains(e.target)) renderLayers();
        },
        { once: true }
      ),
    0
  );
}

async function del(n) {
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
