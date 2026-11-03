// The branch brief: haiku names the side quest and writes its one-line
// "diverge" story — the same prompt the tmux lemux uses, run through the SDK.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { patchNode } from './tree.js';

const SYSTEM = `A side quest is being branched off a parent AI conversation. The user highlighted a passage of the assistant's message and/or typed a question, steering the exploration somewhere new. You write the branch's brief.

Your entire reply is one raw JSON object — it starts with { and ends with }, no fences, no commentary:
{"name": "...", "diverge": "..."}

"name" — a 1-4 word lowercase name for the branch.

"diverge" — ONE sentence, lowercase, no trailing period, 10-18 words, stating where this new exploration is heading. It opens with a motion verb chosen by the kind of move the user is making:
- doubting or stress-testing a claim → testing, probing, pressure-testing
- asking how or why something works → tracing, unpacking, untangling
- comparing options → weighing, pitting ... against ...
- drilling into a term or detail → digging into, zooming in on, pinning down
- sizing or benchmarking something → measuring, quantifying, simulating
- wandering to a related topic → peeling off to, chasing, circling back to

Rules:
- the sentence must read as natural english after its opening verb
- the highlight and question choose the destination: resolve what the highlighted phrase refers to and make that — asked about the way the user asked about it — your sentence's subject; no code or formulas
- the rest of the assistant response only exists to decode references; a topic it covers that the highlight and question do not touch must not appear in your sentence
- the sentence must stand alone: the user re-reads it days later without the conversation, so spell the referent out in plain words — never echo a bare heading or shorthand like "the split" or "this part" whose meaning lives in the parent conversation
- forward-looking: the direction of travel, never a summary of what the assistant already said
- if the input lists earlier steps of this exploration, your sentence CONTINUES that story like the next storyteller in a relay — never restate an earlier step and never reuse its opening verb

Examples of good diverge lines (each from a different conversation):
- digging into how ramjet aircraft get off the ground when the engine is dead at standstill
- weighing eventual consistency against the strict ordering the checkout flow quietly assumes
- a continuation: after "untangling why the borrow checker rejects the iterator rewrite", the next branch wrote: chasing lifetime annotations that could convince it — or a restructure that sidesteps them`;

export type BriefInput = { ctx: string; excerpt?: string; question?: string; chain: string[] };

export async function brief(id: string, b: BriefInput): Promise<void> {
  const parts = [`A side quest is being branched from this assistant response:\n"${b.ctx}"`];
  if (b.excerpt) parts.push(`The user highlighted: "${b.excerpt}"`);
  if (b.question) parts.push(`Their question: "${b.question}"`);
  if (b.chain.length) parts.push(`Earlier steps of this exploration, oldest first:\n${b.chain.map((l) => `- ${l}`).join('\n')}`);
  let text = '';
  try {
    for await (const m of query({
      prompt: parts.join('\n'),
      options: {
        model: 'claude-haiku-4-5',
        systemPrompt: SYSTEM,
        tools: [],
        maxTurns: 1,
        persistSession: false,
        settingSources: [],
        permissionMode: 'default',
      },
    })) {
      if (m.type === 'result' && m.subtype === 'success') text = m.result;
    }
  } catch { return; }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return;
  try {
    const j = JSON.parse(m[0]);
    const name = String(j.name || '').replace(/[^A-Za-z0-9 -]/g, '').trim().split(/\s+/).slice(0, 4).join(' ');
    const diverge = String(j.diverge || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    if (!name && !diverge) return;
    patchNode(id, { ...(name ? { name } : {}), diverge });
  } catch { /* unparseable — placeholder name stays */ }
}

// A fresh topic also gets a name: a few words for its first prompt.
export async function topicName(prompt: string): Promise<string> {
  let text = '';
  try {
    for await (const m of query({
      prompt,
      options: {
        model: 'claude-haiku-4-5',
        systemPrompt: 'The user is starting a new conversation with the message below. Reply with ONLY a 1-4 word lowercase title for that conversation. No punctuation, no quotes, nothing else.',
        tools: [], maxTurns: 1, persistSession: false, settingSources: [], permissionMode: 'default',
      },
    })) {
      if (m.type === 'result' && m.subtype === 'success') text = m.result;
    }
  } catch { return ''; }
  return text.replace(/[^A-Za-z0-9 -]/g, '').trim().split(/\s+/).slice(0, 4).join(' ');
}
