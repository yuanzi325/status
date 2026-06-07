'use strict';

const REFRESH_MS = 15000;
let current = null;
let activeBlock = 'summary';

/* ---- formatting helpers ---- */
function compact(n) {
  const v = Math.max(0, Math.round(n));
  if (v >= 1000) {
    const k = v / 1000;
    return { num: k >= 100 ? Math.round(k).toString() : k.toFixed(1), unit: 'k' };
  }
  return { num: v.toString(), unit: '' };
}

function commas(n) {
  return Math.round(n).toLocaleString('en-US');
}

function pct(ratio) {
  return Math.round(ratio * 100);
}

function signed(n) {
  return (n >= 0 ? '+' : '') + commas(n);
}

/* ---- block definitions: map data -> display ---- */
const BLOCKS = {
  window(d) {
    const c = compact(d.usage.window_load);
    return {
      value: `${c.num}<span class="unit">${c.unit}</span>`,
      title: 'WINDOW',
      rows: [
        ['input tokens', commas(d.usage.input_tokens)],
        ['cache read', commas(d.usage.cache_read_input_tokens)],
        ['cache create', commas(d.usage.cache_creation_input_tokens)],
        ['window load', commas(d.usage.window_load)],
      ],
      foot: 'active context span — input + cache held this window',
    };
  },
  load(d) {
    return {
      value: `${pct(d.load)}<span class="unit">%</span>`,
      title: 'LOAD',
      rows: [
        ['window load', commas(d.usage.window_load)],
        ['context limit', commas(d.context_limit)],
        ['pressure', `${pct(d.load)}%`],
        ['status', d.status],
      ],
      foot: 'token pressure — share of the context window in use',
    };
  },
  pulse(d) {
    return {
      value: d.signals.pulse,
      word: true,
      title: 'PULSE',
      rows: [
        ['pulse tokens', commas(d.usage.pulse_tokens)],
        ['input', commas(d.usage.input_tokens)],
        ['output', commas(d.usage.output_tokens)],
        ['rhythm', d.signals.pulse],
      ],
      foot: 'turn rhythm — input + output moved on the last turn',
    };
  },
  cache(d) {
    return {
      value: `${pct(d.usage.cache_read_ratio)}<span class="unit">%</span>`,
      title: 'CACHE',
      rows: [
        ['cache read', commas(d.usage.cache_read_input_tokens)],
        ['cache create', commas(d.usage.cache_creation_input_tokens)],
        ['read ratio', `${pct(d.usage.cache_read_ratio)}%`],
      ],
      foot: 'read efficiency — reused cache vs freshly created',
    };
  },
  drift(d) {
    return {
      value: d.signals.drift,
      word: true,
      title: 'DRIFT',
      rows: [
        ['drift', d.signals.drift],
        ['offset ratio', `${pct(d.signals.drift_ratio)}%`],
        ['cache create', commas(d.usage.cache_creation_input_tokens)],
      ],
      foot: 'semantic offset — how much context is being rebuilt',
    };
  },
  handover(d) {
    const c = compact(d.handover.tokens_left_to_full);
    return {
      value: `${c.num}<span class="unit">${c.unit.toUpperCase()}</span>`,
      title: 'HANDOVER',
      rows: [
        ['to warning', commas(d.handover.tokens_left_to_warning)],
        ['to danger', commas(d.handover.tokens_left_to_danger)],
        ['to full', commas(d.handover.tokens_left_to_full)],
      ],
      foot: 'left before reset — headroom until the window is full',
    };
  },
};

/* ---- render ---- */
function renderCells(d) {
  document.querySelectorAll('.cell').forEach((cell) => {
    const block = cell.dataset.block;
    const def = BLOCKS[block](d);
    const valEl = cell.querySelector('[data-field="value"]');
    valEl.innerHTML = def.value;
    valEl.classList.toggle('is-word', !!def.word);
  });
}

function renderPanel(d) {
  const now = document.getElementById('panelNow');
  const max = document.getElementById('panelMax');
  const status = document.getElementById('panelStatus');
  const rows = document.getElementById('panelRows');
  const foot = document.getElementById('panelFoot');
  const panel = document.getElementById('panel');
  panel.classList.remove('is-error');

  now.textContent = commas(d.usage.window_load);
  max.textContent = commas(d.context_limit);

  if (activeBlock === 'summary') {
    status.textContent = d.status;
    foot.textContent = d.model ? `model · ${d.model}` : 'session monitor';
    setRows(rows, [
      ['context used', `${pct(d.load)}%`],
      ['last turn', signed(d.usage.pulse_tokens)],
      ['cache read', `${pct(d.usage.cache_read_ratio)}%`],
      ['handover', `${compact(d.handover.tokens_left_to_full).num}${compact(d.handover.tokens_left_to_full).unit.toUpperCase()} left`],
    ]);
  } else {
    const def = BLOCKS[activeBlock](d);
    status.textContent = def.title;
    foot.textContent = def.foot;
    setRows(rows, def.rows);
  }
}

function setRows(container, pairs) {
  container.innerHTML = '';
  for (const [k, v] of pairs) {
    const row = document.createElement('div');
    row.className = 'panel-row';
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    row.append(dt, dd);
    container.appendChild(row);
  }
}

function renderError(payload) {
  const status = document.getElementById('panelStatus');
  const rows = document.getElementById('panelRows');
  const foot = document.getElementById('panelFoot');
  const panel = document.getElementById('panel');
  panel.classList.add('is-error');
  document.getElementById('panelNow').textContent = '—';
  document.getElementById('panelMax').textContent = '—';
  status.textContent = 'NO SIGNAL';
  setRows(rows, [['reason', payload && payload.error ? payload.error : 'unavailable']]);
  foot.textContent = 'waiting for a readable session log';
  document.querySelectorAll('.cell-value').forEach((el) => {
    el.textContent = '—';
    el.classList.remove('is-word');
  });
}

function render() {
  if (!current || !current.ok) {
    renderError(current);
    return;
  }
  const mark = document.getElementById('statusMark');
  mark.dataset.status = current.status;
  renderCells(current);
  renderPanel(current);
}

/* ---- interaction ---- */
document.querySelectorAll('.cell').forEach((cell) => {
  cell.addEventListener('click', () => {
    const block = cell.dataset.block;
    if (activeBlock === block) {
      activeBlock = 'summary';
    } else {
      activeBlock = block;
    }
    document.querySelectorAll('.cell').forEach((c) =>
      c.classList.toggle('is-active', c === cell && activeBlock === block)
    );
    if (current && current.ok) renderPanel(current);
  });
});

/* ---- data ---- */
async function load() {
  try {
    const res = await fetch('/api/session-monitor', { cache: 'no-store' });
    current = await res.json();
  } catch (err) {
    current = { ok: false, error: 'fetch failed' };
  }
  render();
}

load();
setInterval(load, REFRESH_MS);
