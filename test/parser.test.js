'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  extractUsage,
  computeUsage,
  readUsageFromFile,
  getSessionMonitor,
} = require('../src/parser');

const FIXTURES = path.join(__dirname, 'fixtures');
const f = (name) => path.join(FIXTURES, name);

test('extractUsage reads obj.message.usage', () => {
  const usage = extractUsage({ message: { usage: { input_tokens: 5 } } });
  assert.equal(usage.input_tokens, 5);
});

test('extractUsage falls back to obj.usage', () => {
  const usage = extractUsage({ usage: { input_tokens: 9 } });
  assert.equal(usage.input_tokens, 9);
});

test('extractUsage returns null when absent', () => {
  assert.equal(extractUsage({ message: { content: 'x' } }), null);
  assert.equal(extractUsage(null), null);
});

test('computeUsage derives window load, pulse and ratios', () => {
  const u = computeUsage({
    input_tokens: 3204,
    output_tokens: 2100,
    cache_read_input_tokens: 78843,
    cache_creation_input_tokens: 2100,
  });
  assert.equal(u.window_load, 3204 + 78843 + 2100);
  assert.equal(u.pulse_tokens, 3204 + 2100);
  assert.equal(u.cache_total, 78843 + 2100);
  assert.ok(Math.abs(u.cache_read_ratio - 78843 / (78843 + 2100)) < 1e-9);
});

test('computeUsage tolerates missing fields', () => {
  const u = computeUsage({ input_tokens: 10 });
  assert.equal(u.output_tokens, 0);
  assert.equal(u.cache_read_input_tokens, 0);
  assert.equal(u.window_load, 10);
  // cache_total is 0 -> guarded by max(.,1), ratio is 0
  assert.equal(u.cache_read_ratio, 0);
});

test('readUsageFromFile picks the LAST usage record', () => {
  const r = readUsageFromFile(f('message-usage.jsonl'));
  assert.equal(r.found, true);
  assert.equal(r.last.usage.input_tokens, 3204);
  assert.equal(r.model, 'claude-opus-4-8');
});

test('readUsageFromFile handles top-level usage shape', () => {
  const r = readUsageFromFile(f('top-level-usage.jsonl'));
  assert.equal(r.found, true);
  assert.equal(r.last.usage.cache_read_input_tokens, 12000);
});

test('readUsageFromFile reports not found and skips bad json', () => {
  const r = readUsageFromFile(f('no-usage.jsonl'));
  assert.equal(r.found, false);
});

test('getSessionMonitor builds full payload from message.usage', () => {
  const out = getSessionMonitor({ jsonlPath: f('message-usage.jsonl') });
  assert.equal(out.ok, true);
  assert.equal(out.model, 'claude-opus-4-8');
  assert.equal(out.context_limit, 200000);
  assert.equal(out.usage.window_load, 84147);
  assert.equal(out.usage.pulse_tokens, 5304);
  assert.equal(out.status, 'CLEAR');
  assert.equal(out.handover.tokens_left_to_full, 200000 - 84147);
  assert.ok(Array.isArray(out.recent_turns));
  assert.equal(out.recent_turns.length, 2);
  // never leak content
  assert.equal(JSON.stringify(out).includes('redacted'), false);
});

test('getSessionMonitor returns clear error when no usage present', () => {
  const out = getSessionMonitor({ jsonlPath: f('no-usage.jsonl') });
  assert.equal(out.ok, false);
  assert.match(out.error, /no usage record/);
});

test('getSessionMonitor returns clear error when file missing', () => {
  const out = getSessionMonitor({ jsonlPath: f('does-not-exist.jsonl') });
  assert.equal(out.ok, false);
  assert.match(out.error, /not found/);
});

test('status crosses to WATCH and HANDOVER with smaller limits', () => {
  const watch = getSessionMonitor({
    jsonlPath: f('message-usage.jsonl'),
    contextLimit: 110000,
  });
  assert.equal(watch.status, 'WATCH');
  const handover = getSessionMonitor({
    jsonlPath: f('message-usage.jsonl'),
    contextLimit: 95000,
  });
  assert.equal(handover.status, 'HANDOVER');
});
