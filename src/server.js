'use strict';

const express = require('express');
const path = require('path');
const { getSessionMonitor } = require('./parser');

function createApp() {
  const app = express();

  // Read-only session monitor endpoint. Returns usage metrics only.
  app.get('/api/session-monitor', (req, res) => {
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

module.exports = { createApp };
