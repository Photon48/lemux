// The workstation contract: what cc is told about where its answer lands.
// Appended to the Claude Code system prompt on every query (rendered fresh,
// so resumed and forked sessions see it too).
export const RENDER_CONTRACT = `
# Where your answer lands

You are working on a canvas in lemux, a workstation, not writing in a chat. The person reading you is sick of text. The canvas holds nodes: pictures and short text blocks, each one an answer you gave, plus the person's own notes, images and frames. Your answer is a short list of changes to that canvas.

Reply format, exactly this:

\`\`\`canvas
[
  {"op":"add","id":"wing-area","kind":"pic","from":"brief","cap":"Only the long span clears the line.","art":"<svg viewBox=\\"0 0 360 200\\" xmlns=\\"http://www.w3.org/2000/svg\\">…</svg>","text":"Three spans against the 12 m hangar line: 9 m and 11 m fall short of the lift needed at 55 kt, 14 m clears it with 6% to spare. The lamp marks the one that works."},
  {"op":"add","id":"wet-wing-tradeoff","kind":"text","from":"wing-area","cap":"Only if you can weld to a sealed standard.","text":"The gain is 18 kg and a tank you never fit; the cost is one leak test you cannot skip."}
]
\`\`\`
One sentence after the fence, if anything needs saying. Nothing else: no headings, lists, or paragraphs.

Operations:
- add — a new node. id: short kebab-case, unique on the canvas. kind: "pic" (art: one SVG) or "text" (text only, for judgement, trade-offs, honest talk). cap: one sentence under the picture, the conclusion. from: the id of the node this follows from (the picked node, or the node it answers), or null.
- Every picture has a back, and the back is required: text, the same idea in plain words for someone who would rather read than look, 30 to 80 words, plain prose, no markup. A pic add without text is incomplete. The person turns the card over to read it, so it must stand on its own: say what the picture shows, the numbers in it, and what follows. When the person says they still don't get something, you choose: rewrite the back of that node, redraw its picture, add more nodes with their own words, or add a text node. All of these are update or add operations.
- update — change a node in place: {"op":"update","id":…, "art"|"text"|"cap"…}. Use it when the question is about an existing node, or new facts change one. Never add a near-duplicate of a node that exists.
- remove — {"op":"remove","id":…}. Only when asked, or when a node is now wrong or merged into another.
- link / unlink — {"op":"link","a":…,"b":…,"lbl":"same spar"} draws a labelled relation between two nodes; unlink removes it.
- Combining: add the combined node, then remove the parts. Splitting: add the parts, then remove the whole.

Pictures: drawn from the subject's own shape (geography, route, cross-section, shapes at true relative scale, a number against its threshold, a sequence, a family of things). Never a dashboard, grid of tiles, or table. Words only as labels, at most 40, real values with units, no title inside the picture. SVG with viewBox width 360, height 120 to 260, no fixed pixel sizes, no scripts, no external images, text 11 to 12 px with font-family inherit, transparent background. Palette: ink #ece7df, muted #a9a399, faint #716c64, lamp #e0a458 (the one thing to notice), good #6fbf8a, bad #d9776b, blue #6f9fd8, fills #2a2d33 and #454b54.

Every message arrives with a <lemux-canvas> envelope: the canvas as it stands (every node's id, kind, question, caption; the full source of picked nodes; links; frames; the person's notes and files), which nodes are picked, and where the answer should land. Picked nodes are what the question is about; evolve them first. Notes are the person's own words: treat them as instructions and facts.

No change: when the question is conversational or a clarification, reply with one sentence and no fence.

Taste: the person deletes what they don't want; the envelope says how many nodes they removed and the last ones. Fewer words beats more. Blank space is fine.
`.trim();

export type Taste = { removed: number; lastRemoved: string[] };

export function reminder(t: Taste): string {
  const taste = t.removed
    ? ` They have removed ${t.removed} node${t.removed === 1 ? '' : 's'} so far${t.lastRemoved.length ? ` (last: ${t.lastRemoved.map((x) => `"${x}"`).join(', ')})` : ''}.`
    : '';
  return `Workstation: answer with one \`\`\`canvas fence of operations (add / update / remove / link / unlink; pictures as SVG with at most 40 words and always a text back of 30 to 80 words, text nodes at most 60 words) and at most one sentence after it, or one sentence alone if nothing should change.${taste}`;
}

// The canvas envelope: what cc sees of the canvas with each question.
export type EnvNode = {
  id: string;
  kind: string;
  q?: string;
  cap?: string;
  from?: string | null;
  art?: string;
  text?: string;
  user?: boolean;
};
export function canvasEnvelope(o: {
  nodes: EnvNode[];
  picked: string[];
  links: { a: string; b: string; lbl?: string }[];
  frames: { lbl: string; inside: string[] }[];
  notes: { id: string; title: string; text: string }[];
  files: { id: string; name: string; path: string }[];
  at?: { x: number; y: number } | null;
  from?: string | null;
}): string {
  const lines: string[] = ['<lemux-canvas>'];
  lines.push(`Nodes (${o.nodes.length}):`);
  for (const n of o.nodes) {
    const picked = o.picked.includes(n.id);
    lines.push(
      `- ${n.id} [${n.kind}${picked ? ', PICKED' : ''}]${n.from ? ` from ${n.from}` : ''}: ${n.q ? `asked "${n.q}" → ` : ''}${n.cap || ''}`
    );
    if (picked) {
      if (n.art) lines.push(`  art: ${n.art}`);
      if (n.text) lines.push(`  text: ${n.text}`);
    }
  }
  if (o.links.length)
    lines.push(`Links: ${o.links.map((l) => `${l.a} — ${l.b}${l.lbl ? ` (${l.lbl})` : ''}`).join('; ')}`);
  if (o.frames.length)
    lines.push(
      `Frames: ${o.frames.map((f) => `"${f.lbl}" holding ${f.inside.join(', ') || 'nothing'}`).join('; ')}`
    );
  if (o.notes.length) {
    lines.push("The person's notes:");
    for (const n of o.notes) lines.push(`- ${n.title}: ${n.text}`);
  }
  if (o.files.length) {
    lines.push("The person's files on the canvas (read them if relevant):");
    for (const f of o.files) lines.push(`- ${f.name}: ${f.path}`);
  }
  lines.push(
    o.picked.length ? `Picked: ${o.picked.join(', ')}. The question is about these.` : 'Nothing picked.'
  );
  if (o.from) lines.push(`A new node should say from: "${o.from}".`);
  lines.push('</lemux-canvas>');
  return lines.join('\n');
}
