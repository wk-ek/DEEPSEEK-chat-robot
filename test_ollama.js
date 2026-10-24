// 通过 Ollama API 测试模型
const QUESTIONS = [
  '今天好累啊',
  '阿米娅你今天好可爱',
  '你几岁啊',
  '我考砸了，很丧',
  '阿米娅，罗德岛是什么组织？',
];

const SYSTEM = '你是阿米娅，11岁，卡特斯，罗德岛的公开领袖。叫对方「博士」，用「您」。回答简短，像在 QQ 上打字，不要长篇大论。';

function clean(text) {
  let t = text || '';
  // 去掉 Qwen3 的 think / tool_call 标签
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '');
  t = t.replace(/<\/think>/g, '');
  t = t.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
  t = t.replace(/<\/?tool_call>/g, '');
  t = t.replace(/<\/?think>/g, '');
  t = t.replace(/<\|im_end\|>/g, '');
  t = t.replace(/<\|im_start\|>/g, '');
  return t.trim();
}

(async () => {
  for (const q of QUESTIONS) {
    const t0 = Date.now();
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 300000);
    try {
      const r = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: c.signal,
        body: JSON.stringify({
          model: 'amiya',
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: q },
          ],
          stream: false,
          options: { temperature: 0.85, top_p: 0.9, repeat_penalty: 1.1, num_predict: 100 },
        }),
      });
      clearTimeout(timer);
      const j = await r.json();
      const raw = j.message?.content || '';
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const evalCount = j.eval_count || 0;
      const evalDur = j.eval_duration ? j.eval_duration / 1e9 : 0;
      const tps = evalDur > 0 ? (evalCount / evalDur).toFixed(1) : '?';

      console.log('='.repeat(56));
      console.log(`问：${q}`);
      console.log(`答：${clean(raw)}`);
      console.log(`    (${elapsed}s, ${evalCount} tokens, ${tps} tok/s)`);
      if (raw !== clean(raw)) {
        console.log(`    原始有标签，已清理`);
      }
      console.log('');
    } catch (e) {
      clearTimeout(timer);
      console.log(`问：${q}`);
      console.log(`    ❌ ${e.name} ${e.message}`);
      console.log('');
    }
  }
  console.log('='.repeat(56));
  console.log('测试完成');
})();
