'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createApp, isAuthorized } = require('../src/server');

const FIXTURES = path.join(__dirname, 'fixtures');

function fakeReq(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { get: (name) => lower[name.toLowerCase()] };
}

test('isAuthorized allows all when no token configured (dev mode)', () => {
  delete process.env.SESSION_MONITOR_TOKEN;
  assert.equal(isAuthorized(fakeReq()), true);
});

test('isAuthorized enforces matching bearer token when configured', () => {
  process.env.SESSION_MONITOR_TOKEN = 's3cret';
  try {
    assert.equal(isAuthorized(fakeReq()), false);
    assert.equal(isAuthorized(fakeReq({ Authorization: 'Bearer wrong' })), false);
    assert.equal(isAuthorized(fakeReq({ Authorization: 'Basic s3cret' })), false);
    assert.equal(isAuthorized(fakeReq({ Authorization: 'Bearer s3cret' })), true);
  } finally {
    delete process.env.SESSION_MONITOR_TOKEN;
  }
});

test('GET /api/session-monitor returns 401 without bearer when token set', async () => {
  process.env.SESSION_MONITOR_TOKEN = 'tok-abc';
  const app = createApp();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const noAuth = await fetch(`${base}/api/session-monitor`);
    assert.equal(noAuth.status, 401);
    const body = await noAuth.json();
    assert.equal(body.ok, false);
    // token value must never leak into the response
    assert.equal(JSON.stringify(body).includes('tok-abc'), false);

    const badAuth = await fetch(`${base}/api/session-monitor`, {
      headers: { Authorization: 'Bearer nope' },
    });
    assert.equal(badAuth.status, 401);

    // Correct bearer gets past auth (404 here: fixtures aren't the live root).
    const ok = await fetch(`${base}/api/session-monitor`, {
      headers: { Authorization: 'Bearer tok-abc' },
    });
    assert.notEqual(ok.status, 401);
  } finally {
    server.close();
    delete process.env.SESSION_MONITOR_TOKEN;
  }
});
