// Cloudflare Pages Function · /api/fundrank/:tab
// 替代原 Flask 后端（app.py），无需自建服务器，Cloudflare 边缘运行
// 对应前端 refreshFundRank() 的 __API_BASE__ 路径
const EM = 'https://fundapi.eastmoney.com/FundTopicInterface/api/FundTopicAjaxNew';
const TIMEOUT = 12_000;

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

function parse(rows) {
  const out = [];
  for (const x of rows || []) {
    const a = Array.isArray(x) ? x : String(x).split(',');
    const code = a[0], name = a[1];
    if (!code || !name) continue;
    out.push({ code, name, nav: num(a[3]), day_change: num(a[5]), month_change: num(a[7]) });
  }
  return out;
}

function estHeat(it, dir) {
  const day = it.day_change || 0, m = it.month_change || 0;
  if (dir === 'buy') return Math.max(0, Math.min(100, Math.round(40 + day * 8 + m * 1.2)));
  return Math.max(0, Math.min(100, Math.round(40 + Math.abs(day) * 8 + (m < 0 ? -m : 0) * 1.2)));
}

function build(tab, rows) {
  if (!rows) return [];
  const has = x => x.day_change != null;
  let list = rows.filter(has);
  if (tab === 'gain') list.sort((a, b) => b.day_change - a.day_change);
  else if (tab === 'loss') list.sort((a, b) => a.day_change - b.day_change);
  else if (tab === 'buy') {
    list = list.filter(x => x.day_change >= 3 && (x.month_change == null || x.month_change >= 0)).sort((a, b) => b.day_change - a.day_change);
    list = list.map(x => ({ ...x, heat: estHeat(x, 'buy') }));
  } else if (tab === 'sell') {
    list = list.filter(x => x.day_change <= -2 || (x.day_change < 0 && (x.month_change || 0) < 0)).sort((a, b) => a.day_change - b.day_change);
    list = list.map(x => ({ ...x, heat: estHeat(x, 'sell') }));
  }
  return list.slice(0, 20);
}

export async function onRequestGet({ params }) {
  const tab = params.tab;
  if (!['gain', 'loss', 'buy', 'sell'].includes(tab)) return json({ code: 1, msg: 'unknown tab' }, 404);
  try {
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), TIMEOUT);
    const r = await fetch(EM, {
      signal: ctrl.signal,
      headers: { Referer: 'https://fund.eastmoney.com/' },
      // 东方财富要求时间戳参数避免缓存
      url: EM, // ignored; params appended below
    }).catch(() => null);
    // 重新用带 query 的方式请求
    const url = new URL(EM);
    url.searchParams.set('ft', 'all'); url.searchParams.set('sc', 'zzf');
    url.searchParams.set('st', 'desc'); url.searchParams.set('pi', '1');
    url.searchParams.set('pn', '200'); url.searchParams.set('dx', '1');
    url.searchParams.set('_', Date.now());
    const res = await fetch(url.toString(), { headers: { Referer: 'https://fund.eastmoney.com/' }, signal: ctrl.signal });
    if (!res.ok) throw new Error('upstream ' + res.status);
    const j = await res.json();
    const rows = parse(j?.Datas || j?.datas || []);
    return json({ code: 0, data: { tab, list: build(tab, rows), updated_at: Date.now() } });
  } catch (e) {
    return json({ code: 1, msg: '排行接口暂不可用', detail: e?.message }, 502);
  }
}
function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' } }); }
