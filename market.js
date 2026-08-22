// Cloudflare Pages Function: 市场数据代理
// 路径: /api/market
// 作用: 代理东方财富板块/指数/订单数据，解决 CORS 问题
// 参数: type=sectors(板块) / indices(指数) / orders(全A股订单) / rank(基金排行) / history(基金历史净值)

// 服务端内存缓存：基金排行，周末/数据源异常时兜底返回最近一次有效数据
let serverRankCache = null;

function isChinaWeekend() {
  // 按北京时间判断是否为周末（周六/周日）
  const d = new Date();
  const h = Number(d.toLocaleString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit' }).replace(/\D/g, '')) || 0;
  const day = d.getDay(); // UTC day 不够准，用北京时间偏移
  // 北京时间 = UTC+8，简单换算
  const beijingDay = new Date(d.getTime() + 8 * 60 * 60 * 1000).getUTCDay();
  return { beijingDay, hour: h };
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'sectors';

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  };

  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://data.eastmoney.com/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };

  try {
    if (type === 'sectors') {
      // 板块行情（行业+概念）
      const fs_industry = 'm:90+t:2+f:!50';
      const fs_concept = 'm:90+t:3+f:!50';
      const fields = 'f12,f14,f2,f3,f5,f6,f62,f66,f69,f72,f75,f78,f81,f84,f87';
      const results = { industry: [], concept: [] };

      for (const [key, fs] of [['industry', fs_industry], ['concept', fs_concept]]) {
        try {
          const u = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=500&po=1&np=1&ut=fa5fd1943c7b386f172d6893dbbd1d0c&fltt=2&invt=2&fid=f62&fs=' + encodeURIComponent(fs) + '&fields=' + fields;
          const resp = await fetch(u, { headers: commonHeaders });
          if (resp.ok) {
            const j = await resp.json();
            const d = j?.data?.diff || [];
            results[key] = Array.isArray(d) ? d : Object.values(d);
          }
        } catch (e) {}
      }
      return new Response(JSON.stringify({ data: results, source: '东方财富' }), { headers: corsHeaders });
    }

    if (type === 'indices') {
      // 指数（ulist.np 返回 JSONP，需要文本解析）
      const secids = '1.000001,0.399001,0.399006,1.000688';
      const u = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f4&secids=' + secids;
      const resp = await fetch(u, { headers: commonHeaders });
      const text = await resp.text();
      // 去掉可能的 callback 前缀 / 后缀
      const body = text.replace(/^[^(]*\(/, '').replace(/\)[^)]*$/, '');
      let j;
      try { j = JSON.parse(body); } catch { j = JSON.parse(text); }
      return new Response(JSON.stringify({ data: j, source: '东方财富' }), { headers: corsHeaders });
    }

    if (type === 'orders') {
      // 全A股订单分层
      const fs = 'm:0+t:6,m:0+t:13,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:7,m:1+t:3';
      const fields = 'f12,f14,f62,f66,f69,f72,f75';
      const u = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5000&po=1&np=1&ut=fa5fd1943c7b386f172d6893dbbd1d0c&fltt=2&invt=2&fid=f62&fs=' + encodeURIComponent(fs) + '&fields=' + fields;
      const resp = await fetch(u, { headers: commonHeaders });
      if (!resp.ok) throw new Error('orders fetch failed');
      const j = await resp.json();
      return new Response(JSON.stringify({ data: j, source: '东方财富' }), { headers: corsHeaders });
    }

    if (type === 'rank') {
      // 基金排行 JSONP
      const src = 'https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=all&rs=&gs=0&sc=1nzf&st=desc&pi=1&pn=200&dx=1&_=' + Date.now();
      try {
        const resp = await fetch(src, { headers: { ...commonHeaders, Referer: 'https://fund.eastmoney.com/' } });
        const text = await resp.text();
        let jsonStr = '{}';
        const idx = text.indexOf('var rankData = ');
        if (idx !== -1) {
          const start = text.indexOf('{', idx);
          const end = text.lastIndexOf('};');
          if (start !== -1 && end > start) {
            jsonStr = text.slice(start, end + 1);
          }
        }
        // 解析看是否有有效数据
        const parsed = JSON.parse(jsonStr);
        const datas = Array.isArray(parsed?.datas) ? parsed.datas : [];
        if (datas.length > 0) {
          // 有数据就更新服务端缓存
          serverRankCache = { body: jsonStr, time: Date.now() };
          return new Response(jsonStr, { headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } });
        }
      } catch (e) {}
      // 无数据或失败：有缓存就返回缓存
      if (serverRankCache && serverRankCache.body) {
        return new Response(JSON.stringify({ ...JSON.parse(serverRankCache.body), _cached: true, _cachedAt: serverRankCache.time }), { headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } });
      }
      return new Response('{}', { headers: corsHeaders });
    }

    if (type === 'history') {
      // 基金历史净值：代理东方财富 pingzhongdata JS
      const code = url.searchParams.get('code') || '';
      if (!/^\d{6}$/.test(code)) {
        return new Response(JSON.stringify({ error: 'code 参数必须是 6 位基金代码' }), { status: 400, headers: corsHeaders });
      }
      try {
        const resp = await fetch('https://fund.eastmoney.com/pingzhongdata/' + code + '.js', {
          headers: { ...commonHeaders, Referer: 'https://fund.eastmoney.com/' },
        });
        const text = await resp.text();
        const historyMatch = text.match(/var Data_netWorthTrend = (\[[\s\S]+?\]);/);
        const nameMatch = text.match(/var fS_name = "([^"]+)";/);
        const history = historyMatch ? JSON.parse(historyMatch[1]) : [];
        return new Response(JSON.stringify({
          history: history.map(x => x.y),
          dates: history.map(x => x.x),
          name: nameMatch ? nameMatch[1] : ''
        }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ history: [], dates: [], name: '', error: e.message }), { headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ error: '不支持的 type: ' + type }), { status: 400, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: '服务器错误: ' + e.message, type: type }), { status: 500, headers: corsHeaders });
  }
}

export async function onRequestPost(context) {
  const { request } = context;
  const body = await request.text();
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  };
  try {
    const { url, init } = JSON.parse(body);
    const resp = await fetch(url, init || {});
    const text = await resp.text();
    return new Response(JSON.stringify({ ok: resp.ok, status: resp.status, text }), { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
}
