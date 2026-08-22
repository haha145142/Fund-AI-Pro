// Cloudflare Pages Function: 外围市场代理
// 路径: /api/global
// 作用: 代理腾讯财经外围行情（道琼斯/纳指/标普/恒生/黄金/原油），解决 CORS

export async function onRequestGet(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  };

  try {
    const codes = ['usDJI', 'usIXIC', 'usINX', 'hkHSI', 'hkHSTECH', 'nf_GC00', 'hf_CL'];
    const u = 'https://qt.gtimg.cn/q=' + codes.join(',');
    const resp = await fetch(u, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': 'https://qt.gtimg.cn/',
      },
    });
    if (!resp.ok) throw new Error('network ' + resp.status);

    const buf = await resp.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const out = [];

    text.split(';').forEach(seg => {
      const m = seg.match(/v_(\w+)="([^"]*)"/);
      if (m) {
        const p = m[2].split('~');
        if (p.length > 5 && p[1] && p[3] && p[4]) {
          const price = parseFloat(p[3]);
          const prev = parseFloat(p[4]);
          const pct = p[32] ? parseFloat(p[32]) : ((price - prev) / prev * 100);
          out.push({ name: p[1], price, prev, pct });
        }
      }
    });

    return new Response(JSON.stringify({ items: out.filter(x => x.name && Number.isFinite(x.pct)), source: '腾讯财经' }), {
      headers: corsHeaders,
    });
  } catch (e) {
    return new Response(JSON.stringify({ items: [], source: '不可用', error: e.message }), { headers: corsHeaders });
  }
}
