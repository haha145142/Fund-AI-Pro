// Cloudflare Pages Function · /api/news
// 多源 + 交叉验证 + 自动降级
// 源：新浪财经（主） / 东方财富（备） / 财联社（备）
// 交叉验证：同一标题在 ≥2 个源出现 → credibility:"high"，否则 "medium"
// 用法：/api/news?n=30

import { fetchJSON, multiSource, jsonResp } from './_lib.js';

const TIMEOUT = 10_000;
const CACHE_TTL = 60_000;
let cache = { ts: 0, data: null };

// 归一化每条新闻为 {id,title,summary,source,url,publishedAt,timestamp}
function normalize(rows, source) {
  return (rows || [])
    .map((x, idx) => ({
      id: (x.id || x.url || source + '_' + idx) + '',
      title: String(x.title || '').trim(),
      summary: String(x.summary || x.intro || x.digest || '').trim(),
      source: String(x.source || source),
      url: x.url || '',
      publishedAt: x.publishedAt || null,
      timestamp: x.timestamp || Date.now(),
    }))
    .filter((x) => x.title);
}

// ---- 源A：新浪财经滚动新闻 ----
async function fetchSina() {
  const url = 'https://feed.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=50&page=1';
  const j = await fetchJSON(url, 'https://finance.sina.com.cn/', TIMEOUT);
  return (j?.result?.data || []).map((x) => ({
    title: x.title,
    summary: x.intro || x.summary || '',
    source: '新浪财经',
    url: x.url,
    publishedAt: x.ctime ? Number(x.ctime) * 1000 : null,
    timestamp: x.ctime ? Number(x.ctime) * 1000 : Date.now(),
  }));
}

// ---- 源B：东方财富 ----
async function fetchEM() {
  const url =
    'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&pageSize=50&pageIndex=1';
  const text = await fetchJSON(url, 'https://finance.eastmoney.com/', TIMEOUT).then(
    (j) => j,
    async () => null
  );
  if (!text) throw new Error('em empty');
  return (text?.data?.list || []).map((x) => ({
    title: x.title,
    summary: x.summary || x.digest || '',
    source: x.source || '东方财富',
    url: x.url || x.shareUrl,
    publishedAt: x.showTime ? new Date(x.showTime).getTime() : (x.createTime ? x.createTime * 1000 : null),
    timestamp: x.showTime ? new Date(x.showTime).getTime() : Date.now(),
  }));
}

// ---- 源C：财联社（试试，失败不影响）----
async function fetchCls() {
  const url = 'https://www.cls.cn/nodeapi/updateTelegraphList?type=0&page=1&rn=30';
  const j = await fetchJSON(url, 'https://www.cls.cn/', TIMEOUT);
  return (j?.data?.roll_data || j?.data?.list || []).map((x) => ({
    title: x.title || x.content,
    summary: x.digest || '',
    source: '财联社',
    url: '',
    publishedAt: x.modify_time ? x.modify_time * 1000 : (x.created_at ? x.created_at * 1000 : null),
    timestamp: x.modify_time ? x.modify_time * 1000 : Date.now(),
  }));
}

// 去重（标题归一化后按前40字符）
function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const key = it.title.replace(/\s+/g, '').slice(0, 40);
    if (!key) continue;
    if (seen.has(key)) {
      // 合并 source 列表，用于可信度评估
      const prev = seen.get(key);
      prev.sources = Array.from(new Set([...(prev.sources || [prev.source]), it.source]));
    } else {
      seen.set(key, { ...it, sources: [it.source] });
    }
  }
  return Array.from(seen.values());
}

// 交叉验证：跨源出现次数 → 可信度
function crossCheck(all) {
  let checked = 0;
  let high = 0;
  for (const it of all) {
    if ((it.sources || []).length >= 2) {
      checked++;
      high++;
      it.credibility = 'high';
    } else {
      it.credibility = 'medium';
    }
  }
  return { checked, warnings: [], verified: all.length > 0 };
}

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const n = Math.min(100, Math.max(5, Number(url.searchParams.get('n')) || 30));

  // 缓存命中
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    return jsonResp({ ok: true, cached: true, updatedAt: new Date(cache.ts).toISOString(), data: cache.data.slice(0, n) });
  }

  const result = await multiSource({
    sources: [
      { name: 'sina', fetch: fetchSina },
      { name: 'eastmoney', fetch: fetchEM },
      { name: 'cls', fetch: fetchCls },
    ],
    normalize: (raw) => raw, // fetch* 已归一化
    compare: (a, b) => (b.timestamp || 0) - (a.timestamp || 0),
    top: 100,
    crossCheck: () => ({ checked: 0, warnings: [], verified: false }), // 异步后补交叉
  });

  // 归一化 + 去重 + 交叉验证可信度
  let all = result.list;
  if (!all.length && cache.data) {
    return jsonResp({ ok: true, cached: true, degraded: true, updatedAt: new Date(cache.ts).toISOString(), data: cache.data.slice(0, n) });
  }
  all = dedupe(all);
  crossCheck(all);

  const sorted = all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, n);
  const liveSources = result.sourceReport.filter((s) => s.ok).map((s) => s.name);
  cache = { ts: Date.now(), data: sorted };

  return jsonResp({
    ok: true,
    updatedAt: new Date().toISOString(),
    sources: result.sourceReport,
    source: liveSources.join('+') || 'cache',
    cross: { checked: all.filter((x) => (x.sources || []).length >= 2).length, warnings: [], verified: liveSources.length >= 2 },
    data: sorted,
  });
}
