/**
 * 人格体检：读最近的真实对话数据，看她说话像不像人，并给出可执行的调整建议。
 *
 *   node scripts/evolve.mjs                 看最近 7 天
 *   node scripts/evolve.mjs --days 30       看最近 30 天
 *   node scripts/evolve.mjs --all           全部历史
 *   node scripts/evolve.mjs --json          输出 JSON（给脚本/自动化用）
 *
 * 它**不会**自动改人格文件 —— 改坏了不可控。它只做两件事：
 *   1. 把「像不像人」量化出来（长度、复读、接话率、表情率…）
 *   2. 针对异常项给出具体建议，你确认后再手动改
 *
 * 注意两个数据源的差别：
 *   · 数据库存的是「清洗后的回复文本」，表情标记在发送时就被剥掉了
 *   · 日志里有 `[表情包]` 后缀，所以表情率从日志统计才准
 *
 * 建议每周跑一次，或者攒够几百条对话后跑一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb, closeDb } from '../src/memory/db.js';
import { config, PATHS } from '../src/config.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const all = args.includes('--all');
const di = args.indexOf('--days');
const daysArg = args.find((a) => a.startsWith('--days='))?.split('=')[1] || (di >= 0 ? args[di + 1] : undefined);
const days = all ? 0 : Number(daysArg) || 7;

const C = {
  dim: '\x1b[90m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', reset: '\x1b[0m', bold: '\x1b[1m',
};

/**
 * 系统写死的固定话术 —— 这些重复出现是正常的（人格切换确认、静默确认、列表等），
 * 不能算进「复读」里，否则会把机器人的锅算到模型头上。
 */
const FIXED_PATTERNS = [
  /^……行吧，本鱼切串子模式了。?$/,
  /^嗯……变回来了。?$/,
  /^……哦。变回来了。?$/,
  /^哼，谁要给你演啊/,
  /^行。那我就不留嘴了。?$/,
  /^……好，收刀。?$/,
  /^……博士。我回来了。?$/,
  /^……回来了。刚才切哪去了？?$/,
  /^嗯，我回罗德岛了。?$/,
  /^……哦。?$/,
  /^……好嘛。?$/,
  /^嗯。那我安静待着。?$/,
  /^……行吧。?$/,
  /^嗯？$/,
  /^怎么了。?$/,
  /^在。?$/,
  /^你说。?$/,
  /^叫我干嘛。?$/,
  /^已经[是有].{1,8}了。?$/,
  /还没上线/,
  /^没有「.*」这个人格/,
  /^现在：/,
  /主人格：/,
  /子人格：/,
  /用法：\/persona/,
  /^我不知道……但是我很饿/,
  /^这个我查不到。有白饭吗/,
  /^嗯……不知道诶。我好饿/,
  /^想不出来。肚子在叫了/,
];

const isFixed = (t) => FIXED_PATTERNS.some((re) => re.test(String(t || '').trim()));

const db = getDb();
const since = days ? Date.now() - days * 24 * 3600 * 1000 : 0;

const rows = db
  .prepare(
    `SELECT scope, user_id, sender_name, role, text, ts
       FROM messages
      WHERE ts >= ?
      ORDER BY ts ASC`
  )
  .all(since);

if (!rows.length) {
  console.log(`${C.yellow}  这个时间范围里没有对话记录。${C.reset}`);
  console.log(`${C.dim}  先让她聊几天，或者用 --all 看全部历史。${C.reset}`);
  closeDb();
  process.exit(0);
}

const users = rows.filter((r) => r.role !== 'assistant');
const allBots = rows.filter((r) => r.role === 'assistant');
// 真正由模型生成的那些回复
const bots = allBots.filter((r) => !isFixed(r.text));

const len = (s) => [...String(s || '')].length;
const botLens = bots.map((r) => len(r.text)).sort((a, b) => a - b);
const median = botLens.length ? botLens[Math.floor(botLens.length / 2)] : 0;
const avg = botLens.length ? botLens.reduce((a, b) => a + b, 0) / botLens.length : 0;

// ---- 表情率：从日志统计（数据库里没有表情标记）----
let logReplies = 0;
let logStickers = 0;
try {
  const logDir = PATHS.logs;
  const cutoff = days ? Date.now() - days * 24 * 3600 * 1000 : 0;
  for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith('.log'))) {
    const fp = path.join(logDir, f);
    if (fs.statSync(fp).mtimeMs < cutoff) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      if (!line.includes(' → ')) continue;
      logReplies++;
      if (line.includes('[表情包]')) logStickers++;
    }
  }
} catch {
  /* 日志读不到就跳过 */
}
const stickerRate = logReplies ? logStickers / logReplies : null;

// 复读检测（只统计模型生成的）
const replyCount = new Map();
for (const r of bots) replyCount.set(r.text, (replyCount.get(r.text) || 0) + 1);
const repeated = [...replyCount.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);

// 起手式
const heads = new Map();
for (const r of bots) {
  const h = String(r.text || '').slice(0, 2);
  if (h) heads.set(h, (heads.get(h) || 0) + 1);
}
const topHeads = [...heads.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

// 接话率
const byScope = new Map();
for (const r of rows) {
  if (!byScope.has(r.scope)) byScope.set(r.scope, []);
  byScope.get(r.scope).push(r);
}
let answered = 0;
for (const [, list] of byScope) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].role !== 'assistant' && list[i + 1] && list[i + 1].role === 'assistant') answered++;
  }
}
const answerRate = users.length ? answered / users.length : 0;

const suggest = [];

if (bots.length && avg > config.reply.maxReplyChars * 0.7) {
  suggest.push(
    `平均回复 ${avg.toFixed(0)} 字，已经接近上限 ${config.reply.maxReplyChars}。她可能有点话多 —— ` +
      `调小 reply.maxReplyChars，或在人格里加「三句话说不完就别说」。`
  );
}
if (bots.length > 20 && avg < 8) {
  suggest.push(`平均回复只有 ${avg.toFixed(0)} 字，可能太敷衍 —— 人格里可以写得更具体一点。`);
}
if (repeated.length) {
  const [t, n] = repeated[0];
  suggest.push(
    `有 ${repeated.length} 句回复重复 ≥3 次（最多的重复 ${n} 次：「${t.slice(0, 24)}」）。` +
      `这是最像机器人的地方 —— 人格里加「别用同一句话应付人」，或调高 DEEPSEEK_TEMPERATURE。`
  );
}
if (stickerRate !== null && logReplies > 30 && stickerRate < 0.1 && config.stickers?.enabled) {
  suggest.push(
    `表情只有 ${(stickerRate * 100).toFixed(0)}% 的回复带（${logStickers}/${logReplies}），偏低 —— ` +
      `检查 stickerKeys 配置，或在 prompt 的表情包里加强要求。`
  );
}
if (bots.length && topHeads.length && topHeads[0][1] / bots.length > 0.25) {
  suggest.push(
    `开头「${topHeads[0][0]}」占了 ${(topHeads[0][1] / bots.length * 100).toFixed(0)}%，起手式太单一 —— 人格里多写几种开场。`
  );
}
if (answerRate > 0 && answerRate < 0.4 && users.length > 50) {
  suggest.push(
    `接话率 ${(answerRate * 100).toFixed(0)}%。群聊为主时这是正常的（多数时候不该插话）；私聊也这么低就检查限流与静默状态。`
  );
}

const report = {
  range: days ? `最近 ${days} 天` : '全部历史',
  messages: { total: rows.length, user: users.length, bot: allBots.length, botFromModel: bots.length },
  scopes: byScope.size,
  replyLength: { avg: Number(avg.toFixed(1)), median, max: botLens[botLens.length - 1] || 0 },
  stickerRate: stickerRate === null ? null : Number(stickerRate.toFixed(3)),
  answerRate: Number(answerRate.toFixed(3)),
  repeatedReplies: repeated.slice(0, 5).map(([text, n]) => ({ text: text.slice(0, 40), times: n })),
  topHeads: topHeads.slice(0, 5).map(([k, n]) => ({ head: k, count: n })),
  suggestions: suggest,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  closeDb();
  process.exit(0);
}

console.log(`\n${C.bold}  人格体检${C.reset}  ${C.dim}（${report.range}）${C.reset}\n`);

console.log(`  数据量`);
console.log(`    消息 ${C.cyan}${rows.length}${C.reset} 条`);
console.log(
  `    其中她的回复 ${C.cyan}${allBots.length}${C.reset} 条` +
    `${C.dim}（${bots.length} 条由模型生成，${allBots.length - bots.length} 条是系统固定话术）${C.reset}`
);
console.log(`    会话 ${C.cyan}${byScope.size}${C.reset} 个`);

console.log(`\n  像不像人`);
console.log(`    平均回复长度   ${C.cyan}${avg.toFixed(1)}${C.reset} 字（中位数 ${median}，最长 ${botLens[botLens.length - 1] || 0}）`);
console.log(`    接话率         ${C.cyan}${(answerRate * 100).toFixed(0)}%${C.reset}  ${C.dim}（别人说完她接上的比例）${C.reset}`);
if (stickerRate !== null) {
  console.log(`    带表情的回复   ${C.cyan}${(stickerRate * 100).toFixed(0)}%${C.reset}  ${C.dim}（${logStickers}/${logReplies}，从日志统计）${C.reset}`);
} else {
  console.log(`    带表情的回复   ${C.dim}（没有日志，统计不了）${C.reset}`);
}

if (topHeads.length) {
  console.log(`\n  起手式`);
  topHeads.forEach(([k, n]) => {
    const pct = (n / bots.length * 100).toFixed(0);
    const bar = '█'.repeat(Math.max(1, Math.round(n / bots.length * 30)));
    console.log(`    ${C.dim}${k.padEnd(4)}${C.reset} ${bar} ${n} 次 (${pct}%)`);
  });
}

if (repeated.length) {
  console.log(`\n  复读嫌疑 ${C.dim}（已排除系统话术）${C.reset}`);
  repeated.slice(0, 3).forEach(([t, n]) => {
    console.log(`    ${C.yellow}×${n}${C.reset}  ${t.slice(0, 40)}`);
  });
}

console.log(`\n  ${C.bold}建议${C.reset}`);
if (!suggest.length) {
  console.log(`    ${C.green}没发现明显问题。${C.reset}`);
} else {
  suggest.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
}

console.log(`\n${C.dim}  只做诊断，不会自动改人格。挑你认同的建议，手动改 config/persona*.md。${C.reset}\n`);

closeDb();
