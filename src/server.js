'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { getSessionMonitor } = require('./parser');
const { generateHandoverPreview, saveHandoverPreview } = require('./handover');

/**
 * Minimal bearer auth. If SESSION_MONITOR_TOKEN is set, requests must carry
 * `Authorization: Bearer <token>`. If it is unset, access is allowed (local
 * dev mode). The token value is never logged or returned.
 */
function isAuthorized(req) {
  const expected = process.env.SESSION_MONITOR_TOKEN;
  if (!expected) return true; // dev mode: no token configured
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const want = Buffer.from(expected);
  return provided.length === want.length && crypto.timingSafeEqual(provided, want);
}

function createApp() {
  const app = express();

  // Read-only session monitor endpoint. Returns usage metrics only.
  app.get('/api/session-monitor', (req, res) => {
    if (!isAuthorized(req)) {
      return res
        .status(401)
        .set('WWW-Authenticate', 'Bearer')
        .json({ ok: false, error: 'unauthorized' });
    }
    const options = {
      workspace: req.query.workspace || undefined,
      jsonlPath: req.query.jsonl || undefined,
      projectsRoot: process.env.SESSION_MONITOR_PROJECTS || undefined,
      contextLimit: req.query.limit ? Number(req.query.limit) : undefined,
    };
    let payload;
    try {
      payload = getSessionMonitor(options);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.status(payload.ok ? 200 : 404).json(payload);
  });

  // Manual handover preview. Generates a draft summary only — no save, no
  // inject, no window control. Reuses the same bearer auth.
  app.post('/api/handover/preview', express.json({ limit: '16kb' }), async (req, res) => {
    if (!isAuthorized(req)) {
      return res
        .status(401)
        .set('WWW-Authenticate', 'Bearer')
        .json({ ok: false, error: 'unauthorized' });
    }
    const body = req.body || {};
    const options = {
      workspace: body.workspace || undefined,
      jsonlPath: body.jsonl || undefined,
      projectsRoot: process.env.SESSION_MONITOR_PROJECTS || undefined,
      turns: body.turns ? Number(body.turns) : undefined,
      provider: body.provider || undefined,
    };
    let payload;
    try {
      payload = await generateHandoverPreview(options);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.status(payload.ok ? 200 : 400).json(payload);
  });

  // Save a handover to HANDOVER_OUT_DIR (latest.md + latest.json). If the body
  // carries an already-generated preview payload, it is saved as-is with no
  // model call; otherwise a fresh preview is generated. Save only — no window
  // switching, no hook changes. Reuses bearer auth.
  app.post('/api/handover/save', express.json({ limit: '256kb' }), async (req, res) => {
    if (!isAuthorized(req)) {
      return res
        .status(401)
        .set('WWW-Authenticate', 'Bearer')
        .json({ ok: false, error: 'unauthorized' });
    }
    const body = req.body || {};
    const options = {
      workspace: body.workspace || undefined,
      jsonlPath: body.jsonl || undefined,
      projectsRoot: process.env.SESSION_MONITOR_PROJECTS || undefined,
      turns: body.turns ? Number(body.turns) : undefined,
      provider: body.provider || undefined,
      payload: body.payload || undefined,
    };
    let result;
    try {
      result = await saveHandoverPreview(options);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  const app = createApp();
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`session monitor listening on http://localhost:${port}`);
  });
}

module.exports = { createApp, isAuthorized };
