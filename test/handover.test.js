'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getRecentConversationTurns,
  generateHandoverPreview,
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
  assert.ok(longTurn.text.length <= 1500 + 20);
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
  assert.match(out.error, /missing ZHIPU_API_KEY/);
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
