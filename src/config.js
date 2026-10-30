import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 .env 解析：不引第三方，支持 # 注释、引号、行内注释。 */
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[config] 读取 ${file} 失败：${err.message}`);
    return {};
  }
}

// .env 优先级：进程环境变量 > .env 文件 > 默认值
const fileEnv = loadEnvFile(path.join(ROOT, '.env'));
const env = { ...fileEnv, ...process.env };

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`配置文件格式错误 ${file}: ${err.message}`);
  }
}

function deepMerge(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over;
  if (
    base && over &&
    typeof base === 'object' && typeof over === 'object'
  ) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      out[k] = deepMerge(base[k], v);
    }
    return out;
  }
  return over;
}

const DEFAULTS = readJson(path.join(ROOT, 'config', 'config.example.json'), {});

const configFile = path.join(ROOT, 'config', 'config.json');
if (!fs.existsSync(configFile)) {
  fs.writeFileSync(configFile, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
  console.log('[config] 未找到 config/config.json，已用默认值生成一份，可直接改。');
}

export const config = deepMerge(DEFAULTS, readJson(configFile, {}));

export const envConfig = {
  // 兼容：只填了 CLOUD_API_KEY 时，deepseek 单模式也能用
  deepseekKey: env.DEEPSEEK_API_KEY || env.CLOUD_API_KEY || '',
  deepseekBaseUrl: (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  deepseekModel: env.DEEPSEEK_MODEL || 'deepseek-chat',
  temperature: Number(env.DEEPSEEK_TEMPERATURE || 0.85),
  onebotWsUrl: env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001',
  onebotToken: env.ONEBOT_ACCESS_TOKEN || '',
  provider: (env.LLM_PROVIDER || 'deepseek').toLowerCase(),

  // ---- 混合模式用的两套独立配置 ----
  // 为什么要分开：hybrid 模式下闲聊走本地（免费），只有需要准确知识时才调云端。
  // 两边的 base_url / model / key 完全不同，混在一起会互相干扰。
  localBaseUrl: (env.LOCAL_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
  localModel: env.LOCAL_MODEL || 'amiya',
  localApiKey: env.LOCAL_API_KEY || 'ollama',
  localTimeout: Number(env.LOCAL_TIMEOUT || 180000),

  cloudBaseUrl: (env.CLOUD_BASE_URL || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  cloudModel: env.CLOUD_MODEL || env.DEEPSEEK_MODEL || 'deepseek-chat',
  cloudApiKey: env.CLOUD_API_KEY || env.DEEPSEEK_API_KEY || '',
  cloudTimeout: Number(env.CLOUD_TIMEOUT || 90000),

  // 混合模式的策略开关
  hybrid: {
    // 检索到知识才走云端。关掉的话就永远本地。
    routeOnKbHit: env.HYBRID_ROUTE_ON_KB === undefined ? true : env.HYBRID_ROUTE_ON_KB !== 'false',
    // 云端挂了要不要退回本地（一般要，不然一问知识就哑巴）
    fallbackToLocal: env.HYBRID_FALLBACK === undefined ? true : env.HYBRID_FALLBACK !== 'false',
  },

  // 本地模型首次加载要几十秒，推理也比云端慢，超时给宽一点
  llmTimeout: Number(env.LLM_TIMEOUT || (env.LLM_PROVIDER === 'local' ? 180000 : 90000)),
  logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
};

export const PATHS = {
  root: ROOT,
  data: path.join(ROOT, 'data'),
  logs: path.join(ROOT, 'logs'),
  persona: path.join(ROOT, config.personaFile || 'config/persona.md'),
  db: path.join(ROOT, 'data', 'bot.db'),
};

for (const dir of [PATHS.data, PATHS.logs]) {
  fs.mkdirSync(dir, { recursive: true });
}

export function loadPersona() {
  try {
    return fs.readFileSync(PATHS.persona, 'utf8');
  } catch {
    return '你叫小满，一个不太爱说话但很温柔的女生。';
  }
}
