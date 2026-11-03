// lemux workstation — one canvas per session; nodes are answers; dive into a node and you are in its side quest.
import { $, api, store } from './dom.js';
import { state, node, cnode } from './state.js';
import { loadProjects, loadTree } from './layers.js';
import { go, showEmpty } from './nav.js';
import { diveInto } from './ops.js';
import { connect } from './live.js';
import './canvas.js';
import './ask.js';
import './tools.js';

// ---------- sidebar width ----------
const sideW = store.get('sideW', null);
if (sideW) document.documentElement.style.setProperty('--side-w', sideW + 'px');
$('#side-split').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const start = e.clientX;
  const w0 = $('.lib').getBoundingClientRect().width;
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

window.__lemux = { state, go, diveInto, cnode }; // for the console

// ---------- boot ----------
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
