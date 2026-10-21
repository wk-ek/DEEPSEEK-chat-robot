import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { chat } from '../llm/deepseek.js';
import { personaText } from '../llm/prompt.js';
import { getDb } from '../memory/db.js';
import {
  recentMessages,
  saveMessage,
  logProactive,
  lastProactiveAt,
  proactiveCountSince,
} from '../memory/store.js';
import { scopeOf } from '../memory/context.js';

const log = createLogger('proactive');

const DAY = 86400000;
const MIN = 60000;

/**
 * 主动发言：她偶尔会在安静的群里说一句。
 * 默认关闭，开了也要过四道闸：正活跃、够安静、冷却、每日上限。
 */
export class Proactive {
  constructor({ api, getSelfId }) {
    this.api = api;
    this.getSelfId = getSelfId;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (!config.proactive?.enabled) {
      log.info('主动发言未开启（config.proactive.enabled = false）');
      return;
    }
    const groups = (config.proactive.groups || []).map(String);
    if (!groups.length) {
      log.warn('主动发言已开启但没有配置 groups，实际不会生效');
      return;
    }
    log.info(`主动发言已开启，目标群：${groups.join(', ')}`);
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.error(`tick 失败：${err.message}`));
    }, MIN);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running || !this.api) return;
    this.running = true;
    try {
      for (const groupId of (config.proactive.groups || []).map(String)) {
        await this.maybeSpeak(groupId);
      }
    } finally {
      this.running = false;
    }
  }

  #lastMessageTs(scope) {
    const row = getDb()
      .prepare('SELECT MAX(ts) AS ts FROM messages WHERE scope = ?')
      .get(String(scope));
    return Number(row?.ts || 0);
  }

  async maybeSpeak(groupId) {
    const p = config.proactive;
    const scope = scopeOf({ type: 'group', groupId });
    const now = Date.now();

    const lastMsg = this.#lastMessageTs(scope);
    if (!lastMsg) return;

    const idleMin = (now - lastMsg) / MIN;
    if (idleMin < (p.minIdleMinutes ?? 10)) return; // 刚聊完，别插嘴
    if (idleMin > (p.requireRecentActivityMinutes ?? 60)) return; // 群已经凉了，别自言自语

    const lastSelf = lastProactiveAt(scope);
    if (lastSelf && now - lastSelf < (p.cooldownMinutes ?? 45) * MIN) return;

    const todayCount = proactiveCountSince(scope, now - DAY);
    if (todayCount >= (p.maxPerDay ?? 3)) return;

    if (Math.random() > (p.probability ?? 0.15)) return;

    const rows = recentMessages(scope, 16);
    if (!rows.length) return;

    const convo = rows
      .map((r) => `${r.role === 'assistant' ? config.botName : r.sender_name || '某人'}: ${r.text}`)
      .join('\n');

    const system =
      `【你是谁】\n${personaText()}\n\n` +
      `【场景】\n你在 QQ 群里。大家刚才聊过一阵，现在安静了。\n` +
      `你想主动说一句，像是忽然想起什么，或者只是随口一问。\n\n` +
      `【规则】\n` +
      `1. 只输出这一句话，不要前缀，不要解释你为什么说。\n` +
      `2. 不超过 30 个字。\n` +
      `3. 不要 @ 任何人，不要问"大家呢"这种群发式提问。\n` +
      `4. 可以呼应刚才聊过的内容，也可以只是说个刚想到的小事。\n` +
      `5. 不要复读刚才别人说过的话。`;

    let line = '';
    try {
      line = await chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `刚才群里聊的是：\n${convo}\n\n现在只有你还没说话。说一句。` },
        ],
        temperature: 0.95,
        maxTokens: 120,
        tag: 'proactive',
      });
    } catch (err) {
      log.warn(`生成主动发言失败：${err.message}`);
      return;
    }

    line = String(line || '')
      .replace(/^["“「『]+|["”」』]+$/g, '')
      .replace(/\n+/g, ' ')
      .trim()
      .slice(0, 60);

    if (!line) return;

    try {
      await this.api.sendGroup(groupId, line);
      saveMessage({
        scope,
        scopeType: 'group',
        userId: null,
        groupId,
        senderName: config.botName,
        role: 'assistant',
        text: line,
      });
      logProactive(scope);
      log.info(`主动发言 → 群 ${groupId}：${line}`);
    } catch (err) {
      log.warn(`主动发言发送失败：${err.message}`);
    }
  }
}
