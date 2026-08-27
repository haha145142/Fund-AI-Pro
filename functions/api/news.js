// Cloudflare Pages Function · /api/news
// 真实财经新闻抓取：东财 + 新浪，聚合去重，按时间倒序
// 用法：/api/news?n=30

const TIMEOUT = 10_000;
const CACHE_TTL = 60_000; // 60s 边缘缓存
let cache = { ts: 0, data: null };

function jr(o, s = 200) {
  return new Response(JSON.stringify(o), {
    status: s,
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

// 新浪财经滚动新闻（JSONP）
async function fetchSina() {
  const url = 'https://feed.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=50&page=1';
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), TIMEOUT);
  const res = await fetch(url, {
    signal: ctrl.signal,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' },
  });
  if (!res.ok) throw new Error('sina ' + res.status);
  const j = await res.json();
  const list = (j?.result?.data || []).map(x => ({
    id: 'sina_' + x.id,
    title: x.title,
    summary: x.intro || x.summary || '',
    source: '新浪财经',
    url: x.url,
    publishedAt: x.ctime ? Number(x.ctime) * 1000 : null,
    timestamp: x.ctime ? Number(x.ctime) * 1000 : Date.now(),
  }));
  return list;
}

// 东方财富财经新闻（JSONP）
async function fetchEM() {
  const url = 'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&pageSize=50&pageIndex=1';
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), TIMEOUT);
  const res = await fetch(url, {
    signal: ctrl.signal,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.eastmoney.com/' },
  });
  if (!res.ok) throw new Error('em ' + res.status);
  const text = await res.text();
  // 东财有时包一层 callback，有时直接 JSON
  const jsonpStripped = text.replace(/^\s*[\w$]+\(/, '').replace(/\)\s*$/, '');
  const j = JSON.parse(jsonpStripped);
  const list = (j?.data?.list || []).map(x => ({
    id: 'em_' + x.id || x.newsId,
    title: x.title,
    summary: x.summary || x.digest || '',
    source: x.source || '东方财富',
    url: x.url || x.shareUrl,
    publishedAt: x.showTime ? new Date(x.showTime).getTime() : (x.createTime ? x.createTime * 1000 : null),
    timestamp: x.showTime ? new Date(x.showTime).getTime() : Date.now(),
  }));
  return list;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.title || '').replace(/\s+/g, '').slice(0, 40);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export async function onRequest({ request }) {
  try {
    const url = new URL(request.url);
    const n = Math.min(100, Math.max(5, Number(url.searchParams.get('n')) || 30));

    // 缓存命中
    if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
      return jr({ ok: true, cached: true, updatedAt: new Date(cache.ts).toISOString(), data: cache.data.slice(0, n) });
    }

    const results = await Promise.allSettled([fetchSina(), fetchEM()]);
    let all = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) all = all.concat(r.value);
    }

    // 全部失败 → 返回缓存（即使过期）
    if (all.length === 0) {
      if (cache.data) {
        return jr({ ok: true, cached: true, degraded: true, updatedAt: new Date(cache.ts).toISOString(), data: cache.data.slice(0, n) });
      }
      return jr({ ok: false, msg: '新闻源暂不可用', updatedAt: new Date().toISOString() }, 502);
    }

    all = dedupe(all).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    cache = { ts: Date.now(), data: all };

    return jr({ ok: true, sources: results.map(r => r.status), updatedAt: new Date().toISOString(), data: all.slice(0, n) });
  } catch (e) {
    return jr({ ok: false, msg: 'news error', detail: e?.message, updatedAt: new Date().toISOString() }, 500);
  }
}
