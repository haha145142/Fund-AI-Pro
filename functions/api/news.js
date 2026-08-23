// Fund-AI-Pro /api/news
// 新闻代理 v5：实时优先、多源并行、分级排序、去重、无缓存。
// AI 解读不在这里处理，保持前端现有 AI 解读逻辑不变。

export async function onRequestGet(context) {
  const { request } = context;
  const u = new URL(request.url);
  const source = (u.searchParams.get('source') || 'all').toLowerCase();
  const requested = Number.parseInt(u.searchParams.get('limit') || '50', 10);
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 50, 10), 100);
  const now = Date.now();

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139 Safari/537.36';
  const baseHeaders = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    Pragma: 'no-cache',
  };

  if (request.method === 'OPTIONS') return new Response('', { headers: cors });

  const clean = (v) => String(v ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();

  const ts = (v) => {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const s = String(v).trim();
    if (/^\d{10}$/.test(s)) return Number(s) * 1000;
    if (/^\d{13}$/.test(s)) return Number(s);
    const t = Date.parse(s.replace(/\./g, '-'));
    return Number.isFinite(t) ? t : 0;
  };

  const fmt = (t) => t ? new Date(t).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) : '';

  const item = ({ title, summary, timestamp, sourceName, tier, url = '', id = '' }) => {
    const titleText = clean(title);
    if (!titleText) return null;
    const time = ts(timestamp);
    return {
      id: String(id || `${sourceName}-${time}-${titleText.slice(0, 40)}`),
      title: titleText,
      summary: clean(summary).slice(0, 600),
      timestamp: time,
      time: fmt(time),
      source: sourceName,
      sources: [sourceName],
      tier,
      url: typeof url === 'string' ? url : '',
    };
  };

  const get = async (url, init = {}, timeout = 8000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const r = await fetch(url, { ...init, cache: 'no-store', signal: controller.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } finally { clearTimeout(timer); }
  };

  const safe = async (name, fn) => {
    try { return (await fn()) || []; }
    catch (e) { console.log(`[news:${name}]`, e?.message || e); return []; }
  };

  // ---------- 财联社：新版实时电报 v1，签名本地计算，无 key ----------
  const sha1 = async (text) => {
    const h = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
  };

  const md5 = (input) => {
    const b = new TextEncoder().encode(input);
    const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
    const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const n = (((b.length + 8) >> 6) + 1) * 64;
    const p = new Uint8Array(n); p.set(b); p[b.length] = 128;
    const dv = new DataView(p.buffer); const bits = b.length * 8;
    dv.setUint32(n - 8, bits >>> 0, true); dv.setUint32(n - 4, Math.floor(bits / 4294967296), true);
    const add = (a, c) => (a + c) >>> 0;
    const rol = (x, c) => (x << c) | (x >>> (32 - c));
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < n; off += 64) {
      const M = new Uint32Array(16); for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const oldD = D;
        D = C; C = B;
        B = add(B, rol(add(add(add(A, F >>> 0), K[i]), M[g]), S[i]));
        A = oldD;
      }
      a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
    }
    return [a0,b0,c0,d0].map(x => Array.from({length:4}, (_,i) => ((x >>> (i*8)) & 255).toString(16).padStart(2,'0')).join('')).join('');
  };

  const fetchCLS = async () => safe('cls', async () => {
    const p = new URLSearchParams({ appName: 'CailianpressWeb', os: 'web', sv: '7.7.5', last_time: '', refresh_type: '1', rn: String(Math.min(limit, 100)) });
    p.sort();
    p.set('sign', md5(await sha1(p.toString())));
    const r = await get(`https://www.cls.cn/v1/roll/get_roll_list?${p.toString()}`, { headers: { ...baseHeaders, Referer: 'https://www.cls.cn/' } }, 9000);
    const list = r.ok ? ((await r.json())?.data?.roll_data || []) : [];
    return list.map(x => item({
      title: x.title || x.brief, summary: x.content || x.brief,
      timestamp: x.ctime || x.create_time, sourceName: '财联社', tier: 2,
      url: x.shareurl || x.url || (x.id ? `https://www.cls.cn/detail/${x.id}` : ''), id: x.id,
    })).filter(Boolean);
  });

  // ---------- 东方财富 7x24：主力实时备用 ----------
  const fetchEMFlash = async () => safe('emflash', async () => {
    const trace = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const urls = [
      `https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=${limit}&req_trace=${encodeURIComponent(trace)}&_=${Date.now()}`,
      `https://np-listapi.eastmoney.com/nlist/api/list/get?client=web&column_id=102&limit=${limit}&last_time=&_=${Date.now()}`,
    ];
    for (const url of urls) {
      try {
        const j = await (await get(url, { headers: { ...baseHeaders, Referer: 'https://kuaixun.eastmoney.com/' } })).json();
        const list = j?.data?.fastNewsList || j?.data?.list || j?.data?.fastList || j?.data?.data || [];
        const rows = (Array.isArray(list) ? list : []).map(x => item({
          title: x.title || x.content || x.summary, summary: x.summary || x.content || x.brief,
          timestamp: x.showTime || x.pubTime || x.ctime || x.publishTime || x.time || x.timestamp,
          sourceName: '东方财富7x24', tier: 4, url: x.url_unique || x.url || x.link, id: x.id || x.newsId,
        })).filter(x => x && x.timestamp);
        if (rows.length) return rows;
      } catch (e) { console.log('[news:emflash:endpoint]', e?.message || e); }
    }
    return [];
  });

  // ---------- 华尔街见闻 ----------
  const fetchWSCN = async () => safe('wscn', async () => {
    const urls = [
      `https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&client=pc&limit=${limit}&_=${Date.now()}`,
      `https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&client=pc&limit=${limit}&_=${Date.now()}`,
    ];
    for (const url of urls) {
      try {
        const j = await (await get(url, { headers: { ...baseHeaders, Referer: 'https://wallstreetcn.com/' } })).json();
        const list = j?.data?.items || j?.data?.day_items || [];
        const rows = (Array.isArray(list) ? list : []).map(x => item({
          title: x.title || x.resource?.title || x.content_text,
          summary: x.summary || x.brief || x.content_text || x.resource?.content_text,
          timestamp: x.display_time || x.publish_time || x.created_at || x.ctime || x.time,
          sourceName: '华尔街见闻', tier: 3, url: x.uri || x.resource?.uri, id: x.id || x.resource?.id,
        })).filter(x => x && x.timestamp);
        if (rows.length) return rows;
      } catch (e) { console.log('[news:wscn:endpoint]', e?.message || e); }
    }
    return [];
  });

  // ---------- 金十：独立域名备用快讯 ----------
  const fetchJin10 = async () => safe('jin10', async () => {
    for (const url of [
      `https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1&_=${Date.now()}`,
      `https://flash-api.jin10.com/get_flash_list?channel=-8200&_=${Date.now()}`,
    ]) {
      try {
        const j = await (await get(url, { headers: { ...baseHeaders, Referer: 'https://www.jin10.com/' } })).json();
        const list = j?.data || j?.list || [];
        const rows = (Array.isArray(list) ? list : []).map(x => { const d = x?.data || x; return item({
          title: d?.content || d?.title || d?.brief || d?.summary,
          summary: d?.content || d?.brief || d?.summary,
          timestamp: d?.time || d?.ctime || d?.timestamp,
          sourceName: '金十数据', tier: 4, url: d?.link || d?.url, id: d?.id,
        }); }).filter(Boolean);
        if (rows.length) return rows;
      } catch (e) { console.log('[news:jin10:endpoint]', e?.message || e); }
    }
    return [];
  });

  // ---------- 新浪财经 7x24 ----------
  const fetchSina = () => safe('sina', async () => {
    const j = await (await get(`https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=${limit}&page=1&_=${Date.now()}`, { headers: { ...baseHeaders, Referer: 'https://finance.sina.com.cn/' } })).json();
    return (Array.isArray(j?.data) ? j.data : []).map(x => item({
      title: x.title, summary: x.intro || x.summary || x.content,
      timestamp: x.ctime || x.create_time || x.time, sourceName: '新浪财经', tier: 4, url: x.url, id: x.id || x.docid,
    })).filter(Boolean);
  });

  // ---------- 同花顺 ----------
  const fetchTHS = () => safe('ths', async () => {
    const j = await (await get(`https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&pagesize=${limit}&track=website&_=${Date.now()}`, { headers: { ...baseHeaders, Referer: 'https://news.10jqka.com.cn/' } })).json();
    const list = j?.data?.list || [];
    return (Array.isArray(list) ? list : []).map(x => item({
      title: x.title, summary: x.digest || x.summary, timestamp: x.ctime || x.time || x.showTime,
      sourceName: '同花顺', tier: 4, url: x.url || x.url_pc, id: x.id || x.news_id,
    })).filter(Boolean);
  });

  // ---------- 巨潮资讯：官方公告 ----------
  const fetchOfficial = () => safe('official', async () => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const form = new URLSearchParams({ pageNum:'1', pageSize:String(Math.min(limit,30)), column:'szse', tabName:'latest', plate:'', stock:'', searchkey:'', secid:'', category:'', trade:'', seDate:`${today}~${today}` });
    const j = await (await get('https://www.cninfo.com.cn/new/hisAnnouncement/query', { method:'POST', headers:{ ...baseHeaders, Referer:'https://www.cninfo.com.cn/', 'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8' }, body:form.toString() }, 10000)).json();
    return (j?.announcements || []).map(x => item({
      title: x.announcementTitle || x.title, summary: x.announcementTitle,
      timestamp: x.announcementTime || x.seDate || x.publishTime, sourceName:'巨潮资讯', tier:1,
      url: x.adjunctUrl ? `https://static.cninfo.com.cn/${String(x.adjunctUrl).replace(/^\/+/, '')}` : 'https://www.cninfo.com.cn/', id:x.announcementId || x.id || x.adjunctUrl,
    })).filter(Boolean);
  });

  // ---------- 第一财经：补充源（不伪造时间） ----------
  const fetchYicai = () => safe('yicai', async () => {
    const html = await (await get('https://www.yicai.com/', { headers:{ ...baseHeaders, Accept:'text/html,application/xhtml+xml', Referer:'https://www.yicai.com/' } })).text();
    const out=[]; const seen=new Set();
    const re=/<a[^>]+href=["'](https?:\/\/(?:www\.)?yicai\.com\/news\/\d+\.html|\/news\/\d+\.html)["'][^>]*>([\s\S]{1,300}?)<\/a>/gi;
    let m; while((m=re.exec(html)) && out.length<limit){ const url=m[1].startsWith('http')?m[1]:`https://www.yicai.com${m[1]}`; const title=clean(m[2]); if(title.length<4||seen.has(url))continue; seen.add(url); const x=item({title,summary:'',timestamp:0,sourceName:'第一财经',tier:2,url,id:url}); if(x)out.push(x); }
    return out;
  });

  const enabled = (name) => source === 'all' || source === name;
  const jobs = [];
  if (enabled('cls')) jobs.push(fetchCLS());
  if (enabled('emflash') || enabled('em')) jobs.push(fetchEMFlash());
  if (enabled('wscn')) jobs.push(fetchWSCN());
  if (enabled('jin10')) jobs.push(fetchJin10());
  if (enabled('sina')) jobs.push(fetchSina());
  if (enabled('ths')) jobs.push(fetchTHS());
  if (enabled('official')) jobs.push(fetchOfficial());
  if (enabled('yicai')) jobs.push(fetchYicai());

  const batches = await Promise.all(jobs);
  let all = batches.flat().filter(Boolean);

  // 时效策略：有真实时间的新闻只保留最近 36 小时；如果上游全部异常，再放宽到 72 小时，绝不伪造新时间。
  const freshCut = now - 36 * 60 * 60 * 1000;
  const fresh = all.filter(x => !x.timestamp || x.timestamp >= freshCut);
  if (fresh.filter(x => x.timestamp).length >= Math.min(10, limit)) all = fresh;
  else all = all.filter(x => !x.timestamp || x.timestamp >= now - 72 * 60 * 60 * 1000);

  // 同事件去重：标题高度相似时合并来源，优先保留时间更新的版本。
  const normalizeKey = s => clean(s).toLowerCase().replace(/[\s，。、“”‘’：:；;！!？?（）()【】\[\]《》<>·…—\-_/]+/g, '').slice(0, 80);
  const dedup = new Map();
  for (const x of all) {
    const key = normalizeKey(x.title);
    if (!key) continue;
    const old = dedup.get(key);
    if (!old) dedup.set(key, x);
    else {
      const winner = (x.timestamp > old.timestamp) ? x : (x.tier < old.tier ? x : old);
      winner.sources = [...new Set([...(winner.sources || [winner.source]), ...(old.sources || [old.source]), ...(x.sources || [x.source])])];
      dedup.set(key, winner);
    }
  }

  all = [...dedup.values()];
  // 实时优先：先按最新时间；同一 15 分钟窗口内再按来源等级排序。
  all.sort((a,b) => {
    if (!a.timestamp && b.timestamp) return 1;
    if (a.timestamp && !b.timestamp) return -1;
    const diff = b.timestamp - a.timestamp;
    if (Math.abs(diff) <= 15 * 60 * 1000 && a.tier !== b.tier) return a.tier - b.tier;
    return diff;
  });

  const rows = all.slice(0, limit);
  const latestTimestamp = rows.reduce((m,x) => Math.max(m, x.timestamp || 0), 0);
  const latestAgeSeconds = latestTimestamp ? Math.max(0, Math.round((now-latestTimestamp)/1000)) : null;

  return new Response(JSON.stringify({
    ok: true,
    updatedAt: now,
    latestTimestamp,
    latestTime: fmt(latestTimestamp),
    latestAgeSeconds,
    count: rows.length,
    sources: [...new Set(rows.flatMap(x => x.sources || [x.source]))],
    items: rows,
  }), { headers: cors });
}
