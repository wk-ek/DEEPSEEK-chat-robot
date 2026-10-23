/**
 * 第三步：把两批数据合并、清洗、切成训练集和验证集。
 *
 * 输入：train/data/raw_pairs.jsonl（剧情对话）+ train/data/augmented.jsonl（生成的日常对话）
 * 输出：train/data/train.jsonl + train/data/val.jsonl（LLaMA-Factory alpaca/sharegpt 格式）
 *
 *   node train/build-dataset.mjs
 *   node train/build-dataset.mjs --format sharegpt
 *   node train/build-dataset.mjs --with-system    带上 system prompt（训练时更贴人格）
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const format = args.includes('--format') && args[args.indexOf('--format') + 1] === 'sharegpt' ? 'sharegpt' : 'messages';
const withSystem = args.includes('--with-system');
const VAL_RATIO = 0.02;

const DIR = 'train/data';
const OUT_DIR = 'train/out';
const PROFILE = 'config/persona.amiya.profile.json';

/** 训练时给模型的 system prompt：只说「你是谁」，不塞完整人格（人格靠数据学） */
function buildLightSystem() {
  const p = path.join(process.cwd(), PROFILE);
  if (!fs.existsSync(p)) return '你是阿米娅，罗德岛的公开领袖。';
  const profile = JSON.parse(fs.readFileSync(p, 'utf8'));
  const id = profile.identity || {};
  const bits = [id.name, id.age ? `${id.age}岁` : '', id.race, id.role].filter(Boolean);
  return `你是${bits.join('，')}。`;
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

/** 清洗：去掉明显不适合训练的样本 */
function clean(pairs) {
  const seen = new Set();
  const out = [];
  for (const p of pairs) {
    if (!p.user || !p.assistant) continue;
    const u = String(p.user).trim();
    const a = String(p.assistant).trim();
    if (!u || !a) continue;
    if (u.length < 2 || u.length > 300) continue;
    if (a.length < 4 || a.length > 400) continue;

    // 去掉带「我」字太多的自说自话、以及明显的报错残留
    if (/^(error|错误|undefined|null)/i.test(a)) continue;
    if (/\[\[sticker:/.test(a)) continue; // 表情标记不进训练（部署后由代码控制）

    const key = u + '\u0000' + a;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ user: u, assistant: a, source: p.source || '' });
  }
  return out;
}

function toSample(p, system) {
  if (format === 'sharegpt') {
    const conv = [
      { from: 'human', value: p.user },
      { from: 'gpt', value: p.assistant },
    ];
    const o = { conversations: conv };
    if (withSystem) o.system = system;
    return o;
  }
  const msgs = [];
  if (withSystem) msgs.push({ role: 'system', content: system });
  msgs.push({ role: 'user', content: p.user });
  msgs.push({ role: 'assistant', content: p.assistant });
  return { messages: msgs };
}

// ---- 主流程 ----
const raw = readJsonl(path.join(DIR, 'raw_pairs.jsonl'));
const aug = readJsonl(path.join(DIR, 'augmented.jsonl'));
console.log(`读入：剧情 ${raw.length} 条，生成 ${aug.length} 条`);

const cleaned = clean([...raw, ...aug]);
console.log(`清洗后：${cleaned.length} 条（去掉 ${raw.length + aug.length - cleaned.length} 条重复或不合格）`);

if (!cleaned.length) {
  console.error('\n没有可用数据。先跑：\n  node train/prepare-data.mjs\n  node train/augment-dialogue.mjs');
  process.exit(1);
}

const system = buildLightSystem();
const samples = cleaned.map((p) => toSample(p, system));

// 打乱
for (let i = samples.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [samples[i], samples[j]] = [samples[j], samples[i]];
}

const valCount = Math.max(1, Math.floor(samples.length * VAL_RATIO));
const val = samples.slice(0, valCount);
const train = samples.slice(valCount);

fs.mkdirSync(OUT_DIR, { recursive: true });
const write = (file, arr) => {
  fs.writeFileSync(file, arr.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  return fs.statSync(file).size;
};
const trainSize = write(path.join(OUT_DIR, 'train.jsonl'), train);
const valSize = write(path.join(OUT_DIR, 'val.jsonl'), val);

// 统计
const avgAns = cleaned.reduce((s, p) => s + p.assistant.length, 0) / cleaned.length;
const bySource = {};
for (const p of cleaned) {
  const kind = p.source.startsWith('augment') ? '生成的日常对话' : '剧情对话';
  bySource[kind] = (bySource[kind] || 0) + 1;
}

console.log(`\n输出：`);
console.log(`  train.jsonl  ${train.length} 条  ${(trainSize / 1024).toFixed(0)} KB`);
console.log(`  val.jsonl    ${val.length} 条  ${(valSize / 1024).toFixed(0)} KB`);
console.log(`  格式         ${format}${withSystem ? '（含 system）' : ''}`);
console.log(`  回答均长     ${avgAns.toFixed(1)} 字`);
console.log(`\n  来源分布：`);
Object.entries(bySource).forEach(([k, n]) => console.log(`    ${k}  ${n}`));
console.log(`\n下一步：把 train/out/ 上传到云端，按 train/LLaMA-Factory.yaml 训练`);
