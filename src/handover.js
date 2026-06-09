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

const DEFAULT_MAX_TURNS = intFromEnv('HANDOVER_MAX_TURNS', 30);
const DEFAULT_MAX_INPUT_CHARS = intFromEnv('HANDOVER_MAX_INPUT_CHARS', 12000);
const DEFAULT_MAX_MSG_CHARS = intFromEnv('HANDOVER_MAX_MSG_CHARS', 1800);
const ZHIPU_TIMEOUT_MS = intFromEnv('HANDOVER_ZHIPU_TIMEOUT_MS', 90000);

function intFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * Map a raw error to a clear, non-sensitive message for a given failure stage.
 * Never echoes API keys, env values, jsonl text, or absolute paths.
 */
function humanizeError(stage, raw) {
  switch (stage) {
    case 'auth':
      return 'Unauthorized. Provide a valid bearer token.';
    case 'missing_out_dir':
      return 'HANDOVER_OUT_DIR is not configured';
    case 'write_handover':
      return 'Cannot write handover file. Check HANDOVER_OUT_DIR volume permissions.';
    case 'invalid_payload':
      return 'Handover payload is missing a text body.';
    default:
      break;
  }
  const r = String(raw || '');
  if (/missing ZHIPU_API_KEY/.test(r)) return 'missing ZHIPU_API_KEY';
  if (/timed out/.test(r)) return 'Zhipu request timed out while generating handover';
  if (/no readable conversation turns/.test(r))
    return 'No readable user/assistant turns found in the selected session.';
  if (/escapes projects root/.test(r))
    return 'Session log path is outside SESSION_MONITOR_PROJECTS.';
  if (/no session .*jsonl found/.test(r))
    return 'No session log found under SESSION_MONITOR_PROJECTS.';
  if (/jsonl not found/.test(r)) return 'Selected session log was not found.';
  if (/failed to read jsonl/.test(r)) return 'Failed to read the session log.';
  if (stage === 'zhipu') return 'Zhipu request failed while generating handover.';
  return r || 'Unknown error';
}

/** Build a stage-tagged failure object with a clean message. */
function fail(stage, raw, extra = {}) {
  return { ok: false, stage, error: humanizeError(stage, raw), ...extra };
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
 * Build the Chinese handover prompt. The goal is continuity for the NEXT
 * Claude Code window — how to pick up the thread and keep going — not a
 * generic project report. The model may answer in Markdown.
 */
function buildHandoverPrompt(turns, monitor) {
  const transcript = turns
    .map((t) => `【${t.role === 'user' ? '用户' : '助手'}】${t.text}`)
    .join('\n\n');

  const ctx = monitor
    ? `当前窗口状态：status=${monitor.status}，window_load=${monitor.window_load}，context_limit=${monitor.context_limit}。`
    : '当前窗口状态：未知。';

  return [
    '你在为下一个 Claude Code 工作窗口写交接。下面是当前会话的最近对话片段。',
    '目标不是写项目周报，而是让下一个窗口醒来后能自然接上话、知道现在该继续做什么。',
    ctx,
    '请输出 Markdown，严格使用下面的标题结构：',
    '',
    '# 给下一个窗口的交接',
    '',
    '## 现在正在发生什么',
    '用 3-6 句话说明当前对话/任务主线，要具体，不要泛泛总结。',
    '',
    '## 沅沅刚刚最在意什么',
    '抓用户最近真正关心的点、焦虑点、审美偏好、技术担忧或情绪状态；提炼重点，不要逐条复述。',
    '',
    '## 已经确认的技术状态',
    '列出对话里明确出现过的仓库、文件、部署状态、环境变量、接口、测试结果；不要编造。',
    '',
    '## 下一窗口应该怎么接',
    '写出新窗口开场后应该优先回应什么、继续推进什么；重点是接话姿势和下一步动作，不是抽象建议。',
    '',
    '## 不要重复踩的坑',
    '列出刚刚已经澄清过、用户不想再解释的点；只基于输入内容生成。',
    '',
    '## 可以后续沉淀进记忆的内容',
    '列出 3-8 条候选长期记忆，不要太多；如果没有就写“暂无”。',
    '',
    '## 风险与未完成',
    '列出当前没完成、需要小心的地方（如尚未 hook 注入、尚未自动切窗、保存文件是否已配置等）。',
    '',
    '风格要求：中文；简洁但有人味；不要像项目周报；不要机械复述全部对话；',
    '不要用“用户表达了……”这类 AI 腔太重的句式；保留技术精确性但要服务于“新窗口接得上”；',
    '不要编造没出现的信息；如果最近对话太短，明确说明“可用上下文有限”。',
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
  const thin = source.selected_turns < 4;
  return [
    '# 给下一个窗口的交接',
    '_（mock 占位输出，不调用真实模型；不含原始对话正文）_',
    '',
    '## 现在正在发生什么',
    `读取了最近 ${source.selected_turns} 轮对话（约 ${source.total_chars} 字符）。` +
      (thin
        ? '可用上下文有限，真实 provider 会在更多对话上给出具体主线。'
        : '接入真实 provider 后，这里会用 3-6 句描述当前任务主线。'),
    '',
    '## 沅沅刚刚最在意什么',
    '- （mock）真实摘要会在此提炼用户最近的关注点与偏好。',
    '',
    '## 已经确认的技术状态',
    `- 窗口状态：status=${status}，window_load=${load}，context_limit=${limit}。`,
    `- 读取来源：${source.selected_turns} turns / ${source.total_chars} chars。`,
    '',
    '## 下一窗口应该怎么接',
    '- 设置 HANDOVER_PROVIDER=zhipu 并配置 ZHIPU_API_KEY，即可得到真实交接。',
    '',
    '## 不要重复踩的坑',
    '- （mock）真实摘要会在此列出刚澄清过、不要重复的点。',
    '',
    '## 可以后续沉淀进记忆的内容',
    '- 暂无（mock 占位）。',
    '',
    '## 风险与未完成',
    '- 这是 mock 占位输出，不要当作真实交接内容。',
  ].join('\n');
}

/**
 * Safely pull token usage out of a chat-completions response. Returns
 * { prompt_tokens, completion_tokens, total_tokens } or null if absent.
 * Missing individual fields default to 0; never throws.
 */
function extractProviderUsage(data) {
  const u = data && data.usage;
  if (!u || typeof u !== 'object') return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  };
  return {
    prompt_tokens: num(u.prompt_tokens),
    completion_tokens: num(u.completion_tokens),
    total_tokens: num(u.total_tokens),
  };
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
    return {
      ok: true,
      content: content.trim(),
      provider_usage: extractProviderUsage(data),
    };
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
    return fail('read_jsonl', turnsResult.error, { provider });
  }
  if (turnsResult.turns.length === 0) {
    return fail('read_jsonl', 'no readable conversation turns found', { provider });
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
      provider_usage: null,
    };
  }

  if (provider === 'zhipu') {
    const apiKey = process.env.ZHIPU_API_KEY;
    if (!apiKey) {
      return fail('zhipu', 'missing ZHIPU_API_KEY', { provider });
    }
    const model = process.env.ZHIPU_MODEL || 'glm-4.5-air';
    const prompt = buildHandoverPrompt(
      turnsResult.turns,
      mon.ok ? monitor : null
    );
    const out = await callZhipu({ prompt, apiKey, model });
    if (!out.ok) {
      return fail('zhipu', out.error, { provider, model });
    }
    return {
      ...base,
      model,
      handover: out.content,
      provider_usage: out.provider_usage || null,
    };
  }

  return fail('unknown', `unknown provider: ${provider}`, { provider });
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
  const pu = preview.provider_usage;
  const tokenLines = pu
    ? [
        `- provider.prompt_tokens: ${pu.prompt_tokens}`,
        `- provider.completion_tokens: ${pu.completion_tokens}`,
        `- provider.total_tokens: ${pu.total_tokens}`,
      ]
    : ['- provider.tokens: unavailable'];
  const header = [
    '# Session Handover',
    '',
    `- generated_at: ${preview.updated_at}`,
    `- provider: ${preview.provider}`,
    `- model: ${preview.model}`,
    `- selected_turns: ${s.selected_turns}`,
    `- total_chars: ${s.total_chars}`,
    ...tokenLines,
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
 * Normalise a client-supplied preview payload into the shape the writer
 * expects, with light caps/sanitation. Used by the "save existing preview"
 * path so we don't re-call the model just to persist.
 */
function coercePreviewPayload(p) {
  const str = (v, max) =>
    typeof v === 'string' ? v.slice(0, max) : null;
  const intOrNull = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  const src = (p && p.source) || {};
  const mon = (p && p.monitor) || {};
  let usage = null;
  if (p && p.provider_usage && typeof p.provider_usage === 'object') {
    const u = p.provider_usage;
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    };
    usage = {
      prompt_tokens: num(u.prompt_tokens),
      completion_tokens: num(u.completion_tokens),
      total_tokens: num(u.total_tokens),
    };
  }
  return {
    ok: true,
    provider: str(p && p.provider, 64) || 'unknown',
    model: str(p && p.model, 128) || 'unknown',
    handover: String((p && p.handover) || '').slice(0, 100000),
    source: {
      jsonl_path: str(src.jsonl_path, 4096),
      workspace: str(src.workspace, 1024),
      selected_turns: intOrNull(src.selected_turns),
      total_chars: intOrNull(src.total_chars),
    },
    monitor: {
      status: str(mon.status, 32),
      window_load: intOrNull(mon.window_load),
      context_limit: intOrNull(mon.context_limit),
    },
    provider_usage: usage,
    updated_at: str(p && p.updated_at, 64) || new Date().toISOString(),
  };
}

/**
 * Persist a handover to HANDOVER_OUT_DIR as latest.md + latest.json. If
 * options.payload carries an already-generated preview (non-empty handover
 * string), it is saved as-is (zero model calls); otherwise a fresh preview is
 * generated first. Writes only inside HANDOVER_OUT_DIR; never into the Claude
 * jsonl directory. Does not switch windows or touch hooks.
 */
async function saveHandoverPreview(options = {}) {
  const payload = options.payload;

  // A payload that declares a handover but with a non-string body is malformed.
  if (
    payload &&
    typeof payload === 'object' &&
    'handover' in payload &&
    typeof payload.handover !== 'string'
  ) {
    return fail('invalid_payload', 'handover payload missing text body');
  }

  const hasPayload =
    payload &&
    typeof payload === 'object' &&
    typeof payload.handover === 'string' &&
    payload.handover.trim();

  let preview;
  if (hasPayload) {
    preview = coercePreviewPayload(payload); // save existing, no model call
  } else {
    preview = await generateHandoverPreview(options);
    if (!preview.ok) return preview;
  }

  const outDir = process.env.HANDOVER_OUT_DIR;
  if (!outDir) {
    return fail('missing_out_dir', 'missing HANDOVER_OUT_DIR', { provider: preview.provider });
  }

  const resolvedDir = path.resolve(outDir);
  try {
    fs.mkdirSync(resolvedDir, { recursive: true });
  } catch (err) {
    return fail('write_handover', err.message, { provider: preview.provider });
  }

  // Validate against the real directory and confirm both targets stay inside.
  const realDir = safeRealpath(resolvedDir) || resolvedDir;
  const markdownPath = path.join(realDir, 'latest.md');
  const jsonPath = path.join(realDir, 'latest.json');
  if (!isInside(realDir, markdownPath) || !isInside(realDir, jsonPath)) {
    return fail('write_handover', 'output path escapes HANDOVER_OUT_DIR', { provider: preview.provider });
  }

  const record = {
    ok: true,
    provider: preview.provider,
    model: preview.model,
    source: preview.source,
    monitor: preview.monitor,
    provider_usage: preview.provider_usage || null,
    updated_at: preview.updated_at,
    handover: preview.handover,
    consumed: false,
  };

  try {
    atomicWrite(markdownPath, buildMarkdownDoc(preview));
    atomicWrite(jsonPath, JSON.stringify(record, null, 2) + '\n');
  } catch (err) {
    return fail('write_handover', err.message, { provider: preview.provider });
  }

  return {
    ok: true,
    provider: preview.provider,
    model: preview.model,
    saved: { markdown_path: markdownPath, json_path: jsonPath },
    source: preview.source,
    monitor: preview.monitor,
    provider_usage: preview.provider_usage || null,
    updated_at: preview.updated_at,
  };
}

module.exports = {
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_INPUT_CHARS,
  DEFAULT_MAX_MSG_CHARS,
  extractMessageText,
  extractProviderUsage,
  humanizeError,
  getRecentConversationTurns,
  buildHandoverPrompt,
  buildMockHandover,
  generateHandoverPreview,
  saveHandoverPreview,
};
