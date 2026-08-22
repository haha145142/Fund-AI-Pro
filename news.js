// Cloudflare Pages Function: 新闻代理
// 路径: /api/news
// 作用: 代理华尔街见闻 / 同花顺等新闻源，解决浏览器 CORS 问题
// 支持 source 参数: wscn(华尔街见闻) / ths(同花顺) / em(东方财富)

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const source = url.searchParams.get('source') || 'all';
  const limit = parseInt(url.searchParams.get('limit') || '20');

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  };

  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };

  const results = [];

  // 华尔街见闻
  if (source === 'all' || source === 'wscn') {
    try {
      const u = 'https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&client=pc&limit=' + limit;
      const resp = await fetch(u, { headers: commonHeaders });
      if (resp.ok) {
        const j = await resp.json();
        const items = j?.data?.items || j?.data?.day_items || [];
        items.forEach(x => {
          results.push({
            title: x.title || x.resource?.title || '',
            summary: x.summary || x.brief || x.content_text || x.resource?.content_text || '',
            time: x.display_time ? new Date(x.display_time * 1000).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '',
            source: '华尔街见闻',
            url: x.uri || x.resource?.uri || '',
          });
        });
      }
    } catch (e) {}
  }

  // 同花顺
  if (source === 'all' || source === 'ths') {
    try {
      const u = 'https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&pagesize=' + limit + '&track=website';
      const resp = await fetch(u, { headers: commonHeaders });
      if (resp.ok) {
        const j = await resp.json();
        const list = (j.data && j.data.list) || [];
        list.forEach(x => {
          results.push({
            title: x.title || '',
            summary: x.digest || '',
            time: x.ctime ? new Date(parseInt(x.ctime) * 1000).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '',
            source: '同花顺',
            url: '',
          });
        });
      }
    } catch (e) {}
  }

  // 东方财富快讯
  if (source === 'all' || source === 'em') {
    try {
      const u = 'https://search-api-web.eastmoney.com/search/jsonp?cb=jQueryCallback&param=' + encodeURIComponent(JSON.stringify({
        uid: '', keyword: '科技 半导体 算力 PCB CPO 基金 ETF 公募', type: ['cmsArticleWebOld'],
        client: 'web', clientType: 'web', clientVersion: 'curr',
        param: { cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize: limit, preTag: '', postTag: '' } }
      }));
      const resp = await fetch(u, { headers: { ...commonHeaders, Referer: 'https://so.eastmoney.com/' } });
      if (resp.ok) {
        const text = await resp.text();
        const m = text.match(/jQueryCallback\(([\s\S]+)\)\s*;?\s*$/);
        const j = m ? JSON.parse(m[1]) : null;
        const arr = j?.result?.cmsArticleWebOld || j?.data?.cmsArticleWebOld || [];
        arr.forEach(x => {
          results.push({
            title: x.title || x.brief || '',
            summary: x.content || x.brief || '',
            time: x.ctime || x.showTime || '',
            source: '东方财富',
            url: x.url || x.articleUrl || '',
          });
        });
      }
    } catch (e) {}
  }

  return new Response(JSON.stringify({ items: results, count: results.length }), {
    headers: corsHeaders,
  });
}
