#!/usr/bin/env python3
"""Generate the README illustrations — one per audience, identical but for the example.

    python3 assets/make-illustrations.py

Each example is a moment where an answer mentions something worth chasing: you
highlight that bit, branch it, and the side quest answers with the whole parent
conversation behind it while the main thread carries on.

Mark the highlighted excerpt in `answer` with [[double brackets]].
"""

import pathlib

CW, LH, FS = 7.8, 22, 13          # monospace advance, line height, font size
FG, DIM, GOLD, GREEN = "#c9d1d9", "#8b949e", "#f5c24b", "#7ee787"

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


def spans(text, width, x0, y0, colour, indent=0):
    """Wrapped <text> runs, gold inside [[…]]. Returns (svg, line_metrics)."""
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
            if fill == GOLD:
                out.append(f'  <rect x="{sx - 2:.1f}" y="{y - 14:.0f}" '
                           f'width="{len(seg) * CW + 4:.1f}" height="19" rx="3" '
                           f'fill="{GOLD}" opacity="0.16"/>')
            out.append(f'  <text x="{sx:.1f}" y="{y:.0f}" fill="{fill}" '
                       f'textLength="{len(seg) * CW:.1f}">{esc(seg)}</text>')
        metrics.append(dict(y=y, end=x + len(line) * CW,
                            hi_mid=(x + (cuts[0] + cuts[1]) / 2 * CW) if cuts else None))
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


here = pathlib.Path(__file__).parent
for ex in EXAMPLES:
    ex["question_excerpt"] = ex["answer"].split("[[")[1].split("]]")[0]
    out = here / f"side-quest-{ex['slug']}.svg"
    out.write_text(build(ex))
    print(out.name)
