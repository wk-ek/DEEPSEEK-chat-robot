// 诊断：从训练数据里挑样本，问模型同样的问题，看它能不能答出来
import fs from 'node:fs';
import readline from 'node:readline';

const WISDOM = 'F:\\qq-deepseek-robot\\train\\out\\wisdom.jsonl';

async function loadSamples(n) {
  const out = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(WISDOM, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const msgs = obj.messages || [];
      const user = msgs.find((m) => m.role === 'user')?.content;
      const assistant = msgs.find((m) => m.role === 'assistant')?.content;
      const system = msgs.find((m) => m.role === 'system')?.content;
      if (user && assistant) out.push({ user, assistant, system });
    } catch { /* 跳过坏行 */ }
    if (out.length >= n) break;
  }
  return out;
}

function ask(user, system) {
  return new Promise(async (resolve) => {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 120000);
    try {
      const r = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: c.signal,
        body: JSON.stringify({
          model: 'amiya',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: false,
          options: { temperature: 0.85, top_p: 0.9, repeat_penalty: 1.05, num_predict: 200 },
        }),
      });
      clearTimeout(timer);
      const j = await r.json();
      let txt = j.message?.content || '';
      txt = txt.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').replace(/<\/?(?:think|tool_call)>/gi, '').trim();
      resolve(txt);
    } catch (e) {
      clearTimeout(timer);
      resolve(`[失败 ${e.name}]`);
    }
  });
}

const samples = await loadSamples(6);
console.log(`从训练集读了 ${samples.length} 条样本\n`);

let hit = 0;
for (const s of samples) {
  const got = await ask(s.user, s.system || '你是阿米娅。');
  // 粗略判断：答案里的关键实体有没有在回复里出现
  const keyWords = s.assistant.match(/[\u4e00-\u9fff]{2,4}/g) || [];
  const hitWords = keyWords.filter((w) => got.includes(w));
  const ok = keyWords.length > 0 && hitWords.length / keyWords.length > 0.3;
  if (ok) hit++;

  console.log('='.repeat(60));
  console.log(`问: ${s.user}`);
  console.log(`训练答案（前 100 字）: ${s.assistant.slice(0, 100).replace(/\n/g, ' ')}`);
  console.log(`模型回答: ${got.slice(0, 100).replace(/\n/g, ' ')}`);
  console.log(`关键词命中: ${hitWords.length}/${keyWords.length}  ${ok ? '✓' : '✗'}`);
  console.log('');
}

console.log('='.repeat(60));
console.log(`命中 ${hit}/${samples.length}`);
