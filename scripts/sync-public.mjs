/**
 * 把本地工作区（含完整人格）同步成「可以公开」的版本。
 *
 *   node scripts/sync-public.mjs                     同步到 ../qq-deepseek-robot-public
 *   node scripts/sync-public.mjs --target D:\xxx     指定目标
 *   node scripts/sync-public.mjs --dry               只看会动哪些文件，不实际写
 *
 * 工作方式：
 *   1. 清空目标里的受管文件（.git 不动）
 *   2. 按规则从本地复制
 *   3. config.json → config.example.json 并脱敏
 *   4. 打印差异摘要
 *
 * 这个脚本本身也会被复制过去 —— 它是通用工具，不含私有数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const ti = args.indexOf('--target');
const TARGET = path.resolve(ti >= 0 && args[ti + 1] ? args[ti + 1] : path.join(ROOT, '..', 'qq-deepseek-robot-public'));

const C = { dim: '\x1b[90m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m', bold: '\x1b[1m' };

/**
 * 永远不往外复制的路径（相对仓库根）。
 * 宁可多排除，也不要漏一个人格文件出去。
 */
const PRIVATE_FILES = [
  '.env',
  '.env.local',
  'config/config.json',
  'config/persona.amiya.md',
  'config/amiya.lore.md',
  'config/persona.amiya.demon.md',
  'config/persona.chuanzi.md',
  'config/persona.tsundere.md',
  'config/persona.aggressive.md',
  'config/persona.erbao.md',
  'config/persona.amiya.profile.json',
  'config/sensitive-names.txt',
  'HANDOFF.md',
];

const PRIVATE_DIRS = ['node_modules', 'data', 'logs', 'NapCat', '.git', '.vscode', '.idea', 'out'];

/** 按扩展名排除的杂物 */
const JUNK = [/\.log$/, /\.out$/, /\.err$/, /\.db$/, /\.db-shm$/, /\.db-wal$/, /\.tmp$/, /~$/, /^_prts_.*\.txt$/, /^_lore_.*\.txt$/, /^_src_.*\.txt$/];

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function isPrivate(relPath) {
  if (PRIVATE_FILES.includes(relPath)) return true;
  if (JUNK.some((re) => re.test(relPath))) return true;
  const parts = relPath.split('/');
  return parts.some((seg) => PRIVATE_DIRS.includes(seg));
}

/** 递归列出本地所有要复制的文件 */
function collect(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const r = rel(full);
    if (isPrivate(r)) continue;
    if (entry.isDirectory()) collect(full, out);
    else if (entry.isFile()) out.push(r);
  }
  return out;
}

/**
 * 本地的 config.json 含真实 QQ 号、密钥、私有子人格。
 * 公开版必须是脱敏的模板。
 */
function buildExampleConfig() {
  const src = path.join(ROOT, 'config', 'config.json');
  if (!fs.existsSync(src)) {
    console.log(`${C.yellow}  ! 本地没有 config/config.json，跳过模板生成${C.reset}`);
    return null;
  }

  const c = JSON.parse(fs.readFileSync(src, 'utf8'));

  // 脱敏：主人 QQ、多余的主人格、子人格、私有文件路径
  if (c.guard) c.guard.ownerUserIds = [];

  // 只保留两个基础人格作为示例，其余主人格一律不导出
  const KEEP_IDENTITIES = ['feiyu', 'amiya'];
  for (const key of Object.keys(c.persona?.identities || {})) {
    if (!KEEP_IDENTITIES.includes(key)) delete c.persona.identities[key];
  }
  for (const id of Object.values(c.persona?.identities || {})) {
    id.modes = {};
  }
  if (c.botName) c.botName = c.botName;
  if (c.persona?.identities?.amiya) {
    c.persona.identities.amiya.personaFile = 'config/persona.amiya.example.md';
    delete c.persona.identities.amiya.loreFile;
  }

  return JSON.stringify(c, null, 2) + '\n';
}

// ---- 开始 ----
if (!fs.existsSync(TARGET)) {
  console.error(`${C.red}  目标目录不存在：${TARGET}${C.reset}`);
  console.error(`${C.dim}  先 clone 一份干净的远端：git clone <仓库地址> "${TARGET}"${C.reset}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(TARGET, '.git'))) {
  console.error(`${C.red}  目标不是 git 仓库（没有 .git）：${TARGET}${C.reset}`);
  process.exit(1);
}

const files = collect();
const example = buildExampleConfig();
const skipped = PRIVATE_FILES.filter((f) => fs.existsSync(path.join(ROOT, f)));

console.log(`\n${C.bold}  同步到公开工作区${C.reset}  ${C.dim}${TARGET}${C.reset}\n`);
console.log(`  本地文件     ${C.cyan}${files.length}${C.reset} 个`);
console.log(`  排除的人格/私密  ${C.cyan}${skipped.length}${C.reset} 个：`);
skipped.forEach((f) => console.log(`    ${C.dim}- ${f}${C.reset}`));

if (dry) {
  console.log(`\n${C.yellow}  --dry 模式，不实际写入${C.reset}\n`);
  process.exit(0);
}

// 1) 清掉目标里已存在的「受管文件」（保留 .git 和其他非托管内容）
let removed = 0;
for (const f of files) {
  const dst = path.join(TARGET, f);
  if (fs.existsSync(dst)) {
    fs.rmSync(dst, { force: true });
    removed++;
  }
}

// 2) 复制
let copied = 0;
for (const f of files) {
  const src = path.join(ROOT, f);
  const dst = path.join(TARGET, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied++;
}

// 3) 写脱敏后的模板
if (example) {
  fs.writeFileSync(path.join(TARGET, 'config', 'config.example.json'), example, 'utf8');
}

console.log(`\n  ${C.green}✅ 完成${C.reset}  复制 ${copied} 个文件，覆盖前清理 ${removed} 个`);
console.log(`${C.dim}  下一步：cd "${TARGET}" && npm test，然后 git add -A && git commit${C.reset}\n`);
