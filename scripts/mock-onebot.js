/**
 * 模拟 NapCat / OneBot v11 服务端，用来在没有 QQ 号的情况下把整条链路跑通。
 * 手写最小 WebSocket 服务端（不引第三方），只支持文本帧。
 *
 * 用法：
 *   node scripts/mock-onebot.js              # 交互模式：回车输入当私聊
 *   node scripts/mock-onebot.js --auto       # 自动测试：连上后自动发消息并校验回复
 *
 * 交互模式下：
 *   /p 你好          私聊
 *   /g 大家好        群聊（不@）
 *   /m 在吗          群聊 @机器人
 *   /q               退出
 */
import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import fs from 'node:fs';

const PROGRESS_FILE = 'mock-progress.log';
try {
  fs.writeFileSync(PROGRESS_FILE, '');
} catch {
  /* ignore */
}
/** 进度写到文件，避免进程被杀时 stdout 缓冲丢失。 */
function prog(msg) {
  try {
    fs.appendFileSync(PROGRESS_FILE, `${new Date().toISOString().slice(11, 23)} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1]) || 3001;
const MODE = process.argv.includes('--auto') ? 'auto' : 'interactive';
const SELF_ID = '10000';
const BOT_NAME = '小满';
const TEST_USER = { user_id: 22222, nickname: '阿泽', card: '' };
const TEST_GROUP = { group_id: 33333, group_name: '测试群' };

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const c = {
  dim: '\x1b[90m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
  magenta: '\x1b[35m', red: '\x1b[31m', reset: '\x1b[0m', bold: '\x1b[1m',
};

let msgSeq = 1000;
const clients = new Set();
let autoDone = false;

// ---------------- WebSocket 基础 ----------------

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodePong(payload) {
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x8a, len]) : Buffer.from([0x8a, 126, len >> 8, len & 0xff]);
  return Buffer.concat([header, payload]);
}

/** 从缓冲区里切出完整帧，返回剩余字节。 */
function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (offset + 2 > buf.length) break;
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;

    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }

    let mask = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (p + len > buf.length) break;

    let payload = buf.subarray(p, p + len);
    if (masked) {
      const copy = Buffer.alloc(len);
      for (let i = 0; i < len; i++) copy[i] = payload[i] ^ mask[i % 4];
      payload = copy;
    }
    frames.push({ opcode, payload });
    offset = p + len;
  }
  return { frames, rest: buf.subarray(offset) };
}

function handleFrame(socket, frame) {
  switch (frame.opcode) {
    case 0x1: {
      const text = frame.payload.toString('utf8');
      try {
        onAction(JSON.parse(text));
      } catch {
        console.log(`${c.red}[mock] 收到非 JSON 帧${c.reset}`);
      }
      break;
    }
    case 0x8:
      socket.end();
      break;
    case 0x9:
      socket.write(encodePong(frame.payload));
      break;
    default:
      break;
  }
}

// ---------------- OneBot 行为 ----------------

function sendJson(obj) {
  const frame = encodeFrame(JSON.stringify(obj));
  for (const s of clients) {
    if (!s.destroyed) s.write(frame);
  }
}

function actionReply(echo, data = {}) {
  return { status: 'ok', retcode: 0, data, echo };
}

let replyWaiters = [];

function onAction(req) {
  const { action, params = {}, echo } = req;
  switch (action) {
    case 'get_login_info':
      sendJson(actionReply(echo, { user_id: Number(SELF_ID), nickname: BOT_NAME }));
      break;
    case 'send_private_msg':
    case 'send_group_msg': {
      const text = extractTextFromSegments(params.message);
      const target = action === 'send_group_msg' ? `群 ${params.group_id}` : `私聊 ${params.user_id}`;
      prog(`REPLY ${action} "${text}"`);
      console.log('');
      console.log(`${c.magenta}${c.bold}  ${BOT_NAME}${c.reset}${c.dim} → ${target}${c.reset}`);
      console.log(`${c.cyan}  ${text}${c.reset}`);
      console.log('');
      const id = ++msgSeq;
      sendJson(actionReply(echo, { message_id: id }));
      for (const w of replyWaiters.slice()) {
        if (w.match(action, params, text)) {
          replyWaiters = replyWaiters.filter((x) => x !== w);
          w.resolve({ action, params, text });
        }
      }
      break;
    }
    case 'get_group_list':
      sendJson(actionReply(echo, [{ group_id: TEST_GROUP.group_id, group_name: TEST_GROUP.group_name }]));
      break;
    case 'get_stranger_info':
    case 'get_group_member_info':
      sendJson(actionReply(echo, { user_id: params.user_id, nickname: TEST_USER.nickname }));
      break;
    case 'set_msg_emoji_like':
      sendJson(actionReply(echo, {}));
      break;
    default:
      sendJson(actionReply(echo, {}));
      break;
  }
}

function extractTextFromSegments(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message
    .map((s) => {
      if (s.type === 'text') return s.data?.text ?? '';
      if (s.type === 'at') return `@${s.data?.qq} `;
      if (s.type === 'image') return '[图片]';
      return '';
    })
    .join('')
    .trim();
}

function waitForReply(match, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      replyWaiters = replyWaiters.filter((x) => x !== waiter);
      reject(new Error('等待回复超时'));
    }, timeoutMs);
    const waiter = {
      match,
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
    };
    replyWaiters.push(waiter);
  });
}

function pushMessage({ type, text, at = false }) {
  const base = {
    post_type: 'message',
    self_id: Number(SELF_ID),
    time: Math.floor(Date.now() / 1000),
    message_id: ++msgSeq,
    user_id: TEST_USER.user_id,
    sender: {
      user_id: TEST_USER.user_id,
      nickname: TEST_USER.nickname,
      card: TEST_USER.card,
      is_bot: false,
    },
    raw_message: text,
  };
  const message = [];
  if (type === 'group') {
    base.message_type = 'group';
    base.sub_type = 'normal';
    base.group_id = TEST_GROUP.group_id;
    base.group_name = TEST_GROUP.group_name;
    if (at) message.push({ type: 'at', data: { qq: String(SELF_ID), name: BOT_NAME } });
  } else {
    base.message_type = 'private';
    base.sub_type = 'friend';
  }
  message.push({ type: 'text', data: { text } });
  base.message = message;
  console.log(`${c.yellow}  ▶ 你 → ${type === 'group' ? '群' : '私聊'}${at ? ' @她' : ''}：${text}${c.reset}`);
  prog(`PUSH ${type}${at ? '@' : ''} "${text}" (clients=${clients.size})`);
  sendJson(base);
}

// ---------------- 启动 ----------------

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('mock-onebot is running\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  clients.add(socket);
  console.log(`${c.green}[mock] 机器人已连上（客户端数 ${clients.size}）${c.reset}`);

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { frames, rest } = decodeFrames(buf);
    buf = rest;
    for (const f of frames) handleFrame(socket, f);
  });
  socket.on('close', () => {
    clients.delete(socket);
    console.log(`${c.dim}[mock] 机器人断开（剩余 ${clients.size}）${c.reset}`);
  });
  socket.on('error', () => {
    clients.delete(socket);
  });

  // 连上就发 lifecycle，让她知道自己的 QQ 号
  setTimeout(() => {
    sendJson({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
      time: Math.floor(Date.now() / 1000),
      self_id: Number(SELF_ID),
    });
  }, 100);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`${c.magenta}  Mock OneBot v11 服务端${c.reset}`);
  console.log(`  ${c.dim}监听${c.reset}  ws://127.0.0.1:${PORT}`);
  console.log(`  ${c.dim}账号${c.reset}  ${SELF_ID} (${BOT_NAME})`);
  console.log('');
  if (MODE === 'interactive') {
    console.log(`  ${c.dim}直接输入 = 私聊；/g 内容 = 群聊；/m 内容 = 群聊@她；/q 退出${c.reset}`);
    console.log('');
  }
});

// ---------------- 交互 / 自动测试 ----------------

if (MODE === 'auto') {
  runAutoTest();
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return rl.prompt();
    if (s === '/q' || s === 'exit') process.exit(0);
    if (s.startsWith('/g ')) pushMessage({ type: 'group', text: s.slice(3), at: false });
    else if (s.startsWith('/m ')) pushMessage({ type: 'group', text: s.slice(3), at: true });
    else if (s.startsWith('/p ')) pushMessage({ type: 'private', text: s.slice(3) });
    else pushMessage({ type: 'private', text: s });
    rl.prompt();
  });
}

async function runAutoTest() {
  const steps = [];
  const ok = (m) => {
    steps.push(m);
    console.log(`${c.green}  ✓ ${m}${c.reset}`);
  };
  const fail = (m) => {
    console.log(`${c.red}  ✗ ${m}${c.reset}`);
    process.exit(1);
  };

  try {
    prog('auto test start');
    // 等机器人连上来
    const t0 = Date.now();
    while (clients.size === 0) {
      if (Date.now() - t0 > 30000) throw new Error('30s 内机器人没有连上来');
      await new Promise((r) => setTimeout(r, 200));
    }
    ok('机器人已连接');
    prog('client connected');

    await new Promise((r) => setTimeout(r, 1500));

    // 私聊
    prog('sending private msg');
    const p1 = waitForReply((a, _p, text) => a === 'send_private_msg' && text.length > 0);
    pushMessage({ type: 'private', text: '你好呀，今天有点累' });
    const r1 = await p1;
    ok(`私聊收到回复：${r1.text}`);
    prog(`got private reply: ${r1.text}`);

    // 群聊 @
    const p2 = waitForReply((a) => a === 'send_group_msg');
    pushMessage({ type: 'group', text: '小满你在吗', at: true });
    const r2 = await p2;
    ok(`群聊@收到回复：${r2.text}`);
    if (!r2.params.message.some((s) => s.type === 'at' && String(s.data.qq) === String(TEST_USER.user_id))) {
      console.log(`${c.yellow}  ! 群回复里没有 @ 发送者（不影响功能）${c.reset}`);
    }

    // 群聊但不@，应该沉默
    let silent = true;
    const p3 = waitForReply((a) => a === 'send_group_msg', 4000).then(() => (silent = false)).catch(() => {});
    pushMessage({ type: 'group', text: '今天天气不错', at: false });
    await p3;
    if (!silent) fail('没 @ 她的时候她仍然回复了，应该保持安静');
    ok('群聊里没 @ 她时保持安静');

    // ---- 人格切换 ----
    // 注意：切人格走的是 #handlePersona，不进 #flush，所以不消耗限流额度

    // 1) 会话识别：私聊说触发词就切子人格
    const p4 = waitForReply((a, _p, t) => a === 'send_private_msg' && t.length > 0);
    pushMessage({ type: 'private', text: '当傲娇' });
    const r4 = await p4;
    ok(`会话切傲娇 → ${r4.text}`);
    if (!/谁要|就这一次/.test(r4.text)) fail(`傲娇的确认话术不对：${r4.text}`);

    // 2) 全局退出词：任何子人格下都能回正常
    const p5 = waitForReply((a, _p, t) => a === 'send_private_msg' && t.length > 0);
    pushMessage({ type: 'private', text: '正常点' });
    const r5 = await p5;
    ok(`全局退出词生效 → ${r5.text}`);
    if (!/变回来/.test(r5.text)) fail(`退出话术不对：${r5.text}`);

    // 3) /persona 列表：要能看出主人格和子人格两层
    const p6 = waitForReply((a, _p, t) => a === 'send_private_msg' && t.length > 0);
    pushMessage({ type: 'private', text: '/persona' });
    const r6 = await p6;
    ok(`人格列表 → ${r6.text.replace(/\s+/g, ' ')}`);
    for (const need of ['大肥鱼', '阿米娅', '子人格']) {
      if (!r6.text.includes(need)) fail(`列表里应该有「${need}」，实际：${r6.text}`);
    }

    // 4) 阿米娅是强制命令才能进的占位人格，现在还没启用，应该被拦住
    const p7 = waitForReply((a, _p, t) => a === 'send_private_msg' && t.length > 0);
    pushMessage({ type: 'private', text: '/persona 阿米娅' });
    const r7 = await p7;
    ok(`阿米娅占位被拦 → ${r7.text}`);
    if (!/还没上线/.test(r7.text)) fail(`阿米娅应该回「还没上线」，实际：${r7.text}`);

    // 5) 群里不 @ 她时说触发词不该生效，否则路人一句话就能改全群人格
    let silent2 = true;
    const p8 = waitForReply((a) => a === 'send_group_msg', 4000)
      .then(() => (silent2 = false))
      .catch(() => {});
    pushMessage({ type: 'group', text: '当傲娇', at: false });
    await p8;
    if (!silent2) fail('群里没 @ 她时，人格触发词不该生效');
    ok('群里没 @ 她时，人格触发词不生效');

    console.log('');
    console.log(`${c.green}${c.bold}  ✅ 端到端测试通过（${steps.length} 项）${c.reset}`);
    console.log('');
    process.exit(0);
  } catch (err) {
    fail(`测试失败：${err.message}`);
  }
}
