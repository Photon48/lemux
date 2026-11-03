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

function writeTree(nodes: Node[]): void {
  fs.mkdirSync(LEMUX_DIR, { recursive: true });
  const tmp = path.join(LEMUX_DIR, `.tree.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(nodes, null, 2) + '\n');
  fs.renameSync(tmp, TREE);
}

// The tree is shared with the tmux lemux, which also reads, changes and
// rewrites it. Both take this lock around a read-modify-write so neither
// loses the other's change. mkdir is atomic on every filesystem we run on; a
// lock older than LOCK_STALE_MS is a crash's leftover and is broken.
const LOCK = path.join(LEMUX_DIR, '.tree.lock');
export const LOCK_STALE_MS = 5000;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withTreeLock<T>(fn: () => T): T {
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let age: number;
    try {
      age = Date.now() - fs.statSync(LOCK).mtimeMs;
    } catch {
      continue; // released between our two calls
    }
    if (age > LOCK_STALE_MS) {
      try {
        fs.rmdirSync(LOCK);
      } catch {
        /* someone else broke it first */
      }
      continue;
    }
    pause(5);
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(LOCK);
    } catch {
      /* already gone */
    }
  }
}

export function updateTree(fn: (nodes: Node[]) => Node[]): Node[] {
  return withTreeLock(() => {
    const next = fn(readTree());
    writeTree(next);
    return next;
  });
}

export function getNode(id: string, nodes = readTree()): Node | undefined {
  return nodes.find((n) => n.id === id);
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
