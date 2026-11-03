// Paths that arrive in requests are untrusted: resolve them before trusting a prefix.
import os from 'node:os';
import path from 'node:path';

export const expandHome = (p: string): string =>
  p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;

// True when `file`, once resolved, is `root` or lies beneath it. A prefix
// check on the raw string lets `root/../elsewhere` and `root2/…` through.
export function insideDir(file: string, root: string): boolean {
  const r = path.resolve(root);
  const f = path.resolve(file);
  return f === r || f.startsWith(r + path.sep);
}
