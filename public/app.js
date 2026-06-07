'use strict';

const REFRESH_MS = 15000;
let current = null;
let activeBlock = 'summary';
let handoverState = { loading: false, error: null, stage: null, text: null, meta: null };
let saveState = { loading: false, error: null, stage: null, saved: null };

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
  renderHandover();
}

/* ---- handover: panel entry shows only on the HANDOVER block ---- */
function renderHandover() {
  document.getElementById('handoverZone').hidden = activeBlock !== 'handover';
  renderSheet();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

function tokensStr(n) {
  const c = compact(n);
  return c.num + c.unit;
}

// "stage · message", never printing undefined/null
function errorLine(stage, message) {
  const msg = message ? String(message) : 'unknown error';
  return stage ? `${stage} · ${msg}` : msg;
}

// Base line + optional lighter token line, folded into the existing meta.
function metaHtml(m) {
  const base = escapeHtml(
    `${m.provider} · ${m.model} · ${m.source.selected_turns} turns / ${m.source.total_chars} chars`
  );
  const pu = m.provider_usage;
  if (pu) {
    const line = `${tokensStr(pu.total_tokens)} tokens · prompt ${tokensStr(pu.prompt_tokens)} / completion ${tokensStr(pu.completion_tokens)}`;
    return `${base}<br><span class="meta-tokens">${escapeHtml(line)}</span>`;
  }
  // mock: no token line; zhipu without usage: a faint "unavailable"
  if (m.provider === 'mock') return base;
  return `${base}<br><span class="meta-tokens">tokens unavailable</span>`;
}

/* ---- handover: frosted action sheet ---- */
function renderSheet() {
  const btn = document.getElementById('handoverBtn');
  const saveBtn = document.getElementById('handoverSaveBtn');
  const meta = document.getElementById('handoverMeta');
  const errEl = document.getElementById('handoverError');
  const saved = document.getElementById('handoverSaved');
  const out = document.getElementById('handoverOut');

  const busy = handoverState.loading || saveState.loading;
  btn.disabled = busy;
  btn.textContent = handoverState.loading ? 'GENERATING…' : 'GENERATE PREVIEW';
  saveBtn.disabled = busy;
  saveBtn.textContent = saveState.loading ? 'SAVING…' : 'SAVE LATEST';

  const m = handoverState.meta || saveState.saved;
  if (m) {
    meta.innerHTML = metaHtml(m);
  } else {
    meta.textContent = 'no preview yet';
  }

  // single hideable error line: stage · message (most recent action wins)
  if (saveState.error) {
    errEl.hidden = false;
    errEl.textContent = errorLine(saveState.stage, saveState.error);
  } else if (handoverState.error) {
    errEl.hidden = false;
    errEl.textContent = errorLine(handoverState.stage, handoverState.error);
  } else {
    errEl.hidden = true;
    errEl.textContent = '';
  }

  // SAVED block — success only, short line (meta already shows the details)
  if (saveState.saved) {
    const s = saveState.saved;
    saved.hidden = false;
    const md = s.saved.markdown_path.split('/').pop();
    const js = s.saved.json_path.split('/').pop();
    saved.textContent = `saved · ${md} / ${js}`;
  } else {
    saved.hidden = true;
    saved.textContent = '';
  }

  // preview body — success only
  if (handoverState.text) {
    out.hidden = false;
    out.textContent = handoverState.text;
  } else {
    out.hidden = true;
    out.textContent = '';
  }
}

function openSheet() {
  document.getElementById('sheetBackdrop').hidden = false;
  document.getElementById('handoverSheet').hidden = false;
  renderSheet();
}

function closeSheet() {
  document.getElementById('sheetBackdrop').hidden = true;
  document.getElementById('handoverSheet').hidden = true;
}

async function runHandover() {
  if (handoverState.loading) return;
  handoverState = { loading: true, error: null, stage: null, text: null, meta: null };
  saveState = { loading: false, error: null, stage: null, saved: null }; // a new preview makes prior save stale
  renderSheet();
  try {
    const res = await fetch('/api/handover/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data && data.ok) {
      handoverState = { loading: false, error: null, stage: null, text: data.handover, meta: data };
    } else {
      handoverState = {
        loading: false,
        error: (data && data.error) || 'failed',
        stage: (data && data.stage) || null,
        text: null,
        meta: null,
      };
    }
  } catch (_err) {
    handoverState = { loading: false, error: 'request failed', stage: 'unknown', text: null, meta: null };
  }
  renderSheet();
}

async function runHandoverSave() {
  if (saveState.loading || handoverState.loading) return;
  saveState = { loading: true, error: null, stage: null, saved: null };
  handoverState = { ...handoverState, error: null, stage: null }; // don't let a stale preview error mask the save result
  renderSheet();
  try {
    // Reuse the preview we already paid tokens for, if there is one — saving
    // it costs zero model calls. Fall back to generate-then-save otherwise.
    const body = handoverState.meta ? { payload: handoverState.meta } : {};
    const res = await fetch('/api/handover/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data && data.ok) {
      saveState = { loading: false, error: null, stage: null, saved: data };
    } else {
      saveState = {
        loading: false,
        error: (data && data.error) || 'failed',
        stage: (data && data.stage) || null,
        saved: null,
      };
    }
  } catch (_err) {
    saveState = { loading: false, error: 'request failed', stage: 'unknown', saved: null };
  }
  renderSheet();
}

document.getElementById('handoverBtn').addEventListener('click', runHandover);
document.getElementById('handoverSaveBtn').addEventListener('click', runHandoverSave);
document.getElementById('handoverPrepareBtn').addEventListener('click', openSheet);
document.getElementById('sheetCloseBtn').addEventListener('click', closeSheet);
document.getElementById('sheetBackdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

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
  document.getElementById('handoverZone').hidden = true;
  closeSheet();
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
    closeSheet();
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
