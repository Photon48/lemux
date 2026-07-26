#!/usr/bin/env python3
"""Generate the README illustrations — one per audience, identical but for the example.

    python3 assets/make-illustrations.py

Each example is a moment where an answer mentions something worth chasing: you
highlight that bit, branch it, and the side quest answers with the whole parent
conversation behind it while the main thread carries on.

Mark the highlighted excerpt in `answer` with [[double brackets]].

Also emits tree-view-trip.svg: the prefix+T fzf navigator, list on the left,
preview (story-so-far briefs + the branched-on highlight and question) on the
right, with the selection cycling between two branches.
"""

import pathlib

CW, LH, FS = 7.8, 22, 13          # monospace advance, line height, font size
FG, DIM, GOLD, GREEN = "#c9d1d9", "#8b949e", "#f5c24b", "#7ee787"
CYAN = "#39c5cf"

EXAMPLES = [
    dict(
        slug="trip", title="japan trip",
        prompt="plan my 10 days in japan",
        answer="Day 2, Kyoto: Fushimi Inari at sunrise, then Arashiyama. "
               "Note: the [[JR Pass doesn't cover the Nozomi bullet trains]] "
               "— book the Hikari instead, same track…",
        next_prompt="ok — day 3, nara or osaka?",
        question="which trains can I take?",
        reply="With the pass you can ride the Hikari and Kodama — Hikari reaches "
              "Kyoto about 15 minutes later, for free",
    ),
    dict(
        slug="frontend", title="checkout page",
        prompt="why does my layout jump while loading?",
        answer="The product images have no width or height, so the browser can't "
               "reserve space. [[The webfont swap causes a second jump]] "
               "— that one needs a different fix…",
        next_prompt="ok, adding the dimensions now",
        question="which fix, and what does it cost me?",
        reply="font-display: optional. The tradeoff is that on a slow connection "
              "the webfont is skipped entirely for that visit",
    ),
    dict(
        slug="backend", title="orders api",
        prompt="/orders got slow after the migration",
        answer="Classic N+1 — each order re-queries its line items. Batch them with "
               "a join. [[Your connection pool is undersized too]], 5 connections "
               "across 4 workers…",
        next_prompt="let me fix the N+1 first",
        question="how do I size the pool properly?",
        reply="Start from the database's max_connections, divide by worker count, "
              "then leave headroom for migrations and admin",
    ),
    dict(
        slug="science", title="assay results",
        prompt="is the treatment effect significant?",
        answer="p = 0.03 on a two-sample t-test, so yes at α = 0.05. "
               "[[Your groups have unequal variance though]], which that test "
               "assumes away…",
        next_prompt="good — now plot the effect sizes",
        question="does that change the result?",
        reply="Welch's t-test drops the equal-variance assumption. Re-run on your "
              "data it gives p = 0.06, so the effect no longer",
    ),
    dict(
        slug="finance", title="dcf model",
        prompt="sanity-check my valuation model",
        answer="The revenue build and WACC look defensible. [[Terminal value is 82% "
               "of your total]], which is high — the answer rests almost entirely "
               "on year 10…",
        next_prompt="noted — now run the bear case",
        question="what's a normal range for that?",
        reply="For a mature business 60–75% is typical. Above 80% the model is "
              "really a bet on the perpetuity assumption",
    ),
    dict(
        slug="people-ops", title="policy update",
        prompt="draft our new parental leave policy",
        answer="Here's a 16-week draft covering both parents equally. [[This overlaps "
               "your state's paid family leave]], which pays out separately from "
               "what you offer…",
        next_prompt="thanks — now the manager FAQ",
        question="how do the two stack for an employee?",
        reply="In most states the scheme pays a share of wages and the employer tops "
              "it up to full salary rather than paying twice",
    ),
]


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def wrap(text, width):
    """Greedy word-wrap that also reports each line's offset in the source string."""
    words, i = [], 0
    for w in text.split(" "):
        words.append((i, w))
        i += len(w) + 1
    lines, start, cur = [], 0, ""
    for off, w in words:
        if not cur:
            start, cur = off, w
        elif len(cur) + 1 + len(w) > width:
            lines.append((start, cur))
            start, cur = off, w
        else:
            cur += " " + w
    if cur:
        lines.append((start, cur))
    return lines


def spans(text, width, x0, y0, colour, indent=0, mark=True):
    """Wrapped <text> runs, gold inside [[…]] (plain when mark=False, though the
    highlight's per-line geometry is still reported). Returns (svg, metrics)."""
    hs, he = text.find("[["), text.find("]]")
    plain = text.replace("[[", "").replace("]]", "")
    if hs >= 0:
        he -= 2
    out, metrics = [], []
    for n, (off, line) in enumerate(wrap(plain, width)):
        x = x0 + (indent * CW if n else 0)
        y = y0 + n * LH
        cuts = []
        if hs >= 0 and off < he and off + len(line) > hs:
            cuts = [max(0, hs - off), min(len(line), he - off)]
        pieces = ([(0, cuts[0], colour), (cuts[0], cuts[1], GOLD),
                   (cuts[1], len(line), colour)] if cuts else [(0, len(line), colour)])
        for a, b, fill in pieces:
            if b <= a:
                continue
            raw = line[a:b]
            seg = raw.strip()
            if not seg:
                continue
            # SVG eats leading spaces in a text run — carry them in the x offset
            sx = x + (a + len(raw) - len(raw.lstrip())) * CW
            if fill == GOLD and mark:
                out.append(f'  <rect x="{sx - 2:.1f}" y="{y - 14:.0f}" '
                           f'width="{len(seg) * CW + 4:.1f}" height="19" rx="3" '
                           f'fill="{GOLD}" opacity="0.16"/>')
            use = fill if (fill != GOLD or mark) else colour
            out.append(f'  <text x="{sx:.1f}" y="{y:.0f}" fill="{use}" '
                       f'textLength="{len(seg) * CW:.1f}">{esc(seg)}</text>')
        metrics.append(dict(y=y, end=x + len(line) * CW,
                            hi_mid=(x + (cuts[0] + cuts[1]) / 2 * CW) if cuts else None,
                            hi_x0=(x + cuts[0] * CW) if cuts else None,
                            hi_x1=(x + cuts[1] * CW) if cuts else None))
    return "\n".join(out), metrics


def build(ex):
    MAIN_X, MAIN_W, MX = 36, 560, 64
    SIDE_X, SIDE_W, SX = 340, 470, 368
    MAIN_CH, SIDE_CH = 46, 44

    p_y = 96
    ans, m = spans(ex["answer"], MAIN_CH, MX, p_y + 30, FG)
    nxt_y = m[-1]["y"] + 48
    main_h = nxt_y + 40 - 28

    side_top = 28 + main_h + 92
    q_text = f'Re [["{ex["question_excerpt"]}"]]: {ex["question"]}'
    q, qm = spans(q_text, SIDE_CH - 2, SX + 2 * CW, side_top + 52, FG, indent=0)
    rep, rm = spans(ex["reply"], SIDE_CH, SX, qm[-1]["y"] + 44, DIM)
    side_h = rm[-1]["y"] + 34 - side_top

    lit = [l for l in m if l["hi_mid"] is not None]
    hi = lit[0]                                    # where the ! marker perches
    ax, ay = lit[-1]["hi_mid"], lit[-1]["y"] + 16  # the branch leaves from here
    label = "branch it"
    lw = len(label) * CW + 34
    # park the pill on the curve — cubic midpoint is (P0 + 3·P1 + 3·P2 + P3) / 8
    lx = (ax + 3 * ax + 3 * (ax + 64) + SIDE_X + 42) / 8 - lw / 2
    ly = (ay + 3 * (ay + 104) + 3 * (side_top - 32) + side_top - 4) / 8 - 14

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 {side_top + side_h + 34:.0f}" font-family="SFMono-Regular, Menlo, 'Cascadia Mono', Consolas, 'Liberation Mono', monospace" font-size="{FS}">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="{GOLD}"/>
    </marker>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="6" stdDeviation="12" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>

  <!-- ══════════ the main conversation ══════════ -->
  <g filter="url(#shadow)">
    <rect x="{MAIN_X}" y="28" width="{MAIN_W}" height="{main_h:.0f}" rx="10" fill="#171922" stroke="#2d333e"/>
  </g>
  <circle cx="58" cy="50" r="5.5" fill="#ff5f56"/>
  <circle cx="76" cy="50" r="5.5" fill="#ffbd2e"/>
  <circle cx="94" cy="50" r="5.5" fill="#27c93f"/>
  <text x="{MAIN_X + MAIN_W / 2:.0f}" y="54" text-anchor="middle" font-size="11.5" fill="{DIM}">{esc(ex["title"])} — the main quest</text>
  <line x1="{MAIN_X}" y1="66" x2="{MAIN_X + MAIN_W}" y2="66" stroke="#262b33"/>

  <text x="{MX}" y="{p_y}" fill="{FG}"><tspan fill="{GREEN}">&gt;</tspan> {esc(ex["prompt"])}</text>

{ans}

  <!-- the aside worth chasing -->
  <g>
    <text x="{hi["end"] + 19:.0f}" y="{hi["y"] + 3:.0f}" font-size="17" font-weight="bold" fill="{GOLD}" text-anchor="middle">!</text>
    <animateTransform attributeName="transform" type="translate" values="0,0; 0,-5; 0,0" dur="1.4s" repeatCount="indefinite" calcMode="spline" keySplines=".4 0 .6 1; .4 0 .6 1"/>
  </g>

  <!-- …and the main thread carries on regardless -->
  <text x="{MX}" y="{nxt_y:.0f}" fill="{FG}"><tspan fill="{GREEN}">&gt;</tspan> {esc(ex["next_prompt"])}</text>
  <rect x="{MX + (len(ex["next_prompt"]) + 3) * CW:.0f}" y="{nxt_y - 12:.0f}" width="8" height="15" fill="{DIM}">
    <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.1s" repeatCount="indefinite"/>
  </rect>

  <!-- ══════════ the branch ══════════ -->
  <path d="M {ax:.0f} {ay:.0f} C {ax:.0f} {ay + 104:.0f}, {ax + 64:.0f} {side_top - 32:.0f}, {SIDE_X + 42} {side_top - 4:.0f}" fill="none" stroke="{GOLD}" stroke-width="2.2" stroke-dasharray="7 6" marker-end="url(#arr)">
    <animate attributeName="stroke-dashoffset" from="26" to="0" dur="1s" repeatCount="indefinite"/>
  </path>
  <rect x="{lx:.0f}" y="{ly:.0f}" width="{lw:.0f}" height="28" rx="6" fill="#1d212a" stroke="{GOLD}" stroke-opacity="0.55"/>
  <text x="{lx + lw / 2:.0f}" y="{ly + 18:.0f}" text-anchor="middle" fill="{GOLD}">{label}</text>

  <!-- ══════════ the side quest ══════════ -->
  <g filter="url(#shadow)">
    <rect x="{SIDE_X}" y="{side_top:.0f}" width="{SIDE_W}" height="{side_h:.0f}" rx="10" fill="#171922" stroke="#2d333e"/>
  </g>
  <polygon points="{SIDE_X + 33},{side_top - 10:.0f} {SIDE_X + 57},{side_top - 10:.0f} {SIDE_X + 57},{side_top + 12:.0f} {SIDE_X + 33},{side_top + 12:.0f} {SIDE_X + 44},{side_top + 1:.0f}" fill="#c9a227"/>
  <polygon points="{SIDE_X + 387},{side_top - 10:.0f} {SIDE_X + 363},{side_top - 10:.0f} {SIDE_X + 363},{side_top + 12:.0f} {SIDE_X + 387},{side_top + 12:.0f} {SIDE_X + 376},{side_top + 1:.0f}" fill="#c9a227"/>
  <rect x="{SIDE_X + 55}" y="{side_top - 16:.0f}" width="310" height="32" rx="5" fill="{GOLD}"/>
  <text x="{SIDE_X + 210}" y="{side_top + 5:.0f}" text-anchor="middle" font-weight="bold" font-size="13.5" letter-spacing="1" fill="#1c1710">◆ SIDE QUEST ACCEPTED ◆</text>

  <text x="{SX}" y="{side_top + 52:.0f}" fill="{FG}"><tspan fill="{GREEN}">&gt;</tspan></text>
{q}

{rep}
  <rect x="{rm[-1]["end"] + 6:.0f}" y="{rm[-1]["y"] - 12:.0f}" width="8" height="15" fill="{DIM}">
    <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.1s" repeatCount="indefinite"/>
  </rect>
</svg>
'''


# ── the prefix+T tree navigator, one per audience like the cards above ────────
#
# Every tree has the same shape — root, a branch, its deeper branch, a closed
# sibling — and the selection cycles between the two focused branches while the
# preview pane swaps in sync. The first branch is the very branch the matching
# card illustrates; the deeper one chases something in that side quest's reply.
# `story` entries are (depth, colour, diverge brief); snippets mark the
# highlight with [[double brackets]].

TREE_VIEWS = [
    dict(
        slug="trip", title="japan trip", sibling="nara or osaka",
        previews=[
            dict(
                name="nozomi coverage",
                state=[("● idle", FG), (" · 2m ago · 1 branch", DIM)],
                story=[(0, FG, "pinning down which bullet trains the JR pass "
                               "actually covers on the Tokyo–Kyoto leg")],
                snippet="…Fushimi Inari at sunrise, then Arashiyama. Note: the "
                        "[[JR Pass doesn't cover the Nozomi bullet trains]] — "
                        "book the Hikari instead…",
                asked="which trains can I take?",
            ),
            dict(
                name="hikari seats",
                state=[("○ closed · 1h ago", DIM)],
                story=[(0, DIM, "pinning down which bullet trains the JR pass "
                                "actually covers on the Tokyo–Kyoto leg"),
                       (1, FG, "chasing whether the hikari needs seat "
                               "reservations in cherry-blossom season")],
                snippet="…with the pass you can ride the Hikari and Kodama — "
                        "[[the Hikari reaches Kyoto about 15 minutes later]], "
                        "for free",
                asked="do I need seat reservations?",
            ),
        ],
    ),
    dict(
        slug="frontend", title="checkout page", sibling="font subsetting",
        previews=[
            dict(
                name="font swap jump",
                state=[("● idle", FG), (" · 4m ago · 1 branch", DIM)],
                story=[(0, FG, "digging into the second layout jump the "
                               "webfont swap causes and what can stop it")],
                snippet="…images have no width or height, so the browser "
                        "can't reserve space. [[The webfont swap causes a "
                        "second jump]] — that one needs a different fix…",
                asked="which fix, and what does it cost me?",
            ),
            dict(
                name="fallback font",
                state=[("○ closed · 30m ago", DIM)],
                story=[(0, DIM, "digging into the second layout jump the "
                                "webfont swap causes and what can stop it"),
                       (1, FG, "measuring how many real visits would ever see "
                               "the fallback font stick")],
                snippet="font-display: optional. The tradeoff is that [[on a "
                        "slow connection the webfont is skipped entirely]] "
                        "for that visit",
                asked="how many visits does that really affect?",
            ),
        ],
    ),
    dict(
        slug="backend", title="orders api", sibling="slow query log",
        previews=[
            dict(
                name="pool sizing",
                state=[("● busy", GREEN), (" · 1m ago · 1 branch", DIM)],
                story=[(0, FG, "quantifying how many connections each worker "
                               "deserves before the database starts queueing")],
                snippet="…Batch them with a join. [[Your connection pool is "
                        "undersized too]], 5 connections across 4 workers…",
                asked="how do I size the pool properly?",
            ),
            dict(
                name="migration headroom",
                state=[("○ closed · 2h ago", DIM)],
                story=[(0, DIM, "quantifying how many connections each worker "
                                "deserves before the database starts queueing"),
                       (1, FG, "pinning down how much connection headroom "
                               "migrations and admin sessions really need")],
                snippet="Start from the database's max_connections, divide by "
                        "worker count, then [[leave headroom for migrations "
                        "and admin]]",
                asked="how much headroom is enough?",
            ),
        ],
    ),
    dict(
        slug="science", title="assay results", sibling="power analysis",
        previews=[
            dict(
                name="unequal variance",
                state=[("● idle", FG), (" · 6m ago · 1 branch", DIM)],
                story=[(0, FG, "testing whether the significance survives once "
                               "the equal-variance assumption is dropped")],
                snippet="p = 0.03 on a two-sample t-test, so yes at α = 0.05. "
                        "[[Your groups have unequal variance though]], which "
                        "that test assumes away…",
                asked="does that change the result?",
            ),
            dict(
                name="borderline p",
                state=[("○ closed · 40m ago", DIM)],
                story=[(0, DIM, "testing whether the significance survives once "
                                "the equal-variance assumption is dropped"),
                       (1, FG, "weighing what a p of 0.06 says about the "
                               "treatment effect claim")],
                snippet="Welch's t-test drops the equal-variance assumption. "
                        "Re-run on your data [[it gives p = 0.06]], so the "
                        "effect no longer",
                asked="so is the effect real or not?",
            ),
        ],
    ),
    dict(
        slug="finance", title="dcf model", sibling="wacc sanity",
        previews=[
            dict(
                name="terminal weight",
                state=[("● idle", FG), (" · 3m ago · 1 branch", DIM)],
                story=[(0, FG, "sizing how much of the valuation should "
                               "reasonably sit in the terminal value")],
                snippet="The revenue build and WACC look defensible. "
                        "[[Terminal value is 82% of your total]], which is "
                        "high — the answer rests almost entirely on year 10…",
                asked="what's a normal range for that?",
            ),
            dict(
                name="perpetuity bet",
                state=[("○ closed · 1h ago", DIM)],
                story=[(0, DIM, "sizing how much of the valuation should "
                                "reasonably sit in the terminal value"),
                       (1, FG, "pressure-testing the perpetuity growth "
                               "assumption the whole valuation quietly leans on")],
                snippet="For a mature business 60–75% is typical. Above 80% "
                        "[[the model is really a bet on the perpetuity "
                        "assumption]]",
                asked="how do I stress-test that assumption?",
            ),
        ],
    ),
    dict(
        slug="people-ops", title="policy update", sibling="eligibility rules",
        previews=[
            dict(
                name="leave stacking",
                state=[("● waiting", GOLD), (" · 5m ago · 1 branch", DIM)],
                story=[(0, FG, "untangling how the company plan stacks with "
                               "the state's paid family leave")],
                snippet="Here's a 16-week draft covering both parents equally. "
                        "[[This overlaps your state's paid family leave]], "
                        "which pays out separately…",
                asked="how do the two stack for an employee?",
            ),
            dict(
                name="salary top-up",
                state=[("○ closed · 45m ago", DIM)],
                story=[(0, DIM, "untangling how the company plan stacks with "
                                "the state's paid family leave"),
                       (1, FG, "drafting plain policy language for topping "
                               "state payments up to full salary")],
                snippet="In most states the scheme pays a share of wages and "
                        "[[the employer tops it up to full salary]] rather "
                        "than paying twice",
                asked="how should the policy word that?",
            ),
        ],
    ),
]


def divider(label, x, y):
    s = "┄┄ " + label + " " + "┄" * (21 - len(label))
    return (f'  <text x="{x:.1f}" y="{y:.0f}" fill="{DIM}" opacity="0.7" '
            f'textLength="{len(s) * CW:.1f}">{esc(s)}</text>')


def preview_pane(pv, vx, vw, y0):
    """One branch's preview — header, story-so-far cascade, branched-on inputs."""
    out = [f'  <text x="{vx:.1f}" y="{y0:.0f}" font-weight="bold" fill="{FG}" '
           f'textLength="{len(pv["name"]) * CW:.1f}">{esc(pv["name"])}</text>']
    sx = vx + (len(pv["name"]) + 2) * CW
    for seg, col in pv["state"]:
        s = seg.strip()  # SVG eats edge spaces in a text run — carry them in x
        out.append(f'  <text x="{sx + (len(seg) - len(seg.lstrip())) * CW:.1f}" '
                   f'y="{y0:.0f}" fill="{col}" '
                   f'textLength="{len(s) * CW:.1f}">{esc(s)}</text>')
        sx += len(seg) * CW
    y = y0 + 28
    out.append(divider("story so far", vx, y))
    y += LH
    for depth, col, line in pv["story"]:
        gx = vx + depth * CW
        out.append(f'  <text x="{gx:.1f}" y="{y:.0f}" fill="{GOLD}">⑂</text>')
        body, m = spans(line, vw - depth - 2, gx + 2 * CW, y, col)
        out.append(body)
        y = m[-1]["y"] + LH + 4
    out.append(divider("branched on", vx, y))
    y += LH
    out.append(f'  <text x="{vx:.1f}" y="{y:.0f}" fill="{GOLD}">❝</text>')
    body, m = spans(pv["snippet"], vw - 2, vx + 2 * CW, y, DIM)
    out.append(body)
    y = m[-1]["y"] + LH + 4
    out.append(f'  <text x="{vx:.1f}" y="{y:.0f}" font-weight="bold" fill="{CYAN}">❯</text>')
    out.append(f'  <text x="{vx + 2 * CW:.1f}" y="{y:.0f}" fill="{DIM}">asked</text>')
    body, m = spans(pv["asked"], vw - 9, vx + 9 * CW, y, FG)
    out.append(body)
    return "\n".join(out), m[-1]["y"]


def build_tree(tv):
    PX, PW = 60, 760                # the popup card
    LX = PX + 28                    # list text
    BORDER = PX + 342               # fzf's preview border-left (~55% preview)
    VX, VW = BORDER + 22, 43        # preview text origin and wrap width

    prompt_y, info_y, hdr_y, row0 = 96, 118, 140, 166
    DUR = "6s"                      # one full select-A / select-B cycle

    tree_rows = [                   # root, branch, deeper branch, closed sibling
        ("", "●", tv["title"]),
        ("├─ ", "●", tv["previews"][0]["name"]),
        ("│  └─ ", "○", tv["previews"][1]["name"]),
        ("└─ ", "○", tv["sibling"]),
    ]
    rows = []
    for i, (pipes, status, name) in enumerate(tree_rows):
        y, x = row0 + i * LH, LX
        # pipes go glyph by glyph — SVG's whitespace collapsing would shear a
        # run like "│  └─ " out of its cells
        for j, ch in enumerate(pipes):
            if ch != " ":
                rows.append(f'  <text x="{x + j * CW:.1f}" y="{y:.0f}" '
                            f'fill="{DIM}">{esc(ch)}</text>')
        x += len(pipes) * CW
        rows.append(f'  <text x="{x:.1f}" y="{y:.0f}" '
                    f'fill="{FG if status == "●" else DIM}">{status}</text>')
        rows.append(f'  <text x="{x + 2 * CW:.1f}" y="{y:.0f}" fill="{FG}" '
                    f'textLength="{len(name) * CW:.1f}">{esc(name)}</text>')

    panes, bottoms = [], []
    for k, pv in enumerate(tv["previews"]):
        body, bottom = preview_pane(pv, VX, VW, prompt_y)
        panes.append(f'''  <g>
    <animate attributeName="opacity" values="{"1;0" if k == 0 else "0;1"}" keyTimes="0;0.5" calcMode="discrete" dur="{DUR}" repeatCount="indefinite"/>
{body}
  </g>''')
        bottoms.append(bottom)

    sel_y = row0 + 1 * LH           # the selection starts on the first branch…
    sel_dy = LH                     # …and hops to its deeper branch
    content_bottom = max(bottoms + [row0 + (len(tree_rows) - 1) * LH])
    panel_bottom = content_bottom + 26
    panel_h = panel_bottom - 28

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 {panel_bottom + 26:.0f}" font-family="SFMono-Regular, Menlo, 'Cascadia Mono', Consolas, 'Liberation Mono', monospace" font-size="{FS}">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="6" stdDeviation="12" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>

  <!-- ══════════ the tree popup ══════════ -->
  <g filter="url(#shadow)">
    <rect x="{PX}" y="28" width="{PW}" height="{panel_h:.0f}" rx="10" fill="#171922" stroke="#2d333e"/>
  </g>
  <text x="{PX + PW / 2:.0f}" y="54" text-anchor="middle" font-size="11.5" fill="{DIM}">{esc(tv["title"])} — the side-quest tree (prefix + T)</text>
  <line x1="{PX}" y1="66" x2="{PX + PW}" y2="66" stroke="#262b33"/>
  <line x1="{BORDER}" y1="80" x2="{BORDER}" y2="{panel_bottom - 14:.0f}" stroke="#2d333e"/>

  <!-- fzf chrome: prompt, match count, keys -->
  <text x="{LX}" y="{prompt_y}"><tspan fill="{GREEN}">lemux&gt;</tspan></text>
  <rect x="{LX + 7 * CW:.1f}" y="{prompt_y - 12}" width="8" height="15" fill="{DIM}">
    <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.1s" repeatCount="indefinite"/>
  </rect>
  <text x="{LX}" y="{info_y}" fill="{DIM}" opacity="0.7">4/4</text>
  <text x="{LX}" y="{hdr_y}" fill="{DIM}">enter: jump · ctrl-x: delete · esc: close</text>

  <!-- the selection, hopping between two side quests -->
  <g>
    <animateTransform attributeName="transform" type="translate" values="0 0; 0 {sel_dy}" keyTimes="0;0.5" calcMode="discrete" dur="{DUR}" repeatCount="indefinite"/>
    <rect x="{PX + 12}" y="{sel_y - 15}" width="{BORDER - PX - 26}" height="21" rx="4" fill="{GOLD}" opacity="0.10"/>
    <text x="{PX + 14}" y="{sel_y}" fill="{GOLD}" font-weight="bold">▌</text>
  </g>

  <!-- the tree -->
{chr(10).join(rows)}

  <!-- the preview: each branch's story, swapping with the selection -->
{chr(10).join(panes)}
</svg>
'''


# ── the recording: one 20-second loop through the whole flow ─────────────────
#
# Five scenes crossfade inside a single terminal frame like a screen capture:
# an aside surfaces → the user visibly drag-selects it → prefix+B, question
# typed character by character → the side quest answers with full context →
# prefix+T from inside the side quest, selection climbing back to the parent →
# landing on the main quest, which never noticed. A caption below the frame
# narrates each beat; a progress bar paces the loop. All timing lives on one
# shared clock (SMIL keyTimes over T seconds), so the loop can never drift.

T = 23.0                                        # loop length, seconds
SCENES = [(0.0, 5.0), (5.0, 9.0), (9.0, 13.5), (13.5, 18.5), (18.5, 23.0)]
FADE = 0.7                                      # crossfade span between scenes
SEL = "#264f78"                                 # the drag-selection blue


def _k(t):
    return f"{t / T:.4f}"


def fade_anim(a, b):
    """Scene opacity on the shared clock — fades overlap the neighbour scene's
    window, so adjacent scenes genuinely crossfade instead of cutting."""
    if a <= 0:
        vals, times = "0;1;1;0;0", f"0;{_k(FADE)};{_k(b)};{_k(b + FADE)};1"
    elif b >= T:
        vals, times = "0;0;1;1;0", f"0;{_k(a)};{_k(a + FADE)};{_k(T - FADE)};1"
    else:
        vals, times = "0;0;1;1;0;0", f"0;{_k(a)};{_k(a + FADE)};{_k(b)};{_k(b + FADE)};1"
    return (f'<animate attributeName="opacity" values="{vals}" keyTimes="{times}" '
            f'dur="{T:g}s" repeatCount="indefinite"/>')


def appear_anim(t0, ramp=0.45):
    """Fade an element in at t0 and keep it (scene opacity handles the exit)."""
    return (f'<animate attributeName="opacity" values="0;0;1;1" '
            f'keyTimes="0;{_k(t0)};{_k(t0 + ramp)};1" dur="{T:g}s" repeatCount="indefinite"/>')


def typewriter(text, x, y, colour, t0, t1, cid):
    """Type `text` one character at a time between t0 and t1: the text sits
    under a clip whose width grows a cell per step, and the cursor block rides
    along. Returns (clip def for <defs>, body svg)."""
    n = len(text)
    times = "0;" + ";".join(_k(t0 + i * (t1 - t0) / n) for i in range(1, n + 1))
    wvals = "0;" + ";".join(f"{i * CW + 2:.1f}" for i in range(1, n + 1))
    xvals = f"{x:.1f};" + ";".join(f"{x + i * CW + 3:.1f}" for i in range(1, n + 1))
    clip = (f'<clipPath id="{cid}"><rect x="{x - 1:.1f}" y="{y - 13:.0f}" width="0" height="18">'
            f'<animate attributeName="width" values="{wvals}" keyTimes="{times}" '
            f'calcMode="discrete" dur="{T:g}s" repeatCount="indefinite"/></rect></clipPath>')
    body = (f'  <text x="{x:.1f}" y="{y:.0f}" fill="{colour}" textLength="{len(text) * CW:.1f}" '
            f'clip-path="url(#{cid})">{esc(text)}</text>\n'
            f'  <rect x="{x:.1f}" y="{y - 12:.0f}" width="8" height="15" fill="{DIM}">'
            f'<animate attributeName="x" values="{xvals}" keyTimes="{times}" '
            f'calcMode="discrete" dur="{T:g}s" repeatCount="indefinite"/></rect>')
    return clip, body


def scene(n, content):
    a, b = SCENES[n]
    base = '' if n == 0 else ' opacity="0"'
    return f'  <g{base}>\n    {fade_anim(a, b)}\n{content}\n  </g>'


def cursor(x, y, blink=True):
    anim = ('<animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" '
            'dur="1.1s" repeatCount="indefinite"/>' if blink else '')
    return f'  <rect x="{x:.1f}" y="{y - 12:.0f}" width="8" height="15" fill="{DIM}">{anim}</rect>'


def title_line(s):
    return (f'  <text x="440" y="54" text-anchor="middle" font-size="11.5" '
            f'fill="{DIM}">{esc(s)}</text>')


def caption(window, segs):
    body = "".join(f'<tspan fill="{col}">{esc(s)}</tspan>' for s, col in segs)
    return (f'  <text x="440" y="400" text-anchor="middle" font-size="14" opacity="0">'
            f'{fade_anim(*window)}{body}</text>')


def build_flow(ex, tv):
    X0, W = 64, 88                              # content origin and wrap width
    excerpt = ex["answer"].split("[[")[1].split("]]")[0]

    # the main conversation — plain for the early scenes (nothing marked yet),
    # gold-marked for the finale (that excerpt has been branched)
    prompt_line = (f'  <text x="{X0}" y="96" fill="{FG}"><tspan fill="{GREEN}">&gt;</tspan> '
                   f'{esc(ex["prompt"])}</text>')
    ans_plain, m = spans(ex["answer"], W, X0, 126, FG, mark=False)
    ans_gold, _ = spans(ex["answer"], W, X0, 126, FG)
    lit = [l for l in m if l["hi_x0"] is not None]

    # ── scene 1: the aside surfaces, the user drag-selects it ──
    SW0, SW1 = 2.0, 4.0                         # the selection sweep
    total_w = sum(l["hi_x1"] - l["hi_x0"] for l in lit)
    sweep, sel_static, t = [], [], SW0
    for l in lit:
        w = l["hi_x1"] - l["hi_x0"] + 3
        dt = (SW1 - SW0) * (w / total_w)
        sweep.append(f'''  <rect x="{l["hi_x0"] - 2:.1f}" y="{l["y"] - 14:.0f}" width="0" height="19" rx="3" fill="{SEL}" opacity="0.8">
    <animate attributeName="width" values="0;0;{w:.1f};{w:.1f}" keyTimes="0;{_k(t)};{_k(min(t + dt, SW1))};1" dur="{T:g}s" repeatCount="indefinite"/>
  </rect>''')
        sel_static.append(f'  <rect x="{l["hi_x0"] - 2:.1f}" y="{l["y"] - 14:.0f}" '
                          f'width="{w:.1f}" height="19" rx="3" fill="{SEL}" opacity="0.8"/>')
        t += dt
    hi = lit[0]
    s1 = "\n".join([
        title_line(f'{ex["title"]} — the main quest'),
        "\n".join(sweep),
        prompt_line,
        ans_plain,
        f'''  <g opacity="0">
    {appear_anim(SW1 + 0.15, 0.3)}
    <g>
      <text x="{hi["end"] + 19:.0f}" y="{hi["y"] + 3:.0f}" font-size="17" font-weight="bold" fill="{GOLD}" text-anchor="middle">!</text>
      <animateTransform attributeName="transform" type="translate" values="0,0; 0,-5; 0,0" dur="1.4s" repeatCount="indefinite" calcMode="spline" keySplines=".4 0 .6 1; .4 0 .6 1"/>
    </g>
  </g>''',
    ])

    # ── scene 2: the prefix+B popup, question typed a character at a time ──
    PX, PY, PW2, PH = 140, 108, 600, 200
    ty = PY + 136
    qx = PX + 38 + 2 * CW
    clip_q, typed_q = typewriter(ex["question"], qx, ty, FG, 5.9, 8.3, "type-q")
    sel_block = "\n".join(sel_static)
    s2 = "\n".join([
        title_line(f'{ex["title"]} — branch a side quest (prefix + B)'),
        f'  <g opacity="0.22">\n{sel_block}\n{prompt_line}\n{ans_plain}\n  </g>',
        f'  <g filter="url(#shadow)">\n    <rect x="{PX}" y="{PY}" width="{PW2}" height="{PH}" rx="8" fill="#1d212a" stroke="{GOLD}" stroke-opacity="0.45"/>\n  </g>',
        f'  <text x="{PX + 38}" y="{PY + 36}" font-weight="bold" fill="{FG}">branch a side quest</text>'
        f'<text x="{PX + 38 + 20 * CW:.1f}" y="{PY + 36}" fill="{DIM}">(from {esc(ex["title"])})</text>',
        f'  <text x="{PX + 38}" y="{PY + 68}" fill="{DIM}">on </text>'
        f'<text x="{PX + 38 + 3 * CW:.1f}" y="{PY + 68}" fill="{GOLD}">“{esc(excerpt)}”</text>',
        f'  <text x="{PX + 38}" y="{PY + 100}" fill="{DIM}">type your question and hit enter · ctrl-c cancels</text>',
        f'  <text x="{PX + 38}" y="{ty}" fill="{GREEN}">&gt;</text>',
        typed_q,
    ])

    # ── scene 3: the side quest answers, whole parent conversation behind it ──
    bt = 96
    q_text = f'Re [["{excerpt}"]]: {ex["question"]}'
    q, qm = spans(q_text, W - 2, X0 + 2 * CW, 148, FG)
    rep, rm = spans(ex["reply"], W, X0, qm[-1]["y"] + 36, DIM)
    sq_banner = "\n".join([
        f'  <polygon points="263,{bt - 10} 287,{bt - 10} 287,{bt + 12} 263,{bt + 12} 274,{bt + 1}" fill="#c9a227"/>',
        f'  <polygon points="617,{bt - 10} 593,{bt - 10} 593,{bt + 12} 617,{bt + 12} 606,{bt + 1}" fill="#c9a227"/>',
        f'  <rect x="285" y="{bt - 16}" width="310" height="32" rx="5" fill="{GOLD}"/>',
        f'  <text x="440" y="{bt + 5}" text-anchor="middle" font-weight="bold" font-size="13.5" letter-spacing="1" fill="#1c1710">◆ SIDE QUEST ACCEPTED ◆</text>',
    ])
    sq_question = f'  <text x="{X0}" y="148" fill="{FG}"><tspan fill="{GREEN}">&gt;</tspan></text>\n{q}'
    s3 = "\n".join([
        title_line(f'{tv["previews"][0]["name"]} — the side quest'),
        sq_banner,
        sq_question,
        f'''  <g opacity="0">
    {appear_anim(10.1)}
{rep}
{cursor(rm[-1]["end"] + 6, rm[-1]["y"])}
  </g>''',
    ])

    # ── scene 4: prefix+T from inside the side quest — the real fzf layout,
    # list + preview pane, climbing back out to the parent ──
    TX, TY, TW2 = 80, 84, 680
    BORD = TX + 300                             # fzf's preview border-left
    HOP = 15.8                                  # when the selection climbs up
    tree_rows = [
        ("", "●", tv["title"]),
        ("├─ ", "●", tv["previews"][0]["name"]),
        ("│  └─ ", "○", tv["previews"][1]["name"]),
        ("└─ ", "○", tv["sibling"]),
    ]
    row0, rows = TY + 90, []
    for i, (pipes, status, name) in enumerate(tree_rows):
        y, x = row0 + i * LH, TX + 30
        for j, ch in enumerate(pipes):
            if ch != " ":
                rows.append(f'  <text x="{x + j * CW:.1f}" y="{y:.0f}" fill="{DIM}">{esc(ch)}</text>')
        x += len(pipes) * CW
        rows.append(f'  <text x="{x:.1f}" y="{y:.0f}" fill="{FG if status == "●" else DIM}">{status}</text>')
        rows.append(f'  <text x="{x + 2 * CW:.1f}" y="{y:.0f}" fill="{FG}" '
                    f'textLength="{len(name) * CW:.1f}">{esc(name)}</text>')
    # the preview pane: this branch's story while it's selected, the root's
    # once the selection climbs up
    pa_svg, pa_bottom = preview_pane(tv["previews"][0], BORD + 22, 42, TY + 32)
    root_dir = "~/trips/" + tv["title"].split()[0]
    pb_svg = "\n".join([
        f'  <text x="{BORD + 22:.1f}" y="{TY + 32}" font-weight="bold" fill="{FG}" '
        f'textLength="{len(tv["title"]) * CW:.1f}">{esc(tv["title"])}</text>',
        f'  <text x="{BORD + 22 + (len(tv["title"]) + 2) * CW:.1f}" y="{TY + 32}" fill="{FG}">● idle</text>',
        f'  <text x="{BORD + 22 + (len(tv["title"]) + 9) * CW:.1f}" y="{TY + 32}" fill="{DIM}">· 2 branches</text>',
        f'  <text x="{BORD + 22:.1f}" y="{TY + 60}" fill="{DIM}">{esc(root_dir)}</text>',
    ])
    TH = pa_bottom - TY + 26
    swap = (f'<animate attributeName="opacity" values="{{v}}" keyTimes="0;{_k(HOP)}" '
            f'calcMode="discrete" dur="{T:g}s" repeatCount="indefinite"/>')
    s4 = "\n".join([
        title_line(f'{tv["previews"][0]["name"]} — the side-quest tree (prefix + T)'),
        f'  <g opacity="0.22">\n{sq_banner}\n{sq_question}\n{rep}\n  </g>',
        f'  <g filter="url(#shadow)">\n    <rect x="{TX}" y="{TY}" width="{TW2}" height="{TH:.0f}" rx="8" fill="#1d212a" stroke="#2d333e"/>\n  </g>',
        f'  <line x1="{BORD}" y1="{TY + 14}" x2="{BORD}" y2="{TY + TH - 14:.0f}" stroke="#2d333e"/>',
        f'  <text x="{TX + 30}" y="{TY + 32}"><tspan fill="{GREEN}">lemux&gt;</tspan></text>',
        cursor(TX + 30 + 7 * CW, TY + 32),
        f'  <text x="{TX + 30}" y="{TY + 58}" fill="{DIM}">enter: jump · ctrl-x: delete</text>',
        f'''  <g>
    <animateTransform attributeName="transform" type="translate" values="0 0; 0 -{LH}" keyTimes="0;{_k(HOP)}" calcMode="discrete" dur="{T:g}s" repeatCount="indefinite"/>
    <rect x="{TX + 14}" y="{row0 + LH - 15}" width="{BORD - TX - 26}" height="21" rx="4" fill="{GOLD}" opacity="0.10">
      <animate attributeName="opacity" values="0.10;0.10;0.32;0.10;0.10" keyTimes="0;{_k(17.25)};{_k(17.4)};{_k(17.65)};1" dur="{T:g}s" repeatCount="indefinite"/>
    </rect>
    <text x="{TX + 16}" y="{row0 + LH}" fill="{GOLD}" font-weight="bold">▌</text>
  </g>''',
        "\n".join(rows),
        f'  <g>\n    {swap.format(v="1;0")}\n{pa_svg}\n  </g>',
        f'  <g opacity="0">\n    {swap.format(v="0;1")}\n{pb_svg}\n  </g>',
        f'''  <g opacity="0">
    {appear_anim(16.7, 0.3)}
    <g>
      <animateTransform attributeName="transform" type="translate" values="0 0;0 0;0 2;0 0;0 0" keyTimes="0;{_k(17.2)};{_k(17.3)};{_k(17.45)};1" dur="{T:g}s" repeatCount="indefinite"/>
      <rect x="{BORD - 106}" y="{row0 - 16}" width="92" height="24" rx="5" fill="#1d212a" stroke="{GOLD}" stroke-opacity="0.6"/>
      <text x="{BORD - 60}" y="{row0}" text-anchor="middle" fill="{GOLD}">⏎ enter</text>
    </g>
  </g>''',
    ])

    # ── scene 5: landing back on the main quest, which never noticed ──
    nxt_y = m[-1]["y"] + 48
    clip_n, typed_n = typewriter(ex["next_prompt"], X0 + 2 * CW, nxt_y, FG, 19.4, 21.4, "type-n")
    s5 = "\n".join([
        title_line(f'{ex["title"]} — the main quest'),
        prompt_line,
        ans_gold,
        f'  <text x="{X0}" y="{nxt_y:.0f}" fill="{GREEN}">&gt;</text>',
        typed_n,
    ])

    captions = [
        ((0.0, 2.0), [("deep in a session, an aside surfaces", FG)]),
        ((2.0, 5.0), [("highlight the part you want to dig into", FG)]),
        ((5.0, 9.0), [("prefix + B", GOLD), (" — ask your side-quest question", FG)]),
        ((9.0, 13.5), [("a real fork — the whole parent conversation behind it", FG)]),
        ((13.5, 16.6), [("prefix + T", GOLD), (" — zoom back out when you're done", FG)]),
        ((16.6, 18.5), [("enter", GOLD), (" jumps to the parent", FG)]),
        ((18.5, 23.0), [("back on the main quest — it never noticed", FG)]),
    ]

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 432" font-family="SFMono-Regular, Menlo, 'Cascadia Mono', Consolas, 'Liberation Mono', monospace" font-size="{FS}">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="6" stdDeviation="12" flood-color="#000" flood-opacity="0.35"/>
    </filter>
    {clip_q}
    {clip_n}
  </defs>

  <!-- ══════════ the terminal frame, constant across scenes ══════════ -->
  <g filter="url(#shadow)">
    <rect x="36" y="28" width="808" height="338" rx="10" fill="#171922" stroke="#2d333e"/>
  </g>
  <circle cx="58" cy="50" r="5.5" fill="#ff5f56"/>
  <circle cx="76" cy="50" r="5.5" fill="#ffbd2e"/>
  <circle cx="94" cy="50" r="5.5" fill="#27c93f"/>
  <line x1="36" y1="66" x2="844" y2="66" stroke="#262b33"/>

{chr(10).join(scene(i, s) for i, s in enumerate([s1, s2, s3, s4, s5]))}

  <!-- ══════════ subtitles + the loop's progress ══════════ -->
{chr(10).join(caption(w, c) for w, c in captions)}
  <rect x="36" y="416" width="808" height="3" rx="1.5" fill="#262b33"/>
  <rect x="36" y="416" width="0" height="3" rx="1.5" fill="{GOLD}" opacity="0.55">
    <animate attributeName="width" values="0;808" dur="{T:g}s" repeatCount="indefinite"/>
  </rect>
</svg>
'''


here = pathlib.Path(__file__).parent
for ex in EXAMPLES:
    ex["question_excerpt"] = ex["answer"].split("[[")[1].split("]]")[0]
    out = here / f"side-quest-{ex['slug']}.svg"
    out.write_text(build(ex))
    print(out.name)

for tv in TREE_VIEWS:
    out = here / f"tree-view-{tv['slug']}.svg"
    out.write_text(build_tree(tv))
    print(out.name)

out = here / "flow-trip.svg"
out.write_text(build_flow(EXAMPLES[0], TREE_VIEWS[0]))
print(out.name)
