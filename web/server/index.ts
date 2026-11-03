// lemux web — the workstation: a small server with a JSON API over the lemux
// tree and Claude Code transcripts, a WebSocket that streams live sessions,
// and the static page. Sessions are canvases; answers are changes to them.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { ZodError } from 'zod';
import {
  LEMUX_DIR,
  readTree,
  getNode,
  addNode,
  patchNode,
  updateTree,
  descendants,
  topics,
  hookState,
  hookNotify,
  type Node,
} from './tree.js';
import { applyOps, blankCanvas, canvasOf, collapse, type Frame, type UserNode } from './canvas.js';
import {
  AdoptBody,
  BranchBody,
  IdBody,
  NewBody,
  PermissionBody,
  ProjectBody,
  ProjectsFile,
  RenameBody,
  SendBody,
  SidBody,
  UploadBody,
  parseCanvasPost,
  type Scope,
} from './schemas.js';
import {
  sessionFile,
  replayCanvas,
  lastAssistantText,
  wholeConversation,
  firstUserText,
  unlistedSessions,
  type CNode,
} from './transcript.js';
import * as S from './sessions.js';
import { brief, topicName } from './name.js';
import { reminder, canvasEnvelope } from './widgets.js';

const PORT = Number(process.env.PORT || 4321);
const PROJECTS_FILE = path.join(LEMUX_DIR, 'projects.json');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');

// ---------- helpers ----------
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function readBody(req: http.IncomingMessage, max = 30_000_000): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > max) reject(new Error('too large'));
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.on('error', reject);
  });
}
const expandHome = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
function extraProjects(): string[] {
  try {
    return ProjectsFile.parse(JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')));
  } catch {
    return [];
  }
}
function rememberProject(dir: string) {
  const cur = extraProjects();
  if (!cur.includes(dir)) fs.writeFileSync(PROJECTS_FILE, JSON.stringify([...cur, dir], null, 2));
}
function projectList() {
  const nodes = readTree();
  const roots = nodes.filter((n) => !n.parent && !n.archive);
  const dirs = new Set<string>([...roots.map((n) => n.dir), ...extraProjects()]);
  return [...dirs]
    .filter((d) => fs.existsSync(d))
    .map((dir) => ({
      dir,
      name: path.basename(dir),
      sessions: roots.filter((n) => n.dir === dir).length,
      last: Math.max(0, ...nodes.filter((n) => n.dir === dir).map((n) => n.created || 0)),
    }))
    .sort((a, b) => b.last - a.last);
}
function stateOf(id: string): string {
  const s = S.stateOf(id);
  if (s) return s;
  const n = hookNotify(id);
  if (n) return n;
  return hookState(id);
}
function viewNode(n: Node) {
  return {
    id: n.id,
    parent: n.parent,
    name: n.name,
    dir: n.dir,
    created: n.created,
    diverge: n.diverge || '',
    origin: n.origin ? { id: n.origin.id, parentName: n.origin.parentName } : null,
    state: stateOf(n.id),
    live: S.isLive(n.id),
  };
}
function treeView() {
  return topics().map((t) => ({ root: viewNode(t.root), nodes: t.nodes.map(viewNode) }));
}
function taste(dir: string) {
  let removed = 0;
  const last: string[] = [];
  for (const n of readTree().filter((x) => !x.archive && x.dir === dir)) {
    const c = canvasOf(n.canvas);
    removed += c.removed.length;
    last.push(...c.removedQ);
  }
  return { removed, lastRemoved: last.slice(-3) };
}

// The canvas as the page sees it: cc's nodes from the transcript, with the
// person's removals, positions, links, notes, frames layered on top.
function fullCanvas(n: Node) {
  const f = sessionFile(n.id, n.dir);
  const seed: CNode[] = n.origin
    ? [
        {
          id: n.origin.id,
          kind: n.origin.kind === 'text' ? 'text' : 'pic',
          q: n.origin.q,
          cap: n.origin.cap,
          art: n.origin.art,
          text: n.origin.text,
          from: null,
          by: 'origin',
        },
      ]
    : [];
  const rep = f
    ? replayCanvas(f, n.parent ? n.created - 5 : 0, seed)
    : { nodes: seed, links: [], said: [], turns: [] };
  const c = canvasOf(n.canvas);
  const nodes: (CNode & { origin?: boolean })[] = [];
  for (const x of rep.nodes)
    if (!c.removed.includes(x.id)) nodes.push(x.by === 'origin' ? { ...x, origin: true } : x);
  const ids = new Set(nodes.map((x) => x.id));
  const links = [
    ...rep.links.filter(
      (l) =>
        ids.has(l.a) &&
        ids.has(l.b) &&
        !c.unlinks.some((u) => (u.a === l.a && u.b === l.b) || (u.a === l.b && u.b === l.a))
    ),
    ...c.links.filter(
      (l) =>
        (ids.has(l.a) || c.notes.some((m) => m.id === l.a)) &&
        (ids.has(l.b) || c.notes.some((m) => m.id === l.b))
    ),
  ];
  // positions: stored, or laid out beside what they follow from, else in a column
  const pos: Record<string, { x: number; y: number }> = { ...c.pos };
  const W = 360,
    H = 230,
    GAP = 60;
  let col = 0;
  const taken = (x: number, y: number) =>
    Object.values(pos).some((p) => Math.abs(p.x - x) < W - 20 && Math.abs(p.y - y) < H - 20);
  for (const x of nodes) {
    if (pos[x.id]) continue;
    let px: number, py: number;
    if (x.from && pos[x.from]) {
      px = pos[x.from].x + W + GAP;
      py = pos[x.from].y;
      while (taken(px, py)) py += H + 30;
    } else {
      px = 60;
      py = 60 + col * (H + 30);
      while (taken(px, py)) {
        py += H + 30;
      }
      col++;
    }
    pos[x.id] = { x: px, y: py };
  }
  for (const m of c.notes) if (!pos[m.id]) pos[m.id] = { x: m.x, y: m.y };
  // doors: children that dived from a node here
  const kids = readTree().filter((k) => k.parent === n.id && k.origin);
  const doors = kids.map((k) => ({ node: k.origin!.id, sid: k.id, name: k.name, state: stateOf(k.id) }));
  return {
    nodes,
    links,
    pos,
    frames: c.frames,
    notes: c.notes,
    folded: c.folded,
    aside: c.aside,
    doors,
    said: rep.said,
    turns: rep.turns,
    hasTranscript: !!f,
  };
}

// @mentions: "@fuel tank" brings that canvas along as context.
function mentionBody(f: string, n: Node, scope: Scope): string {
  if (scope === 'whole') return wholeConversation(f);
  if (scope === 'last') return lastAssistantText(f);
  const first = firstUserText(f).replace(/\s+/g, ' ').slice(0, 300);
  const last = lastAssistantText(f, 600);
  return [
    n.diverge ? `About: ${n.diverge}` : '',
    first ? `It started with: ${first}` : '',
    last ? `Where it stands: ${last}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
function expandMentions(text: string, scope: Scope = 'last'): { prompt: string; display: string } {
  const nodes = readTree().filter((n) => !n.archive && n.name);
  const byLen = [...nodes].sort((a, b) => b.name.length - a.name.length);
  const blocks: string[] = [];
  let scan = text;
  for (const n of byLen) {
    const re = new RegExp('@' + n.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', 'i');
    if (!re.test(scan)) continue;
    scan = scan.replace(new RegExp(re.source, 'gi'), ' ');
    const f = sessionFile(n.id, n.dir);
    if (!f) continue;
    const body = mentionBody(f, n, scope);
    if (!body) continue;
    blocks.push(
      `<lemux-context session="${n.name}" about="${(n.diverge || '').replace(/"/g, "'")}" scope="${scope}">\n${body}\n</lemux-context>`
    );
  }
  const prompt = blocks.length
    ? `${blocks.join('\n\n')}\n\n<lemux-context session="" scope="note">The blocks above are carried over from other canvases the person referred to by @name. Use them as context for the question that follows.</lemux-context>\n\n${text}`
    : text;
  return { prompt, display: text };
}

function envelopeFor(
  n: Node,
  picked: string[],
  at: { x: number; y: number } | null,
  from: string | null
): string {
  const cv = fullCanvas(n);
  const inside = (f: Frame) =>
    [...cv.nodes.map((x) => x.id), ...cv.notes.map((m) => m.id)].filter((id) => {
      const p = cv.pos[id];
      return p && p.x > f.x && p.y > f.y && p.x < f.x + f.w && p.y < f.y + f.h;
    });
  return canvasEnvelope({
    nodes: cv.nodes.map((x) => ({
      id: x.id,
      kind: x.kind,
      q: x.q,
      cap: x.cap,
      from: x.from,
      art: x.art,
      text: x.text,
    })),
    picked: picked.filter((id) => cv.nodes.some((x) => x.id === id)),
    links: cv.links,
    frames: cv.frames.map((f) => ({ lbl: f.lbl, inside: inside(f) })),
    notes: cv.notes
      .filter((m) => m.kind === 'note')
      .map((m) => ({
        id: m.id,
        title: m.q,
        text: (m.text || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      })),
    files: cv.notes
      .filter((m) => m.kind !== 'note' && m.path)
      .map((m) => ({ id: m.id, name: m.q, path: m.path! })),
    at,
    from,
  });
}

// The node a dive starts from, as the child remembers it.
function originOf(src: CNode | UserNode, parentName: string): NonNullable<Node['origin']> {
  const cc = 'by' in src ? src : undefined;
  return {
    id: src.id,
    kind: src.kind === 'text' || src.kind === 'note' ? 'text' : 'pic',
    q: src.q,
    cap: cc?.cap || '',
    art: cc?.art,
    text: src.text,
    parentName,
  };
}

// ---------- API ----------
async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const p = url.pathname;
  const m = (re: RegExp) => p.match(re);
  let mm: RegExpMatchArray | null;

  if (req.method === 'GET' && p === '/api/projects')
    return json(res, 200, { projects: projectList(), home: os.homedir() });
  if (req.method === 'POST' && p === '/api/projects') {
    const b = ProjectBody.parse(await readBody(req));
    const dir = expandHome(b.dir.trim()).replace(/\/+$/, '');
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
      return json(res, 400, { error: 'that folder does not exist' });
    rememberProject(dir);
    return json(res, 200, { dir });
  }
  if (req.method === 'GET' && p === '/api/tree') {
    const dir = url.searchParams.get('dir') || '';
    const all = treeView();
    return json(res, 200, {
      topics: dir ? all.filter((t) => t.root.dir === dir) : all,
      home: os.homedir(),
      taste: dir ? taste(dir) : null,
    });
  }
  if (req.method === 'GET' && p === '/api/names') {
    const nodes = readTree().filter((n) => !n.archive && n.name);
    return json(res, 200, {
      names: nodes.map((n) => ({ id: n.id, name: n.name, dir: n.dir, project: path.basename(n.dir) })),
    });
  }
  if (req.method === 'GET' && p === '/api/unlisted') {
    const dir = url.searchParams.get('dir') || '';
    const known = new Set(readTree().map((n) => n.id));
    return json(res, 200, { sessions: dir ? unlistedSessions(dir, known) : [] });
  }

  // the canvas of a session
  if (req.method === 'GET' && (mm = m(/^\/api\/canvas\/([^/]+)$/))) {
    const n = getNode(mm[1]);
    if (!n) return json(res, 404, { error: 'unknown session' });
    S.acknowledge(n.id);
    return json(res, 200, { node: viewNode(n), ...fullCanvas(n), pending: S.pendingPermissions(n.id) });
  }
  // the person's changes: positions, frames, links, notes, removals, folds, asides; undo
  if (req.method === 'POST' && (mm = m(/^\/api\/canvas\/([^/]+)$/))) {
    const n = getNode(mm[1]);
    if (!n) return json(res, 404, { error: 'unknown session' });
    const b = parseCanvasPost(await readBody(req));
    const r = applyOps(canvasOf(n.canvas), b.ops, { noHistory: b.noHistory, newId: randomUUID });
    if (r.undone !== undefined) {
      if (r.undone) {
        patchNode(n.id, { canvas: r.state });
        broadcast({ type: 'canvas', sid: n.id });
      }
      return json(res, 200, { ok: r.undone, undone: r.undone });
    }
    if (r.changed) {
      patchNode(n.id, { canvas: r.state });
      broadcast({ type: 'canvas', sid: n.id, quiet: b.quiet });
    }
    return json(res, 200, { ok: true });
  }
  // a file dropped onto the canvas: saved into the project, served back
  if (req.method === 'POST' && p === '/api/upload') {
    const b = UploadBody.parse(await readBody(req));
    const n = getNode(b.sid);
    if (!n) return json(res, 404, { error: 'unknown session' });
    const name = b.name.replace(/[^\w.-]+/g, '_').slice(0, 80);
    const dir = path.join(n.dir, '.lemux', 'files');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${name}`);
    fs.writeFileSync(file, Buffer.from(b.data, 'base64'));
    return json(res, 200, {
      path: file,
      name,
      url: `/api/file?sid=${n.id}&path=${encodeURIComponent(file)}`,
    });
  }
  if (req.method === 'GET' && p === '/api/file') {
    const n = getNode(url.searchParams.get('sid') || '');
    const file = url.searchParams.get('path') || '';
    if (!n || !file.startsWith(path.join(n.dir, '.lemux', 'files'))) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  // search every canvas in the project
  if (req.method === 'GET' && p === '/api/search') {
    const dir = url.searchParams.get('dir') || '';
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const hits: { sid: string; canvas: string; id: string; q: string; cap: string }[] = [];
    for (const n of readTree().filter((x) => !x.archive && x.dir === dir)) {
      const cv = fullCanvas(n);
      for (const x of [
        ...cv.nodes.map((y) => ({ id: y.id, q: y.q, cap: y.cap })),
        ...cv.notes.map((y) => ({ id: y.id, q: y.q, cap: y.text || '' })),
      ])
        if (!q || (x.q + ' ' + x.cap).toLowerCase().includes(q))
          hits.push({
            sid: n.id,
            canvas: n.name,
            id: x.id,
            q: x.q,
            cap: (x.cap || '').replace(/<[^>]+>/g, '').slice(0, 80),
          });
      if (hits.length > 40) break;
    }
    return json(res, 200, { hits: hits.slice(0, 40) });
  }

  // ask: the answer changes the canvas
  if (req.method === 'POST' && p === '/api/send') {
    const b = SendBody.parse(await readBody(req));
    const n = getNode(b.sid);
    if (!n) return json(res, 404, { error: 'unknown session' });
    const text = b.text.trim();
    if (!text) return json(res, 400, { error: 'empty message' });
    if (S.isLive(n.id)) return json(res, 409, { error: 'still drawing' });
    const { prompt: body, display } = expandMentions(text, b.scope);
    const picked = b.picked;
    const at = b.at ? { x: Math.round(b.at.x), y: Math.round(b.at.y) } : null;
    const from = b.from || picked[0] || null;
    const prompt = `${envelopeFor(n, picked, at, from)}\n\n${body}`;
    // where the answer should land, remembered until the result arrives
    pendingPlace.set(n.id, { at, from, picked });
    // a dive is forked from its parent on its first message; a root with no transcript starts fresh
    const f = sessionFile(n.id, n.dir);
    const how = f
      ? {}
      : n.parent && sessionFile(n.parent, n.dir)
        ? { fork: { parent: n.parent } }
        : { fresh: true };
    S.run({ sid: n.id, dir: n.dir, prompt, display, reminder: reminder(taste(n.dir)), ...how }).catch(
      () => {}
    );
    return json(res, 200, { ok: true });
  }

  // dive: a side quest that starts from a node
  if (req.method === 'POST' && p === '/api/branch') {
    const b = BranchBody.parse(await readBody(req));
    const parent = getNode(b.parent);
    if (!parent) return json(res, 404, { error: 'unknown parent' });
    const pf = sessionFile(parent.id, parent.dir);
    if (!pf) return json(res, 400, { error: 'ask something first' });
    const question = collapse(b.question);
    const cv = fullCanvas(parent);
    const src = cv.nodes.find((x) => x.id === b.node) || cv.notes.find((x) => x.id === b.node);
    if (!src) return json(res, 400, { error: 'pick a node to dive from' });
    const id = randomUUID();
    const name =
      (question || src.q)
        .replace(/\?$/, '')
        .slice(0, 28)
        .replace(/[^\x20-\x7e]/g, '')
        .trim() || 'dive';
    const origin = originOf(src, parent.name);
    addNode({
      id,
      parent: parent.id,
      name,
      excerpt: '',
      question,
      dir: parent.dir,
      created: Math.floor(Date.now() / 1000),
      window: '',
      pane: '',
      origin,
      canvas: { ...blankCanvas(), pos: { [src.id]: { x: 60, y: 60 } } },
    });
    const chain: string[] = [];
    for (let cur: Node | undefined = parent; cur; cur = cur.parent ? getNode(cur.parent) : undefined)
      if (cur.diverge) chain.unshift(cur.diverge);
    brief(id, {
      ctx: origin.cap + ' ' + (origin.text || ''),
      excerpt: src.q,
      question,
      chain,
    })
      .then(() => broadcast({ type: 'tree' }))
      .catch(() => {});
    if (question) {
      const seed = `Re the node "${src.q}": ${question}`;
      const { prompt: body } = expandMentions(seed);
      const child = getNode(id)!;
      const prompt = `${envelopeFor(child, [src.id], null, src.id)}\n\n${body}`;
      pendingPlace.set(id, { at: null, from: src.id, picked: [src.id] });
      S.run({
        sid: id,
        dir: parent.dir,
        prompt,
        display: seed,
        fork: { parent: parent.id },
        reminder: reminder(taste(parent.dir)),
      }).catch(() => {});
    }
    broadcast({ type: 'tree' });
    return json(res, 200, { id, name });
  }

  if (req.method === 'POST' && p === '/api/new') {
    const b = NewBody.parse(await readBody(req));
    const dir = expandHome(b.dir.trim());
    const text = b.text.trim();
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
      return json(res, 400, { error: 'that folder does not exist' });
    if (!text) return json(res, 400, { error: 'ask something to open the canvas' });
    const id = randomUUID();
    rememberProject(dir);
    addNode({
      id,
      parent: '',
      name: b.name.trim().slice(0, 40) || path.basename(dir),
      dir,
      created: Math.floor(Date.now() / 1000),
      window: '',
      pane: '',
    });
    const { prompt: body, display } = expandMentions(text);
    const n = getNode(id)!;
    const prompt = `${envelopeFor(n, [], null, null)}\n\n${body}`;
    pendingPlace.set(id, { at: null, from: null, picked: [] });
    S.run({ sid: id, dir, prompt, display, fresh: true, reminder: reminder(taste(dir)) }).catch(() => {});
    if (!b.name)
      topicName(text)
        .then((name) => {
          if (name) {
            patchNode(id, { name });
            broadcast({ type: 'tree' });
          }
        })
        .catch(() => {});
    broadcast({ type: 'tree' });
    return json(res, 200, { id });
  }
  if (req.method === 'POST' && p === '/api/rename') {
    const b = RenameBody.parse(await readBody(req));
    const name = collapse(b.name).slice(0, 60);
    if (!getNode(b.id) || !name) return json(res, 400, { error: 'bad rename' });
    patchNode(b.id, { name });
    broadcast({ type: 'tree' });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/delete') {
    const b = IdBody.parse(await readBody(req));
    const n = getNode(b.id);
    if (!n) return json(res, 404, { error: 'unknown session' });
    const ids = descendants(n.id);
    for (const id of ids) await S.interrupt(id);
    for (const id of ids) {
      const x = getNode(id);
      if (!x || !x.parent) continue;
      const f = sessionFile(id, x.dir);
      if (f) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* gone */
        }
      }
    }
    updateTree((nodes) => nodes.filter((x) => !ids.includes(x.id)));
    broadcast({ type: 'tree' });
    return json(res, 200, { ok: true, removed: ids });
  }
  if (req.method === 'POST' && p === '/api/interrupt') {
    const b = SidBody.parse(await readBody(req));
    return json(res, 200, { ok: await S.interrupt(b.sid) });
  }
  if (req.method === 'POST' && p === '/api/permission') {
    const b = PermissionBody.parse(await readBody(req));
    const ok = S.answerPermission(b.sid, b.reqId, b.reply);
    return json(res, ok ? 200 : 404, { ok });
  }
  if (req.method === 'POST' && p === '/api/adopt') {
    const b = AdoptBody.parse(await readBody(req));
    const id = b.id;
    const dir = expandHome(b.dir);
    const f = sessionFile(id, dir);
    if (!f) return json(res, 404, { error: 'no transcript for that session' });
    if (!getNode(id)) {
      addNode({
        id,
        parent: '',
        name: path.basename(dir),
        dir,
        created: Math.floor(Date.now() / 1000),
        window: '',
        pane: '',
      });
      const firstText = firstUserText(f);
      if (firstText)
        topicName(firstText)
          .then((name) => {
            if (name) {
              patchNode(id, { name });
              broadcast({ type: 'tree' });
            }
          })
          .catch(() => {});
    }
    broadcast({ type: 'tree' });
    return json(res, 200, { id });
  }
  json(res, 404, { error: 'no such route' });
}

// after an answer, place what it added where the question pointed
const pendingPlace = new Map<
  string,
  { at: { x: number; y: number } | null; from: string | null; picked: string[] }
>();
function placeNew(sid: string) {
  const n = getNode(sid);
  if (!n) return;
  const pl = pendingPlace.get(sid);
  pendingPlace.delete(sid);
  const cv = fullCanvas(n);
  const c = canvasOf(n.canvas);
  let changed = false;
  const fresh = cv.nodes.filter((x) => !c.pos[x.id]);
  fresh.forEach((x, i) => {
    if (pl && pl.at) {
      c.pos[x.id] = { x: pl.at.x, y: pl.at.y + i * 260 };
      changed = true;
    } else if (cv.pos[x.id]) {
      c.pos[x.id] = cv.pos[x.id];
      changed = true;
    }
  });
  if (changed) patchNode(sid, { canvas: c });
}

// ---------- static ----------
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/plain',
};
function serveStatic(res: http.ServerResponse, url: URL) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------- server + websocket ----------
async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(res, url);
  } catch (e) {
    if (e instanceof ZodError)
      return json(res, 400, {
        error: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      });
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}
const server = http.createServer((req, res) => {
  void handle(req, res);
});
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(msg: unknown) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}
S.onEvent((e) => {
  if (e.type === 'result') placeNew(e.sid);
  broadcast(e);
  if (e.type === 'result' || e.type === 'state') broadcast({ type: 'tree' });
});
let lastSig = '';
setInterval(() => {
  const sig = treeView()
    .map((t) => t.nodes.map((n) => n.id + n.state + n.name).join())
    .join('|');
  if (sig !== lastSig) {
    lastSig = sig;
    broadcast({ type: 'tree' });
  }
}, 2000);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`lemux web → http://localhost:${PORT}`);
});
