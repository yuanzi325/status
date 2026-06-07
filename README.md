# Claude Code Session Monitor (MVP)

A **read-only** monitor for the current Claude Code window's token usage.
It reads session `.jsonl` logs, extracts only `usage` token counts plus minimal
file metadata, and renders a mobile-first dashboard. It does **not** kill
processes, restart tmux, write handovers, touch hooks, or read/emit secrets,
prompts, conversation text, or tool args/results.

## Run

```bash
npm install
npm start            # http://localhost:3000
```

Point it at a logs root if needed:

```bash
SESSION_MONITOR_PROJECTS=~/.claude/projects PORT=3000 npm start
```

## API

`GET /api/session-monitor`

Query params (all optional):

| param       | meaning                                              |
| ----------- | ---------------------------------------------------- |
| `workspace` | subdirectory under the projects root to scan         |
| `jsonl`     | explicit path to a single `.jsonl` file              |
| `limit`     | context window limit (default `200000`)              |

The endpoint finds the most recently modified `.jsonl` under
`SESSION_MONITOR_PROJECTS` (default `~/.claude/projects`), reads it line by
line, and returns the last record carrying `usage`. It tolerates both
`obj.message.usage` and `obj.usage` shapes.

### Sample response

```json
{
  "ok": true,
  "workspace": null,
  "jsonl_path": ".../message-usage.jsonl",
  "model": "claude-opus-4-8",
  "context_limit": 200000,
  "status": "CLEAR",
  "load": 0.420735,
  "updated_at": "2026-06-07T00:01:00.000Z",
  "usage": {
    "input_tokens": 3204,
    "output_tokens": 2100,
    "cache_read_input_tokens": 78843,
    "cache_creation_input_tokens": 2100,
    "window_load": 84147,
    "pulse_tokens": 5304,
    "cache_read_ratio": 0.974
  },
  "signals": { "pulse": "active", "drift": "low", "drift_ratio": 0.026 },
  "handover": {
    "warning_threshold": 140000,
    "danger_threshold": 170000,
    "tokens_left_to_warning": 55853,
    "tokens_left_to_danger": 85853,
    "tokens_left_to_full": 115853
  },
  "recent_turns": [ /* usage-only, no content */ ]
}
```

On failure (no log found, no usage record, unreadable file) it returns
`{ "ok": false, "error": "..." }` with a clear message and HTTP 404.

### Derived metrics

```text
window_load      = input + cache_read + cache_creation
pulse_tokens     = input + output
cache_read_ratio = cache_read / max(cache_read + cache_creation, 1)
load             = window_load / context_limit
```

## UI

Mobile-first page at `/`: off-white paper background, Klein-blue haze, thin
black grid, bold black type. A 2×3 grid — **WINDOW · LOAD · PULSE · CACHE ·
DRIFT · HANDOVER** — sits above a frosted-glass detail panel. Tap any block to
swap the panel to that block's breakdown; tap again to return to the summary.

## Test

```bash
npm test     # node --test
```

Fixtures in `test/fixtures/` cover the `message.usage` shape, the top-level
`usage` shape, and the no-usage error path.
