// Reading Claude Code transcripts (~/.claude/projects/<dir>/<id>.jsonl).
// A transcript is a tree, not a list: retries, edits and /clear leave abandoned
// branches. Only the newest leaf's ancestor chain is the conversation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactResult, jsonIn, parseFenceOps } from './schemas.js';

const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

export function munge(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-');
}

export function sessionFile(id: string, dir: string): string | null {
  const direct = path.join(PROJECTS, munge(dir), `${id}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  // resumed from elsewhere — look across every project folder
  try {
    for (const d of fs.readdirSync(PROJECTS)) {
      const f = path.join(PROJECTS, d, `${id}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {
    /* no projects dir */
  }
  return null;
}

type Rec = {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
};
const isRec = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';

// Content blocks as the API writes them. Only the three kinds we read are
// spelled out; a block of any other kind is skipped.
type RawBlock = { type: string } & Record<string, unknown>;
type TextBlock = { type: 'text'; text: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> };
type ResultPart = { type: string; text?: string };
type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | ResultPart[];
  is_error?: boolean;
};
const blocksOf = (content: unknown): RawBlock[] =>
  Array.isArray(content)
    ? content.filter(
        (b: unknown): b is RawBlock =>
          typeof b === 'object' && b !== null && typeof (b as { type?: unknown }).type === 'string'
      )
    : [];
const isText = (b: RawBlock): b is RawBlock & TextBlock => b.type === 'text' && typeof b.text === 'string';
const isToolUse = (b: RawBlock): b is RawBlock & ToolUseBlock =>
  b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string';
const isToolResult = (b: RawBlock): b is RawBlock & ToolResultBlock =>
  b.type === 'tool_result' && typeof b.tool_use_id === 'string';

function readRecords(file: string): Rec[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: Rec[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isRec(v)) out.push(v);
    } catch {
      /* half-written last line */
    }
  }
  return out;
}

export function chain(file: string): Rec[] {
  const recs = readRecords(file);
  const by = new Map<string, Rec>();
  for (const r of recs) if (r.uuid) by.set(r.uuid, r);
  const convo = recs.filter((r) => (r.type === 'user' || r.type === 'assistant') && !r.isSidechain);
  const leaf = convo[convo.length - 1];
  if (!leaf?.uuid) return [];
  const out: Rec[] = [];
  const seen = new Set<string>();
  let cur: Rec | undefined = leaf;
  while (cur && cur.uuid && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    out.push(cur);
    cur = cur.parentUuid ? by.get(cur.parentUuid) : undefined;
  }
  return out.reverse();
}

export type Block =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      summary: string;
      result?: string;
      isError?: boolean;
      artifact?: { title?: string; url?: string; slug?: string; version?: string };
    };

export type Carried = { session: string; about: string; scope: string; text: string };
export type Turn = {
  role: 'user' | 'assistant';
  uuid: string;
  ts?: string;
  blocks: Block[];
  ctx?: Carried[];
};

export const textOf = (blocks: Block[]): string[] =>
  blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : []));

// Collapse the chain into renderable turns. Tool calls stay as compact chips
// with their result attached; everything that isn't prose or a tool is dropped
// (thinking, images, system reminders, meta records).
//
// A canvas, an envelope and a search each walk the same transcripts, so the
// turns are cached per file until its mtime or size changes. Callers must not
// mutate what they get.
const TURNS_CACHE_MAX = 200;
const turnsCache = new Map<string, { mtime: number; size: number; turns: Turn[] }>();

export function turns(file: string): Turn[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    turnsCache.delete(file);
    return [];
  }
  const hit = turnsCache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.turns;
  const fresh = parseTurns(file);
  turnsCache.delete(file);
  turnsCache.set(file, { mtime: st.mtimeMs, size: st.size, turns: fresh });
  if (turnsCache.size > TURNS_CACHE_MAX) turnsCache.delete(turnsCache.keys().next().value!);
  return fresh;
}

function parseTurns(file: string): Turn[] {
  const out: Turn[] = [];
  const toolIndex = new Map<string, Block & { kind: 'tool' }>();
  for (const r of chain(file)) {
    if (r.isMeta) continue;
    const content = r.message?.content;
    if (r.type === 'user') {
      if (typeof content === 'string') {
        const text = cleanUserText(content);
        if (text)
          out.push({
            role: 'user',
            uuid: r.uuid!,
            ts: r.timestamp,
            blocks: [{ kind: 'text', text }],
            ctx: carried(content),
          });
        continue;
      }
      const blocks: Block[] = [];
      const ctx: Carried[] = [];
      for (const b of blocksOf(content)) {
        if (isText(b)) {
          const text = cleanUserText(b.text);
          ctx.push(...carried(b.text));
          if (text) blocks.push({ kind: 'text', text });
        } else if (isToolResult(b)) {
          const t = toolIndex.get(b.tool_use_id);
          if (!t) continue;
          const full = resultText(b.content);
          t.result = full.slice(0, 1200);
          t.isError = !!b.is_error;
          // an artifact the session published or edited — show it as a card
          if (
            /^mcp__claude-artifacts__(publish_version|publish_files|edit_version|create_from_type)$/.test(
              t.name
            )
          ) {
            const j = jsonIn(full, ArtifactResult);
            if (j && (j.url || j.title)) t.artifact = j;
          }
        }
      }
      if (blocks.length) out.push({ role: 'user', uuid: r.uuid!, ts: r.timestamp, blocks, ctx });
    } else if (r.type === 'assistant') {
      const blocks: Block[] = [];
      for (const b of blocksOf(content)) {
        if (isText(b)) {
          if (b.text.trim()) blocks.push({ kind: 'text', text: b.text });
        } else if (isToolUse(b)) {
          const t: Block & { kind: 'tool' } = {
            kind: 'tool',
            id: b.id,
            name: b.name,
            summary: toolSummary(b.name, b.input),
          };
          toolIndex.set(b.id, t);
          blocks.push(t);
        }
      }
      if (!blocks.length) continue;
      // consecutive assistant records are one turn (one model call per record)
      const last = out[out.length - 1];
      if (last && last.role === 'assistant') last.blocks.push(...blocks);
      else out.push({ role: 'assistant', uuid: r.uuid!, ts: r.timestamp, blocks });
    }
  }
  return out;
}

function resultText(c: ToolResultBlock['content']): string {
  if (typeof c === 'string') return c;
  return (c ?? []).map((b) => (b.type === 'text' ? b.text || '' : '')).join('\n');
}

// Slash-command echoes, system reminders and pasted-content wrappers are not
// something the user typed — hide them, keep what they did.
export function cleanUserText(s: string): string {
  if (/^<(command-name|command-message|local-command-stdout|local-command-caveat)/.test(s.trim())) return '';
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<lemux-context\b[^>]*>[\s\S]*?<\/lemux-context>\s*/g, '')
    .replace(/<lemux-page\b[^>]*>[\s\S]*?<\/lemux-page>\s*/g, '')
    .replace(/<lemux-canvas>[\s\S]*?<\/lemux-canvas>\s*/g, '')
    .trim();
}

// What an @mention carried into this message — session, its brief, the scope and the text itself.
export function carried(s: string): Carried[] {
  return [
    ...s.matchAll(
      /<lemux-context session="([^"]*)"(?: about="([^"]*)")?(?: scope="([^"]*)")?>\n?([\s\S]*?)\n?<\/lemux-context>/g
    ),
  ]
    .map((m) => ({ session: m[1], about: m[2] || '', scope: m[3] || 'last', text: m[4] }))
    .filter((c) => c.session);
}

// The whole conversation as plain prose, for carrying into another session.
export function wholeConversation(file: string, max = 60000): string {
  const lines: string[] = [];
  for (const t of turns(file)) {
    const text = textOf(t.blocks).join('\n').trim();
    if (text) lines.push(`${t.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  const s = lines.join('\n\n');
  return s.length > max ? s.slice(s.length - max) : s; // keep the newest end
}

export function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const s = (k: string) => (typeof input[k] === 'string' ? input[k] : '');
  switch (name) {
    case 'Bash':
      return s('description') || s('command').split('\n')[0].slice(0, 120);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return short(s('file_path') || s('notebook_path'));
    case 'Glob':
    case 'Grep':
      return s('pattern');
    case 'WebFetch':
    case 'WebSearch':
      return s('url') || s('query');
    case 'Agent':
      return s('description');
    case 'Skill':
      return s('skill');
    default: {
      const v = Object.values(input).find((x): x is string => typeof x === 'string');
      return (v || '').slice(0, 120);
    }
  }
}

function short(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// The last thing Claude said in a session — what an @mention carries over.
export function lastAssistantText(file: string, max = 6000): string {
  const t = turns(file);
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i].role !== 'assistant') continue;
    const text = textOf(t[i].blocks).join('\n\n').trim();
    if (text) return text.length > max ? text.slice(0, max) + '\n…' : text;
  }
  return '';
}

export function firstUserText(file: string): string {
  const t = turns(file);
  const u = t.find((x) => x.role === 'user');
  return u ? textOf(u.blocks)[0] || '' : '';
}

// Older answers carried a ```page fence: a picture, and ```page redraw=N to replace page N.
const PAGE_FENCE = /```page(?:[ \t]+redraw=(\d+))?[^\n]*\n([\s\S]*?)```/;

// ---------- the canvas, replayed from the transcript ----------
// Every assistant answer may carry a ```canvas fence: a list of operations.
// Older answers carry a ```page fence; those become an add (or an update when
// they said redraw=N). Replaying all of them in order gives the canvas as cc
// left it; the person's own changes are layered on top by the server.
export type CNode = {
  id: string;
  kind: 'pic' | 'text';
  q: string;
  cap: string;
  art?: string;
  text?: string;
  from: string | null;
  by: string;
  redrawn?: string[];
};
export type CLink = { a: string; b: string; lbl?: string };
export type Replay = {
  nodes: CNode[];
  links: CLink[];
  said: { who: 'you' | 'cc'; text: string; key: string }[];
  turns: { key: string; q: string; ops: number }[];
};

const CANVAS_FENCE = /```canvas[^\n]*\n([\s\S]*?)```/;

// seed: nodes the canvas starts with (a dive's origin), so updates and links can land on them
export function replayCanvas(file: string, since = 0, seed: CNode[] = []): Replay {
  const nodes: CNode[] = seed.map((n) => ({ ...n }));
  const links: CLink[] = [];
  const said: Replay['said'] = [];
  const turnsOut: Replay['turns'] = [];
  const byId = () => new Map(nodes.map((n) => [n.id, n]));
  const t = turns(file);
  let pageN = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i].role !== 'user') continue;
    if (since && t[i].ts && Date.parse(t[i].ts!) / 1000 < since) continue;
    const q = textOf(t[i].blocks).join(' ').replace(/\s+/g, ' ').trim();
    if (!q) continue;
    said.push({ who: 'you', text: q, key: t[i].uuid });
    const a = t.slice(i + 1).find((x) => x.role === 'assistant');
    if (!a) continue;
    const full = textOf(a.blocks).join('\n\n');
    let ops = 0;
    const cm = full.match(CANVAS_FENCE);
    const pm = !cm ? full.match(PAGE_FENCE) : null;
    const rest = (
      cm
        ? full.slice(full.indexOf(cm[0]) + cm[0].length)
        : pm
          ? full.slice(full.indexOf(pm[0]) + pm[0].length)
          : full
    )
      .replace(/\s+/g, ' ')
      .trim();
    const tail = rest || '';
    if (cm) {
      for (const o of parseFenceOps(cm[1])) {
        const m = byId();
        switch (o.op) {
          case 'add': {
            const base = o.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'node';
            let id = base;
            for (let k = 2; m.has(id); k++) id = `${base}-${k}`;
            nodes.push({
              id,
              kind: o.kind === 'text' ? 'text' : 'pic',
              q,
              cap: (o.cap || '').trim(),
              art: o.art || undefined,
              text: o.text || undefined,
              from: o.from && m.has(o.from) ? o.from : null,
              by: t[i].uuid,
            });
            ops++;
            break;
          }
          case 'update': {
            const n = m.get(o.id);
            if (!n) break;
            if (o.art) n.art = o.art;
            if (o.text) n.text = o.text;
            if (o.cap) n.cap = o.cap;
            if (o.kind === 'text' || o.kind === 'pic') n.kind = o.kind;
            (n.redrawn = n.redrawn || []).push(q);
            ops++;
            break;
          }
          case 'remove': {
            const idx = nodes.findIndex((n) => n.id === o.id);
            if (idx < 0) break;
            const gone = nodes.splice(idx, 1)[0];
            const rewire = o.rewireTo && m.has(o.rewireTo) ? o.rewireTo : null;
            for (const n of nodes) if (n.from === gone.id) n.from = rewire;
            for (let j = links.length - 1; j >= 0; j--)
              if (links[j].a === gone.id || links[j].b === gone.id) links.splice(j, 1);
            ops++;
            break;
          }
          case 'link':
            if (!m.has(o.a) || !m.has(o.b)) break;
            if (!links.some((l) => (l.a === o.a && l.b === o.b) || (l.a === o.b && l.b === o.a)))
              links.push({ a: o.a, b: o.b, lbl: o.lbl || undefined });
            ops++;
            break;
          case 'unlink': {
            const before = links.length;
            for (let j = links.length - 1; j >= 0; j--)
              if ((links[j].a === o.a && links[j].b === o.b) || (links[j].a === o.b && links[j].b === o.a))
                links.splice(j, 1);
            if (links.length !== before) ops++;
            break;
          }
        }
      }
    } else if (pm) {
      const art = pm[2].trim();
      const html = !/^<svg[\s>]/i.test(art);
      if (pm[1] && nodes.find((n) => n.id === `p${pm[1]}`)) {
        const n = nodes.find((x) => x.id === `p${pm[1]}`)!;
        n.art = art;
        n.cap = tail || n.cap;
        (n.redrawn = n.redrawn || []).push(q);
        ops++;
      } else {
        pageN++;
        nodes.push({
          id: `p${pageN}`,
          kind: html ? 'text' : 'pic',
          q,
          cap: tail,
          art: html ? undefined : art,
          text: html ? art : undefined,
          from: pageN > 1 ? `p${pageN - 1}` : null,
          by: t[i].uuid,
        });
        ops++;
      }
    } else if (tail) {
      // words only: a text node of its own, so talk also lands on the canvas
      const id = `say-${said.length}`;
      nodes.push({
        id,
        kind: 'text',
        q,
        cap: tail.split(/(?<=[.!?])\s/)[0].slice(0, 160),
        text: tail.slice(0, 600),
        from: null,
        by: t[i].uuid,
      });
      ops++;
    }
    if (tail) said.push({ who: 'cc', text: tail.slice(0, 300), key: a.uuid });
    turnsOut.push({ key: t[i].uuid, q, ops });
  }
  return { nodes, links, said, turns: turnsOut };
}

function listDir(d: string): string[] {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

// Claude sessions in a folder that lemux doesn't track yet — candidates to adopt.
export function unlistedSessions(
  dir: string,
  known: Set<string>
): { id: string; firstPrompt: string; mtime: number }[] {
  const d = path.join(PROJECTS, munge(dir));
  const names = listDir(d).filter((n) => n.endsWith('.jsonl'));
  if (!names.length) return [];
  const out: { id: string; firstPrompt: string; mtime: number }[] = [];
  for (const n of names) {
    const id = n.slice(0, -6);
    if (known.has(id)) continue;
    const f = path.join(d, n);
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    if (st.size < 200) continue;
    const first = firstUserText(f).replace(/\s+/g, ' ').slice(0, 90);
    if (!first) continue;
    out.push({ id, firstPrompt: first, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 20);
}
