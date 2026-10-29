/**
 * 混合路由：本地免费处理闲聊，云端只处理需要准确知识的问题。
 *
 * 分工依据很简单：
 *   检索到了知识库条目  → 这问题需要准确事实 → 云端（DeepSeek 听话、能照资料说）
 *   没检索到            → 闲聊、情绪、日常 → 本地（阿米娅的 LoRA，免费）
 *
 * 实测过纯本地跑 RAG 不行：4B + Q4 的模型在 4000 token 的 prompt 里
 * 抓不住资料，问「远山是谁」会答「普罗旺斯……还有萨米」。
 * 但纯本地聊「今天好累啊」效果很好，比云端更像阿米娅。
 *
 * 所以两边各干各的，云端调用量能压到很低（只有知识问答才走）。
 */
import { chat as rawChat } from './deepseek.js';
import { envConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('llm:router');

const localTarget = () => ({
  baseUrl: envConfig.localBaseUrl,
  model: envConfig.localModel,
  key: envConfig.localApiKey,
  timeoutMs: envConfig.localTimeout,
});

const cloudTarget = () => ({
  baseUrl: envConfig.cloudBaseUrl,
  model: envConfig.cloudModel,
  key: envConfig.cloudApiKey,
  timeoutMs: envConfig.cloudTimeout,
});

/**
 * 混合调用入口。签名和 deepseek.js 的 chat 完全一样，额外认一个 kbHits。
 *
 * @param {object} opts
 * @param {Array} [opts.kbHits] 知识库检索结果，有就说明这轮可能走云端
 */
export async function chat(opts = {}) {
  // 单模式（local / deepseek / mock）保持原样，不掺混合逻辑
  if (envConfig.provider !== 'hybrid') {
    return rawChat(opts);
  }

  const { kbHits, forceCloud, ...rest } = opts;
  const hasKb = Array.isArray(kbHits) && kbHits.length > 0;
  const canCloud = Boolean(envConfig.cloudApiKey);
  // 三种情况走云端：
  //   1. 调用方明确要求（讲故事/写诗，本地模型写不出来）
  //   2. 检索到了知识，需要准确转述
  const wantCloud = canCloud && (forceCloud === true || (envConfig.hybrid.routeOnKbHit && hasKb));

  if (wantCloud) {
    try {
      log.info(forceCloud ? '→ 云端（任务需要）' : `→ 云端（命中 ${kbHits?.length || 0} 条知识）`);
      return await rawChat({ ...rest, override: cloudTarget(), tag: rest.tag || 'hybrid-cloud' });
    } catch (err) {
      if (!envConfig.hybrid.fallbackToLocal) throw err;
      log.warn(`云端失败（${err.message}），退回本地`);
      return rawChat({ ...rest, override: localTarget(), tag: rest.tag || 'hybrid-local' });
    }
  }

  log.debug('→ 本地');
  return rawChat({ ...rest, override: localTarget(), tag: rest.tag || 'hybrid-local' });
}

/** 当前路由是否启用混合模式 */
export function isHybrid() {
  return envConfig.provider === 'hybrid';
}

/** 给启动横幅用的一句话描述 */
export function describeRouting() {
  if (!isHybrid()) return null;
  const cloud = envConfig.cloudApiKey ? envConfig.cloudModel : '（未配置 key）';
  return `本地 ${envConfig.localModel} + 云端 ${cloud}（仅知识问答）`;
}
