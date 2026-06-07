'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Session monitor parser.
 *
 * Read-only. Extracts ONLY usage token counts and minimal file metadata from
 * Claude Code session .jsonl files. It never returns conversation text, tool
 * arguments/results, prompts, env values, or secrets.
 */

const DEFAULT_CONTEXT_LIMIT = 200000;
const DEFAULT_WARNING_RATIO = 0.6; // token pressure starts to matter
const DEFAULT_DANGER_RATIO = 0.75; // time to hand over

/**
 * True if `child` resolves to `parent` itself or somewhere inside it.
 * Used to keep all file access contained to the projects root.
 */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve the projects root that holds Claude Code session logs.
 * Order: explicit arg -> SESSION_MONITOR_PROJECTS env -> ~/.claude/projects
 */
function resolveProjectsRoot(explicitRoot) {
  if (explicitRoot) return explicitRoot;
  if (process.env.SESSION_MONITOR_PROJECTS) {
    return process.env.SESSION_MONITOR_PROJECTS;
  }
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Walk a directory tree collecting every *.jsonl file with its mtime.
 */
function collectJsonlFiles(root) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_err) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stat = fs.statSync(full);
        out.push({ path: full, mtimeMs: stat.mtimeMs });
      } catch (_err) {
        // ignore unreadable file
      }
    }
  }
  return out;
}

/**
 * Find the most-recently-modified .jsonl under the projects root, or an
 * explicit workspace subdirectory if one is given.
 */
function findLatestJsonl({ projectsRoot, workspace } = {}) {
  const root = resolveProjectsRoot(projectsRoot);
  const searchRoot = workspace ? path.join(root, workspace) : root;
  const files = collectJsonlFiles(searchRoot);
  if (files.length === 0) return null;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0];
}

/**
 * Pull a usage object out of a parsed jsonl record, tolerating both
 * `obj.message.usage` and `obj.usage` shapes.
 */
function extractUsage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.message && obj.message.usage && typeof obj.message.usage === 'object') {
    return obj.message.usage;
  }
  if (obj.usage && typeof obj.usage === 'object') {
    return obj.usage;
  }
  return null;
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/**
 * Read a jsonl file line by line and return the last record carrying usage,
 * plus a small list of recent turns (usage-only, no content).
 */
function readUsageFromFile(filePath, { recentLimit = 8 } = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);

  let lastUsageRecord = null;
  let model = null;
  const turns = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_err) {
      continue; // skip malformed line
    }
    const usage = extractUsage(obj);
    if (!usage) continue;

    const detectedModel =
      (obj.message && obj.message.model) || obj.model || null;
    if (detectedModel) model = detectedModel;

    const turn = {
      input_tokens: toInt(usage.input_tokens),
      output_tokens: toInt(usage.output_tokens),
      cache_read_input_tokens: toInt(usage.cache_read_input_tokens),
      cache_creation_input_tokens: toInt(usage.cache_creation_input_tokens),
      timestamp: obj.timestamp || null,
    };
    turns.push(turn);
    lastUsageRecord = { usage, model: detectedModel, timestamp: obj.timestamp };
  }

  if (!lastUsageRecord) {
    return { found: false, model, turns: [] };
  }

  return {
    found: true,
    model,
    last: lastUsageRecord,
    turns: turns.slice(-recentLimit),
  };
}

/**
 * Compute the derived metrics shown by the monitor from a raw usage object.
 */
function computeUsage(usage) {
  const input_tokens = toInt(usage.input_tokens);
  const output_tokens = toInt(usage.output_tokens);
  const cache_read_input_tokens = toInt(usage.cache_read_input_tokens);
  const cache_creation_input_tokens = toInt(usage.cache_creation_input_tokens);

  const window_load =
    input_tokens + cache_read_input_tokens + cache_creation_input_tokens;
  const pulse_tokens = input_tokens + output_tokens;
  const cache_total = cache_read_input_tokens + cache_creation_input_tokens;
  const cache_read_ratio = cache_read_input_tokens / Math.max(cache_total, 1);
  const drift_ratio =
    cache_creation_input_tokens / Math.max(cache_total, 1);

  return {
    input_tokens,
    output_tokens,
    cache_read_input_tokens,
    cache_creation_input_tokens,
    window_load,
    pulse_tokens,
    cache_total,
    cache_read_ratio,
    drift_ratio,
  };
}

function qualifyPulse(pulse_tokens) {
  if (pulse_tokens >= 12000) return 'surge';
  if (pulse_tokens >= 4000) return 'active';
  return 'stable';
}

function qualifyDrift(drift_ratio) {
  if (drift_ratio >= 0.4) return 'high';
  if (drift_ratio >= 0.15) return 'medium';
  return 'low';
}

function qualifyStatus(load, warningRatio, dangerRatio) {
  if (load >= dangerRatio) return 'HANDOVER';
  if (load >= warningRatio) return 'WATCH';
  return 'CLEAR';
}

/**
 * Top-level: locate the latest session log, parse it, and build the full
 * monitor payload. Returns { ok: false, error } on any failure so the API
 * and UI can render a clear message.
 */
function getSessionMonitor(options = {}) {
  const contextLimit = toInt(options.contextLimit) || DEFAULT_CONTEXT_LIMIT;
  const warningRatio = options.warningRatio || DEFAULT_WARNING_RATIO;
  const dangerRatio = options.dangerRatio || DEFAULT_DANGER_RATIO;

  // Everything must stay inside the projects root: no `..` traversal, no
  // arbitrary absolute paths. Reject before touching the filesystem.
  const projectsRoot = resolveProjectsRoot(options.projectsRoot);

  if (options.workspace) {
    const candidate = path.join(projectsRoot, options.workspace);
    if (!isInside(projectsRoot, candidate)) {
      return {
        ok: false,
        error: 'workspace escapes projects root',
        workspace: options.workspace,
      };
    }
  }

  let target;
  if (options.jsonlPath) {
    if (!isInside(projectsRoot, options.jsonlPath)) {
      return {
        ok: false,
        error: 'jsonl path escapes projects root',
      };
    }
    let mtimeMs = null;
    try {
      mtimeMs = fs.statSync(options.jsonlPath).mtimeMs;
    } catch (_err) {
      return {
        ok: false,
        error: `jsonl not found: ${options.jsonlPath}`,
      };
    }
    target = { path: options.jsonlPath, mtimeMs };
  } else {
    target = findLatestJsonl({
      projectsRoot,
      workspace: options.workspace,
    });
  }

  if (!target) {
    return {
      ok: false,
      error: 'no session .jsonl found',
      workspace: options.workspace || null,
    };
  }

  let parsed;
  try {
    parsed = readUsageFromFile(target.path, {
      recentLimit: options.recentLimit,
    });
  } catch (err) {
    return { ok: false, error: `failed to read jsonl: ${err.message}` };
  }

  if (!parsed.found) {
    return {
      ok: false,
      error: 'no usage record found in session',
      jsonl_path: target.path,
      workspace: options.workspace || null,
    };
  }

  const usage = computeUsage(parsed.last.usage);
  const load = usage.window_load / Math.max(contextLimit, 1);
  const status = qualifyStatus(load, warningRatio, dangerRatio);

  const warningThreshold = Math.round(contextLimit * warningRatio);
  const dangerThreshold = Math.round(contextLimit * dangerRatio);

  return {
    ok: true,
    workspace: options.workspace || null,
    jsonl_path: target.path,
    model: parsed.model || null,
    context_limit: contextLimit,
    status,
    load,
    updated_at: parsed.last.timestamp || new Date(target.mtimeMs).toISOString(),
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      window_load: usage.window_load,
      pulse_tokens: usage.pulse_tokens,
      cache_read_ratio: usage.cache_read_ratio,
    },
    signals: {
      pulse: qualifyPulse(usage.pulse_tokens),
      drift: qualifyDrift(usage.drift_ratio),
      drift_ratio: usage.drift_ratio,
    },
    handover: {
      warning_threshold: warningThreshold,
      danger_threshold: dangerThreshold,
      tokens_left_to_warning: warningThreshold - usage.window_load,
      tokens_left_to_danger: dangerThreshold - usage.window_load,
      tokens_left_to_full: contextLimit - usage.window_load,
    },
    recent_turns: parsed.turns,
  };
}

module.exports = {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_WARNING_RATIO,
  DEFAULT_DANGER_RATIO,
  isInside,
  resolveProjectsRoot,
  collectJsonlFiles,
  findLatestJsonl,
  extractUsage,
  readUsageFromFile,
  computeUsage,
  getSessionMonitor,
};
