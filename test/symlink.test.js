'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getSessionMonitor, collectJsonlFiles } = require('../src/parser');

const USAGE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    model: 'claude-test',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 0,
    },
  },
});

let base;
let root;
let outside;
let goodFile;
let linkFile; // root/link.jsonl -> outside/ext.jsonl
let linkDir; // root/linkdir   -> outside/

before(() => {
  // realpath the temp base: on some platforms /tmp is itself a symlink.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-')));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);

  goodFile = path.join(root, 'good.jsonl');
  fs.writeFileSync(goodFile, USAGE_LINE + '\n');

  const extFile = path.join(outside, 'ext.jsonl');
  fs.writeFileSync(extFile, USAGE_LINE + '\n');

  linkFile = path.join(root, 'link.jsonl');
  fs.symlinkSync(extFile, linkFile);

  linkDir = path.join(root, 'linkdir');
  fs.symlinkSync(outside, linkDir);

  // Make the external (linked) files NEWER so a naive scan would prefer them.
  const newer = Date.now() / 1000 + 100;
  fs.utimesSync(extFile, newer, newer);
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

test('explicit jsonl that is a symlink escaping the root is rejected', () => {
  const out = getSessionMonitor({ projectsRoot: root, jsonlPath: linkFile });
  assert.equal(out.ok, false);
  assert.match(out.error, /escapes projects root/);
});

test('workspace that is a symlink pointing outside the root is rejected', () => {
  const out = getSessionMonitor({ projectsRoot: root, workspace: 'linkdir' });
  assert.equal(out.ok, false);
  assert.match(out.error, /escapes projects root/);
});

test('latest scan skips escaping symlinks and uses the in-root file', () => {
  const out = getSessionMonitor({ projectsRoot: root });
  assert.equal(out.ok, true);
  // even though the linked external file is newer, the real in-root file wins
  assert.equal(out.jsonl_path, goodFile);
  assert.equal(out.usage.window_load, 30);
});

test('collectJsonlFiles does not follow symlinks escaping the root', () => {
  const files = collectJsonlFiles(root);
  const names = files.map((f) => path.basename(f.path)).sort();
  assert.deepEqual(names, ['good.jsonl']);
});

test('a real in-root jsonl is read normally', () => {
  const out = getSessionMonitor({ projectsRoot: root, jsonlPath: goodFile });
  assert.equal(out.ok, true);
  assert.equal(out.model, 'claude-test');
  assert.equal(out.usage.window_load, 30);
});
