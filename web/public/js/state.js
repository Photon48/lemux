// The one app state, lookups into it, and the canvas DOM anchors.
import { $, store } from './dom.js';

export const state = {
  projects: [],
  project: store.get('project', ''),
  home: '',
  names: [],
  byId: new Map(),
  topics: [],
  taste: null,
  cur: null, // the open session id
  fresh: null, // a new canvas not yet asked into being: { name }
  cv: null, // the open canvas as the server sent it
  sel: new Set(),
  selLink: null,
  view: { x: 0, y: 0, k: 1 },
  mode: null, // the rail tool: null (select) | ask | note | frame | pan
  hist: [],
  hpos: -1,
  mscope: 'last',
  live: null, // a question in flight: { q, from, at, moved }
};

export const node = (id) => state.byId.get(id);
export const crumbs = (id) => {
  const c = [];
  for (let n = node(id); n; n = n.parent ? node(n.parent) : null) c.unshift(n);
  return c;
};
export const cnode = (id) =>
  state.cv && (state.cv.nodes.find((n) => n.id === id) || state.cv.notes.find((n) => n.id === id));
export const isUser = (id) => !!(state.cv && state.cv.notes.some((n) => n.id === id));
export const allNodes = () => (state.cv ? [...state.cv.nodes, ...state.cv.notes] : []);
export const widthOf = (n) => (n.kind === 'text' ? 300 : n.kind === 'note' ? 260 : 360);
export const short = (p) => (state.home && p.startsWith(state.home) ? '~' + p.slice(state.home.length) : p);

export const vp = $('#vp');
export const world = $('#world');
export const N = $('#nodes');
export const F = $('#frames');
export const E = $('#edges');
