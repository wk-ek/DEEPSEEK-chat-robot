/**
 * 用人设试聊一次，看这个人格在真实模型下长什么样。
 *
 * 不碰数据库、不发 QQ 消息、只调模型。用来调人格文字，比在群里试快得多。
 *
 * 用法：
 *   node scripts/try-persona.mjs 阿米娅 "博士，今天好累啊"
 *   node scripts/try-persona.mjs 大肥鱼:傲娇 "你有想我吗"
 *   node scripts/try-persona.mjs 阿米娅 "第一句" "第二句" "第三句"   ← 多轮对话
 *
 * 加了 --dump 会把完整的 system prompt 也打出来，方便看模型到底收到了什么。
 */
import { config, envConfig } from '../src/config.js';
import { normalizeIdentities, findIdentity, findMode, stickerKeysFor } from '../src/persona/identities.js';
import { buildSystemPrompt } from '../src/llm/prompt.js';
import { chat } from '../src/llm/deepseek.js';

const args = process.argv.slice(2);
const dump = args.includes('--dump');
const rest = args.filter((a) => a !== '--dump');

const who = rest[0];
const says = rest.slice(1);

if (!who || !says.length) {
  console.error(`
用法：node scripts/try-persona.mjs <人格> "<对方说的话>" [更多句子...]

  人格写法： 阿米娅      → 主人格
             大肥鱼:傲娇  → 主人格 + 子人格

  可选：--dump 连 system prompt 一起打出来
`);
  process.exit(1);
}

if (envConfig.provider === 'mock') {
  console.error('当前是 mock 模式，看不到真实回复。把 .env 里的 LLM_PROVIDER 改成 deepseek 再试。');
  process.exit(1);
}
if (!envConfig.deepseekKey) {
  console.error('.env 里没有 DEEPSEEK_API_KEY，调不了模型。');
  process.exit(1);
}

// 解析 "主人格:子人格"
const [idPart, modePart] = who.split(':');
const identities = normalizeIdentities();
const identity = findIdentity(idPart, identities);
if (!identity) {
  console.error(`没有叫「${idPart}」的主人格。现有：${identities.map((i) => i.label).join('、')}`);
  process.exit(1);
}
if (!identity.enabled) {
  console.error(`「${identity.label}」还没启用。`);
  process.exit(1);
}

const mode = modePart ? findMode(identity, modePart) : null;
if (modePart && !mode) {
  console.error(
    `「${identity.label}」没有「${modePart}」这个子人格。现有：${identity.modes.map((m) => m.label).join('、') || '(无)'}`
  );
  process.exit(1);
}

// 造一个假的状态，避免连数据库
const state = {
  nick: '博士',
  favor: Math.round(config.emotion.initialFavor ?? 30),
  mood: 'calm',
  moodIntensity: 0.3,
  turns: 0,
  lastNote: '',
};

const system = buildSystemPrompt({
  state,
  memories: [],
  scope: { type: 'private' },
  identity,
  mode,
});

if (dump) {
  console.log('='.repeat(70));
  console.log(system);
  console.log('='.repeat(70));
  console.log('');
}

console.log(`【${identity.label}${mode ? ' · ' + mode.label : ''}】`);
console.log(`可用表情：${stickerKeysFor({ mode, identity }).join(', ') || '(已关闭)'}`);
console.log('');

const messages = [{ role: 'system', content: system }];
for (const line of says) {
  console.log(`你：${line}`);
  messages.push({ role: 'user', content: line });

  const t0 = Date.now();
  try {
    const reply = await chat({ messages, maxTokens: 500, tag: 'try-persona' });
    messages.push({ role: 'assistant', content: reply });
    console.log(`${identity.label}：${reply}`);
    console.log(`\x1b[90m  (${Date.now() - t0}ms)\x1b[0m`);
  } catch (err) {
    console.error(`调用失败：${err.message}`);
    process.exit(1);
  }
  console.log('');
}
