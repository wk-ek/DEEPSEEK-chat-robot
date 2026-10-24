import { createLogger } from '../logger.js';
import { envConfig } from '../config.js';

const log = createLogger('llm');

export class LLMError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 简易 token 估算：中文按 1.6 字/token，英文按 4 字符/token，够用。 */
export function estimateTokens(text = '') {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.6 + other / 4);
}

/**
 * 清理模型输出里的特殊 token。
 *
 * Qwen3 用的是 reasoning template，输出会带 <think></think> 和 <tool_call></tool_call>。
 * 训练数据里每条 assistant 前面都插了空的 <think>，所以模型学会了这个模式。
 * 这些标签不能直接发到 QQ 里，必须剥掉。
 */
export function sanitizeReply(text) {
  if (!text) return '';
  let t = text;
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  t = t.replace(/<\/?(?:think|tool_call|tool_response)>/gi, '');
  t = t.replace(/<\|im_start\|>/g, '');
  t = t.replace(/<\|im_end\|>/g, '');
  return t.trim();
}

function mockReply(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const snippet = last.replace(/\s+/g, ' ').slice(0, 30);
  const pool = [
    `嗯……我在。${snippet ? '你说的「' + snippet + '」，我想了一下。' : ''}`,
    '嗯，听到了。你接着说。',
    '我想想……这个我还真没想过。',
    '今天有点困，但看到你说话就不困了。',
    '你吃了吗？',
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 调用一次对话补全，返回纯文本。
 * 支持重试（429/5xx/网络抖动）与超时中断。
 */
export async function chat({
  messages,
  temperature = envConfig.temperature,
  maxTokens = 800,
  jsonMode = false,
  timeoutMs = envConfig.llmTimeout ?? 90000,
  retries = 2,
  tag = 'chat',
} = {}) {
  if (envConfig.provider === 'mock') {
    await sleep(200 + Math.random() * 300);
    return mockReply(messages);
  }
  // 本地模型（Ollama）不校验 key，云端才需要。
  // Ollama 的 OpenAI 兼容端点即使传空 Bearer 也能用，但有些版本要个占位值。
  const isLocal = envConfig.provider === 'local';
  if (!isLocal && !envConfig.deepseekKey) {
    throw new LLMError('未配置 DEEPSEEK_API_KEY，请在 .env 里填上（用本地模型就把 LLM_PROVIDER 设成 local）');
  }

  const url = `${envConfig.deepseekBaseUrl}/chat/completions`;
  const body = {
    model: envConfig.deepseekModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 本地 Ollama 不需要真 key，但带上占位值更兼容
          Authorization: `Bearer ${envConfig.deepseekKey || 'ollama'}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retries) {
          attempt += 1;
          const wait = 800 * attempt + Math.random() * 400;
          log.warn(`${tag} 返回 ${res.status}，${Math.round(wait)}ms 后重试（${attempt}/${retries}）`);
          await sleep(wait);
          continue;
        }
        throw new LLMError(`DeepSeek ${res.status}: ${detail.slice(0, 300)}`);
      }

      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content ?? '';
      log.debug(
        `${tag} ok ${Date.now() - started}ms tokens=${json?.usage?.total_tokens ?? '?'}`
      );
      return sanitizeReply(content);
    } catch (err) {
      if (err instanceof LLMError) throw err;
      const timedOut = err.name === 'AbortError';
      const msg = timedOut ? `请求超时（${timeoutMs}ms）` : err.message;
      if (attempt < retries && !timedOut) {
        attempt += 1;
        const wait = 800 * attempt;
        log.warn(`${tag} 失败：${msg}，${wait}ms 后重试（${attempt}/${retries}）`);
        await sleep(wait);
        continue;
      }
      throw new LLMError(`${tag} 失败：${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 容错地从模型输出里抠出 JSON（模型爱加 ```json 包裹）。 */
export function parseJsonLoose(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}
