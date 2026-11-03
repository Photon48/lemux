// The boundaries: what the page sends the server, and what cc and haiku
// write back. Everything crossing one is parsed here, once, into a type the
// rest of the server can trust.
import { z } from 'zod';
import type { CanvasOp } from './canvas.js';

const id = z.string().min(1);
const point = z.object({ x: z.number(), y: z.number() });

// ---------- the person's changes to a canvas ----------
export const CanvasOpSchema: z.ZodType<CanvasOp> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('move'), pos: z.record(z.string(), point) }),
  z.object({
    op: z.literal('frame'),
    frame: z.object({
      id: z.string().optional(),
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      lbl: z.string().optional(),
    }),
  }),
  z.object({ op: z.literal('unframe'), id }),
  z.object({ op: z.literal('link'), a: id, b: id, lbl: z.string().optional() }),
  z.object({ op: z.literal('unlink'), a: id, b: id }),
  z.object({
    op: z.literal('note'),
    note: z.object({
      id: z.string().optional(),
      kind: z.string().optional(),
      q: z.string().optional(),
      text: z.string().nullable().optional(),
      path: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
  }),
  z.object({ op: z.literal('unnote'), id }),
  z.object({
    op: z.literal('remove'),
    ids: z.array(z.string()).optional(),
    id: z.string().optional(),
    q: z.string().optional(),
  }),
  z.object({ op: z.literal('restore'), id }),
  z.object({ op: z.literal('fold'), id, on: z.boolean() }),
  z.object({ op: z.literal('aside'), id, on: z.boolean() }),
  z.object({ op: z.literal('undo') }),
]);

const CanvasPostEnvelope = z.object({
  ops: z.array(CanvasOpSchema).optional(),
  noHistory: z.boolean().optional(),
  quiet: z.boolean().optional(),
});
export type CanvasPost = { ops: CanvasOp[]; noHistory: boolean; quiet: boolean };

// A batch { ops: [...] } or a single op, either with the flags beside it.
export function parseCanvasPost(body: unknown): CanvasPost {
  const e = CanvasPostEnvelope.parse(body);
  return { ops: e.ops ?? [CanvasOpSchema.parse(body)], noHistory: !!e.noHistory, quiet: !!e.quiet };
}

// ---------- the other requests ----------
export const ProjectBody = z.object({ dir: z.string() });
export const SendBody = z.object({
  sid: id,
  text: z.string(),
  scope: z.enum(['last', 'whole', 'brief']).catch('last'),
  picked: z.array(z.string()).default([]),
  at: point.nullable().default(null),
  from: z.string().nullable().default(null),
});
export type Scope = z.infer<typeof SendBody>['scope'];
export const BranchBody = z.object({ parent: id, node: id, question: z.string().default('') });
export const NewBody = z.object({ dir: z.string(), text: z.string(), name: z.string().default('') });
export const RenameBody = z.object({ id, name: z.string() });
export const IdBody = z.object({ id });
export const SidBody = z.object({ sid: id });
export const AdoptBody = z.object({ id, dir: z.string() });
export const UploadBody = z.object({ sid: id, name: z.string().default('file'), data: z.string() });
export const PermissionReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allow'), always: z.boolean().optional() }),
  z.object({ kind: z.literal('deny'), message: z.string().optional() }),
  z.object({
    kind: z.literal('answers'),
    answers: z.record(z.string(), z.string()),
    response: z.string().optional(),
  }),
]);
export type PermissionReply = z.infer<typeof PermissionReplySchema>;
export const PermissionBody = z.object({ sid: id, reqId: z.string(), reply: PermissionReplySchema });

// ---------- files on disk ----------
export const ProjectsFile = z.array(z.string());

// ---------- what cc writes in a ```canvas fence ----------
// A field cc got wrong is dropped; an op it got wrong is skipped; the rest lands.
const loose = z.string().optional().catch(undefined);
export const FenceOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    id,
    kind: loose,
    cap: loose,
    art: loose,
    text: loose,
    from: z.string().nullable().optional().catch(undefined),
  }),
  z.object({ op: z.literal('update'), id, kind: loose, cap: loose, art: loose, text: loose }),
  z.object({ op: z.literal('remove'), id, rewireTo: loose }),
  z.object({ op: z.literal('link'), a: id, b: id, lbl: loose }),
  z.object({ op: z.literal('unlink'), a: id, b: id }),
]);
export type FenceOp = z.infer<typeof FenceOpSchema>;

// The fence body as ops. A trailing comma is forgiven; anything else that
// does not parse as a list is no ops at all.
export function parseFenceOps(src: string): FenceOp[] {
  for (const s of [src, src.replace(/,\s*]$/, ']')]) {
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch {
      continue;
    }
    if (!Array.isArray(v)) return [];
    return v.flatMap((o: unknown) => {
      const r = FenceOpSchema.safeParse(o);
      return r.success ? [r.data] : [];
    });
  }
  return [];
}

// ---------- what the tools and haiku answer ----------
export const ArtifactResult = z
  .object({ title: z.string(), url: z.string(), slug: z.string(), version: z.string() })
  .partial();
export const BriefJson = z.object({ name: z.string().optional(), diverge: z.string().optional() });

// The first {...} in a reply, parsed against a schema; undefined when there is none or it does not fit.
export function jsonIn<T>(text: string, schema: z.ZodType<T>): T | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const r = schema.safeParse(JSON.parse(m[0]));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}
