'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readClaudeUsage, getSessionMonitor } = require('../src/parser');

const FIXTURES = path.join(__dirname, 'fixtures');

function tmpUsageFile(obj) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')));
  const file = path.join(dir, 'claude_usage.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return { dir, file };
}

const made = [];
function track(t) {
  made.push(t.dir);
  return t.file;
}

afterEach(() => {
  delete process.env.CLAUDE_USAGE_PATH;
  delete process.env.CLAUDE_USAGE_MAX_AGE_MS;
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

test('readClaudeUsage returns null when no path configured', () => {
  delete process.env.CLAUDE_USAGE_PATH;
  assert.equal(readClaudeUsage(), null);
});

test('readClaudeUsage returns null when the file is missing', () => {
  assert.equal(readClaudeUsage({ path: '/nope/claude_usage.json' }), null);
});

test('readClaudeUsage reads a fresh snapshot and keeps only whitelisted fields', () => {
  const file = track(
    tmpUsageFile({
      updated_at: new Date().toISOString(),
      five_hour: { used_percentage: 13, resets_at: '2026-06-07T06:30:00.000Z' },
      seven_day: { used_percentage: 35, resets_at: '2026-06-12T01:00:00.000Z' },
      // fields that must never be echoed:
      account_email: 'secret@example.com',
      token: 'sk-should-not-appear',
    })
  );
  const u = readClaudeUsage({ path: file });
  assert.equal(u.five_hour.used_percentage, 13);
  assert.equal(u.seven_day.used_percentage, 35);
  assert.equal(u.five_hour.resets_at, '2026-06-07T06:30:00.000Z');
  assert.deepEqual(Object.keys(u).sort(), ['five_hour', 'seven_day', 'updated_at']);
  const blob = JSON.stringify(u);
  assert.equal(blob.includes('secret@example.com'), false);
  assert.equal(blob.includes('sk-should-not-appear'), false);
});

test('readClaudeUsage returns null on invalid JSON', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')));
  made.push(dir);
  const file = path.join(dir, 'claude_usage.json');
  fs.writeFileSync(file, '{ not json');
  assert.equal(readClaudeUsage({ path: file }), null);
});

test('readClaudeUsage returns null when required fields are missing', () => {
  const file = track(tmpUsageFile({ updated_at: new Date().toISOString(), five_hour: {} }));
  assert.equal(readClaudeUsage({ path: file }), null);
});

test('readClaudeUsage treats a stale snapshot as null', () => {
  const file = track(
    tmpUsageFile({
      updated_at: '2000-01-01T00:00:00.000Z',
      five_hour: { used_percentage: 13, resets_at: null },
      seven_day: { used_percentage: 35, resets_at: null },
    })
  );
  assert.equal(readClaudeUsage({ path: file }), null);
});

test('CLAUDE_USAGE_MAX_AGE_MS=0 disables the staleness check', () => {
  const file = track(
    tmpUsageFile({
      updated_at: '2000-01-01T00:00:00.000Z',
      five_hour: { used_percentage: 1, resets_at: null },
      seven_day: { used_percentage: 2, resets_at: null },
    })
  );
  process.env.CLAUDE_USAGE_MAX_AGE_MS = '0';
  const u = readClaudeUsage({ path: file });
  assert.equal(u.five_hour.used_percentage, 1);
});

test('getSessionMonitor includes claude_usage when CLAUDE_USAGE_PATH is set', () => {
  const file = track(
    tmpUsageFile({
      updated_at: new Date().toISOString(),
      five_hour: { used_percentage: 13, resets_at: null },
      seven_day: { used_percentage: 35, resets_at: null },
    })
  );
  process.env.CLAUDE_USAGE_PATH = file;
  const out = getSessionMonitor({
    projectsRoot: FIXTURES,
    jsonlPath: path.join(FIXTURES, 'message-usage.jsonl'),
  });
  assert.equal(out.ok, true);
  assert.equal(out.claude_usage.five_hour.used_percentage, 13);
});

test('getSessionMonitor claude_usage is null when no snapshot is configured', () => {
  delete process.env.CLAUDE_USAGE_PATH;
  const out = getSessionMonitor({
    projectsRoot: FIXTURES,
    jsonlPath: path.join(FIXTURES, 'message-usage.jsonl'),
  });
  assert.equal(out.ok, true);
  assert.equal(out.claude_usage, null);
});
