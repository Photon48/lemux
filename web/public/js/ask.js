// Asking: the bar, ask-here boxes on the canvas, the thread pulled from a node, @mentions, speech.
import { $, $$, h, api, toast } from './dom.js';
import { state, node, isUser, vp, world, N, E } from './state.js';
import { loadTree } from './layers.js';
import { go } from './nav.js';
import { renderNodes, renderSel } from './canvas.js';

const ta = $('#in');
const ac = $('#ac');
const autosize = () => {
  ta.style.height = 'auto';
  ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
};

export async function send(opt = {}) {
  const text = (opt.text || ta.value).trim();
  if (!text) return;
  if (state.fresh) {
    ta.value = '';
    autosize();
    try {
      const r = await api('/api/new', {
        dir: state.project,
        text,
        name: state.fresh.name !== 'New canvas' ? state.fresh.name : '',
      });
      state.fresh = null;
      await loadTree();
      await go(r.id);
      state.live = { q: text };
      renderNodes();
    } catch (e) {
      ta.value = text;
      toast(e.message);
    }
    return;
  }
  if (!state.cur) {
    toast('Pick a canvas, or start a new one');
    return;
  }
  const n = node(state.cur);
  if (n && (n.state === 'busy' || n.state === 'waiting')) {
    toast('Still drawing · wait, or press stop');
    return;
  }
  const picked = [...state.sel].filter((id) => !isUser(id));
  const from = opt.from || picked[0] || null;
  ta.value = '';
  autosize();
  scopeVisible();
  try {
    await api('/api/send', { sid: state.cur, text, scope: state.mscope, picked, at: opt.at || null, from });
    state.sel.clear();
    renderSel();
  } catch (e) {
    ta.value = text;
    toast(e.message);
  }
}
$('#go').onclick = () => send();

// a question asked at a spot on the canvas; the answer lands there
export function askHere(x, y, from = null) {
  $$('.askhere').forEach((a) => a.remove());
  const box = h(
    'div',
    { class: 'askhere', style: `left:${x}px;top:${y}px`, onmousedown: (e) => e.stopPropagation() },
    h('span', { class: 'x', title: 'close' }, '✕'),
    h('input', { placeholder: from ? `Ask, from “${from.q.slice(0, 26)}…”` : 'Ask' }),
    h('div', { class: 'hint' }, 'The answer lands here · click away to close')
  );
  world.append(box);
  const inp = $('input', box);
  inp.focus();
  const close = () => {
    box.remove();
    document.removeEventListener('mousedown', away, true);
  };
  const away = (e) => {
    if (!box.contains(e.target)) close();
  };
  setTimeout(() => document.addEventListener('mousedown', away, true), 0);
  $('.x', box).onmousedown = (e) => {
    e.stopPropagation();
    close();
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && inp.value.trim()) {
      const q = inp.value.trim();
      close();
      if (from) state.sel = new Set([from.id]);
      send({ text: q, at: { x, y }, from: from ? from.id : null });
    }
  };
}

// pull the ● out of a node: onto empty space to ask from it, onto another node to pick both
export function pullThread(n) {
  const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  tmp.setAttribute('class', 'tmp');
  E.append(tmp);
  const r = vp.getBoundingClientRect();
  const toW = (ev) => ({
    x: (ev.clientX - r.left - state.view.x) / state.view.k,
    y: (ev.clientY - r.top - state.view.y) / state.view.k,
  });
  const el = N.querySelector(`[data-id="${n.id}"]`);
  const p = state.cv.pos[n.id];
  const ax = p.x + el.offsetWidth;
  const ay = p.y + el.offsetHeight / 2;
  let over = null;
  const mv = (ev) => {
    const w = toW(ev);
    tmp.setAttribute('d', `M${ax},${ay} C${ax + 60},${ay} ${w.x - 60},${w.y} ${w.x},${w.y}`);
    const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
    over = hit && hit.dataset.id !== n.id ? hit.dataset.id : null;
    $$('.node').forEach((x) =>
      x.classList.toggle('sel', x.dataset.id === over || state.sel.has(x.dataset.id))
    );
  };
  const up = (ev) => {
    window.removeEventListener('mousemove', mv);
    window.removeEventListener('mouseup', up);
    tmp.remove();
    if (over) {
      state.sel = new Set([n.id, over]);
      renderSel();
      $('#in').focus();
      return;
    }
    const w = toW(ev);
    if (Math.hypot(w.x - ax, w.y - ay) < 30) return;
    state.sel = new Set([n.id]);
    renderSel();
    askHere(w.x, w.y, n);
  };
  window.addEventListener('mousemove', mv);
  window.addEventListener('mouseup', up);
}

// ---------- @mentions ----------
let acItems = [];
let acSel = 0;
let acStart = -1;
const allNames = () => state.names.map((n) => ({ name: n.name, id: n.id, topic: n.project }));
const closeAc = () => {
  ac.classList.add('hidden');
  acItems = [];
  acStart = -1;
};
const mentionRe = (name) =>
  new RegExp('@' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', 'i');
const scopeVisible = () =>
  $('#mscope').classList.toggle('hidden', !allNames().some((x) => mentionRe(x.name).test(ta.value)));
function updateAc() {
  const upto = ta.value.slice(0, ta.selectionStart);
  const m = upto.match(/(^|\s)@([^@\n]{0,40})$/);
  if (!m) return closeAc();
  acStart = upto.length - m[2].length - 1;
  const q = m[2].toLowerCase();
  acItems = allNames()
    .filter((x) => x.id !== state.cur && x.name.toLowerCase().includes(q))
    .slice(0, 12);
  if (!acItems.length) return closeAc();
  acSel = 0;
  renderAc();
}
function renderAc() {
  ac.replaceChildren(
    ...acItems.map((x, i) =>
      h(
        'div',
        {
          class: i === acSel ? 'sel' : '',
          onmousedown: (e) => {
            e.preventDefault();
            pickAc(i);
          },
        },
        x.name,
        h('small', {}, x.topic)
      )
    )
  );
  ac.classList.remove('hidden');
}
function pickAc(i) {
  const x = acItems[i];
  if (!x) return;
  const before = ta.value.slice(0, acStart);
  const after = ta.value.slice(ta.selectionStart);
  ta.value = `${before}@${x.name} ${after}`;
  const pos = before.length + x.name.length + 2;
  ta.setSelectionRange(pos, pos);
  closeAc();
  autosize();
  scopeVisible();
  ta.focus();
}
ta.addEventListener('input', () => {
  autosize();
  updateAc();
  scopeVisible();
});
ta.addEventListener('blur', () => setTimeout(closeAc, 150));
ta.addEventListener('keydown', (e) => {
  if (!ac.classList.contains('hidden')) {
    if (e.key === 'ArrowDown') {
      acSel = (acSel + 1) % acItems.length;
      renderAc();
      return e.preventDefault();
    }
    if (e.key === 'ArrowUp') {
      acSel = (acSel - 1 + acItems.length) % acItems.length;
      renderAc();
      return e.preventDefault();
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      pickAc(acSel);
      return e.preventDefault();
    }
    if (e.key === 'Escape') {
      closeAc();
      return e.preventDefault();
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
for (const b of $$('#mscope button'))
  b.onclick = () => {
    state.mscope = b.dataset.scope;
    $$('#mscope button').forEach((x) => x.classList.toggle('on', x === b));
  };

// ---------- speech ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
$('#mic').onclick = () => {
  if (!SR) {
    toast('Speech input needs Chrome or Safari');
    return;
  }
  if (rec) {
    rec.stop();
    return;
  }
  rec = new SR();
  rec.lang = navigator.language || 'en-AU';
  rec.interimResults = true;
  const base = ta.value;
  rec.onresult = (ev) => {
    let t = '';
    for (const r of ev.results) t += r[0].transcript;
    ta.value = (base ? base + ' ' : '') + t;
    autosize();
  };
  rec.onend = () => {
    rec = null;
    $('#mic').classList.remove('on');
    ta.focus();
  };
  rec.onerror = () => {
    rec = null;
    $('#mic').classList.remove('on');
  };
  $('#mic').classList.add('on');
  rec.start();
};

$('#chat-t').onclick = () => {
  const d = $('#drawer');
  d.classList.toggle('on');
  $('#chat-t').textContent = d.classList.contains('on') ? 'conversation ▾' : 'conversation ▴';
};
$('#change-x').onclick = () => $('#change').classList.remove('on');
