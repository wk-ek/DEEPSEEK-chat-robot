/**
 * Stage 1 数据：从「干员档案」提取结构化角色知识。
 *
 * 为什么用干员档案：它的格式非常规整（【代号】【性别】【种族】【身高】…），
 * 444 个文件覆盖了泰拉世界几乎所有重要角色。正则就能提取，不需要调 API、不花钱。
 *
 * 产出的是「问答对」格式，用于第一阶段的「她认识这个世界」训练：
 *   问：凯尔希是谁  →  答：凯尔希，女性，菲林，罗德岛的医疗主管……
 *
 *   node train/prepare-wisdom.mjs
 *   node train/prepare-wisdom.mjs --stats
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.ARK_STORY_ROOT || 'F:\\ark_story_data\\collected\\合集版';
const OPERATOR_DIR = path.join(ROOT, '干员');
const OUT_DIR = 'train/data';
const statsOnly = process.argv.includes('--stats');

/** 档案里的字段 */
const FIELDS = ['代号', '性别', '战斗经验', '出身地', '生日', '种族', '身高', '矿石病感染情况'];

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

/** 从档案文本里抠出字段 */
function parseProfile(text) {
  const get = (field) => {
    const re = new RegExp(`【${field}】\\s*\\n?\\s*([^\\n【]+)`);
    const m = text.match(re);
    return m ? m[1].trim().replace(/[。，]$/, '') : '';
  };
  const out = {};
  for (const f of FIELDS) {
    const v = get(f);
    if (v) out[f] = v;
  }
  return out;
}

/** 抠出「客观履历」或「档案资料」里的描述段落（这些是角色的故事） */
function parseBio(text) {
  const blocks = [];
  for (const marker of ['客观履历', '档案资料一', '档案资料二', '档案资料三', '档案资料四']) {
    const i = text.indexOf(marker);
    if (i < 0) continue;
    // 取 marker 之后到下一个 markdown 标题/档案标题之前，最多 500 字
    const rest = text.slice(i + marker.length, i + marker.length + 700);
    const cut = rest.search(/\n\s*(【|\d+\.|档案资料|临床诊断)/);
    const body = (cut > 0 ? rest.slice(0, cut) : rest).trim();
    if (body.length > 20) blocks.push(body.slice(0, 500));
  }
  return blocks;
}

/** 拼成自然语言的介绍 */
function toIntro(prof, bios) {
  const parts = [];
  const name = prof['代号'];
  const desc = [];
  if (prof['性别']) desc.push(prof['性别']);
  if (prof['种族']) desc.push(prof['种族']);
  if (prof['出身地']) desc.push(`出身${prof['出身地']}`);
  if (prof['身高']) desc.push(prof['身高']);
  let head = name;
  if (desc.length) head += `，${desc.join('，')}`;;
  const tail = [];
  if (prof['矿石病感染情况']) tail.push(prof['矿石病感染情况'].replace(/[。.]$/, ''));
  if (prof['战斗经验']) tail.push(`战斗经验${prof['战斗经验']}`);
  if (tail.length) head += `。${tail.join('，')}。`;
  parts.push(head);
  if (bios.length) parts.push(bios.slice(0, 2).join('\n'));
  return parts.join('\n');
}

// ---- 主流程 ----
const files = walk(OPERATOR_DIR);
if (!files.length) {
  console.error(`找不到干员档案目录：${OPERATOR_DIR}`);
  console.error('用 ARK_STORY_ROOT 指定剧情根目录');
  process.exit(1);
}

const samples = [];
let skipped = 0;

for (const f of files) {
  try {
    const text = fs.readFileSync(f, 'utf8');
    const prof = parseProfile(text);
    const name = prof['代号'];
    if (!name) {
      skipped++;
      continue;
    }
    const bios = parseBio(text);
    const intro = toIntro(prof, bios);
    if (intro.length < 15) {
      skipped++;
      continue;
    }

    // 每个角色造 3 种问法，让模型学会「被问到就知道」
    const questions = [
      `${name}是谁`,
      `跟我说说${name}`,
      `${name}是什么样的人`,
    ];
    for (const q of questions) {
      samples.push({ user: q, assistant: intro, source: 'operator:' + name });
    }
  } catch {
    skipped++;
  }
}

console.log(`干员档案：${files.length} 个文件`);
console.log(`  解析成功 ${files.length - skipped} 个角色，跳过 ${skipped}`);
console.log(`  生成问答 ${samples.length} 条（每角色 3 种问法）`);

if (!statsOnly && samples.length) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'wisdom_operators.jsonl');
  fs.writeFileSync(out, samples.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  console.log(`\n已写出 ${out}（${(fs.statSync(out).size / 1024).toFixed(0)} KB）`);

  // 抽 2 条看看
  console.log('\n样本：');
  for (const s of samples.slice(0, 2)) {
    console.log(`  问：${s.user}`);
    console.log(`  答：${s.assistant.split('\n')[0].slice(0, 80)}…`);
    console.log('');
  }
}
