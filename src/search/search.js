/**
 * 轻量联网搜索：抓 Bing 结果页，提取标题 + 摘要。
 * 不依赖任何搜索 API key，代价是可能被反爬——所以调用方必须做好失败兜底。
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const DECODE = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&ensp;|&nbsp;/g, ' ')
    .replace(/&#0?183;|&middot;/g, '·')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    })
    .replace(/&[a-z]+;/gi, (m) => ({ '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' })[m] ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * @returns {Promise<{query:string, items:{title:string,url:string,snippet:string}[], blocked:boolean}>}
 */
export async function searchWeb(query, { maxResults = 5, timeoutMs = 12000 } = {}) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { query, items: [], blocked: true, error: `HTTP ${res.status}` };
    }
    const html = await res.text();

    // 命中人机验证 / 无结果
    if (/验证|captcha|are you a robot/i.test(html) && !html.includes('b_algo')) {
      return { query, items: [], blocked: true, error: 'blocked' };
    }

    const items = [];
    const blocks = html.split('<li class="b_algo"').slice(1);
    for (const block of blocks) {
      if (items.length >= maxResults) break;

      const linkMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"/);
      const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
      const snippetMatch =
        block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/) ||
        block.match(/<p[^>]*>([\s\S]*?)<\/p>/);

      const title = DECODE(titleMatch?.[1]);
      const href = linkMatch?.[1] || '';
      const snippet = DECODE(snippetMatch?.[1]);

      if (!title && !snippet) continue;
      // 跳过 Bing 自家的聚合块
      if (/bing\.com\/ck\/a|go\.microsoft\.com/.test(href) && !snippet) continue;

      items.push({ title, url: href, snippet });
    }

    return { query, items, blocked: false };
  } catch (err) {
    return { query, items: [], blocked: true, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 把结果压成一段给模型看的资料。 */
export function formatResults({ query, items }) {
  if (!items?.length) return '';
  const lines = items.map((it, i) => {
    const s = it.snippet ? `：${it.snippet}` : '';
    return `${i + 1}. ${it.title}${s}`;
  });
  return `【刚查到的资料】（关键词：${query}）\n${lines.join('\n')}`;
}

/** 把口语问题洗成更像搜索词的短句：「最近有什么科技新闻」→「科技新闻」。 */
export function cleanQuery(text) {
  const q = String(text || '')
    .replace(/有什么|有没有|最近|帮我|帮忙|查一下|查查|搜一下|搜搜|告诉我|说一下/g, '')
    .replace(/怎么样|怎么|如何|吗|呢|啊|呀|吧|喵|捏|哦/g, '')
    .replace(/[，。？！,.?!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return q;
}

/** 从「明天北京天气怎么样喵」里抠出城市名。 */
export function extractCity(text) {
  const t = String(text || '')
    // 先去掉语气词，否则「北京喵」会被当成城市
    .replace(/喵|呀|呢|啊|哦|吧|啦|嘛|捏|哈|呗|咯|诶|欸|吗|么/g, '')
    .replace(/今天|明天|后天|现在|此刻|这边|那边/g, '')
    .replace(/天气|气温|温度|怎么样|如何|多少度|几度|冷不冷|热不热|下雨|下雪|带伞/g, '')
    .replace(/[，。？！,.?!\s]/g, '')
    .trim();
  return t.slice(0, 12);
}

/** 温度 → 体感描述（不报具体数字）。 */
function tempToDesc(t) {
  if (t == null || !Number.isFinite(t)) return '';
  if (t <= 0) return '冷得不行';
  if (t <= 8) return '挺冷的';
  if (t <= 16) return '有点凉';
  if (t <= 24) return '温温的，挺舒服';
  if (t <= 30) return '有点热';
  if (t <= 35) return '很热';
  return '热得快化了';
}

/**
 * 实时天气（wttr.in，免 key）。
 * 返回值里**不留具体度数**，换成「有点凉 / 挺热的」这类体感描述。
 * 失败返回 null。
 */
export async function fetchWeather(city, { timeoutMs = 8000 } = {}) {
  const clean = String(city || '').trim();
  if (!clean) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `https://wttr.in/${encodeURIComponent(clean)}?format=%l:+%c+%t+%h+%w&lang=zh`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'curl/8.0', 'Accept-Language': 'zh-CN' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    let text = (await res.text()).replace(/\s+/g, ' ').trim();
    // wttr 查不到城市时会返回一段 HTML 或报错文本
    if (!text || text.length > 200 || /<|Unknown|Sorry/i.test(text)) return null;

    // 把 "+23°C" 换成体感描述
    const tempMatch = text.match(/([+-]?\d+)\s*°C/);
    if (tempMatch) {
      const desc = tempToDesc(Number(tempMatch[1]));
      if (desc) text = text.replace(/[+-]?\d+\s*°C/, desc);
    }
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
