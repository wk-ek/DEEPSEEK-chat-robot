/**
 * Stage 1 数据：从剧情文本提取「世界观知识」问答。
 *
 * 为什么要做：阿米娅不是在真空里长大的。整个泰拉的历史、国家、种族、
 * 那场战争、感染者怎么被对待 —— 这些构成了她的世界。让她「知道这个世界」，
 * 她回答问题时才不会像个只有人设的空壳。
 *
 * 做法：每个剧情章节喂给 DeepSeek，让它提炼 5-8 条「这个世界的常识」问答。
 * 不是复述剧情，是提炼**设定**：谁是谁、什么地方、发生过什么。
 *
 *   node train/prepare-lore.mjs              全量（约 1-2 元）
 *   node train/prepare-lore.mjs --limit 10    只跑前 10 个（试水）
 *   node train/prepare-lore.mjs --dry         只统计
 */
import fs from 'node:fs';
import path from 'node:path';
import { chat } from '../src/llm/deepseek.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const li = args.indexOf('--limit');
const LIMIT = li >= 0 ? Number(args[li + 1]) || 0 : 0;

const ROOT = process.env.ARK_STORY_ROOT || 'F:\\ark_story_data\\collected\\合集版';
const DIRS = ['主线', '支线', '故事集', '特殊'];
const OUT_DIR = 'train/data';
const OUT_FILE = path.join(OUT_DIR, 'wisdom_lore.jsonl');

const SYSTEM = `你在整理《明日方舟》的世界观资料，用于训练一个角色 AI。

读下面的剧情片段，提炼 5-8 条「这个世界的常识」，输出 JSON 数组：
[{"q":"问题","a":"答案"}, ...]

要求：
- 提炼的是**世界观设定**，不是剧情流水账
  ✅「乌萨斯是什么样的国家」→「乌萨斯是泰拉北方的军事强国……」
  ✅「源石是什么」→「源石是泰拉世界的能源……」
  ❌「阿米娅在这章做了什么」（这是剧情，不是常识）
- 优先提炼：地名、国家、组织、种族、历史事件、社会制度、专业术语
- 答案 40-150 字，像百科条目，客观陈述
- 问题要像人真的会问的：「XX是什么」「XX在哪」「XX为什么会XX」
- 不确定的内容不要编，宁可少写
- 只输出 JSON，不要解释、不要代码块`;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && e.name.endsWith('.txt')) out.push(full);
  }
  return out;
}

/** 取文件中段一段内容（开头通常是标题，中段信息密度高） */
function sampleText(text, maxChars = 3000) {
  const clean = text.replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= maxChars) return clean;
  const mid = Math.floor(clean.length * 0.3);
  return clean.slice(mid, mid + maxChars);
}

async function extractFromFile(file, relName) {
  const raw = fs.readFileSync(file, 'utf8');
  const excerpt = sampleText(raw);
  if (excerpt.length < 200) return [];

  const out = await chat({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `章节：${relName}\n\n${excerpt}` },
    ],
    maxTokens: 1800,
    temperature: 0.4,
    tag: 'wisdom',
  });

  const s = out.indexOf('[');
  const e = out.lastIndexOf(']');
  if (s < 0 || e < 0) return [];
  try {
    const arr = JSON.parse(out.slice(s, e + 1));
    return Array.isArray(arr)
      ? arr
          .filter((x) => x && typeof x.q === 'string' && typeof x.a === 'string')
          .map((x) => ({ user: x.q.trim(), assistant: x.a.trim(), source: relName }))
          .filter((x) => x.user.length > 3 && x.assistant.length > 20)
      : [];
  } catch {
    return [];
  }
}

// ---- 主流程 ----
const files = [];
for (const d of DIRS) {
  const dir = path.join(ROOT, d);
  for (const f of walk(dir)) files.push({ file: f, rel: `${d}/${path.basename(f, '.txt')}` });
}

console.log(`待处理剧情文件：${files.length} 个（${DIRS.join(' / ')}）`);
const todo = LIMIT > 0 ? files.slice(0, LIMIT) : files;
console.log(`本次处理：${todo.length} 个`);
console.log(`预计消耗：约 ${Math.round((todo.length * 6000) / 1000)}K tokens ≈ ${(todo.length * 6000 / 1000000 * 2).toFixed(1)} 元`);

if (dry) {
  console.log('\n--dry，不实际调用');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// 断点续传：读已有的，跳过处理过的文件
const done = new Set();
let total = 0;
if (fs.existsSync(OUT_FILE)) {
  for (const line of fs.readFileSync(OUT_FILE, 'utf8').trim().split('\n').filter(Boolean)) {
    try {
      const o = JSON.parse(line);
      if (o.source) done.add(o.source);
      total++;
    } catch {}
  }
  if (done.size) console.log(`  已处理 ${done.size} 个文件（${total} 条），跳过`);
}

const fh = fs.openSync(OUT_FILE, 'a');
let failed = 0;
const remaining = todo.filter((x) => !done.has(x.rel));
console.log(`  本次还需处理 ${remaining.length} 个`);

for (let i = 0; i < remaining.length; i++) {
  const { file, rel } = remaining[i];
  try {
    const pairs = await extractFromFile(file, rel);
    for (const p of pairs) fs.writeSync(fh, JSON.stringify(p) + '\n');
    total += pairs.length;
    process.stdout.write(`\r  ${i + 1}/${remaining.length}  ${rel.slice(0, 24)} → +${pairs.length}，累计 ${total}`);
  } catch (err) {
    failed++;
    process.stdout.write(`\r  ${i + 1}/${remaining.length}  失败：${err.message.slice(0, 30)}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

fs.closeSync(fh);
console.log(`\n\n已生成 ${total} 条世界观问答 → ${OUT_FILE}`);
if (failed) console.log(`  失败 ${failed} 个文件（网络或解析问题，重跑时会补上）`);
console.log('下一步：node train/build-dataset.mjs --two-stage');
