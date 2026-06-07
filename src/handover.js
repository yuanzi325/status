'use strict';

const fs = require('fs');
const path = require('path');
const { resolveJsonlTarget, getSessionMonitor, isInside, safeRealpath } = require('./parser');

/**
 * Manual handover preview.
 *
 * Reads the same session jsonl the monitor uses, extracts a bounded amount of
 * plain user/assistant text (never tool calls, tool results, thinking,
 * images, attachments or other sensitive blocks), and asks a small model to
 * draft a handover summary. Preview only: it does not save, inject, write
 * memory, or touch any window.
 */

const DEFAULT_MAX_TURNS = intFromEnv('HANDOVER_MAX_TURNS', 20);
const DEFAULT_MAX_INPUT_CHARS = intFromEnv('HANDOVER_MAX_INPUT_CHARS', 12000);
const DEFAULT_MAX_MSG_CHARS = intFromEnv('HANDOVER_MAX_MSG_CHARS', 1500);
const ZHIPU_TIMEOUT_MS = intFromEnv('HANDOVER_ZHIPU_TIMEOUT_MS', 30000);

function intFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * Pull only plain text out of a message's content, dropping every non-text
 * block (tool_use, tool_result, thinking, image, document, etc.).
 */
function extractMessageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
    // anything else (tool_use, tool_result, thinking, image, ...) is skipped
  }
  return parts.join('\n').trim();
}

function clamp(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + ' …[truncated]';
}

/**
 * Read recent readable conversation turns (user/assistant text only) within
 * the configured length budget. Reuses the monitor's path containment.
 */
function getRecentConversationTurns(options = {}) {
  const maxTurns = options.turns
    ? Math.max(1, Math.min(Math.trunc(options.turns), 200))
    : DEFAULT_MAX_TURNS;
  const maxMsgChars = options.maxMsgChars || DEFAULT_MAX_MSG_CHARS;
  const maxInputChars = options.maxInputChars || DEFAULT_MAX_INPUT_CHARS;

  const resolved = resolveJsonlTarget(options);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  let raw;
  try {
    raw = fs.readFileSync(resolved.path, 'utf8');
  } catch (err) {
    return { ok: false, error: `failed to read jsonl: ${err.message}` };
  }

  const collected = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_err) {
      continue;
    }
    const message = obj.message;
    const role = message && message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = extractMessageText(message);
    if (!text) continue; // e.g. a user turn that was purely a tool_result
    collected.push({ role, text: clamp(text, maxMsgChars) });
  }

  // Take the most recent N turns, then trim the oldest until under the total
  // character budget (keep the most recent context).
  let recent = collected.slice(-maxTurns);
  let total = recent.reduce((sum, t) => sum + t.text.length, 0);
  while (recent.length > 1 && total > maxInputChars) {
    total -= recent[0].text.length;
    recent = recent.slice(1);
  }

  return {
    ok: true,
    turns: recent,
    source: {
      jsonl_path: resolved.path,
      workspace: options.workspace || null,
      selected_turns: recent.length,
      total_chars: total,
    },
  };
}

/**
 * Build the Chinese handover prompt. The model may answer in Markdown; the
 * backend does not require strict JSON.
 */
function buildHandoverPrompt(turns, monitor) {
  const transcript = turns
    .map((t) => `【${t.role === 'user' ? '用户' : '助手'}】${t.text}`)
    .join('\n\n');

  const ctx = monitor
    ? `当前窗口状态：status=${monitor.status}，window_load=${monitor.window_load}，context_limit=${monitor.context_limit}。`
    : '当前窗口状态：未知。';

  return [
    '你是一个会话交接（handover）助手。下面是一段 Claude Code 工作会话的最近对话片段。',
    '请基于这些内容，生成一份简洁、准确的中文交接摘要，方便下一个窗口快速接手。',
    ctx,
    '请覆盖以下部分，可用 Markdown 标题组织（无需输出 JSON）：',
    '- summary：一段话总览',
    '- current_tasks：正在进行的任务',
    '- open_questions：尚未确认或待决的问题',
    '- technical_state：技术现状（涉及的文件、命令、配置、分支等）',
    '- emotional_context：协作语气/偏好/约束',
    '- next_actions：下一步建议动作',
    '- memory_candidates：值得长期记住的事实',
    '- risks：风险与注意事项',
    '只依据给出的对话内容，不要编造未出现的信息。',
    '',
    '=== 对话片段开始 ===',
    transcript,
    '=== 对话片段结束 ===',
  ].join('\n');
}

/**
 * Mock provider: deterministic text that embeds the REAL source/monitor
 * statistics, but never echoes raw conversation text.
 */
function buildMockHandover(source, monitor) {
  const status = monitor ? monitor.status : 'unknown';
  const load = monitor ? monitor.window_load : 'n/a';
  const limit = monitor ? monitor.context_limit : 'n/a';
  return [
    '# Handover Preview (mock)',
    '',
    '## summary',
    `基于最近 ${source.selected_turns} 轮对话（约 ${source.total_chars} 字符）生成的占位摘要。` +
      '这是 mock provider 输出，用于在不调用真实模型时验证链路。',
    '',
    '## current_tasks',
    '- （mock）当前任务占位，接入真实 provider 后由模型填充。',
    '',
    '## open_questions',
    '- （mock）待决问题占位。',
    '',
    '## technical_state',
    `- 窗口状态：status=${status}，window_load=${load}，context_limit=${limit}。`,
    `- 读取来源：${source.selected_turns} turns / ${source.total_chars} chars。`,
    '',
    '## emotional_context',
    '- （mock）协作偏好占位。',
    '',
    '## next_actions',
    '- 设置 HANDOVER_PROVIDER=zhipu 并配置 ZHIPU_API_KEY 以获得真实摘要。',
    '',
    '## memory_candidates',
    '- （mock）长期记忆候选占位。',
    '',
    '## risks',
    '- （mock）这是占位输出，不要当作真实交接内容。',
  ].join('\n');
}

/**
 * Call Zhipu BigModel chat completions. No retries, no key logging.
 */
async function callZhipu({ prompt, apiKey, model }) {
  const url =
    process.env.ZHIPU_BASE_URL ||
    'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZHIPU_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              '你是一个严谨的会话交接助手，只根据用户给出的对话内容总结，不编造信息。',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Never surface the response body verbatim (avoid leaking anything).
      return { ok: false, error: `zhipu request failed: HTTP ${res.status}` };
    }
    let data;
    try {
      data = await res.json();
    } catch (_err) {
      return { ok: false, error: 'zhipu returned non-JSON response' };
    }
    const content =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : null;
    if (!content || !content.trim()) {
      return { ok: false, error: 'zhipu returned empty content' };
    }
    return { ok: true, content: content.trim() };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, error: 'zhipu request timed out' };
    }
    return { ok: false, error: `zhipu request failed: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate a handover preview. Provider selection:
 *   options.provider || HANDOVER_PROVIDER || 'mock'
 */
async function generateHandoverPreview(options = {}) {
  const provider = (options.provider || process.env.HANDOVER_PROVIDER || 'mock')
    .toString()
    .toLowerCase();

  const turnsResult = getRecentConversationTurns(options);
  if (!turnsResult.ok) {
    return { ok: false, provider, error: turnsResult.error };
  }
  if (turnsResult.turns.length === 0) {
    return { ok: false, provider, error: 'no readable conversation turns found' };
  }

  // Best-effort monitor context (handover does not require a usage record).
  const mon = getSessionMonitor(options);
  const monitor = mon.ok
    ? {
        status: mon.status,
        window_load: mon.usage.window_load,
        context_limit: mon.context_limit,
      }
    : { status: null, window_load: null, context_limit: null };

  const base = {
    ok: true,
    provider,
    source: turnsResult.source,
    monitor,
    updated_at: new Date().toISOString(),
  };

  if (provider === 'mock') {
    return {
      ...base,
      model: 'mock',
      handover: buildMockHandover(turnsResult.source, mon.ok ? monitor : null),
    };
  }

  if (provider === 'zhipu') {
    const apiKey = process.env.ZHIPU_API_KEY;
    if (!apiKey) {
      return { ok: false, provider, error: 'missing ZHIPU_API_KEY' };
    }
    const model = process.env.ZHIPU_MODEL || 'glm-4.5-air';
    const prompt = buildHandoverPrompt(
      turnsResult.turns,
      mon.ok ? monitor : null
    );
    const out = await callZhipu({ prompt, apiKey, model });
    if (!out.ok) {
      return { ok: false, provider, model, error: out.error };
    }
    return { ...base, model, handover: out.content };
  }

  return { ok: false, provider, error: `unknown provider: ${provider}` };
}

/**
 * Atomically write `content` to `filePath`: write a sibling .tmp file, then
 * rename it into place so readers never see a partial file.
 */
function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_e) {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

function buildMarkdownDoc(preview) {
  const m = preview.monitor || {};
  const s = preview.source || {};
  const header = [
    '# Session Handover',
    '',
    `- generated_at: ${preview.updated_at}`,
    `- provider: ${preview.provider}`,
    `- model: ${preview.model}`,
    `- selected_turns: ${s.selected_turns}`,
    `- total_chars: ${s.total_chars}`,
    `- monitor.status: ${m.status}`,
    `- monitor.window_load: ${m.window_load}`,
    `- monitor.context_limit: ${m.context_limit}`,
    '',
    '---',
    '',
  ].join('\n');
  return header + (preview.handover || '') + '\n';
}

/**
 * Generate a handover preview and persist it to HANDOVER_OUT_DIR as
 * latest.md + latest.json. Writes only inside HANDOVER_OUT_DIR; never into the
 * Claude jsonl directory. Does not switch windows or touch hooks.
 */
async function saveHandoverPreview(options = {}) {
  const preview = await generateHandoverPreview(options);
  if (!preview.ok) return preview;

  const outDir = process.env.HANDOVER_OUT_DIR;
  if (!outDir) {
    return { ok: false, provider: preview.provider, error: 'missing HANDOVER_OUT_DIR' };
  }

  const resolvedDir = path.resolve(outDir);
  try {
    fs.mkdirSync(resolvedDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      provider: preview.provider,
      error: `cannot create HANDOVER_OUT_DIR: ${err.message}`,
    };
  }

  // Validate against the real directory and confirm both targets stay inside.
  const realDir = safeRealpath(resolvedDir) || resolvedDir;
  const markdownPath = path.join(realDir, 'latest.md');
  const jsonPath = path.join(realDir, 'latest.json');
  if (!isInside(realDir, markdownPath) || !isInside(realDir, jsonPath)) {
    return { ok: false, provider: preview.provider, error: 'output path escapes HANDOVER_OUT_DIR' };
  }

  const record = {
    ok: true,
    provider: preview.provider,
    model: preview.model,
    source: preview.source,
    monitor: preview.monitor,
    updated_at: preview.updated_at,
    handover: preview.handover,
    consumed: false,
  };

  try {
    atomicWrite(markdownPath, buildMarkdownDoc(preview));
    atomicWrite(jsonPath, JSON.stringify(record, null, 2) + '\n');
  } catch (err) {
    return {
      ok: false,
      provider: preview.provider,
      error: `failed to write handover: ${err.message}`,
    };
  }

  return {
    ok: true,
    provider: preview.provider,
    model: preview.model,
    saved: { markdown_path: markdownPath, json_path: jsonPath },
    source: preview.source,
    monitor: preview.monitor,
    updated_at: preview.updated_at,
  };
}

module.exports = {
  extractMessageText,
  getRecentConversationTurns,
  buildHandoverPrompt,
  buildMockHandover,
  generateHandoverPreview,
  saveHandoverPreview,
};
