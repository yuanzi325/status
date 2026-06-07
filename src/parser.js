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
 * Resolve a path to its real (symlink-followed) location, or null if it does
 * not exist / is not accessible. Never throws.
 */
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (_err) {
    return null;
  }
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
 *
 * Follows symlinks but never escapes the real projects root: any entry whose
 * real (symlink-resolved) path lands outside `realRoot` is skipped. Unreadable
 * or broken entries are skipped rather than thrown.
 */
function collectJsonlFiles(root, realRoot) {
  const out = [];
  const base = realRoot || safeRealpath(root) || path.resolve(root);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_err) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    // Resolve the real target and refuse anything that escapes the root
    // (this catches symlinks pointing outside projectsRoot).
    const real = safeRealpath(full);
    if (!real || !isInside(base, real)) continue;
    let stat;
    try {
      stat = fs.statSync(full); // follows symlinks
    } catch (_err) {
      continue; // unreadable / broken link
    }
    if (stat.isDirectory()) {
      out.push(...collectJsonlFiles(full, base));
    } else if (stat.isFile() && entry.name.endsWith('.jsonl')) {
      out.push({ path: full, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

/**
 * Find the most-recently-modified .jsonl under the projects root, or an
 * explicit workspace subdirectory if one is given. Stays within the real
 * projects root.
 */
function findLatestJsonl({ projectsRoot, workspace, realRoot } = {}) {
  const root = path.resolve(resolveProjectsRoot(projectsRoot));
  const realBase = realRoot || safeRealpath(root) || root;
  let searchRoot = root;
  if (workspace) {
    const candidate = path.join(root, workspace);
    if (!isInside(root, candidate)) return null;
    const realCandidate = safeRealpath(candidate);
    if (realCandidate && !isInside(realBase, realCandidate)) return null;
    searchRoot = candidate;
  }
  const files = collectJsonlFiles(searchRoot, realBase);
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
  // arbitrary absolute paths, and no symlink that escapes after resolution.
  // Reject before reading any file. We compare against the REAL root so a
  // symlinked projects dir is handled consistently.
  const projectsRoot = path.resolve(resolveProjectsRoot(options.projectsRoot));
  const realRoot = safeRealpath(projectsRoot) || projectsRoot;

  if (options.workspace) {
    const candidate = path.join(projectsRoot, options.workspace);
    // 1) lexical check on the resolved (but not yet realpath'd) path
    if (!isInside(projectsRoot, candidate)) {
      return {
        ok: false,
        error: 'workspace escapes projects root',
        workspace: options.workspace,
      };
    }
    // 2) if it exists, its real target must still be inside the real root
    const realCandidate = safeRealpath(candidate);
    if (realCandidate && !isInside(realRoot, realCandidate)) {
      return {
        ok: false,
        error: 'workspace escapes projects root',
        workspace: options.workspace,
      };
    }
  }

  let target;
  if (options.jsonlPath) {
    const resolvedJsonl = path.resolve(options.jsonlPath);
    // 1) lexical containment of the resolved path
    if (!isInside(projectsRoot, resolvedJsonl)) {
      return {
        ok: false,
        error: 'jsonl path escapes projects root',
      };
    }
    // 2) realpath: file must exist and its real target stay inside real root
    const realJsonl = safeRealpath(resolvedJsonl);
    if (!realJsonl) {
      return {
        ok: false,
        error: `jsonl not found: ${options.jsonlPath}`,
      };
    }
    if (!isInside(realRoot, realJsonl)) {
      return {
        ok: false,
        error: 'jsonl path escapes projects root',
      };
    }
    let mtimeMs = null;
    try {
      mtimeMs = fs.statSync(realJsonl).mtimeMs;
    } catch (_err) {
      return {
        ok: false,
        error: `jsonl not found: ${options.jsonlPath}`,
      };
    }
    target = { path: realJsonl, mtimeMs };
  } else {
    target = findLatestJsonl({
      projectsRoot,
      workspace: options.workspace,
      realRoot,
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
  safeRealpath,
  resolveProjectsRoot,
  collectJsonlFiles,
  findLatestJsonl,
  extractUsage,
  readUsageFromFile,
  computeUsage,
  getSessionMonitor,
};
