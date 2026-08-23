// Cloudflare Pages Function: 新闻代理
// 路径: /api/news
// 支持 source 参数: wscn(华尔街见闻) / ths(同花顺) / em(东方财富) / all
// 说明: 若三家主源均被各自 WAF 策略 403 拦截,会自动尝试兜底公开源,
//       并在返回中标注每条来源与是否来自兜底源,便于前端排查。

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const source = (url.searchParams.get('source') || 'all').toLowerCase();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20') || 20, 1), 50);

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  };

  // CF Pages (Service Worker) 环境无 encodeURIComponent 之外的坑,这里用原生即可
  const enc = (s) => encodeURIComponent(s);

  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, application/xml, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };

  const results = [];
  const errors = [];

  // ---------- 华尔街见闻 ----------
  if (source === 'all' || source === 'wscn') {
    try {
      const u = 'https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&client=pc&limit=' + limit;
      const resp = await fetch(u, { headers: commonHeaders });
      if (!resp.ok) { errors.push({source:'华尔街见闻', status:resp.status}); }
      else {
        const j = await resp.json();
        const items = (j && (j.data && (j.data.items || j.data.day_items))) || [];
        items.forEach(x => {
          results.push({
            title: x.title || (x.resource && x.resource.title) || '',
            summary: x.summary || x.brief || x.content_text || (x.resource && x.resource.content_text) || '',
            time: x.display_time ? new Date(x.display_time * 1000).toLocaleString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : '',
            source: '华尔街见闻', url: x.uri || (x.resource && x.resource.uri) || '',
          });
        });
      }
    } catch (e) { errors.push({source:'华尔街见闻', error: String(e)}); }
  }

  // ---------- 同花顺 ----------
  if (source === 'all' || source === 'ths') {
    try {
      const u = 'https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&pagesize=' + limit + '&track=website';
      const resp = await fetch(u, { headers: commonHeaders });
      if (!resp.ok) { errors.push({source:'同花顺', status:resp.status}); }
      else {
        const j = await resp.json();
        const list = (j.data && j.data.list) || [];
        list.forEach(x => {
          results.push({
            title: x.title || '', summary: x.digest || '',
            time: x.ctime ? new Date(parseInt(x.ctime) * 1000).toLocaleString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : '',
            source: '同花顺', url: '',
          });
        });
      }
    } catch (e) { errors.push({source:'同花顺', error: String(e)}); }
  }

  // ---------- 东方财富 ----------
  if (source === 'all' || source === 'em') {
    try {
      const paramObj = {
        uid:'', keyword:'科技 半导体 算力 PCB CPO 基金 ETF 公募', type:['cmsArticleWebOld'],
        client:'web', clientType:'web', clientVersion:'curr',
        param:{ cmsArticleWebOld:{ searchScope:'default', sort:'default', pageIndex:1, pageSize:limit, preTag:'', postTag:'' } }
      };
      const u = 'https://search-api-web.eastmoney.com/search/jsonp?cb=jQueryCallback&param=' + enc(JSON.stringify(paramObj));
      const resp = await fetch(u, { headers: { ...commonHeaders, Referer: 'https://so.eastmoney.com/' } });
      if (!resp.ok) { errors.push({source:'东方财富', status:resp.status}); }
      else {
        const text = await resp.text();
        let j = null;
        const m = text.match(/jQueryCallback\(([\s\S]+)\)\s*;?\s*$/);
        if (m) { try { j = JSON.parse(m[1]); } catch(_){ j=null; } }
        if (j) {
          const arr = (j.result && j.result.cmsArticleWebOld) || (j.data && j.data.cmsArticleWebOld) || [];
          arr.forEach(x => {
            results.push({
              title: x.title || x.brief || '', summary: x.content || x.brief || '',
              time: x.ctime || x.showTime || '', source: '东方财富',
              url: x.url || x.articleUrl || '',
            });
          });
        }
      }
    } catch (e) { errors.push({source:'东方财富', error: String(e)}); }
  }

  // ---------- 兜底: 若主源无任何数据,尝试公开 RSS(可能被 WAF 也拦,仅作 best-effort) ----------
  if (results.length === 0) {
    const fallbacks = [
      { name:'财联社电报(RSS)', u:'https://www.cls.cn/telegram/rss' },
      { name:'巨潮公告(RSS)', u:'http://www.cninfo.com.cn/new/disclosure/szse/rss' },
    ];
    for (const fb of fallbacks) {
      try {
        const r = await fetch(fb.u, { headers: commonHeaders });
        if (r.ok) {
          const txt = await r.text();
          // 简单解析 RSS <item>
          const items = txt.match(/<item>[\s\S]*?<\/item>/g) || [];
          items.slice(0, limit).forEach(it => {
            const title = (it.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || it.match(/<title>([\s\S]*?)<\/title>/) || [,])[1] || '';
            const desc  = (it.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || it.match(/<description>([\s\S]*?)<\/description>/) || [,])[1] || '';
            const pub   = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [,])[1] || '';
            if (title) results.push({ title:title.replace(/<!\[CDATA\[|\]\]>/g,'').trim(), summary:desc.replace(/<!\[CDATA\[|\]\]>/g,'').slice(0,200), time: pub ? new Date(pub).toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit'}) : '', source: fb.name + '(兜底)', url:'' });
          });
        } else { errors.push({source:fb.name, status:r.status}); }
      } catch(e) { errors.push({source:fb.name, error:String(e)}); }
    }
  }

  // 按时间倒序简单排(时间不可靠时尽量靠前)
  results.sort((a,b) => (b.time || '').localeCompare(a.time || ''));

  return new Response(JSON.stringify({
    items: results,
    count: results.length,
    fetched_at: new Date().toISOString(),
    errors: errors.length ? errors : undefined,
    notice: results.length === 0 ? '主源与兜底源均未返回数据,很可能是源站 Cloudflare/WAF 策略对服务端请求 403 拦截,建议改为前端直连浏览器抓取或自建中转代理。' : undefined,
  }), { headers: corsHeaders });
}
