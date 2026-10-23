/**
 * 第二步：用 DeepSeek 批量生成「日常聊天」训练样本。
 *
 * 为什么需要：剧情对话对只覆盖了剧情场景（战斗、政治、危机），
 * 但用户平时跟她说的是「今天好累」「在干嘛」「你好可爱」这种。
 * 只有剧情样本训出来的模型，会像个随时准备上战场的干部，不像个会闲聊的人。
 *
 * 做法：给模型一个「场景清单」，每批让它生成 20 条一问一答。
 * 用当前的精简人格作为 system prompt，保证语气一致。
 *
 *   node train/augment-dialogue.mjs             生成（默认 1200 条）
 *   node train/augment-dialogue.mjs --count 3000
 *   node train/augment-dialogue.mjs --dry       只显示会花多少
 *
 * 成本：约 1500 条 ≈ 300 万 tokens ≈ 3-6 元（deepseek-chat）
 */
import fs from 'node:fs';
import path from 'node:path';
import { chat } from '../src/llm/deepseek.js';
import { loadProfile, renderLitePersona } from '../src/llm/lite-persona.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const ci = args.indexOf('--count');
const TARGET = ci >= 0 ? Number(args[ci + 1]) || 1200 : 1200;
const BATCH = 20;
const OUT_DIR = 'train/data';
const OUT_FILE = path.join(OUT_DIR, 'augmented.jsonl');

const PROFILE = 'config/persona.amiya.profile.json';

/** 日常场景清单：覆盖用户真会说的话 */
const SCENES = [
  '打招呼（早/晚安、在吗、你好）',
  '问她在做什么、吃了吗、睡了吗',
  '说自己累了、困了、加班到很晚',
  '说自己心情不好、emo、失恋、考试失利',
  '夸她可爱、说她厉害、说喜欢她',
  '问她年龄、身高、种族、耳朵',
  '问她喜欢吃什么、有什么爱好',
  '让她讲个笑话、唱首歌、说句晚安',
  '问她关于罗德岛、感染者、矿石病的事',
  '说自己是博士，或者问她记不记得自己',
  '抱怨老板、抱怨天气、抱怨生活',
  '跟她开玩笑、逗她、故意说离谱的话',
  '问她要不要一起做某件事',
  '说自己生病了、受伤了',
  '问她累不累、她也会累吗',
  '道别、说要下线了',
  '半夜找她聊天',
  '问她会不会想自己',
  '跟她分享开心的事',
  '随便说一句没头没尾的话，看她怎么接',
];

function pickScenes(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(SCENES[i % SCENES.length]);
  return out;
}

function buildSystem(profile) {
  const personaText = renderLitePersona(profile, [], {});
  return `${personaText}

你现在要帮人**造训练数据**：生成「用户说的话」×「阿米娅会怎么回答」的配对。
要求：
- 用户的话要像真人在 QQ 上随手打的：短、口语、可能带错别字、可能没标点
- 阿米娅的回答要完全符合上面的人格：句子短、常有省略号、不用网络流行语
- 回答长度参考她平时的样子：大多 10-30 字，偶尔一两句长的
- 不要每句都带「博士」称呼，真实对话里不会一直叫
- 情绪要跟着场景走：对方难过时她认真，对方开玩笑时她会接

输出严格的 JSON 数组，不要任何解释、不要代码块：
[{"user":"...","assistant":"..."}, ...]`;
}

async function genBatch(profile, scene, count) {
  const sys = buildSystem(profile);
  const user = `生成 ${count} 条训练样本，场景：${scene}。
注意：每条的用户问法要不一样，不要都是同一个句式。`;

  const raw = await chat({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    maxTokens: 2000,
    temperature: 0.95,
    tag: 'augment',
  });

  // 宽松解析（模型有时会包代码块或加前言）
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < 0) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(arr)
      ? arr.filter((x) => x && typeof x.user === 'string' && typeof x.assistant === 'string' && x.user.length > 1 && x.assistant.length > 3)
      : [];
  } catch {
    return [];
  }
}

// ---- 主流程 ----
const profile = loadProfile(PROFILE);
if (!profile) {
  console.error(`读不到人格档案：${PROFILE}`);
  process.exit(1);
}

const batches = Math.ceil(TARGET / BATCH);
console.log(`目标 ${TARGET} 条，分 ${batches} 批（每批 ${BATCH} 条）`);
console.log(`预计调用 ${batches} 次，约 ${Math.round(batches * 3500 * 2 / 1000)}K tokens`);

if (dry) {
  console.log('\n--dry，不实际生成');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const fh = fs.openSync(OUT_FILE, 'w');
let total = 0;
const scenes = pickScenes(batches);

for (let i = 0; i < batches; i++) {
  const scene = scenes[i];
  try {
    const pairs = await genBatch(profile, scene, BATCH);
    for (const p of pairs) {
      fs.writeSync(fh, JSON.stringify({ user: p.user, assistant: p.assistant, speaker: '（生成）', source: 'augment:' + scene.slice(0, 10) }) + '\n');
    }
    total += pairs.length;
    process.stdout.write(`\r  第 ${i + 1}/${batches} 批  场景「${scene.slice(0, 12)}」→ +${pairs.length}，累计 ${total}`);
  } catch (err) {
    process.stdout.write(`\r  第 ${i + 1} 批失败：${err.message.slice(0, 40)}`);
  }
  // 轻微限速，避免撞到 RPM
  await new Promise((r) => setTimeout(r, 400));
}

fs.closeSync(fh);
console.log(`\n\n已生成 ${total} 条 → ${OUT_FILE}`);
console.log('下一步：node train/build-dataset.mjs');
