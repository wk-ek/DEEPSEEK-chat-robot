/**
 * 第四步：构建两阶段训练集。
 *
 *   Stage 1（智慧层）  wisdom_operators + wisdom_lore     → 认识泰拉世界
 *   Stage 2（说话层）  raw_pairs + augmented              → 像阿米娅说话
 *
 * 为什么要分开：知识要「装进去」，语气要「调出来」。
 * 混在一起训，模型容易把世界观变成台词的一部分，说每句话都像在念设定集。
 *
 *   node train/build-dataset.mjs            两阶段都构建（默认）
 *   node train/build-dataset.mjs --stage 1  只构建智慧层
 *   node train/build-dataset.mjs --stage 2  只构建说话层
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const si = args.indexOf('--stage');
const onlyStage = si >= 0 ? Number(args[si + 1]) : 0;
const VAL_RATIO = 0.02;

const DIR = 'train/data';
const OUT = 'train/out';
const PROFILE = 'config/persona.amiya.profile.json';

/** 训练时的 system：只说「你是谁」，人格靠数据学，不靠 prompt 灌 */
function lightSystem() {
  try {
    const p = JSON.parse(fs.readFileSync(PROFILE, 'utf8'));
    const id = p.identity || {};
    const bits = [id.name, id.age ? `${id.age}岁` : '', id.race, id.role].filter(Boolean);
    return `你是${bits.join('，')}。`;
  } catch {
    return '你是阿米娅。';
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function clean(pairs, stage) {
  const seen = new Set();
  const out = [];
  for (const p of pairs) {
    if (!p || !p.user || !p.assistant) continue;
    const u = String(p.user).trim();
    const a = String(p.assistant).trim();
    if (!u || !a) continue;
    if (u.length < 3 || u.length > 400) continue;

    if (stage === 1) {
      // 智慧层：答案可以长（百科式）
      if (a.length < 15 || a.length > 1200) continue;
    } else {
      // 说话层：答案应该短（她的台词中位数 18 字）
      if (a.length < 4 || a.length > 400) continue;
      if (/\[\[sticker:/.test(a)) continue;
      if (/^(error|错误|undefined|null)/i.test(a)) continue;
    }

    const key = u + '\u0000' + a;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ user: u, assistant: a, source: p.source || '' });
  }
  return out;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function write(name, samples, system, withSystem = true) {
  fs.mkdirSync(OUT, { recursive: true });
  const valCount = Math.max(1, Math.floor(samples.length * VAL_RATIO));
  const val = samples.slice(0, valCount);
  const train = samples.slice(valCount);
  const conv = (p) => {
    const msgs = [];
    if (withSystem) msgs.push({ role: 'system', content: system });
    msgs.push({ role: 'user', content: p.user });
    msgs.push({ role: 'assistant', content: p.assistant });
    return { messages: msgs };
  };
  const trainFile = path.join(OUT, `${name}.jsonl`);
  const valFile = path.join(OUT, `${name}_val.jsonl`);
  fs.writeFileSync(trainFile, train.map((p) => JSON.stringify(conv(p))).join('\n') + '\n', 'utf8');
  fs.writeFileSync(valFile, val.map((p) => JSON.stringify(conv(p))).join('\n') + '\n', 'utf8');
  const size = fs.statSync(trainFile).size;
  return { train: train.length, val: val.length, size };
}

const system = lightSystem();
const report = [];

// ---- Stage 1：智慧层 ----
if (!onlyStage || onlyStage === 1) {
  const ops = readJsonl(path.join(DIR, 'wisdom_operators.jsonl'));
  const lore = readJsonl(path.join(DIR, 'wisdom_lore.jsonl'));
  console.log(`Stage 1 读入：干员档案 ${ops.length} 条，世界观 ${lore.length} 条`);

  const cleaned = shuffle(clean([...ops, ...lore], 1));
  if (cleaned.length < 50) {
    console.log(`  ⚠️ 数据太少（${cleaned.length} 条），跳过 Stage 1`);
    console.log(`     先跑：node train/prepare-wisdom.mjs && node train/prepare-lore.mjs`);
  } else {
    const r = write('wisdom', cleaned, system);
    console.log(`  → wisdom.jsonl ${r.train} 条 / val ${r.val} 条  ${(r.size / 1024).toFixed(0)} KB`);
    report.push(['Stage 1 智慧层', r.train]);
  }
}

// ---- Stage 2：说话层 ----
if (!onlyStage || onlyStage === 2) {
  const raw = readJsonl(path.join(DIR, 'raw_pairs.jsonl'));
  const aug = readJsonl(path.join(DIR, 'augmented.jsonl'));
  console.log(`Stage 2 读入：剧情对话 ${raw.length} 条，日常生成 ${aug.length} 条`);

  const cleaned = shuffle(clean([...raw, ...aug], 2));
  if (cleaned.length < 50) {
    console.log(`  ⚠️ 数据太少（${cleaned.length} 条），跳过 Stage 2`);
    console.log(`     先跑：node train/prepare-data.mjs && node train/augment-dialogue.mjs`);
  } else {
    const r = write('persona', cleaned, system);
    console.log(`  → persona.jsonl ${r.train} 条 / val ${r.val} 条  ${(r.size / 1024).toFixed(0)} KB`);
    report.push(['Stage 2 说话层', r.train]);
  }
}

if (!report.length) {
  console.error('\n没有任何数据被构建。检查 train/data/ 下的文件是否存在。');
  process.exit(1);
}

console.log('\n构建完成：');
for (const [name, n] of report) console.log(`  ${name}  ${n} 条训练样本`);
console.log('\n下一步：');
console.log('  1. 把 train/out/ 下的 jsonl 和 train/dataset_info.json 上传到云端 /workspace/data/');
console.log('  2. 运行 bash train/run.sh');
