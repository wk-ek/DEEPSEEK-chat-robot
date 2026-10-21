/**
 * 用 .env 里的 GITHUB_TOKEN 推送到 GitHub。
 *
 *   node scripts/push.mjs                 推当前分支到 origin
 *   node scripts/push.mjs origin main     指定远端和分支
 *
 * 令牌只从 .env 读，不会写进 .git/config，也不会打印出来。
 * 认证走一次性的 http.extraheader，推完就没了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { dim: '\x1b[90m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', reset: '\x1b[0m', bold: '\x1b[1m' };

/** 从 .env 里读一个键，不引第三方。 */
function readEnv(key) {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return '';
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || m[1] !== key) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      const hash = v.indexOf(' #');
      if (hash !== -1) v = v.slice(0, hash).trim();
    }
    return v;
  }
  return '';
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: opts.stdio || ['ignore', 'pipe', 'pipe'] }).trim();
}

const remote = process.argv[2] || 'origin';
const branch = process.argv[3] || git(['rev-parse', '--abbrev-ref', 'HEAD']);

const token = readEnv('GITHUB_TOKEN');
if (!token) {
  console.error(`${C.red}  .env 里没有 GITHUB_TOKEN${C.reset}`);
  console.error(`${C.dim}  在 .env 里加一行：GITHUB_TOKEN=github_pat_xxxx${C.reset}`);
  process.exit(1);
}

// 有东西要推吗
const status = git(['status', '--porcelain']);
if (status) {
  console.log(`${C.yellow}  工作区还有未提交的改动：${C.reset}`);
  status.split('\n').slice(0, 10).forEach((l) => console.log('    ' + l));
  console.log(`${C.dim}  先 commit 再推。${C.reset}\n`);
  process.exit(1);
}

const ahead = git(['rev-list', '--count', `origin/${branch}..${branch}`]);
if (ahead === '0') {
  console.log(`${C.green}  没有新的提交，远端已经是最新的。${C.reset}`);
  process.exit(0);
}

console.log(`${C.bold}  推送到 ${remote}/${branch}${C.reset}  ${C.dim}（${ahead} 个提交）${C.reset}\n`);

// 一次性 Basic 认证头，不落盘
const pair = `x-access-token:${token}`;
const header = `Authorization: Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;

try {
  const out = execFileSync(
    'git',
    ['-c', `http.extraheader=${header}`, 'push', remote, branch],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  console.log(out.replace(new RegExp(token, 'g'), '***').trim());
  console.log(`\n${C.green}  ✅ 推送成功${C.reset}\n`);
} catch (err) {
  const msg = ((err.stderr || '') + (err.stdout || '')).replace(new RegExp(token, 'g'), '***');
  console.error(`${C.red}  ❌ 推送失败${C.reset}`);
  console.error(msg.trim().slice(0, 800));
  if (/403|Permission .* denied/i.test(msg)) {
    console.error(`\n${C.yellow}  提示：令牌权限不够。fine-grained token 需要有该仓库的 Contents: Read and write。${C.reset}`);
  }
  process.exit(1);
}
