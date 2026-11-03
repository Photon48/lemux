// Running sessions through the Claude Agent SDK. One query() per prompt;
// follow-ups resume the same session id, side quests fork the parent.
import {
  query,
  type Query,
  type SDKMessage,
  type PermissionResult,
  type PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import { clearNotify } from './tree.js';
import { RENDER_CONTRACT } from './widgets.js';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// the claude the terminal runs, not the copy bundled with the SDK
const CLAUDE_BIN =
  process.env.LEMUX_CLAUDE ||
  (() => {
    try {
      return (
        execSync('command -v claude', { encoding: 'utf8', shell: '/bin/zsh' }).trim() ||
        path.join(os.homedir(), '.local/bin/claude')
      );
    } catch {
      return path.join(os.homedir(), '.local/bin/claude');
    }
  })();

export type State = 'idle' | 'busy' | 'waiting' | 'done' | 'error';

export type Event =
  | { type: 'state'; sid: string; state: State }
  | { type: 'user'; sid: string; text: string }
  | { type: 'delta'; sid: string; text: string }
  | { type: 'assistant'; sid: string; blocks: unknown[] }
  | { type: 'tool_result'; sid: string; toolUseId: string; text: string; isError: boolean }
  | { type: 'result'; sid: string; ok: boolean; error?: string; costUsd?: number; durationMs?: number }
  | {
      type: 'permission';
      sid: string;
      reqId: string;
      tool: string;
      input: unknown;
      suggestions: PermissionUpdate[];
      canAlways: boolean;
    }
  | { type: 'permission_resolved'; sid: string; reqId: string }
  | { type: 'error'; sid: string; message: string };

type Pending = {
  resolve: (r: PermissionResult) => void;
  tool: string;
  input: unknown;
  suggestions: PermissionUpdate[];
};

type Live = { q: Query; pending: Map<string, Pending> };

const live = new Map<string, Live>();
const states = new Map<string, State>();
const listeners = new Set<(e: Event) => void>();

export function onEvent(fn: (e: Event) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(e: Event) {
  for (const fn of listeners) fn(e);
}

function setState(sid: string, s: State) {
  states.set(sid, s);
  emit({ type: 'state', sid, state: s });
}

export function stateOf(sid: string): State | undefined {
  return states.get(sid);
}
export function isLive(sid: string): boolean {
  return live.has(sid);
}
export function pendingPermissions(sid: string): Event[] {
  const l = live.get(sid);
  if (!l) return [];
  return [...l.pending.entries()].map(([reqId, p]) => ({
    type: 'permission',
    sid,
    reqId,
    tool: p.tool,
    input: p.input,
    suggestions: p.suggestions,
    canAlways: p.suggestions.length > 0,
  }));
}

// The user opened the session — whatever it was flagging, they saw it.
export function acknowledge(sid: string) {
  clearNotify(sid);
  const s = states.get(sid);
  if (s === 'done' || s === 'error') setState(sid, 'idle');
}

let reqCounter = 0;

export type RunOpts = {
  sid: string;
  dir: string;
  prompt: string;
  display?: string; // what to echo to the UI (prompt minus injected context)
  fork?: { parent: string };
  fresh?: boolean; // brand-new session (no resume)
  reminder: string; // the per-turn note that rides beside the message
};

export async function run(o: RunOpts): Promise<void> {
  if (live.has(o.sid)) throw new Error('session is busy');
  const pending = new Map<string, Pending>();

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    opts: { suggestions?: PermissionUpdate[] }
  ): Promise<PermissionResult> => {
    const reqId = `p${++reqCounter}`;
    const suggestions = opts.suggestions ?? [];
    setState(o.sid, 'waiting');
    return new Promise<PermissionResult>((resolve) => {
      pending.set(reqId, { resolve, tool: toolName, input, suggestions });
      emit({
        type: 'permission',
        sid: o.sid,
        reqId,
        tool: toolName,
        input,
        suggestions,
        canAlways: suggestions.length > 0,
      });
    }).finally(() => {
      pending.delete(reqId);
      emit({ type: 'permission_resolved', sid: o.sid, reqId });
      if (live.has(o.sid)) setState(o.sid, 'busy');
    });
  };

  const q = query({
    prompt: o.prompt,
    options: {
      cwd: o.dir,
      ...(o.fresh
        ? { sessionId: o.sid }
        : o.fork
          ? { resume: o.fork.parent, forkSession: true, sessionId: o.sid }
          : { resume: o.sid }),
      includePartialMessages: true,
      canUseTool,
      // behave like the terminal — and like `cc`, the user's alias for
      // `claude --dangerously-skip-permissions`: same binary, same system
      // prompt, same settings, CLAUDE.md and MCP servers, no permission prompts
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      // snapshot: false — a resumed or forked session would otherwise reuse the
      // system prompt recorded at its first request, without the contract
      systemPrompt: { type: 'preset', preset: 'claude_code', append: RENDER_CONTRACT, snapshot: false },
      settingSources: ['user', 'project', 'local'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              () =>
                Promise.resolve({
                  hookSpecificOutput: {
                    hookEventName: 'UserPromptSubmit' as const,
                    additionalContext: o.reminder,
                  },
                }),
            ],
          },
        ],
      },
    },
  });

  live.set(o.sid, { q, pending });
  setState(o.sid, 'busy');
  emit({ type: 'user', sid: o.sid, text: o.display ?? o.prompt });

  let ok = false;
  let error: string | undefined;
  let costUsd: number | undefined;
  let durationMs: number | undefined;
  try {
    for await (const m of q as AsyncIterable<SDKMessage>) {
      if (m.type === 'stream_event') {
        const ev: any = m.event;
        if (
          ev?.type === 'content_block_delta' &&
          ev.delta?.type === 'text_delta' &&
          m.parent_tool_use_id === null
        ) {
          emit({ type: 'delta', sid: o.sid, text: ev.delta.text });
        }
      } else if (m.type === 'assistant') {
        if (m.parent_tool_use_id !== null) continue; // subagent chatter stays out of the pane
        const blocks = (m.message.content as any[]).filter((b) => b.type === 'text' || b.type === 'tool_use');
        if (blocks.length) emit({ type: 'assistant', sid: o.sid, blocks });
      } else if (m.type === 'user') {
        if (m.parent_tool_use_id !== null) continue;
        const c = (m as any).message?.content;
        if (Array.isArray(c)) {
          for (const b of c) {
            if (b?.type === 'tool_result') {
              const text =
                typeof b.content === 'string'
                  ? b.content
                  : Array.isArray(b.content)
                    ? b.content.map((x: any) => (x?.type === 'text' ? x.text : '')).join('\n')
                    : '';
              emit({
                type: 'tool_result',
                sid: o.sid,
                toolUseId: b.tool_use_id,
                text: text.slice(0, 1200),
                isError: !!b.is_error,
              });
            }
          }
        }
      } else if (m.type === 'result') {
        ok = m.subtype === 'success';
        costUsd = (m as any).total_cost_usd;
        durationMs = (m as any).duration_ms;
        if (!ok) error = (m as any).errors?.join('\n') || m.subtype;
      }
    }
  } catch (e: any) {
    error = error || e?.message || String(e);
    emit({ type: 'error', sid: o.sid, message: error! });
  } finally {
    live.delete(o.sid);
    for (const p of pending.values()) p.resolve({ behavior: 'deny', message: 'session ended' });
    emit({ type: 'result', sid: o.sid, ok, error, costUsd, durationMs });
    setState(o.sid, ok ? 'done' : 'error');
  }
}

export function answerPermission(
  sid: string,
  reqId: string,
  reply:
    | { kind: 'allow'; always?: boolean }
    | { kind: 'deny'; message?: string }
    | { kind: 'answers'; answers: Record<string, string>; response?: string }
): boolean {
  const l = live.get(sid);
  const p = l?.pending.get(reqId);
  if (!p) return false;
  if (reply.kind === 'deny')
    p.resolve({ behavior: 'deny', message: reply.message || 'The user declined this action' });
  else if (reply.kind === 'answers')
    p.resolve({
      behavior: 'allow',
      updatedInput: {
        ...(p.input as object),
        answers: reply.answers,
        ...(reply.response ? { response: reply.response } : {}),
      },
    });
  else
    p.resolve({
      behavior: 'allow',
      updatedInput: p.input as Record<string, unknown>,
      ...(reply.always
        ? {
            updatedPermissions: p.suggestions.filter(
              (s: any) => s.destination === 'localSettings' || s.destination === 'userSettings'
            ),
          }
        : {}),
    });
  return true;
}

export async function interrupt(sid: string): Promise<boolean> {
  const l = live.get(sid);
  if (!l) return false;
  for (const p of l.pending.values())
    p.resolve({ behavior: 'deny', message: 'The user stopped the session', interrupt: true });
  try {
    await l.q.interrupt();
  } catch {
    /* already finishing */
  }
  return true;
}
