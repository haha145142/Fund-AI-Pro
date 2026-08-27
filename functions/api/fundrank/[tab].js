// Cloudflare Pages Function · /api/fundrank/:tab
// 替代原 Flask 后端（app.py），无需自建服务器，Cloudflare 边缘运行
// tab 支持：gain/loss/buy/sell，及中文别名 股票/基金/混合/指数/债券/QDII/货币
const EM = 'https://fundapi.eastmoney.com/FundTopicInterface/api/FundTopicAjaxNew';
const TIMEOUT = 12_000;

// 中文 tab → 内部 key（含大小写不敏感）
const TAB_ALIAS = {
  '股票': 'gain', '基金': 'gain', '混合': 'buy', '指数': 'gain',
  '债券': 'loss', 'qdii': 'sell', '货币': 'loss',
  'gain': 'gain', 'loss': 'loss', 'buy': 'buy', 'sell': 'sell',
};
const ALL_TABS = new Set(['gain', 'loss', 'buy', 'sell']);

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

// 兼容东财多种返回结构：数组 / CSV 字符串 / 对象数组
function parse(rows) {
  const out = [];
  for (const x of rows || []) {
    let a;
    if (Array.isArray(x)) a = x;
    else if (typeof x === 'string') a = x.split(',');
    else if (typeof x === 'object') {
      // 对象形式：直接取字段
      const day = num(x.day_change ?? x.dayChange ?? x.f2 ?? x.day);
      const month = num(x.month_change ?? x.monthChange ?? x.f3 ?? x.month);
      out.push({
        code: String(x.code ?? x.fundCode ?? x[0] ?? ''),
        name: String(x.name ?? x.fundName ?? x[1] ?? ''),
        nav: num(x.nav ?? x.f1 ?? x[3]),
        day_change: day,
        month_change: month,
      });
      continue;
    } else continue;
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
  if (!rows || !rows.length) return [];
  // 允许 day_change 为 0（0 != null），只在真正缺失时过滤
  const has = x => x.day_change !== null && x.day_change !== undefined;
  let list = rows.filter(has);
  if (!list.length) list = rows; // 实在没有涨跌字段就全量返回，避免空
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

function resolveTab(raw) {
  const key = decodeURIComponent((raw || '').replace(/[\[\]]/g, '')).toLowerCase();
  return TAB_ALIAS[key] || (ALL_TABS.has(key) ? key : 'gain'); // 未知→gain，不再 404
}

export async function onRequestGet({ params }) {
  const tab = resolveTab(params.tab);
  try {
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), TIMEOUT);
    const url = new URL(EM);
    url.searchParams.set('ft', 'all'); url.searchParams.set('sc', 'zzf');
    url.searchParams.set('st', 'desc'); url.searchParams.set('pi', '1');
    url.searchParams.set('pn', '200'); url.searchParams.set('dx', '1');
    url.searchParams.set('_', Date.now());
    const res = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers: { Referer: 'https://fund.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) throw new Error('upstream ' + res.status);
    const text = await res.text();
    // 东财有时返回 JSONP（callback(...)），有时纯 JSON
    const cleaned = text.trim().replace(/^\s*[\w$]+\(/, '').replace(/\)\s*$/, '');
    const j = JSON.parse(cleaned);
    const rows = parse(j?.Datas || j?.datas || j?.data?.list || []);
    return json({ code: 0, data: { tab, list: build(tab, rows), total: rows.length, updated_at: Date.now() } });
  } catch (e) {
    return json({ code: 1, msg: '排行接口暂不可用', detail: e?.message, tab, list: [] }, 502);
  }
}

function json(o, s = 200) {
  return new Response(JSON.stringify(o), {
    status: s,
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
