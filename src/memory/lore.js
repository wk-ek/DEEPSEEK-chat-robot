/**
 * lore 分段检索：把剧情知识库切成段，只取跟当前对话相关的那一两段。
 *
 * 为什么需要：原 lore.md 有 3.4KB，每次对话全量塞进 prompt，
 * 但它九成内容跟「今天吃了什么」这种日常闲聊毫无关系。
 * 全塞的代价是 token 贵、而且模型注意力被分散（信息越多，人格越不稳）。
 *
 * 做法很朴素：按 ## 标题切段 → 给每段打关键词 → 用户说什么就跟什么比 → 取分最高的。
 * 没用向量库，因为段数不多（十几个），关键词匹配够了，而且零依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';

const cache = new Map();

/** 把 lore.md 按 ## 标题切成段 */
function splitSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      if (cur && cur.body.trim()) sections.push(cur);
      cur = { title: m[1].trim(), body: '' };
    } else if (cur) {
      cur.body += line + '\n';
    }
  }
  if (cur && cur.body.trim()) sections.push(cur);
  return sections;
}

/** 中文二元组 + 英文单词，过滤掉纯语气词 */
const STOP = new Set(['的了', '是在', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '为什', '可以', '就是', '不是', '没有', '一个', '这样', '那样', '知道', '觉得', '现在']);

function keywords(text) {
  const t = String(text || '');
  const out = new Set();
  // 中文二元组
  const cjk = t.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) {
    const g = cjk.slice(i, i + 2);
    if (!STOP.has(g)) out.add(g);
  }
  // 英文/数字
  for (const w of t.toLowerCase().match(/[a-z]{3,}/g) || []) out.add(w);
  return out;
}

/**
 * 加载并索引一份 lore 文件。
 * @param {string} file 绝对路径
 */
export function loadLore(file) {
  try {
    const st = fs.statSync(file);
    const key = file;
    const hit = cache.get(key);
    if (hit && hit.mtime === st.mtimeMs) return hit.sections;

    const raw = fs.readFileSync(file, 'utf8');
    const sections = splitSections(raw).map((s) => {
      // 每段正文取前 400 字做索引，标题权重更高
      const kw = new Set([...keywords(s.title), ...keywords(s.body.slice(0, 400))]);
      return { ...s, kw, titleKw: keywords(s.title) };
    });
    cache.set(key, { mtime: st.mtimeMs, sections });
    return sections;
  } catch {
    return [];
  }
}

/**
 * 挑出跟这句话最相关的几段。
 *
 * @param {string} file    lore 文件路径
 * @param {string} userText 用户说的话
 * @param {number} [topK]  最多取几段
 * @param {number} [minScore] 低于这个分就不要（避免硬塞不相关的内容）
 * @returns {{title:string, body:string, score:number}[]}
 */
export function recallLore(file, userText, topK = 2, minScore = 2) {
  const sections = loadLore(file);
  if (!sections.length) return [];

  const want = keywords(userText);
  if (!want.size) return [];

  const scored = sections.map((s) => {
    let score = 0;
    for (const k of want) {
      if (s.titleKw.has(k)) score += 3; // 标题命中权重高
      else if (s.kw.has(k)) score += 1;
    }
    return { title: s.title, body: s.body.trim(), score };
  });

  return scored
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** 测试用：清缓存 */
export function clearLoreCache() {
  cache.clear();
}

/** lore 文件的默认位置（相对仓库根） */
export function defaultLorePath(rel) {
  return path.join(PATHS.root, rel);
}
