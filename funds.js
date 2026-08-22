// Cloudflare Pages Function: 基金数据代理
// 路径: /api/funds
// 作用: 代理天天基金/东方财富基金估值接口，解决 CORS 问题
// 参数: codes=018816,020640 (逗号分隔的基金代码)

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const codes = url.searchParams.get('codes') || '';
  if (!codes) {
    return new Response(JSON.stringify({ error: 'codes 参数必填' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  };

  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://fund.eastmoney.com/',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };

  const fields = 'FCODE,SHORTNAME,GSZZL,GZTIME,GSZ,NAV,PDATE';
  const bases = [
    'https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast',
    'https://fundcomapi.eastmoney.com/mm/newCore/FundValuationLast',
  ];

  for (const base of bases) {
    try {
      const u = base + '?FCODES=' + encodeURIComponent(codes) + '&FIELDS=' + encodeURIComponent(fields) + '&_=' + Date.now();
      const resp = await fetch(u, { headers: commonHeaders });
      if (resp.ok) {
        const text = await resp.text();
        let j;
        try { j = JSON.parse(text); } catch { j = null; }
        if (j) {
          const rows = j?.Data || j?.data || j?.Datas || [];
          if (Array.isArray(rows) && rows.length) {
            return new Response(JSON.stringify({ Data: rows, source: base.includes('tiantian') ? '天天基金' : '东方财富' }), {
              headers: corsHeaders,
            });
          }
        }
      }
    } catch (e) {}
  }

  return new Response(JSON.stringify({ Data: [], source: '不可用', error: '所有基金估值源均不可用' }), {
    headers: corsHeaders,
  });
}
