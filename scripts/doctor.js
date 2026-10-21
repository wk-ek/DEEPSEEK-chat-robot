/** 启动前自检：把「为什么连不上」这类问题在启动前就说清楚。 */
import fs from 'node:fs';
import net from 'node:net';
import { config, envConfig, PATHS } from '../src/config.js';

const C = {
  ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m',
  dim: '\x1b[90m', bold: '\x1b[1m', reset: '\x1b[0m',
};

const issues = [];
const ok = (n, d = '') => console.log(`  ${C.ok}✓${C.reset} ${n}${d ? `  ${C.dim}${d}${C.reset}` : ''}`);
const warn = (n, d = '', fix = '') => {
  console.log(`  ${C.warn}!${C.reset} ${n}${d ? `  ${C.dim}${d}${C.reset}` : ''}`);
  if (fix) issues.push(fix);
};
const bad = (n, d = '', fix = '') => {
  console.log(`  ${C.bad}✗${C.reset} ${n}${d ? `  ${C.dim}${d}${C.reset}` : ''}`);
  if (fix) issues.push(fix);
};

function tcpCheck(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      resolve(false);
    }, timeout);
    s.on('connect', () => {
      clearTimeout(t);
      s.destroy();
      resolve(true);
    });
    s.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

function parseWs(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port) || (u.protocol === 'wss:' ? 443 : 80) };
  } catch {
    return null;
  }
}

async function main() {
  console.log(`\n${C.bold}  自检${C.reset}\n`);

  // 1. Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  if (major > 22 || (major === 22 && minor >= 5)) {
    ok(`Node.js ${process.version}`, '需要 >= 22.5（内置 WebSocket / node:sqlite）');
  } else {
    bad(`Node.js ${process.version} 太旧`, '需要 >= 22.5', '升级 Node.js 到 22.5 或更高（推荐 24 LTS）');
  }

  // 2. 配置文件
  const envPath = `${PATHS.root}/.env`;
  if (fs.existsSync(envPath)) ok('.env 已存在');
  else bad('缺少 .env', '复制 .env.example 为 .env', '把 .env.example 复制成 .env，并填入 DEEPSEEK_API_KEY');

  // 3. API Key
  if (envConfig.provider === 'mock') {
    warn('LLM_PROVIDER=mock', '当前是假回复模式，不会真的调用模型', '');
  } else if (!envConfig.deepseekKey) {
    bad('DEEPSEEK_API_KEY 为空', '', '去 platform.deepseek.com 申请 key，填进 .env');
  } else if (!/^sk-/.test(envConfig.deepseekKey)) {
    warn('DEEPSEEK_API_KEY 不像标准格式', 'DeepSeek 的 key 通常以 sk- 开头', '确认是否复制完整');
  } else {
    ok('DEEPSEEK_API_KEY 已配置', `${envConfig.deepseekKey.slice(0, 7)}…${envConfig.deepseekKey.slice(-4)}`);
  }

  // 4. 人设文件
  if (fs.existsSync(PATHS.persona)) {
    const text = fs.readFileSync(PATHS.persona, 'utf8');
    ok('人设文件存在', `${config.personaFile}（${text.length} 字）`);
    if (text.length < 80) warn('人设文件内容偏短', '模型会不太稳定', '在 config/persona.md 里多写点「她会/她不会」');
  } else {
    bad('缺少人设文件', PATHS.persona, '运行一次 npm start 会自动生成默认人设，或手动创建');
  }

  // 5. 模型 API 连通性
  if (envConfig.provider !== 'mock') {
    try {
      const url = `${envConfig.deepseekBaseUrl}/models`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(url, {
        headers: envConfig.deepseekKey ? { Authorization: `Bearer ${envConfig.deepseekKey}` } : {},
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 200 || res.status === 401) {
        ok('模型 API 可达', `${envConfig.deepseekBaseUrl} → HTTP ${res.status}${res.status === 401 ? '（缺 key 或 key 无效）' : ''}`);
        if (res.status === 401 && envConfig.deepseekKey) issues.push('API 返回 401：key 无效或填错了');
      } else {
        warn(`模型 API 返回 HTTP ${res.status}`, '', '检查网络或代理设置');
      }
    } catch (err) {
      bad('模型 API 不可达', err.message, '检查网络/代理；如果开了代理，确认 api.deepseek.com 走了正确线路');
    }
  }

  // 6. OneBot 端口
  const ws = parseWs(envConfig.onebotWsUrl);
  if (!ws) {
    bad('ONEBOT_WS_URL 格式不对', envConfig.onebotWsUrl, '应形如 ws://127.0.0.1:3001');
  } else {
    const reachable = await tcpCheck(ws.host, ws.port);
    if (reachable) {
      ok('NapCat WebSocket 端口可达', `${ws.host}:${ws.port}`);
    } else {
      warn(
        `NapCat 端口不可达（${ws.host}:${ws.port}）`,
        '如果你还没启动 NapCat，这是正常的',
        '启动 NapCat 并在「网络配置」里开启 WebSocket 服务器，端口与 .env 的 ONEBOT_WS_URL 保持一致'
      );
    }
  }

  // 7. 数据库可写
  try {
    fs.accessSync(PATHS.data, fs.constants.W_OK);
    ok('数据目录可写', 'data/');
  } catch {
    bad('数据目录不可写', PATHS.data, '检查文件夹权限');
  }

  // 汇总
  console.log('');
  if (!issues.length) {
    console.log(`  ${C.ok}${C.bold}全部就绪，可以 node src/index.js 启动了。${C.reset}\n`);
  } else {
    console.log(`  ${C.warn}${C.bold}还有 ${issues.length} 件事要处理：${C.reset}`);
    issues.forEach((s, i) => console.log(`   ${i + 1}. ${s}`));
    console.log('');
  }
}

main().catch((err) => {
  console.error(`${C.bad}自检本身出错了：${err.message}${C.reset}`);
  process.exit(1);
});
