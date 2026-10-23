/**
 * 同人素材 → 深度问答（Stage 3 用，可选）
 *
 * 有两条路，按你手上的素材选：
 *
 *   A. 自己放文本：把同人小说 / 剧情解读 / 安科丢进 train/data/extra/*.txt
 *      → 脚本切段，每段提炼成「深度问答」
 *
 *   B. 让 API 生成：没有现成素材时，用官方剧情 + 人格，让模型生成
 *      「站在阿米娅视角的深度自省」——这不是同人，是同人**风格**的补充
 *      （能补上官方从没写过的东西：她怎么想自己、怎么想博士、害怕什么）
 *
 *      node train/prepare-extra.mjs --generate 200
 *
 * 为什么单独一层：同人的语气是「作者理解的阿米娅」。
 * 拿它和官方数据混训会稀释人格。所以做成独立的 Stage 3，
 * 在纯官方模型基础上再微调 —— 训歪了随时丢掉这一层，官方版还在。
 *
 *   node train/prepare-extra.mjs              处理 train/data/extra/ 下的文本
 *   node train/prepare-extra.mjs --generate 200  让 API 生成 200 条
 *   node train/prepare-extra.mjs --stats      只看统计
 */
import fs from 'node:fs';
import path from 'node:path';
import { chat } from '../src/llm/deepseek.js';
import { loadProfile, renderLitePersona } from '../src/llm/lite-persona.js';

const args = process.argv.slice(2);
const statsOnly = args.includes('--stats');
const gi = args.indexOf('--generate');
const GENERATE = gi >= 0 ? Number(args[gi + 1]) || 200 : 0;

const EXTRA_DIR = 'train/data/extra';
const OUT_DIR = 'train/data';
const OUT_FILE = path.join(OUT_DIR, 'extra_pairs.jsonl');
const BATCH = 10;

/** 让模型产出「同人风格的深度自省」 */
const DEEP_PROMPT = `你在补全一个角色的**内在**。

官方剧情只写了阿米娅做了什么、说了什么，但没写她**怎么想**。
现在以她的视角，生成「深度自省」式的问答——问题来自玩家会好奇的角度，
答案是她自己会说的那种话：不完整、会犹豫、有时说到一半停住。

覆盖面（每轮挑 2-3 个角度）：
- 她怎么看待自己是感染者这件事
- 她怎么想博士（依赖？害怕？还是别的）
- 她最怕失去什么
- 她有没有后悔过
- 她一个人时会想什么
- 她怎么看成年的自己和还是个孩子的自己
- 她怎么理解「魔王」这个身份
- 她对凯尔希、特蕾西娅、其他干员的私人感情
- 她怎么面对「必须让别人去牺牲」这种事

要求：
- 答案要像她说的，不是分析她的。用第一人称。
- 保持她的语气：短句、有省略号、不煽情、不喊口号
- 允许「不知道」「说不清」——这才是真的
- 40-150 字
- 不要写成心理分析报告

只输出 JSON 数组，不要解释：
[{"q":"...","a":"..."}, ...]`;

const ANGLES = [
  '她怎么看待自己是感染者',
  '她怎么想博士',
  '她最怕失去什么',
  '她有没有后悔过',
  '她一个人时会想什么',
  '她怎么看成年的自己和孩子的自己',
  '她怎么理解魔王这个身份',
  '她对凯尔希的私人感情',
  '她怎么面对让别人去牺牲',
  '她怎么看罗德岛的未来',
  '她累的时候会做什么',
  '她记得的第一个死者',
];

/** 从一段文本里提炼问答 */
async function fromText(text, source) {
  const excerpt = text.length > 3000 ? text.slice(0, 3000) : text;
  const out = await chat({
    messages: [
      {
        role: 'system',
        content: `你在整理《明日方舟》同人素材，提炼成角色 AI 的训练数据。

读下面的文本，提炼 2-4 条「深度问答」：问题来自读者会好奇的角度，
答案要符合阿米娅的说话方式（短句、有省略号、不煽情）。

输出 JSON 数组：[{"q":"问题","a":"答案"}]
答案 40-150 字，用第一人称。只输出 JSON。`,
      },
      { role: 'user', content: excerpt },
    ],
    maxTokens: 1200,
    temperature: 0.7,
    tag: 'extra',
  });
  const s = out.indexOf('[');
  const e = out.lastIndexOf(']');
  if (s < 0 || e < 0) return [];
  try {
    const arr = JSON.parse(out.slice(s, e + 1));
    return Array.isArray(arr)
      ? arr
          .filter((x) => x && typeof x.q === 'string' && typeof x.a === 'string')
          .map((x) => ({ user: x.q.trim(), assistant: x.a.trim(), source }))
          .filter((x) => x.user.length > 3 && x.assistant.length > 20)
      : [];
  } catch {
    return [];
  }
}

/** 让 API 生成深度自省 */
async function generate(profile, count) {
  const personaText = renderLitePersona(profile, [], {});
  const results = [];
  const rounds = Math.ceil(count / BATCH);

  for (let i = 0; i < rounds; i++) {
    const angles = [ANGLES[i % ANGLES.length], ANGLES[(i + 3) % ANGLES.length], ANGLES[(i + 7) % ANGLES.length]];
    try {
      const out = await chat({
        messages: [
          { role: 'system', content: personaText + '\n\n' + DEEP_PROMPT },
          { role: 'user', content: `这一轮的角度：${angles.join('、')}。生成 ${BATCH} 条。` },
        ],
        maxTokens: 2000,
        temperature: 0.9,
        tag: 'extra-gen',
      });
      const s = out.indexOf('[');
      const e = out.lastIndexOf(']');
      if (s < 0 || e < 0) continue;
      const arr = JSON.parse(out.slice(s, e + 1));
      if (!Array.isArray(arr)) continue;
      for (const x of arr) {
        if (x && typeof x.q === 'string' && typeof x.a === 'string' && x.a.length > 20) {
          results.push({ user: x.q.trim(), assistant: x.a.trim(), source: 'extra:generated' });
        }
      }
      process.stdout.write(`\r  第 ${i + 1}/${rounds} 批 → 累计 ${results.length}`);
    } catch (err) {
      process.stdout.write(`\r  第 ${i + 1} 批失败：${err.message.slice(0, 30)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return results;
}

// ---- 主流程 ----
const profile = loadProfile('config/persona.amiya.profile.json');
let samples = [];

// A. 处理用户放的同人文本
const txtFiles = fs.existsSync(EXTRA_DIR)
  ? fs.readdirSync(EXTRA_DIR).filter((f) => f.endsWith('.txt'))
  : [];

if (txtFiles.length) {
  console.log(`发现 ${txtFiles.length} 个同人文本，开始提炼…`);
  for (const f of txtFiles) {
    const text = fs.readFileSync(path.join(EXTRA_DIR, f), 'utf8');
    const chunks = [];
    // 按 2000 字切块
    for (let i = 0; i < text.length; i += 2000) chunks.push(text.slice(i, i + 2000));
    for (const c of chunks.slice(0, 10)) {
      try {
        const pairs = await fromText(c, 'extra:' + f);
        samples.push(...pairs);
        process.stdout.write(`\r  ${f} → 累计 ${samples.length}`);
      } catch (err) {
        process.stdout.write(`\r  ${f} 失败：${err.message.slice(0, 30)}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  console.log('');
} else {
  console.log(`没有 train/data/extra/*.txt（想放同人素材就建这个目录）`);
}

// B. 让 API 生成
if (GENERATE > 0) {
  if (!profile) {
    console.error('读不到人格档案，没法生成');
    process.exit(1);
  }
  console.log(`\n让 API 生成 ${GENERATE} 条深度自省（约 ${Math.ceil(GENERATE / BATCH)} 次调用）`);
  const gen = await generate(profile, GENERATE);
  samples.push(...gen);
  console.log('');
}

// ---- 输出 ----
if (!samples.length) {
  console.log('\n没有产生任何 extra 数据。');
  console.log('两个选择：');
  console.log('  1. 把同人文本放进 train/data/extra/*.txt，再跑');
  console.log('  2. node train/prepare-extra.mjs --generate 200');
  process.exit(statsOnly ? 0 : 1);
}

const seen = new Set();
const uniq = samples.filter((s) => {
  const k = s.user + '\u0000' + s.assistant;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

console.log(`\n共 ${uniq.length} 条（去重后）`);
if (statsOnly) process.exit(0);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, uniq.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
console.log(`已写出 ${OUT_FILE}`);
console.log('\n其中 3 条：');
uniq.slice(0, 3).forEach((s) => {
  console.log(`  问：${s.user}`);
  console.log(`  答：${s.assistant.slice(0, 90)}…\n`);
});
console.log('下一步：node train/build-dataset.mjs   （会一起构建 extra 训练集）');
