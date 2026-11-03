# lemux

**A session manager for coding agents.** Side quests, supervision, digest and
archives — for your Claude Code sessions, from tmux.

<p align="center">
  <img src="assets/demo.gif" width="820"
       alt="Highlighting a line in an answer, hitting prefix+B, and the side quest opening in its own window with the full parent conversation behind it.">
</p>

```sh
curl -fsSL https://raw.githubusercontent.com/Photon48/lemux/main/install.sh | bash
```

Needs `tmux` ≥ 3.2, `fzf` ≥ 0.48, `jq`, `claude`. Then run claude in tmux, any
way you already do.

---

### 1 · Side quests

<img src="assets/feature-branch.svg" width="820" alt="Two sessions side by side. In the main session a highlighted line; an arrow labelled fork leads to the side quest, which contains every message of the main session copied in, ghosted, with your new question below them.">

Works on any claude session already running in tmux — nothing to launch
differently. Side quests nest, so you can branch a side quest, and each one
gets a name and a one-line brief written for it as it opens.

### 2 · Supervision

<img src="assets/feature-supervise.svg" width="820" alt="The tree navigator listing a topic's sessions with live status: done, waiting on user, running.">

Flags outlive their window and clear the moment you arrive, so a session that
finished an hour ago while you were elsewhere is still holding its hand up.

### 3 · Digest

<img src="assets/feature-digest.svg" width="820" alt="Digest: before, 498,140 tokens of tool calls, file dumps, test output and images. After, 58,910 tokens holding every prompt and every reply. 8.5x less context, 11.2 MB down to 235 KB on disk.">

Your numbers appear before anything is written, read from the API's own usage
records. Nothing happens until you press enter, and the whole tree is rewritten
at once — the root and every side quest under it.

### 4 · Archives

<img src="assets/feature-archives.svg" width="820" alt="The archives timeline: each digest keeps the tree it replaced, oldest to newest, ending in the live copy.">

`rm` will not delete an archived transcript, the way it won't delete a root.
Digest as often as you like; the chain just gets longer.

---

| Keys | |
|---|---|
| `prefix + B` | branch on the text you copied |
| `prefix + T` | tree — `enter` jump · `ctrl-d` digest · `tab` archives · `ctrl-r` rename · `ctrl-x` delete |
| `prefix + X` | delete this branch + subtree |

<details>
<summary><b>In the browser</b></summary>

The workstation: the same sessions and transcripts, for someone who is sick of
text. A session is a canvas. Each answer cc gives is a change to that canvas:
a new node (a picture or a short block of words, its choice), a node changed
in place, one removed, or a link between two. You arrange the nodes, frame
them, write your own notes among them, and the conversation itself is folded
into a tiny drawer at the bottom.

```sh
cd web && npm install && npm start     # → http://localhost:4321
```

- **Canvases** are the sessions of a project, nested as they were branched.
  *+ new* opens an empty canvas; the first question draws its first nodes.
- **Ask** from the bar, or pick a spot with the Ask tool and the answer lands
  there, or pull the ● on a node out into space to ask from it. Pick nodes
  first and the question is about them; cc gets their full source.
- **Dive** by double-clicking a node: a side quest with the whole conversation
  behind it and its own canvas, starting from that node. The node becomes a
  portal; the parent never changes.
- **Yours:** notes (titled, editable, read by cc when you ask), frames (named,
  movable, resizable; one named *later* sets aside what you drop in it),
  images and files dropped in (saved under the project's `.lemux/files`),
  links drawn between nodes, positions, folds. Delete is the taste signal: cc
  is told what you removed.
- **Find** searches every canvas in the project. Undo covers your own changes.
- Two fingers drag to pan, pinch to zoom; Select is the default tool, Pan is
  on the rail.

cc is told all this through a contract appended to its system prompt and a
canvas envelope with every question: every node's id, kind, question and
caption, the picked nodes' sources, links, frames, your notes and files. It
answers with a fenced list of operations that the app replays from the
transcript; your own layer is stored on the session in `~/.lemux/tree.json`.
Sessions run through the Claude Agent SDK with your installed claude and the
same settings as `claude --dangerously-skip-permissions`. The tmux side still
shows the same answers as fenced JSON. Needs Node ≥ 20. Digest and archives are
terminal-only.

Working on it: `npm run check` in `web/` runs the typecheck, eslint, the
prettier check and the tests (`node:test`, no browser needed). Point the server
at a scratch tree while you poke at it so the real one stays untouched:
`LEMUX_DIR=/tmp/lemux-scratch PORT=4399 npm start`. The server is `server/`
(one module per concern, every request body parsed by a zod schema in
`schemas.ts`), the page is `public/js/` (ES modules, no build step).

</details>

<details>
<summary><b>How it works</b></summary>

One bash script over things that already exist — no daemon, no database, no
wrapper around the agent:

- Claude Code stores every session as a JSONL transcript and supports
  `--resume <id> --fork-session`. A fork is a full snapshot copy under a new
  session ID; the parent is never touched.
- tmux provides the windows, the text selection, and the popups.
- fzf renders the tree.

State is one file, `~/.lemux/tree.json`: per session, its parent, the excerpt
it branched on, and its tmux window. A `SessionStart` hook makes every claude
session tag its pane as it starts — that's why anything running in tmux is
branchable with zero ceremony.

</details>

<details>
<summary><b>Digest — what it keeps, and the numbers</b></summary>

Text is the whole rule: any content block that isn't prose is dropped, images
included. What survives is what you'd get by reading the conversation back.

A transcript is a *tree*, not a list — retries, edited messages and `/clear`
leave abandoned branches in the file. Digest walks `parentUuid` back from the
newest leaf and keeps only that chain. On a real session that dropped 33% of
records as dead ends.

Measured on an 11.2 MB session by resuming each and reading the API's own
token usage:

| | tokens loaded |
|---|---|
| the original | 498,140 |
| its digest | 58,910 |
| empty session, same repo (system prompt, tools, MCP, CLAUDE.md) | 24,003 |

So the entire conversation is ~35k tokens; the other 460k was tool traffic and
screenshots. The popup shows your real numbers before writing anything, and
commits only on `enter`.

Digesting archives the old tree rather than deleting it. Archives are detached
from the working tree and stacked on a timeline behind `tab`; `rm` spares
archived transcripts the way it spares roots, and untracking a topic takes its
whole timeline with it.

</details>

<details>
<summary><b>Topics, windows, and pruning</b></summary>

Every session announces itself as it starts; the first branch (`prefix + B`)
enrols it as a topic root named after its folder. Topics are scoped per folder,
like `claude --resume`.

Open windows follow a one-window discipline: a topic only ever has the session
you're inside open. Branching closes the parent behind you; jumping in the tree
closes everything else. The tree and every transcript survive pruning, so
anything closed is one `prefix + T`, enter away. Exiting claude (ctrl-c) leaves
you at a shell in that window — nothing else closes.

Pruning never kills a session that's busy or waiting on you. One known gap:
Esc-cancelling a permission dialog emits no event, so that session stays
"waiting" — spared — until you next interact with it.

`prefix + T` only ever shows the tree you're in: from any window you see that
root and its descendants, never another topic's branches.

</details>

<details>
<summary><b>Install details, updating, uninstall</b></summary>

`install.sh` fetches the script and hands off to `lemux setup`, which copies
`lemux` to `~/.local/bin`, writes keybindings into `~/.tmux.conf`, merges
lifecycle hooks into `~/.claude/settings.json` (your own settings untouched),
and reloads tmux. All idempotent.

Update from a checkout with `git pull && ./lemux setup`; curl users re-run the
one-liner. Uninstall by deleting `~/.local/bin/lemux`, the `>>> lemux >>>`
block in `~/.tmux.conf`, the lemux hook entries in `~/.claude/settings.json`,
and `~/.lemux`.

Sessions already running when you install haven't announced themselves — the
hook only fires on launch, so restart claude in that pane (`claude --continue`
picks up where you were).

</details>

<details>
<summary><b>Notes</b></summary>

- **Deleting**: `rm` on a branch takes its window, transcript and subtree.
  `rm` on a topic name untracks it but always keeps the root transcript.
- **Forks are cheap**: a fork shares its full prefix with the parent, so the
  first message usually hits the prompt cache.
- **Excerpts** come from the system clipboard (`pbpaste`), falling back to
  tmux's paste buffer. Branches open as full-width windows — never splits — so
  mouse selection can't pick up a neighbouring pane.
- **Big copies** show as first words plus a `⟨N lines copied⟩` badge; the seed
  keeps the first 600 characters.
- The pre-fill waits for claude's UI to render (up to ~15s) and never presses
  enter, so nothing is auto-submitted.

</details>
