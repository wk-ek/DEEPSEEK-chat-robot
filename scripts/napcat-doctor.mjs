/**
 * NapCat 启动问题诊断。
 *
 * 一键启动卡住时跑这个，它会告诉你是哪一环出了问题：
 *
 *   node scripts/napcat-doctor.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PATHS } from '../src/config.js';

const C = { dim: '\x1b[90m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m', bold: '\x1b[1m' };
const ok = (s) => console.log(`${C.green}  ✓${C.reset} ${s}`);
const bad = (s) => console.log(`${C.red}  ✗${C.reset} ${s}`);
const warn = (s) => console.log(`${C.yellow}  !${C.reset} ${s}`);
const info = (s) => console.log(`${C.dim}    ${s}${C.reset}`);

const ROOT = PATHS.root;
const NAPCAT_DIR = path.join(ROOT, 'NapCat');
const SHELL_DIR = path.join(NAPCAT_DIR, 'OneKey', 'NapCat.52230.Shell');
const BOOT_EXE = path.join(SHELL_DIR, 'NapCatWinBootMain.exe');
const BUILTIN_QQ = path.join(SHELL_DIR, 'QQ.exe');

console.log(`\n${C.bold}  NapCat 诊断${C.reset}\n`);

let problems = 0;

// ---------- 1. 文件完整性 ----------
console.log(`${C.cyan}[1] 文件完整性${C.reset}`);
if (fs.existsSync(BOOT_EXE)) ok(`启动器存在：${path.relative(ROOT, BOOT_EXE)}`);
else {
  bad(`找不到启动器：${BOOT_EXE}`);
  info('NapCat 目录可能不完整，需要重新解压 NapCat.Shell.Windows.OneKey.zip');
  problems++;
}
if (fs.existsSync(BUILTIN_QQ)) {
  const v = getVersion(BUILTIN_QQ);
  ok(`内置 QQ 存在${v ? `，版本 ${v}` : ''}`);
} else {
  bad('找不到内置 QQ.exe');
  problems++;
}

function getVersion(exe) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item "${exe}").VersionInfo.FileVersion`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return '';
  }
}

// ---------- 2. 配置文件 ----------
console.log(`\n${C.cyan}[2] 配置文件${C.reset}`);
const cfgRoot = path.join(SHELL_DIR, 'versions');
let obCfg = '';
if (fs.existsSync(cfgRoot)) {
  const verDir = fs.readdirSync(cfgRoot).find((d) => d.startsWith('9.'));
  if (verDir) {
    const cfgDir = path.join(cfgRoot, verDir, 'resources', 'app', 'napcat', 'config');
    if (fs.existsSync(cfgDir)) {
      const files = fs.readdirSync(cfgDir);
      const ob = files.find((f) => /^onebot11_\d+\.json$/.test(f));
      if (ob) {
        obCfg = path.join(cfgDir, ob);
        ok(`OneBot 配置：${path.relative(ROOT, obCfg)}`);
      } else {
        warn('没有 onebot11_<QQ号>.json —— NapCat 还没登录过，或者配置没生成');
      }
      const nap = files.find((f) => /^napcat_\d+\.json$/.test(f));
      if (nap) ok(`NapCat 配置：${nap}`);
    } else {
      warn('配置目录不存在（还没首次登录）');
    }
  }
}

// 检查 WebSocket 端口
if (obCfg) {
  try {
    const j = JSON.parse(fs.readFileSync(obCfg, 'utf8'));
    const servers = j.network?.websocketServers || [];
    const on3001 = servers.find((s) => Number(s.port) === 3001);
    if (!on3001) {
      bad('配置里没有 3001 端口的 WebSocket 服务');
      info('机器人连的是 ws://127.0.0.1:3001，NapCat 必须在这个端口监听');
      problems++;
    } else if (!on3001.enable) {
      bad('3001 端口的 WebSocket 服务被禁用了（enable: false）');
      info('浏览器打开 http://127.0.0.1:6099 进 WebUI 把它打开');
      problems++;
    } else {
      ok(`WebSocket 服务已启用：127.0.0.1:3001（${on3001.name || '未命名'}）`);
    }
  } catch (err) {
    warn(`配置读不了：${err.message}`);
  }
}

// ---------- 3. QQ 版本冲突 ----------
console.log(`\n${C.cyan}[3] QQ 版本冲突检查${C.reset}`);
const builtinVer = fs.existsSync(BUILTIN_QQ) ? getVersion(BUILTIN_QQ) : '';
const sysQQ = 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';
const sysVer = fs.existsSync(sysQQ) ? getVersion(sysQQ) : '';

if (builtinVer) info(`NapCat 内置 QQ：${builtinVer}`);
if (sysVer) info(`系统安装的 QQ：${sysVer}`);

if (builtinVer && sysVer) {
  const b = builtinVer.split('.').slice(0, 3).join('.');
  const s = sysVer.split('.').slice(0, 3).join('.');
  if (b !== s) {
    warn('两个 QQ 版本不同 —— 这是最常见的启动失败原因');
    info('NapCat 的注入器只能 hook 自己那个版本。如果系统 QQ 正在运行，就会冲突。');
    info('一键启动.bat 已经会在启动前 taskkill QQ.exe，如果还不行就手动去任务管理器结束所有 QQ 进程');
  } else {
    ok('版本一致');
  }
}

// 检查正在运行的 QQ
try {
  const out = execFileSync('tasklist', ['/fi', 'imagename eq QQ.exe', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = out.split(/\r?\n/).filter((l) => l.includes('QQ.exe'));
  if (lines.length) {
    warn(`当前有 ${lines.length} 个 QQ.exe 在运行`);
    info('如果不是 NapCat 启动的，它会干扰注入。关掉再试。');
  } else {
    ok('没有运行中的 QQ（好现象）');
  }
} catch {
  /* ignore */
}

// ---------- 4. 端口 ----------
console.log(`\n${C.cyan}[4] 端口状态${C.reset}`);
for (const [port, what] of [
  [3001, 'OneBot WebSocket（机器人连这个）'],
  [6099, 'NapCat WebUI'],
]) {
  let listening = false;
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    listening = out.split(/\r?\n/).some((l) => l.includes(`:${port}`) && l.includes('LISTENING'));
  } catch {
    /* ignore */
  }
  if (listening) ok(`${port} 正在监听 —— ${what}`);
  else {
    if (port === 3001) {
      bad(`${port} 没有监听 —— ${what}`);
      info('这就是机器人连不上的直接原因');
      problems++;
    } else {
      info(`${port} 没监听（${what}，启动后才有）`);
    }
  }
}

// ---------- 5. 机器人连接 ----------
console.log(`\n${C.cyan}[5] 机器人侧${C.reset}`);
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  const env = fs.readFileSync(envFile, 'utf8');
  const m = env.match(/^ONEBOT_WS_URL=(.+)$/m);
  if (m) ok(`配置的连接地址：${m[1].trim()}`);
  if (!env.match(/^DEEPSEEK_API_KEY=\S+/m)) {
    warn('DEEPSEEK_API_KEY 没配 —— 机器人能连上但不会说话');
  } else {
    ok('API key 已配置');
  }
} else {
  bad('没有 .env 文件');
  problems++;
}

// ---------- 总结 ----------
console.log(`\n${C.bold}  结论${C.reset}`);
if (problems === 0) {
  console.log(`${C.green}  没发现明显问题。${C.reset}`);
  console.log(`${C.dim}  如果还是连不上，去看 NapCat 的窗口是不是停在扫码登录。${C.reset}\n`);
} else {
  console.log(`${C.yellow}  发现 ${problems} 个问题，按上面标 ✗ 的逐条处理。${C.reset}\n`);
}
