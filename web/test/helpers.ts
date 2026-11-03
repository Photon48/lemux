// Fixture transcripts: a chain of user/assistant records written as a .jsonl
// file in a temp dir, the way Claude Code writes them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Rec = { type: 'user' | 'assistant'; text: string; ts?: string; isMeta?: boolean };

let n = 0;
export function writeTranscript(recs: Rec[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemux-test-'));
  const file = path.join(dir, `${++n}.jsonl`);
  const lines: string[] = [];
  let parent: string | null = null;
  recs.forEach((r, i) => {
    const uuid = `u${i}`;
    const content = r.type === 'user' ? r.text : [{ type: 'text', text: r.text }];
    lines.push(
      JSON.stringify({
        type: r.type,
        uuid,
        parentUuid: parent,
        timestamp: r.ts ?? new Date(1_700_000_000_000 + i * 60_000).toISOString(),
        isMeta: r.isMeta,
        message: { role: r.type, content },
      })
    );
    parent = uuid;
  });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

export const fence = (ops: unknown[], after = '') =>
  '```canvas\n' + JSON.stringify(ops) + '\n```' + (after ? '\n' + after : '');
