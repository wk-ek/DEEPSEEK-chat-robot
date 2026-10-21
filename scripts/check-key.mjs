/** 验证 .env 里的 DeepSeek API key 是否真的可用。 */
import { envConfig } from '../src/config.js';

const key = envConfig.deepseekKey || '';
const mask = key ? `${key.slice(0, 7)}…${key.slice(-4)}` : '(空)';
const base = envConfig.deepseekBaseUrl;
const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[90m', reset: '\x1b[0m', bold: '\x1b[1m' };

const ok = (m, d = '') => console.log(`  ${C.ok}✓${C.reset} ${m}${d ? `  ${C.dim}${d}${C.reset}` : ''}`);
const bad = (m, d = '') => console.log(`  ${C.bad}✗${C.reset} ${m}${d ? `  ${C.dim}${d}${C.reset}` : ''}`);

console.log(`\n${C.bold}  DeepSeek Key 检测${C.reset}\n`);
console.log(`  key     ${mask}   长度 ${key.length}`);
console.log(`  端点    ${base}`);
console.log(`  模型    ${envConfig.deepseekModel}\n`);

if (!key) {
  bad('没有配置 key', '在 .env 里填 DEEPSEEK_API_KEY');
  process.exit(1);
}

const H = { Authorization: `Bearer ${key}` };

// 1) 鉴权：GET /models
try {
  const r = await fetch(`${base}/models`, { headers: H });
  if (r.ok) {
    const j = await r.json();
    const models = (j.data || []).map((m) => m.id).slice(0, 8);
    ok('鉴权通过', `可用模型：${models.join(', ')}`);
  } else if (r.status === 401) {
    bad('key 无效（401）', '检查是否复制完整、是否已在后台删除');
  } else {
    bad(`鉴权返回 HTTP ${r.status}`, (await r.text()).slice(0, 200));
  }
} catch (err) {
  bad('连不上 API', err.message);
  process.exit(1);
}

// 2) 余额
try {
  const r = await fetch(`${base}/user/balance`, { headers: H });
  if (r.ok) {
    const j = await r.json();
    const parts = (j.balance_infos || []).map((b) => {
      const granted = Number(b.granted_balance || 0);
      const topped = Number(b.topped_up_balance || 0);
      return `${b.currency} 总 ${b.total_balance}（赠送 ${granted.toFixed(2)} + 充值 ${topped.toFixed(2)}）`;
    });
    if (j.is_available) ok('账户可用', parts.join(' | ') || '余额正常');
    else bad('账户不可用', parts.join(' | ') || '余额可能为 0，需要充值');
  } else {
    console.log(`  ${C.warn}!${C.reset} 余额接口返回 ${r.status}（不影响使用）`);
  }
} catch (err) {
  console.log(`  ${C.warn}!${C.reset} 余额查询失败：${err.message}`);
}

// 3) 真实对话
try {
  const t0 = Date.now();
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: envConfig.deepseekModel,
      messages: [{ role: 'user', content: '只回复两个字：在的' }],
      max_tokens: 16,
      temperature: 0,
    }),
  });
  const ms = Date.now() - t0;
  const j = await r.json();
  if (r.ok) {
    const reply = j?.choices?.[0]?.message?.content ?? '';
    const u = j?.usage || {};
    ok(`真实对话成功`, `${ms}ms`);
    console.log(`  ${C.dim}模型回复：${JSON.stringify(reply)}${C.reset}`);
    console.log(`  ${C.dim}tokens：prompt ${u.prompt_tokens ?? '?'} + completion ${u.completion_tokens ?? '?'} = ${u.total_tokens ?? '?'}${C.reset}`);
  } else {
    bad(`对话失败 HTTP ${r.status}`, JSON.stringify(j).slice(0, 300));
  }
} catch (err) {
  bad('对话请求出错', err.message);
}

console.log('');
