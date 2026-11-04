// The person's layer over cc's nodes, and the pure reducer that changes it.
// No I/O here: the server reads the state off the node, applies the ops, and
// writes it back; tests feed states and ops straight in.

export type UserNode = {
  id: string;
  kind: 'note' | 'img' | 'file';
  q: string;
  text?: string;
  path?: string;
  x: number;
  y: number;
};
export type Frame = { id: string; x: number; y: number; w: number; h: number; lbl: string };
export type Link = { a: string; b: string; lbl?: string };
export type Point = { x: number; y: number };

export type CanvasState = {
  pos: Record<string, Point>;
  frames: Frame[];
  links: Link[]; // the person's own links (cc's come from the transcript)
  unlinks: { a: string; b: string }[]; // cc links the person removed
  notes: UserNode[];
  removed: string[]; // cc nodes the person deleted (the taste signal)
  removedQ: string[]; // their captions, for the reminder
  history: string[]; // undo stack of JSON snapshots of this state
};

export type CanvasOp =
  | { op: 'move'; pos: Record<string, Point> }
  | { op: 'frame'; frame: { id?: string; x: number; y: number; w: number; h: number; lbl?: string } }
  | { op: 'unframe'; id: string }
  | { op: 'link'; a: string; b: string; lbl?: string }
  | { op: 'unlink'; a: string; b: string }
  | {
      op: 'note';
      note: {
        id?: string;
        kind?: string;
        q?: string;
        text?: string | null;
        path?: string;
        x?: number;
        y?: number;
      };
    }
  | { op: 'unnote'; id: string }
  | { op: 'remove'; ids?: string[]; id?: string; q?: string }
  | { op: 'restore'; id: string }
  | { op: 'undo' };

export const HISTORY_LIMIT = 40;
export const REMOVED_CAPTIONS_KEPT = 10;

export function blankCanvas(): CanvasState {
  return {
    pos: {},
    frames: [],
    links: [],
    unlinks: [],
    notes: [],
    removed: [],
    removedQ: [],
    history: [],
  };
}

// A stored state may predate a field; fill what is missing.
export function canvasOf(stored: Partial<CanvasState> | undefined): CanvasState {
  return { ...blankCanvas(), ...(stored || {}) };
}

export const collapse = (s: string) =>
  s
    .replace(/[\n\t\r]+/g, ' ')
    .replace(/ +/g, ' ')
    .trim();

const samePair = (l: { a: string; b: string }, a: string, b: string) =>
  (l.a === a && l.b === b) || (l.a === b && l.b === a);

export type ApplyOptions = {
  noHistory?: boolean; // a quiet change (a drag in progress) that undo should not step through
  newId?: () => string; // injectable for tests
};
export type ApplyResult = { state: CanvasState; changed: boolean; undone?: boolean };

// Apply ops in order to a copy of the state. An undo op restores the previous
// snapshot and ends the batch; otherwise one snapshot is pushed for the batch.
export function applyOps(state: CanvasState, ops: CanvasOp[], opts: ApplyOptions = {}): ApplyResult {
  const c = structuredClone(state);
  const newId = opts.newId ?? (() => Math.random().toString(36).slice(2, 10));
  const snap = JSON.stringify({ ...c, history: [] });
  let changed = false;
  for (const o of ops) {
    if (o.op === 'undo') {
      const prev = c.history.pop();
      if (!prev) return { state: c, changed: false, undone: false };
      const restored = JSON.parse(prev) as Omit<CanvasState, 'history'>;
      return { state: { ...restored, history: c.history }, changed: true, undone: true };
    }
    changed = applyOne(c, o, newId) || changed;
  }
  if (changed && !opts.noHistory) {
    c.history.push(snap);
    if (c.history.length > HISTORY_LIMIT) c.history.shift();
  }
  return { state: c, changed };
}

function applyOne(c: CanvasState, o: Exclude<CanvasOp, { op: 'undo' }>, newId: () => string): boolean {
  switch (o.op) {
    case 'move':
      for (const [id, pt] of Object.entries(o.pos || {}))
        c.pos[id] = { x: Math.round(pt.x), y: Math.round(pt.y) };
      return true;
    case 'frame': {
      const i = c.frames.findIndex((f) => f.id === o.frame.id);
      const f: Frame = {
        id: String(o.frame.id || newId()),
        x: Math.round(o.frame.x),
        y: Math.round(o.frame.y),
        w: Math.round(o.frame.w),
        h: Math.round(o.frame.h),
        lbl: collapse(String(o.frame.lbl || 'section')).slice(0, 60),
      };
      if (i >= 0) c.frames[i] = f;
      else c.frames.push(f);
      return true;
    }
    case 'unframe':
      c.frames = c.frames.filter((f) => f.id !== o.id);
      return true;
    case 'link':
      if (!c.links.some((l) => samePair(l, o.a, o.b)))
        c.links.push({ a: o.a, b: o.b, lbl: o.lbl ? collapse(o.lbl).slice(0, 40) : undefined });
      c.unlinks = c.unlinks.filter((u) => !samePair(u, o.a, o.b));
      return true;
    case 'unlink':
      c.links = c.links.filter((l) => !samePair(l, o.a, o.b));
      if (!c.unlinks.some((u) => samePair(u, o.a, o.b))) c.unlinks.push({ a: o.a, b: o.b });
      return true;
    case 'note': {
      const i = c.notes.findIndex((x) => x.id === o.note.id);
      const was = i >= 0 ? c.notes[i] : undefined;
      const kind = o.note.kind === 'img' || o.note.kind === 'file' ? o.note.kind : 'note';
      const u: UserNode = {
        id: String(o.note.id || 'u-' + newId().slice(0, 8)),
        kind,
        q: collapse(String(o.note.q || 'Untitled note')).slice(0, 80),
        text: o.note.text != null ? String(o.note.text).slice(0, 4000) : was?.text || '',
        path: o.note.path || was?.path,
        x: Math.round(o.note.x ?? was?.x ?? 60),
        y: Math.round(o.note.y ?? was?.y ?? 60),
      };
      if (was) c.notes[i] = u;
      else c.notes.push(u);
      return true;
    }
    case 'unnote':
      c.notes = c.notes.filter((x) => x.id !== o.id);
      return true;
    case 'remove': {
      for (const id of o.ids || (o.id ? [o.id] : [])) {
        if (c.notes.some((x) => x.id === id)) {
          c.notes = c.notes.filter((x) => x.id !== id);
          continue;
        }
        if (!c.removed.includes(id)) {
          c.removed.push(id);
          if (o.q) c.removedQ.push(String(o.q).slice(0, 60));
        }
      }
      c.removedQ = c.removedQ.slice(-REMOVED_CAPTIONS_KEPT);
      return true;
    }
    case 'restore':
      c.removed = c.removed.filter((id) => id !== o.id);
      return true;
  }
}
