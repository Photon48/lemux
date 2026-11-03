// The lemux tree — the same ~/.lemux/tree.json the tmux lemux reads and writes,
// so the browser and the terminal are two views of one thing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanvasState } from './canvas.js';

export type { CanvasState, UserNode } from './canvas.js';

export const LEMUX_DIR = process.env.LEMUX_DIR || path.join(os.homedir(), '.lemux');
const TREE = path.join(LEMUX_DIR, 'tree.json');

export type Node = {
  id: string;
  parent: string;
  name: string;
  dir: string;
  created: number;
  excerpt?: string;
  question?: string;
  lines?: number;
  window?: string;
  pane?: string;
  diverge?: string;
  ctx_pre?: string;
  ctx_post?: string;
  archive?: boolean;
  successor?: string;
  digested?: number;
  canvas?: CanvasState; // the person's layer over cc's nodes
  origin?: {
    id: string;
    kind: string;
    q: string;
    cap: string;
    art?: string;
    text?: string;
    parentName: string;
  }; // the node a dive started from
};
export function readTree(): Node[] {
  try {
    return JSON.parse(fs.readFileSync(TREE, 'utf8')) as Node[];
  } catch {
    return [];
  }
}

export function writeTree(nodes: Node[]): void {
  fs.mkdirSync(LEMUX_DIR, { recursive: true });
  const tmp = path.join(LEMUX_DIR, `.tree.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(nodes, null, 2) + '\n');
  fs.renameSync(tmp, TREE);
}

export function updateTree(fn: (nodes: Node[]) => Node[]): Node[] {
  const next = fn(readTree());
  writeTree(next);
  return next;
}

export function getNode(id: string, nodes = readTree()): Node | undefined {
  return nodes.find((n) => n.id === id);
}

export function rootOf(id: string, nodes = readTree()): string {
  let cur = id;
  for (;;) {
    const n = getNode(cur, nodes);
    if (!n || !n.parent) return cur;
    cur = n.parent;
  }
}

export function descendants(id: string, nodes = readTree()): string[] {
  const out = [id];
  const frontier = [id];
  while (frontier.length) {
    const p = frontier.shift()!;
    for (const n of nodes)
      if (n.parent === p) {
        out.push(n.id);
        frontier.push(n.id);
      }
  }
  return out;
}

export function addNode(n: Node): void {
  updateTree((nodes) => [...nodes.filter((x) => x.id !== n.id), n]);
}

export function patchNode(id: string, patch: Partial<Node>): void {
  updateTree((nodes) => nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
}

// Live topics: every root (no parent) that is not an archived generation.
export function topics(nodes = readTree()): { root: Node; nodes: Node[] }[] {
  const roots = nodes.filter((n) => !n.parent && !n.archive);
  return roots
    .map((root) => ({ root, nodes: descendants(root.id, nodes).map((id) => getNode(id, nodes)!) }))
    .sort((a, b) => lastCreated(b.nodes) - lastCreated(a.nodes));
}

function lastCreated(nodes: Node[]): number {
  return Math.max(...nodes.map((n) => n.created || 0));
}

// Session state as the tmux lemux hooks report it — busy / waiting / idle —
// plus the unseen done/error flag. Sessions this server runs itself are
// tracked in memory; these files cover ones running in a terminal.
export function hookState(id: string): string {
  try {
    return fs.readFileSync(path.join(LEMUX_DIR, 'state', id), 'utf8').trim() || 'idle';
  } catch {
    return 'idle';
  }
}
export function hookNotify(id: string): string {
  try {
    return fs.readFileSync(path.join(LEMUX_DIR, 'notify', id), 'utf8').trim();
  } catch {
    return '';
  }
}
export function clearNotify(id: string): void {
  try {
    fs.unlinkSync(path.join(LEMUX_DIR, 'notify', id));
  } catch {
    /* none */
  }
}
