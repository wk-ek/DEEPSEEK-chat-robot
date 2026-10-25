/**
 * 知识库检索：把 Stage 1 的训练数据（wisdom.jsonl）做成可检索的索引。
 *
 * 为什么要这个：
 *   4B 模型记不住 2045 条干员档案。实测单独跑 Stage 1 的 adapter，它会说
 *   「黑角，女，沃尔珀，出身维多利亚，163cm」——格式学会了，内容是把别的
 *   干员的属性串在一起。根因是参数量不够装下整个泰拉世界。
 *
 *   所以换个分工：
 *     Stage 1 的数据  → 当数据库，问什么查什么
 *     Stage 2 的模型  → 只负责「用阿米娅的语气把查到的东西说出来」
 *
 *   查到的是原文，不会幻觉；模型只做改写，不需要记忆。
 *
 * 检索算法很朴素：中文 bigram（相邻两字）交集打分。没用向量库，因为：
 *   - 问题都很短（中位 8 字），bigram 够区分
 *   - 零依赖，启动快
 *   - 2045 条规模下线性扫描几毫秒就完了
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('kb');

/** 一条知识：问题 + 答案 */
// { q: '黑角是谁', a: '黑角，男，鬼，出身东国，180cm...' }

/** bigram 索引：Map<bigram, number[]>（值是条目下标） */
let index = null;
/** 所有条目 */
let entries = null;
/** 索引构建时间，用于日志 */
let builtAt = 0;

/** 中文/英文/数字归一化：去标点、空格、统一小写 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）【】《》…—\-·,\.!\?;:'"()\[\]<>]/g, '');
}

/** 生成 bigram 集合 */
function bigrams(text) {
  const s = normalize(text);
  const out = new Set();
  if (s.length === 1) {
    out.add(s);
  } else {
    for (let i = 0; i < s.length - 1; i++) {
      out.add(s.slice(i, i + 2));
    }
  }
  return out;
}

/** 从 jsonl 加载条目 */
function loadEntries(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msgs = obj.messages || [];
    const q = msgs.find((m) => m.role === 'user')?.content;
    const a = msgs.find((m) => m.role === 'assistant')?.content;
    if (q && a) out.push({ q: q.trim(), a: a.trim() });
  }
  return out;
}

/**
 * 构建索引。首次调用时执行，之后复用。
 * @param {string} file jsonl 路径
 */
export function buildIndex(file) {
  if (index && entries) return { entries: entries.length, ms: builtAt };

  const t0 = Date.now();
  entries = loadEntries(file);
  index = new Map();

  for (let i = 0; i < entries.length; i++) {
    // 只索引问题的前 20 字，问题都很短，没必要全量
    for (const bg of bigrams(entries[i].q.slice(0, 20))) {
      let arr = index.get(bg);
      if (!arr) {
        arr = [];
        index.set(bg, arr);
      }
      arr.push(i);
    }
  }

  builtAt = Date.now() - t0;
  log.info(`索引就绪：${entries.length} 条，${index.size} 个 bigram，耗时 ${builtAt}ms`);
  return { entries: entries.length, ms: builtAt };
}

/**
 * 检索。
 *
 * @param {string} query 用户说的话
 * @param {object} [opts]
 * @param {number} [opts.topK=2]     最多返回几条
 * @param {number} [opts.minScore=0.5] 覆盖率下限（0~1），低于这个当没命中
 * @param {number} [opts.maxLen=400]  每条答案截断长度
 * @returns {Array<{q: string, a: string, score: number}>}
 */
export function search(query, opts = {}) {
  const { topK = 2, minScore = 0.5, maxLen = 400 } = opts;
  if (!index || !entries) return [];
  if (!query || normalize(query).length < 2) return [];

  const qb = bigrams(query);
  if (qb.size === 0) return [];

  // 统计每个条目命中了几个 bigram
  const hits = new Map();
  for (const bg of qb) {
    const arr = index.get(bg);
    if (!arr) continue;
    for (const idx of arr) {
      hits.set(idx, (hits.get(idx) || 0) + 1);
    }
  }
  if (hits.size === 0) return [];

  const scored = [];
  for (const [idx, count] of hits) {
    // 覆盖率：用户问题的 bigram 有多少被这条知识覆盖
    const cover = count / qb.size;
    // 反向覆盖率：防止「一个字撞上 1000 条」的短问题误命中
    const e = entries[idx];
    const eb = bigrams(e.q.slice(0, 20));
    const reverse = eb.size > 0 ? count / eb.size : 0;
    // 两头都要像才算匹配
    const score = cover * 0.7 + reverse * 0.3;
    if (score >= minScore) {
      scored.push({ idx, score, cover });
    }
  }

  scored.sort((x, y) => y.score - x.score);

  // 去重：wisdom.jsonl 里有答案完全相同的条目（同一干员的多个问法），
  // 不处理的话 prompt 里会出现两段一模一样的档案，白占 token 还干扰模型。
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    const e = entries[s.idx];
    const key = e.a.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      q: e.q,
      a: e.a.length > maxLen ? `${e.a.slice(0, maxLen)}…` : e.a,
      score: Math.round(s.score * 100) / 100,
    });
    if (out.length >= topK) break;
  }
  return out;
}

/** 索引是否已就绪 */
export function isReady() {
  return Boolean(index && entries);
}

/** 条目总数（未构建时返回 0） */
export function size() {
  return entries ? entries.length : 0;
}

/** 默认知识库路径 */
export function defaultKbPath() {
  return path.join(process.cwd(), 'config', 'kb', 'wisdom.jsonl');
}
