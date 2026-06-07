# Claude Code Session Monitor (MVP)

A **read-only** monitor for the current Claude Code window's token usage.
It reads session `.jsonl` logs, extracts only `usage` token counts plus minimal
file metadata, and renders a mobile-first dashboard. It can also draft a
**handover preview** on demand. It does **not** kill processes, restart tmux,
switch/inject windows, write handover files or memory, touch hooks, or
read/emit secrets, prompts, full conversation text, or tool args/results.

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
    "warning_threshold": 120000,
    "danger_threshold": 150000,
    "tokens_left_to_warning": 35853,
    "tokens_left_to_danger": 65853,
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

### Thresholds

`status` is derived from `load` against two ratios of `context_limit`:

```text
load < 0.60            -> CLEAR
0.60 <= load < 0.75    -> WATCH
load >= 0.75           -> HANDOVER
```

So `warning_threshold = 0.60 * context_limit` and
`danger_threshold = 0.75 * context_limit` (120k / 150k at the default 200k).

## Handover preview

`POST /api/handover/preview` drafts a handover for the current window.
**Preview only** — nothing is saved, injected, or written to memory, and no
window is touched. It reads the same session jsonl as the monitor (same path
containment), extracts a bounded amount of **plain user/assistant text only**
(tool calls, tool results, thinking, images and attachments are dropped), and
asks a small model to summarise it.

The handover is written **for next-window continuity, not a generic report** —
it tells the next Claude Code window what is happening, what the user just
cared about, the confirmed technical state, how to pick the thread back up,
pitfalls not to repeat, memory candidates, and risks / unfinished work.

JSON body (all optional):

| field      | meaning                                                |
| ---------- | ------------------------------------------------------ |
| `workspace`| subdirectory under the projects root                   |
| `jsonl`    | explicit path to a `.jsonl` (must stay inside the root)|
| `turns`    | how many recent turns to read (default `40`)           |
| `provider` | `mock` or `zhipu` (overrides `HANDOVER_PROVIDER`)       |

It reuses the same bearer auth as the monitor (`401` without a valid token when
`SESSION_MONITOR_TOKEN` is set).

### Providers

- **mock** (default) — no API key required; returns a deterministic draft that
  embeds the real source/monitor statistics. Use it to verify the wiring.
- **zhipu** — calls Zhipu BigModel chat completions (GLM‑4.5‑Air). If
  `HANDOVER_PROVIDER=zhipu` but `ZHIPU_API_KEY` is unset, the endpoint returns
  `{ "ok": false, "error": "missing ZHIPU_API_KEY" }` (no crash). Requests use
  a low temperature, a 30s timeout, and **no retries**; the API key is never
  logged or returned.

Both `/preview` and `/save` carry a `provider_usage` field. For **zhipu** it
reflects the model's real token usage
(`{ prompt_tokens, completion_tokens, total_tokens }`) when the API returns it,
or `null` if it doesn't. For **mock** it is always `null`. The action sheet
folds this into the existing small meta line (e.g.
`zhipu · glm-4.5-air · 40 turns / 18000 chars` with a lighter second line
`21.4k tokens · prompt 19.8k / completion 1.6k`); there is no separate token
widget.

### Sample response (mock)

```json
{
  "ok": true,
  "provider": "mock",
  "model": "mock",
  "handover": "# 给下一个窗口的交接\n\n## 现在正在发生什么\n...",
  "provider_usage": null,
  "source": {
    "jsonl_path": ".../conversation.jsonl",
    "workspace": null,
    "selected_turns": 4,
    "total_chars": 63
  },
  "monitor": { "status": "CLEAR", "window_load": 84147, "context_limit": 200000 },
  "updated_at": "2026-06-07T00:00:00.000Z"
}
```

For **zhipu** with usage, `provider_usage` is e.g.
`{ "prompt_tokens": 19800, "completion_tokens": 1600, "total_tokens": 21400 }`.

### Environment

| var                        | default     | meaning                                  |
| -------------------------- | ----------- | ---------------------------------------- |
| `HANDOVER_PROVIDER`        | `mock`      | `mock` or `zhipu`                        |
| `ZHIPU_API_KEY`            | —           | required for the `zhipu` provider        |
| `ZHIPU_MODEL`              | `glm-4.5-air` | model id — **use the exact id from the BigModel console**; do not assume |
| `ZHIPU_BASE_URL`           | BigModel v4 chat endpoint | override the API URL if needed |
| `HANDOVER_MAX_TURNS`       | `40`        | recent turns to read                     |
| `HANDOVER_MAX_INPUT_CHARS` | `20000`     | total input character budget             |
| `HANDOVER_MAX_MSG_CHARS`   | `1800`      | per-message character cap                |
| `HANDOVER_OUT_DIR`         | —           | directory the save endpoint writes to    |

The model id is **env-configurable, not hardcoded**. `glm-4.5-air` is only a
default — confirm the actual model name in the Zhipu BigModel console.

## Handover save

`POST /api/handover/save` persists a handover to `HANDOVER_OUT_DIR` for a later
SessionStart hook to pick up. **Save only** — it writes two files and nothing
else: it does not switch/restart any window, does not change hooks, does not
write memory, and never writes into the Claude jsonl directory.

- **Save an existing preview (zero tokens).** If the body carries a
  `payload` with a non-empty `handover` string, it is saved **as-is** with no
  model call — so generating once costs tokens and saving costs `0`. The
  frontend's `SAVE LATEST` sends back the preview it just generated. The
  payload is lightly sanitised/capped (it's written verbatim to disk, never
  executed). If `payload` is missing or its `handover` is empty, it falls back
  to generating a fresh preview first (same options/providers as `/preview`).
- If `HANDOVER_OUT_DIR` is unset, it returns `400` with
  `{ "ok": false, "error": "missing HANDOVER_OUT_DIR" }`.
- Files are written **atomically** (`.tmp` then `rename`) so a reader never
  sees a half-written file:
  - `latest.md` — a header (generated_at, provider, model, selected_turns,
    total_chars, provider token usage or `provider.tokens: unavailable`, and
    monitor status/window_load/context_limit) followed by the handover
    Markdown body.
  - `latest.json` — `{ ok, provider, model, source, monitor, provider_usage,
    updated_at, handover, consumed: false }`. The `consumed` flag is for a
    future hook to flip after reading.
- Writes stay inside the resolved `HANDOVER_OUT_DIR`; the filenames are fixed.
- Reuses the same bearer auth as the rest of the API.

```json
{
  "ok": true,
  "provider": "mock",
  "model": "mock",
  "saved": {
    "markdown_path": "/data/session-handover/latest.md",
    "json_path": "/data/session-handover/latest.json"
  },
  "source": { "jsonl_path": "...", "workspace": null, "selected_turns": 4, "total_chars": 63 },
  "monitor": { "status": "CLEAR", "window_load": 84147, "context_limit": 200000 },
  "updated_at": "2026-06-07T00:00:00.000Z"
}
```

### Mounting the output directory (Cool volume example)

Persist the handover dir on the host so a hook outside the container can read it:

```text
Host Path:        /home/ubuntu/.claude/session-handover
Destination Path: /data/session-handover
HANDOVER_OUT_DIR=/data/session-handover
```

The save step only writes `latest.md` / `latest.json`. Reading them back into a
new session (the SessionStart hook) and any window switching are **out of scope
here** and are not performed by this service.

## Security boundary

This endpoint exposes machine-local metadata (`jsonl_path`, `model`,
`updated_at`, window status). It does **not** expose conversation text, but it
should not run unauthenticated on a public network.

- **Auth** — set `SESSION_MONITOR_TOKEN` and every request must send
  `Authorization: Bearer <token>`; missing/wrong tokens get `401`. When the
  variable is unset, access is open for local development. The token value is
  never logged or returned.
- **Path containment** — `?jsonl=` and `?workspace=` are resolved and must land
  **inside** the projects root (`SESSION_MONITOR_PROJECTS`, default
  `~/.claude/projects`). Absolute paths outside it and `../` traversal are
  rejected with `{ "ok": false }` before any file is read. Paths are also
  checked **after `realpath` resolution** so a symlink inside the root that
  points outside it cannot escape; the recursive scan likewise never follows
  symlinks that leave the root.

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
