// 测试机器人的 LLM 层：从 .env 读配置，走 chat()，验证清理
import { chat, sanitizeReply } from './src/llm/deepseek.js';
import { envConfig } from './src/config.js';

console.log('=== 生效配置 ===');
console.log('  provider:', envConfig.provider);
console.log('  baseUrl :', envConfig.deepseekBaseUrl);
console.log('  model   :', envConfig.deepseekModel);
console.log('  timeout :', envConfig.llmTimeout, 'ms');
console.log('  key     :', envConfig.deepseekKey ? '已设置（本地不需要）' : '空');
console.log('');

// 先单独验证清理函数
console.log('=== sanitizeReply 单测 ===');
const cases = [
  { in: '<think>\n\n</think>\n\n在的。', want: '在的。' },
  { in: '<tool_call>\n\n</think>\n\n嗯。', want: '嗯。' },
  { in: '正常回复', want: '正常回复' },
  { in: '<think>思考中...</think>答案', want: '答案' },
];
let pass = 0;
for (const c of cases) {
  const got = sanitizeReply(c.in);
  const ok = got === c.want;
  if (ok) pass++;
  console.log(`  ${ok ? 'OK ' : 'BAD'}  ${JSON.stringify(c.in)} -> ${JSON.stringify(got)}`);
}
console.log(`  ${pass}/${cases.length} 通过\n`);

// 再测真实调用
const QUESTIONS = ['今天好累啊', '阿米娅，罗德岛是什么组织？'];

for (const q of QUESTIONS) {
  const t0 = Date.now();
  try {
    const reply = await chat({
      messages: [
        { role: 'system', content: '你是阿米娅，11岁，卡特斯，罗德岛的公开领袖。叫对方「博士」，用「您」。回答简短。' },
        { role: 'user', content: q },
      ],
      maxTokens: 120,
      tag: 'test',
    });
    const ms = Date.now() - t0;
    const hasAngle = /<[|/]?(?:think|tool_call|im_start|im_end)/i.test(reply);
    console.log('='.repeat(56));
    console.log(`问：${q}`);
    console.log(`答：${reply}`);
    console.log(`    (${ms}ms)  残留标签: ${hasAngle ? '有' : '无'}`);
    console.log('');
  } catch (e) {
    console.log('='.repeat(56));
    console.log(`问：${q}`);
    console.log(`    ❌ ${e.name}: ${e.message}`);
    console.log('');
  }
}
console.log('测试完成');
