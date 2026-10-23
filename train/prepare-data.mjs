/**
 * 第一步：从明日方舟剧情文本里提取「对话对」，转成训练数据。
 *
 * 输入：F:\ark_story_data\collected\合集版\**\*.txt（553 个文件，37.5 MB）
 * 输出：train/data/raw_pairs.jsonl
 *
 * 做法：找到每一句「阿米娅: xxx」，把它前面**紧邻的那句非阿米娅台词**当作对方的话。
 * 这样得到的是真实的剧情对话，不是编的。
 *
 *   node train/prepare-data.mjs
 *   node train/prepare-data.mjs --stats     只看统计，不写文件
 */
import fs from 'node:fs';
import path from 'node:path';

const STORY_ROOT = process.env.ARK_STORY_ROOT || 'F:\\ark_story_data\\collected\\合集版';
const OUT_DIR = 'train/data';
const statsOnly = process.argv.includes('--stats');

/** 一句台词的行格式："角色": 内容 */
const LINE_RE = /^\s*"([^"]{1,20})"\s*[:：]\s*(.+)$/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.txt')) out.push(full);
  }
  return out;
}

/** 处理单个文件，返回对话对 */
function extractFromFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const pairs = [];

  // 先解析成 { speaker, content } 序列，跳过旁白
  const said = [];
  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (m) said.push({ speaker: m[1].trim(), content: m[2].trim() });
  }

  const source = path.basename(file, '.txt');
  for (let i = 1; i < said.length; i++) {
    const cur = said[i];
    if (cur.speaker !== '阿米娅') continue;

    // 往前找最近的一句「别人说的」
    let userLine = null;
    for (let j = i - 1; j >= 0 && i - j <= 3; j--) {
      if (said[j].speaker !== '阿米娅') {
        userLine = said[j];
        break;
      }
    }
    if (!userLine) continue;

    const q = userLine.content;
    const a = cur.content;

    // ---- 过滤：宁可少留，也不要留半句话 ----
    // 脱离上下文就没意义的台词会把模型带歪（学会说「……？」这种）
    if (q.length < 4 || q.length > 120) continue;
    if (a.length < 6 || a.length > 220) continue;   // 回答太短基本是语气词
    if (/^[（(]/.test(q) || /^[（(]/.test(a)) continue;  // 动作描写
    if (/[:：]$/.test(q)) continue;

    // 回答里去掉省略号后不足 4 个字的，说明只是「嗯」「……」「？」这种
    const stripped = a.replace(/[…\.\s？?！!，,、~～]/g, '');
    if (stripped.length < 4) continue;

    // 问题里去掉省略号后不足 3 个字的，也是半句
    const qStripped = q.replace(/[…\.\s？?！!，,、~～]/g, '');
    if (qStripped.length < 3) continue;

    // 明显是承接上文的碎片（以这些开头的基本都需要前情）
    if (/^(它|他|她|这|那|所以|但是|可是|然后|而且)/.test(a) && a.length < 10) continue;

    // ---- 最关键的一条：排掉「旁白」----
    // 剧情文本里有一部分格式是 "阿米娅": 阿米娅闻声回头，目光温柔……
    // 那是第三人称叙述，不是她说的。混进训练集会让模型学会「用第三人称写自己」。
    if (a.includes('阿米娅')) continue;                    // 台词里不会直呼自己名字
    if (/^[^「『“"]*?(回头|抬头|低头|看向|望向|目光|脸色|似乎|好像|随后|接着)/.test(a)) continue;

    // 问题侧：引文/书名号包裹的多半是引用，不是对话
    if (/^[「『“"].{10,}/.test(q)) continue;

    pairs.push({
      user: q,
      assistant: a,
      speaker: userLine.speaker,
      source,
    });
  }
  return pairs;
}

// ---- 主流程 ----
if (!fs.existsSync(STORY_ROOT)) {
  console.error(`剧情目录不存在：${STORY_ROOT}`);
  console.error('用 ARK_STORY_ROOT 环境变量指定，或修改脚本里的 STORY_ROOT');
  process.exit(1);
}

const files = walk(STORY_ROOT);
console.log(`扫描 ${files.length} 个剧情文件…`);

let all = [];
for (const f of files) {
  try {
    all = all.concat(extractFromFile(f));
  } catch (err) {
    console.warn(`跳过 ${path.basename(f)}：${err.message}`);
  }
}

// 去重（同样的问 + 同样的答）
const seen = new Set();
const uniq = [];
for (const p of all) {
  const key = p.user + '\u0000' + p.assistant;
  if (seen.has(key)) continue;
  seen.add(key);
  uniq.push(p);
}

// 统计
const lens = uniq.map((p) => p.assistant.length).sort((a, b) => a - b);
const filesCovered = new Set(uniq.map((p) => p.source)).size;

console.log(`\n提取结果：`);
console.log(`  原始对话对      ${all.length}`);
console.log(`  去重后          ${uniq.length}`);
console.log(`  覆盖剧情文件    ${filesCovered} / ${files.length}`);
console.log(`  回复长度        中位数 ${lens[Math.floor(lens.length / 2)]}，平均 ${(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1)}，最长 ${lens[lens.length - 1]}`);

// 按来源分布
const bySource = {};
for (const p of uniq) bySource[p.source] = (bySource[p.source] || 0) + 1;
const top = Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`\n  贡献最多的剧情文件：`);
top.forEach(([s, n]) => console.log(`    ${String(n).padStart(4)}  ${s}`));

if (statsOnly) process.exit(0);

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, 'raw_pairs.jsonl');
fs.writeFileSync(outFile, uniq.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');
console.log(`\n已写出 ${outFile}（${(fs.statSync(outFile).size / 1024 / 1024).toFixed(2)} MB）`);
console.log(`下一步：node train/build-dataset.mjs`);
