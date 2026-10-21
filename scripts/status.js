/** 看她现在对你是什么感觉（调试用）。 */
import { getDb } from '../src/memory/db.js';
import { favorTier, MOOD_LABELS } from '../src/persona/state.js';

const C = { dim: '\x1b[90m', bold: '\x1b[1m', reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m' };

const db = getDb();

const users = db.prepare('SELECT * FROM users ORDER BY favor DESC').all();
const groups = db.prepare('SELECT * FROM groups ORDER BY last_active DESC').all();
const memCount = db.prepare('SELECT COUNT(*) n FROM memories').get();
const msgCount = db.prepare('SELECT COUNT(*) n FROM messages').get();

const bar = (v) => {
  const filled = Math.round(Math.max(0, Math.min(100, v)) / 5);
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
};

console.log(`\n${C.bold}  她记得的人${C.reset}\n`);
if (!users.length) {
  console.log(`  ${C.dim}还没有人和她说过话。${C.reset}\n`);
} else {
  for (const u of users) {
    const tier = favorTier(u.favor);
    const mood = MOOD_LABELS[u.mood] || u.mood;
    console.log(`  ${C.cyan}${u.nick || u.user_id}${C.reset}  ${C.dim}(${u.user_id})${C.reset}`);
    console.log(`   好感  ${C.green}${bar(u.favor)}${C.reset} ${Math.round(u.favor)}/100  ${C.dim}${tier.desc}${C.reset}`);
    console.log(`   情绪  ${mood}   聊过 ${u.turns} 轮`);
    if (u.last_note) console.log(`   最近  ${C.dim}${u.last_note}${C.reset}`);
    console.log('');
  }
}

console.log(`${C.bold}  记忆${C.reset}`);
console.log(`  ${C.dim}对话 ${msgCount.n} 条，提炼出 ${memCount.n} 条长期记忆${C.reset}`);
const mems = db.prepare('SELECT subject, content, importance FROM memories ORDER BY ts DESC LIMIT 8').all();
for (const m of mems) {
  console.log(`  ${C.yellow}·${C.reset} ${C.dim}[${m.subject}]${C.reset} ${m.content}`);
}

if (groups.length) {
  console.log(`\n${C.bold}  群${C.reset}`);
  for (const g of groups) {
    const t = g.last_active ? new Date(g.last_active).toLocaleString() : '—';
    console.log(`  ${C.cyan}${g.name || g.group_id}${C.reset}  ${C.dim}${g.group_id} · 最后活跃 ${t}${C.reset}`);
  }
}
console.log('');
