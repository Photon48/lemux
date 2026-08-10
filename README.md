# lemux

**A session manager for coding agents.** Branch, supervise, and un-bloat your
Claude Code sessions — from tmux.

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

### Branch a tangent instead of derailing the thread

<img src="assets/flow-trip.svg" width="820" alt="An answer mentions something worth chasing; you highlight it, prefix+B forks it into a side quest with the full parent context, and the main thread carries on untouched.">

Highlight → `prefix + B` → ask. Opens as a fork with the **whole** parent
conversation. Delete it after; nothing flows back.

### Get your context window back

<img src="assets/feature-digest.svg" width="820" alt="Digest: before, 498,140 tokens of tool calls, file dumps, test output and images. After, 58,910 tokens holding every prompt and every reply. 8.5x less context, 11.2 MB down to 235 KB on disk.">

`ctrl-d` rewrites the session as prose only — every prompt, every reply, no
tool traffic.

### See which agent needs you

<img src="assets/feature-supervise.svg" width="820" alt="The tree navigator listing a topic's sessions with live status: done, waiting on user, running.">

`prefix + T`. Status comes from Claude Code's lifecycle hooks — lemux never
closes a session that's working.

### Nothing is thrown away

<img src="assets/feature-archives.svg" width="820" alt="The archives timeline: each digest keeps the tree it replaced, oldest to newest, ending in the live copy.">

`tab` in the tree. Any generation reopens with its full tool-call history.

---

| Keys | |
|---|---|
| `prefix + B` | branch on the text you copied |
| `prefix + T` | tree — `enter` jump · `ctrl-d` digest · `tab` archives · `ctrl-r` rename · `ctrl-x` delete |
| `prefix + X` | delete this branch + subtree |

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
