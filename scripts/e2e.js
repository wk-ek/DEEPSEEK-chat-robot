/**
 * 一键端到端测试：自动拉起 mock 服务端 + 机器人（mock 模型），跑完自动退出。
 *   node scripts/e2e.js
 * 不需要 QQ，不需要 API key，不花钱。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 3001 被占时（比如上一次跑崩了没退干净）可以换个端口：E2E_PORT=3011 npm run e2e
const PORT = Number(process.env.E2E_PORT || 3001);
const C = { dim: '\x1b[90m', green: '\x1b[32m', red: '\x1b[31m', reset: '\x1b[0m', bold: '\x1b[1m' };

const procs = [];

function start(args, env) {
  // 用 inherit 而不是 pipe：既能在普通终端看到输出，
  // 也避开某些受限环境下管道 stdio 被拒绝的问题。
  const p = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  procs.push(p);
  return p;
}

function cleanup(code) {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 150);
}

/** 端口被占时给一句人话，别丢一堆 EADDRINUSE 堆栈。 */
function checkPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : err.message));
    srv.once('listening', () => srv.close(() => resolve(null)));
    srv.listen(port, '127.0.0.1');
  });
}

async function main() {
  console.log(`${C.bold}  端到端测试（mock 模型，不花钱）${C.reset}\n`);

  const busy = await checkPortFree(PORT);
  if (busy) {
    console.error(`${C.red}  ${busy}${C.reset}`);
    console.error(`${C.dim}  换个端口再试：$env:E2E_PORT=3011; npm run e2e${C.reset}\n`);
    cleanup(1);
    return;
  }

  const mock = start(['scripts/mock-onebot.js', '--auto', `--port=${PORT}`]);

  // 等 mock 监听
  await new Promise((r) => setTimeout(r, 1500));

  const bot = start(['src/index.js'], {
    LLM_PROVIDER: 'mock',
    LOG_LEVEL: 'error',
    ONEBOT_WS_URL: `ws://127.0.0.1:${PORT}`,
  });

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: 124, reason: '超时（60s）' }), 60000);
    mock.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, reason: code === 0 ? '通过' : '失败' });
    });
  });

  cleanup(result.code === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${C.red}${err.stack}${C.reset}`);
  cleanup(1);
});
