'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getRecentConversationTurns,
  generateHandoverPreview,
  saveHandoverPreview,
  buildHandoverPrompt,
  extractProviderUsage,
  humanizeError,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_INPUT_CHARS,
  DEFAULT_MAX_MSG_CHARS,
} = require('../src/handover');
const { createApp } = require('../src/server');

const USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 200,
  cache_creation_input_tokens: 0,
};

const LONG = 'L'.repeat(3000);

let root;
let convo;

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ho-')));
  convo = path.join(root, 'conversation.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: '请帮我修复登录 bug' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-test',
        usage: USAGE,
        content: [
          { type: 'text', text: '好的，我先看看 auth.js' },
          { type: 'tool_use', name: 'Read', input: { file: 'TOOL_INPUT_LEAK_TOKEN' } },
        ],
      },
    },
    {
      // purely a tool result -> no text -> must be skipped entirely
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOL_RESULT_LEAK_TOKEN' }] },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', usage: USAGE, content: [{ type: 'text', text: '修好了，问题在于 token 校验' }] },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: LONG }] },
    },
  ];
  fs.writeFileSync(convo, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('getRecentConversationTurns extracts only user/assistant text', () => {
  const r = getRecentConversationTurns({ projectsRoot: root, jsonlPath: convo });
  assert.equal(r.ok, true);
  // user1, assistant2(text only), assistant4, assistant5 -> 4 turns
  // the pure tool_result user turn is dropped
  assert.equal(r.turns.length, 4);
  assert.equal(r.source.selected_turns, 4);
  const blob = JSON.stringify(r.turns);
  assert.equal(blob.includes('TOOL_INPUT_LEAK_TOKEN'), false);
  assert.equal(blob.includes('TOOL_RESULT_LEAK_TOKEN'), false);
});

test('per-message text is truncated to the cap', () => {
  const r = getRecentConversationTurns({ projectsRoot: root, jsonlPath: convo });
  const longTurn = r.turns[r.turns.length - 1];
  assert.ok(longTurn.text.length <= 1800 + 20); // default cap is 1800
  assert.match(longTurn.text, /\[truncated\]/);
});

test('total input chars budget trims oldest turns', () => {
  const r = getRecentConversationTurns({
    projectsRoot: root,
    jsonlPath: convo,
    maxMsgChars: 20,
    maxInputChars: 30,
  });
  assert.equal(r.ok, true);
  assert.ok(r.source.selected_turns < 4);
  assert.ok(r.source.selected_turns >= 1);
  assert.ok(r.source.total_chars <= 30 || r.source.selected_turns === 1);
});

test('default context budgets are 40 / 20000 / 1800', () => {
  assert.equal(DEFAULT_MAX_TURNS, 40);
  assert.equal(DEFAULT_MAX_INPUT_CHARS, 20000);
  assert.equal(DEFAULT_MAX_MSG_CHARS, 1800);
});

test('buildHandoverPrompt frames next-window continuity, no tool content', () => {
  const r = getRecentConversationTurns({ projectsRoot: root, jsonlPath: convo });
  const prompt = buildHandoverPrompt(r.turns, { status: 'CLEAR', window_load: 350, context_limit: 200000 });
  assert.ok(prompt.includes('给下一个窗口的交接'));
  assert.ok(prompt.includes('下一窗口应该怎么接'));
  assert.ok(prompt.includes('不要重复踩的坑'));
  // the transcript embedded in the prompt must never carry tool content
  assert.equal(prompt.includes('TOOL_INPUT_LEAK_TOKEN'), false);
  assert.equal(prompt.includes('TOOL_RESULT_LEAK_TOKEN'), false);
});

test('mock provider needs no API key and returns ok', async () => {
  delete process.env.ZHIPU_API_KEY;
  const out = await generateHandoverPreview({
    projectsRoot: root,
    jsonlPath: convo,
    provider: 'mock',
  });
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'mock');
  assert.equal(out.model, 'mock');
  assert.match(out.handover, /mock/i);
  assert.ok(out.handover.includes('给下一个窗口的交接')); // new continuity structure
  assert.ok(out.handover.includes('下一窗口应该怎么接'));
  assert.equal(out.source.selected_turns, 4);
  assert.equal(typeof out.monitor.status, 'string');
  // never leak raw tool content / conversation transcript
  const blob = JSON.stringify(out);
  assert.equal(blob.includes('TOOL_INPUT_LEAK_TOKEN'), false);
  assert.equal(blob.includes('TOOL_RESULT_LEAK_TOKEN'), false);
});

test('zhipu provider without key returns a clear error', async () => {
  delete process.env.ZHIPU_API_KEY;
  const out = await generateHandoverPreview({
    projectsRoot: root,
    jsonlPath: convo,
    provider: 'zhipu',
  });
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'zhipu');
  assert.match(out.error, /missing ZHIPU_API_KEY/);
});

/* ---- zhipu provider token usage (fetch mocked, no real API call) ---- */

test('extractProviderUsage reads usage and tolerates absence', () => {
  assert.deepEqual(
    extractProviderUsage({ usage: { prompt_tokens: 19800, completion_tokens: 1600, total_tokens: 21400 } }),
    { prompt_tokens: 19800, completion_tokens: 1600, total_tokens: 21400 }
  );
  // missing fields default to 0
  assert.deepEqual(extractProviderUsage({ usage: { total_tokens: 5 } }), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 5,
  });
  // absent usage -> null, no throw
  assert.equal(extractProviderUsage({}), null);
  assert.equal(extractProviderUsage(null), null);
});

function withMockedFetch(impl, fn) {
  const real = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = real;
    });
}

test('zhipu success surfaces provider_usage when the model returns usage', async () => {
  process.env.ZHIPU_API_KEY = 'test-key';
  try {
    await withMockedFetch(
      async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '# 给下一个窗口的交接\n内容' } }],
          usage: { prompt_tokens: 19800, completion_tokens: 1600, total_tokens: 21400 },
        }),
      }),
      async () => {
        const out = await generateHandoverPreview({ projectsRoot: root, jsonlPath: convo, provider: 'zhipu' });
        assert.equal(out.ok, true);
        assert.equal(out.provider, 'zhipu');
        assert.deepEqual(out.provider_usage, {
          prompt_tokens: 19800,
          completion_tokens: 1600,
          total_tokens: 21400,
        });
        // the API key must never leak into the payload
        assert.equal(JSON.stringify(out).includes('test-key'), false);
      }
    );
  } finally {
    delete process.env.ZHIPU_API_KEY;
  }
});

test('zhipu success with no usage yields provider_usage=null, no error', async () => {
  process.env.ZHIPU_API_KEY = 'test-key';
  try {
    await withMockedFetch(
      async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '内容' } }] }),
      }),
      async () => {
        const out = await generateHandoverPreview({ projectsRoot: root, jsonlPath: convo, provider: 'zhipu' });
        assert.equal(out.ok, true);
        assert.equal(out.provider_usage, null);
      }
    );
  } finally {
    delete process.env.ZHIPU_API_KEY;
  }
});

test('zhipu save records provider_usage in latest.json and latest.md', async () => {
  const outDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hout-')));
  process.env.ZHIPU_API_KEY = 'test-key';
  process.env.HANDOVER_OUT_DIR = outDir;
  try {
    await withMockedFetch(
      async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '# 给下一个窗口的交接\n内容' } }],
          usage: { prompt_tokens: 19800, completion_tokens: 1600, total_tokens: 21400 },
        }),
      }),
      async () => {
        const out = await saveHandoverPreview({ projectsRoot: root, jsonlPath: convo, provider: 'zhipu' });
        assert.equal(out.ok, true);
        assert.deepEqual(out.provider_usage, {
          prompt_tokens: 19800,
          completion_tokens: 1600,
          total_tokens: 21400,
        });
        const json = JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8'));
        assert.deepEqual(json.provider_usage, {
          prompt_tokens: 19800,
          completion_tokens: 1600,
          total_tokens: 21400,
        });
        const md = fs.readFileSync(path.join(outDir, 'latest.md'), 'utf8');
        assert.match(md, /provider\.prompt_tokens: 19800/);
        assert.match(md, /provider\.completion_tokens: 1600/);
        assert.match(md, /provider\.total_tokens: 21400/);
        assert.equal((md + JSON.stringify(json)).includes('test-key'), false);
      }
    );
  } finally {
    delete process.env.ZHIPU_API_KEY;
    delete process.env.HANDOVER_OUT_DIR;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('save reuses a provided payload and never calls the model', async () => {
  const outDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hout-')));
  process.env.HANDOVER_OUT_DIR = outDir;
  delete process.env.ZHIPU_API_KEY;
  // any model call would go through fetch — make it throw to prove we don't
  const realFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('model must not be called when saving an existing payload');
  };
  try {
    const payload = {
      provider: 'zhipu',
      model: 'glm-4.5-air',
      handover: '# 给下一个窗口的交接\nSAVED_VERBATIM_MARKER',
      source: { jsonl_path: '/x/c.jsonl', workspace: null, selected_turns: 7, total_chars: 1234 },
      monitor: { status: 'WATCH', window_load: 5, context_limit: 200000 },
      provider_usage: { prompt_tokens: 4800, completion_tokens: 200, total_tokens: 5000 },
      updated_at: '2026-06-07T00:00:00.000Z',
    };
    // provider says zhipu and there is no key, yet save succeeds: no generation
    const out = await saveHandoverPreview({ provider: 'zhipu', payload });
    assert.equal(out.ok, true);
    assert.deepEqual(out.provider_usage, { prompt_tokens: 4800, completion_tokens: 200, total_tokens: 5000 });

    const json = JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8'));
    assert.ok(json.handover.includes('SAVED_VERBATIM_MARKER'));
    assert.equal(json.provider, 'zhipu');
    assert.equal(json.source.selected_turns, 7);
    assert.equal(json.consumed, false);

    const md = fs.readFileSync(path.join(outDir, 'latest.md'), 'utf8');
    assert.match(md, /provider\.total_tokens: 5000/);
    assert.match(md, /SAVED_VERBATIM_MARKER/);
  } finally {
    global.fetch = realFetch;
    delete process.env.HANDOVER_OUT_DIR;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('empty/whitespace handover payload falls back to generating', async () => {
  const outDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hout-')));
  process.env.HANDOVER_OUT_DIR = outDir;
  try {
    const out = await saveHandoverPreview({
      projectsRoot: root,
      jsonlPath: convo,
      provider: 'mock',
      payload: { handover: '   ' }, // not a real payload -> fallback
    });
    assert.equal(out.ok, true);
    assert.equal(out.provider, 'mock');
    const json = JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8'));
    assert.ok(json.handover.includes('给下一个窗口的交接'));
  } finally {
    delete process.env.HANDOVER_OUT_DIR;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('POST /api/handover/save accepts a payload and saves it verbatim', async () => {
  const outDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hout-')));
  process.env.HANDOVER_OUT_DIR = outDir;
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/handover/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: {
          provider: 'zhipu',
          model: 'glm-4.5-air',
          handover: '# 给下一个窗口的交接\nMARKER_API',
          source: { jsonl_path: '/x', workspace: null, selected_turns: 3, total_chars: 99 },
          monitor: { status: 'CLEAR', window_load: 1, context_limit: 200000 },
          provider_usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          updated_at: '2026-06-07T00:00:00.000Z',
        },
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.provider_usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    const json = JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8'));
    assert.ok(json.handover.includes('MARKER_API'));
  } finally {
    server.close();
    delete process.env.HANDOVER_OUT_DIR;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('save without HANDOVER_OUT_DIR returns stage=missing_out_dir', async () => {
  delete process.env.HANDOVER_OUT_DIR;
  const out = await saveHandoverPreview({ projectsRoot: root, jsonlPath: convo, provider: 'mock' });
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'missing_out_dir');
  assert.match(out.error, /HANDOVER_OUT_DIR is not configured/);
});

test('humanizeError never leaks paths/keys and stays clear', () => {
  assert.equal(humanizeError('missing_out_dir', 'x'), 'HANDOVER_OUT_DIR is not configured');
  assert.equal(
    humanizeError('write_handover', "EACCES: permission denied, open '/data/secret/latest.md'"),
    'Cannot write handover file. Check HANDOVER_OUT_DIR volume permissions.'
  );
  assert.equal(humanizeError('auth', null), 'Unauthorized. Provide a valid bearer token.');
  assert.equal(humanizeError('invalid_payload', undefined), 'Handover payload is missing a text body.');
  assert.match(humanizeError('zhipu', 'zhipu request timed out'), /timed out/);
  assert.match(humanizeError('read_jsonl', 'jsonl path escapes projects root'), /SESSION_MONITOR_PROJECTS/);
  // a write_handover message must not echo the absolute path it came from
  assert.equal(
    humanizeError('write_handover', "ENOSPC '/data/secret/x'").includes('/data/secret'),
    false
  );
});

test('write failure surfaces stage=write_handover (out dir is a file)', async () => {
  // point HANDOVER_OUT_DIR at a regular file so mkdir/write fails
  const tmpFile = path.join(fs.realpathSync(os.tmpdir()), `hof-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'not a dir');
  process.env.HANDOVER_OUT_DIR = tmpFile;
  try {
    const out = await saveHandoverPreview({ projectsRoot: root, jsonlPath: convo, provider: 'mock' });
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'write_handover');
    assert.match(out.error, /Cannot write handover file/);
    // never leak the absolute path in the message
    assert.equal(out.error.includes(tmpFile), false);
  } finally {
    delete process.env.HANDOVER_OUT_DIR;
    fs.rmSync(tmpFile, { force: true });
  }
});

test('zhipu timeout surfaces stage=zhipu', async () => {
  process.env.ZHIPU_API_KEY = 'test-key';
  const realFetch = global.fetch;
  global.fetch = async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  try {
    const out = await generateHandoverPreview({ projectsRoot: root, jsonlPath: convo, provider: 'zhipu' });
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'zhipu');
    assert.match(out.error, /timed out/);
  } finally {
    global.fetch = realFetch;
    delete process.env.ZHIPU_API_KEY;
  }
});

test('malformed payload (non-string handover) returns stage=invalid_payload', async () => {
  process.env.HANDOVER_OUT_DIR = fs.realpathSync(os.tmpdir());
  try {
    const out = await saveHandoverPreview({ payload: { handover: { not: 'a string' } } });
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'invalid_payload');
    assert.match(out.error, /missing a text body/);
  } finally {
    delete process.env.HANDOVER_OUT_DIR;
  }
});

test('mock save writes latest.md and latest.json with consumed=false', async () => {
  const outDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hout-')));
  process.env.HANDOVER_OUT_DIR = outDir;
  try {
    const out = await saveHandoverPreview({ projectsRoot: root, jsonlPath: convo, provider: 'mock' });
    assert.equal(out.ok, true);
    assert.equal(out.saved.markdown_path, path.join(outDir, 'latest.md'));
    assert.equal(out.saved.json_path, path.join(outDir, 'latest.json'));

    const md = fs.readFileSync(path.join(outDir, 'latest.md'), 'utf8');
    assert.match(md, /# Session Handover/);
    assert.match(md, /provider: mock/);
    assert.match(md, /selected_turns: 4/);
    // mock has no provider usage -> markdown notes it as unavailable
    assert.match(md, /provider\.tokens: unavailable/);

    const json = JSON.parse(fs.readFileSync(path.join(outDir, 'latest.json'), 'utf8'));
    assert.equal(json.ok, true);
    assert.equal(json.consumed, false);
    assert.equal(json.provider, 'mock');
    assert.equal(json.provider_usage, null);
    assert.equal(out.provider_usage, null);
    assert.equal(json.source.selected_turns, 4);
    assert.ok(typeof json.handover === 'string' && json.handover.length > 0);

    // no leftover temp files; only the two finals
    const left = fs.readdirSync(outDir).sort();
    assert.deepEqual(left, ['latest.json', 'latest.md']);

    // never leak tool content into either file
    const blob = md + JSON.stringify(json);
    assert.equal(blob.includes('TOOL_INPUT_LEAK_TOKEN'), false);
    assert.equal(blob.includes('TOOL_RESULT_LEAK_TOKEN'), false);
  } finally {
    delete process.env.HANDOVER_OUT_DIR;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('POST /api/handover/save reuses bearer auth (401 without token)', async () => {
  const outDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hout-')));
  process.env.SESSION_MONITOR_TOKEN = 'sv-tok';
  process.env.SESSION_MONITOR_PROJECTS = root;
  process.env.HANDOVER_OUT_DIR = outDir;
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const noAuth = await fetch(`${base}/api/handover/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'mock' }),
    });
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`${base}/api/handover/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sv-tok' },
      body: JSON.stringify({ provider: 'mock' }),
    });
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.equal(data.ok, true);
    assert.ok(data.saved.markdown_path.endsWith('latest.md'));
    assert.ok(fs.existsSync(path.join(outDir, 'latest.json')));
  } finally {
    server.close();
    delete process.env.SESSION_MONITOR_TOKEN;
    delete process.env.SESSION_MONITOR_PROJECTS;
    delete process.env.HANDOVER_OUT_DIR;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('POST /api/handover/preview reuses bearer auth (401 without token)', async () => {
  process.env.SESSION_MONITOR_TOKEN = 'ho-tok';
  process.env.SESSION_MONITOR_PROJECTS = root;
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const noAuth = await fetch(`${base}/api/handover/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'mock' }),
    });
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`${base}/api/handover/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ho-tok' },
      body: JSON.stringify({ provider: 'mock' }),
    });
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.equal(data.ok, true);
    assert.equal(data.provider, 'mock');
  } finally {
    server.close();
    delete process.env.SESSION_MONITOR_TOKEN;
    delete process.env.SESSION_MONITOR_PROJECTS;
  }
});
