// Reading Claude Code transcripts (~/.claude/projects/<dir>/<id>.jsonl).
// A transcript is a tree, not a list: retries, edits and /clear leave abandoned
// branches. Only the newest leaf's ancestor chain is the conversation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  toolUseResult?: unknown;
};

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
      out.push(JSON.parse(line) as Rec);
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

// Collapse the chain into renderable turns. Tool calls stay as compact chips
// with their result attached; everything that isn't prose or a tool is dropped
// (thinking, images, system reminders, meta records).
export function turns(file: string): Turn[] {
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
      if (!Array.isArray(content)) continue;
      const blocks: Block[] = [];
      const ctx: Carried[] = [];
      for (const b of content) {
        if (b?.type === 'text') {
          const text = cleanUserText(b.text || '');
          ctx.push(...carried(b.text || ''));
          if (text) blocks.push({ kind: 'text', text });
        } else if (b?.type === 'tool_result') {
          const t = toolIndex.get(b.tool_use_id);
          if (t) {
            const full = resultText(b.content);
            t.result = full.slice(0, 1200);
            t.isError = !!b.is_error;
            // an artifact the session published or edited — show it as a card
            if (
              /^mcp__claude-artifacts__(publish_version|publish_files|edit_version|create_from_type)$/.test(
                t.name
              )
            ) {
              const m = full.match(/\{[\s\S]*\}/);
              try {
                const j = m ? JSON.parse(m[0]) : null;
                if (j && (j.url || j.title))
                  t.artifact = { title: j.title, url: j.url, slug: j.slug, version: j.version };
              } catch {
                /* not json */
              }
            }
          }
        }
      }
      if (blocks.length) out.push({ role: 'user', uuid: r.uuid!, ts: r.timestamp, blocks, ctx });
    } else if (r.type === 'assistant') {
      if (!Array.isArray(content)) continue;
      const blocks: Block[] = [];
      for (const b of content) {
        if (b?.type === 'text' && b.text?.trim()) blocks.push({ kind: 'text', text: b.text });
        else if (b?.type === 'tool_use') {
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

function resultText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b: any) => (b?.type === 'text' ? b.text : '')).join('\n');
  return '';
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
    const text = t.blocks
      .filter((b) => b.kind === 'text')
      .map((b) => (b as any).text)
      .join('\n')
      .trim();
    if (text) lines.push(`${t.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  const s = lines.join('\n\n');
  return s.length > max ? s.slice(s.length - max) : s; // keep the newest end
}

export function toolSummary(name: string, input: any): string {
  if (!input) return '';
  switch (name) {
    case 'Bash':
      return input.description || (input.command || '').split('\n')[0].slice(0, 120);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return short(input.file_path || input.notebook_path || '');
    case 'Glob':
    case 'Grep':
      return input.pattern || '';
    case 'WebFetch':
    case 'WebSearch':
      return input.url || input.query || '';
    case 'Agent':
      return input.description || '';
    case 'Skill':
      return input.skill || '';
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

// Files a session wrote — its artifacts. Edits count, reads don't.
export function artifacts(file: string): string[] {
  const set = new Set<string>();
  for (const r of chain(file)) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    for (const b of r.message.content) {
      if (b?.type !== 'tool_use') continue;
      if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(b.name)) {
        const p = b.input?.file_path || b.input?.notebook_path;
        if (p) set.add(p);
      }
    }
  }
  return [...set];
}

// The last thing Claude said in a session — what an @mention carries over.
export function lastAssistantText(file: string, max = 6000): string {
  const t = turns(file);
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i].role !== 'assistant') continue;
    const text = t[i].blocks
      .filter((b) => b.kind === 'text')
      .map((b) => (b as any).text)
      .join('\n\n')
      .trim();
    if (text) return text.length > max ? text.slice(0, max) + '\n…' : text;
  }
  return '';
}

export function firstUserText(file: string): string {
  const t = turns(file);
  const u = t.find((x) => x.role === 'user');
  return u ? (u.blocks.find((b) => b.kind === 'text') as any)?.text || '' : '';
}

// ---------- pages ----------
// A page is what one question produced: the ```page fence (a picture) and the
// sentence after it. ```page redraw=N replaces page N instead of adding one.
export type Page = {
  n: number;
  key: string;
  q: string;
  art: string;
  caption: string;
  html: boolean;
  redrawn?: { by: string; q: string }[];
};

const PAGE_FENCE = /```page(?:[ \t]+redraw=(\d+))?[^\n]*\n([\s\S]*?)```/;

// since: a side quest's transcript starts as a copy of its parent's; pages
// asked before the branch (by timestamp) belong to the parent, not to it.
export function pages(
  file: string,
  since = 0
): { pages: Page[]; said: { who: 'you' | 'cc'; text: string; key: string }[] } {
  const out: Page[] = [];
  const said: { who: 'you' | 'cc'; text: string; key: string }[] = [];
  const t = turns(file);
  for (let i = 0; i < t.length; i++) {
    if (t[i].role !== 'user') continue;
    if (since && t[i].ts && Date.parse(t[i].ts!) / 1000 < since) continue;
    const q = t[i].blocks
      .filter((b) => b.kind === 'text')
      .map((b: any) => b.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!q) continue;
    said.push({ who: 'you', text: q, key: t[i].uuid });
    const a = t.slice(i + 1).find((x) => x.role === 'assistant');
    if (!a) continue;
    const texts = a.blocks.filter((b) => b.kind === 'text').map((b: any) => b.text as string);
    const full = texts.join('\n\n');
    const m = full.match(PAGE_FENCE);
    // the caption is what cc said after the fence (or its last sentence when there is no fence)
    const rest = (m ? full.slice(full.indexOf(m[0]) + m[0].length) : full).replace(/\s+/g, ' ').trim();
    const caption = rest || (m ? '' : (texts[texts.length - 1] || '').replace(/\s+/g, ' ').trim());
    if (caption) said.push({ who: 'cc', text: caption, key: a.uuid });
    if (!m) continue;
    const art = m[2].trim();
    const html = !/^<svg[\s>]/i.test(art);
    if (m[1]) {
      const target = out.find((p) => p.n === Number(m[1]));
      if (target) {
        target.art = art;
        target.caption = caption || target.caption;
        target.html = html;
        (target.redrawn = target.redrawn || []).push({ by: t[i].uuid, q });
        continue;
      }
    }
    out.push({ n: out.length + 1, key: t[i].uuid, q, art, caption, html });
  }
  return { pages: out, said };
}

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

// The fence body as a list; a trailing comma is forgiven, anything else unparseable is no ops.
function parseOps(src: string): any[] {
  for (const s of [src, src.replace(/,\s*]$/, ']')]) {
    try {
      const v: unknown = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      /* try the next */
    }
  }
  return [];
}

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
    const q = t[i].blocks
      .filter((b) => b.kind === 'text')
      .map((b: any) => b.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!q) continue;
    said.push({ who: 'you', text: q, key: t[i].uuid });
    const a = t.slice(i + 1).find((x) => x.role === 'assistant');
    if (!a) continue;
    const full = a.blocks
      .filter((b) => b.kind === 'text')
      .map((b: any) => b.text as string)
      .join('\n\n');
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
      const list = parseOps(cm[1]);
      for (const o of list) {
        if (!o || typeof o !== 'object') continue;
        const m = byId();
        if (o.op === 'add' && o.id) {
          let id =
            String(o.id)
              .replace(/[^a-z0-9-]/gi, '-')
              .toLowerCase() || 'node';
          let k = 1;
          while (m.has(id)) id = `${o.id}-${++k}`;
          nodes.push({
            id,
            kind: o.kind === 'text' ? 'text' : 'pic',
            q,
            cap: String(o.cap || '').trim(),
            art: o.art ? String(o.art) : undefined,
            text: o.text ? String(o.text) : undefined,
            from: o.from && m.has(String(o.from)) ? String(o.from) : null,
            by: t[i].uuid,
          });
          ops++;
        } else if (o.op === 'update' && o.id && m.has(String(o.id))) {
          const n = m.get(String(o.id))!;
          if (o.art) n.art = String(o.art);
          if (o.text) n.text = String(o.text);
          if (o.cap) n.cap = String(o.cap);
          if (o.kind === 'text' || o.kind === 'pic') n.kind = o.kind;
          (n.redrawn = n.redrawn || []).push(q);
          ops++;
        } else if (o.op === 'remove' && o.id) {
          const idx = nodes.findIndex((n) => n.id === String(o.id));
          if (idx >= 0) {
            const gone = nodes.splice(idx, 1)[0];
            for (const n of nodes)
              if (n.from === gone.id)
                n.from = o.rewireTo && m.has(String(o.rewireTo)) ? String(o.rewireTo) : null;
            for (let j = links.length - 1; j >= 0; j--)
              if (links[j].a === gone.id || links[j].b === gone.id) links.splice(j, 1);
            ops++;
          }
        } else if (o.op === 'link' && o.a && o.b && m.has(String(o.a)) && m.has(String(o.b))) {
          if (!links.some((l) => (l.a === o.a && l.b === o.b) || (l.a === o.b && l.b === o.a)))
            links.push({ a: String(o.a), b: String(o.b), lbl: o.lbl ? String(o.lbl) : undefined });
          ops++;
        } else if (o.op === 'unlink' && o.a && o.b) {
          const before = links.length;
          for (let j = links.length - 1; j >= 0; j--)
            if ((links[j].a === o.a && links[j].b === o.b) || (links[j].a === o.b && links[j].b === o.a))
              links.splice(j, 1);
          if (links.length !== before) ops++;
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

// ---------- claude.ai artifacts ----------
// What a session made or touched on claude.ai: every claude-artifacts tool
// call (publish, edit, read, get) plus any claude.ai/artifact link in the
// conversation. Keyed by slug or URL, whichever the record carries.
export type Artifact = { key: string; slug?: string; url?: string; title?: string };

const ARTIFACT_TOOL =
  /^mcp__claude-artifacts__(publish_version|publish_files|edit_version|get_artifact|read_artifact|read_shared_artifact|create_from_type|pin_artifact|watch)$/;
const LINK = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/g;

export function claudeArtifacts(file: string): Artifact[] {
  const found = new Map<string, Artifact>();
  const pendingByTool = new Map<string, Artifact>();
  const put = (a: Artifact) => {
    // merge on slug or url, whichever already exists
    let cur = (a.slug && found.get('slug:' + a.slug)) || (a.url && found.get('url:' + a.url)) || undefined;
    if (!cur) {
      cur = { key: a.url || a.slug || '' };
    }
    if (a.slug) {
      cur.slug = a.slug;
      found.set('slug:' + a.slug, cur);
    }
    if (a.url) {
      cur.url = a.url;
      found.set('url:' + a.url, cur);
    }
    if (a.title && !cur.title) cur.title = a.title;
    if (!cur.key) cur.key = cur.url || cur.slug || '';
    return cur;
  };
  const fromSlugField = (v: unknown): Partial<Artifact> => {
    if (typeof v !== 'string') return {};
    return /^https?:/.test(v) ? { url: v.replace(/\/+$/, '') } : { slug: v };
  };
  for (const r of chain(file)) {
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (r.type === 'assistant' && b?.type === 'tool_use' && ARTIFACT_TOOL.test(b.name)) {
        const inp = b.input || {};
        const a = put({ key: '', ...fromSlugField(inp.slug), title: inp.title || inp.artifact_title });
        pendingByTool.set(b.id, a);
      } else if (r.type === 'user' && b?.type === 'tool_result' && pendingByTool.has(b.tool_use_id)) {
        const text =
          typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content[0]?.text || ''
              : '';
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) continue;
        try {
          const j = JSON.parse(m[0]);
          const prior = pendingByTool.get(b.tool_use_id)!;
          const merged = put({
            key: '',
            slug: j.slug || prior.slug,
            url: j.url || prior.url,
            title: j.title || prior.title,
          });
          if (prior !== merged) {
            prior.key = merged.key;
          }
        } catch {
          /* not json */
        }
      } else if (b?.type === 'text' && typeof b.text === 'string') {
        for (const u of b.text.match(LINK) || []) put({ key: u, url: u });
      }
    }
  }
  const uniq = new Map<Artifact, true>();
  for (const a of found.values()) uniq.set(a, true);
  return [...uniq.keys()].filter((a) => a.url || a.slug);
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
