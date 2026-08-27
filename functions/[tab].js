// Cloudflare Pages Function · /api/fundrank/:tab
// 多源 + 交叉验证 + 自动降级
// 主源：东财 fundapi（首选尝试，CF 边缘常被反爬 → 通常降级）
// 备源：腾讯 qt（查实时涨跌） / 新浪 sinajs
// tab：gain/loss/buy/sell，中文别名 股票/基金/混合/指数/债券/QDII/货币
// 交叉验证：东财列表 vs 腾讯抽样，涨跌幅偏差>0.3% 标记 warn
// 全挂 → 规则化降级数据（degraded:true），永不 404

import { fetchJSON, fetchGBK, multiSource, jsonResp, num } from '../_lib.js';

const EM = 'https://fundapi.eastmoney.com/FundTopicInterface/api/FundTopicAjaxNew';
const TIMEOUT = 12_000;

const TAB_ALIAS = {
  '股票': 'gain', '基金': 'gain', '指数': 'gain', '混合': 'buy',
  '债券': 'loss', '货币': 'loss', 'qdii': 'sell',
  'gain': 'gain', 'loss': 'loss', 'buy': 'buy', 'sell': 'sell',
};
const ALL = new Set(['gain', 'loss', 'buy', 'sell']);

// 归一化为 {code,name,nav,day,month}
function normEM(rows) {
  return (rows || []).map((r) => {
    if (Array.isArray(r)) {
      return { code: String(r[0]), name: String(r[1]), nav: num(r[3]), day: num(r[5]), month: num(r[7]) };
    }
    if (typeof r === 'string') {
      const a = r.split(',');
      return { code: String(a[0]), name: String(a[1]), nav: num(a[3]), day: num(a[5]), month: num(a[7]) };
    }
    return {
      code: String(r.code ?? r.fundCode ?? ''),
      name: String(r.name ?? r.fundName ?? ''),
      nav: num(r.nav ?? r.f1),
      day: num(r.day_change ?? r.dayChange ?? r.f2),
      month: num(r.month_change ?? r.monthChange ?? r.f3),
    };
  }).filter((r) => r.code && r.name);
}

async function fetchEastmoney() {
  const u = new URL(EM);
  u.searchParams.set('ft', 'all'); u.searchParams.set('sc', 'zzf');
  u.searchParams.set('st', 'desc'); u.searchParams.set('pi', '1');
  u.searchParams.set('pn', '200'); u.searchParams.set('dx', '1'); u.searchParams.set('_', Date.now());
  const j = await fetchJSON(u.toString(), 'https://fund.eastmoney.com/', TIMEOUT);
  return normEM(j?.Datas || j?.datas || j?.data?.list || []);
}

// 腾讯/新浪：用一组代表基金代码批量查实时涨跌做交叉验证样本
const SAMPLE_CODES = ['110011', '161725', '005827', '260108', '003096', '007119', '006327'];

function qtUrl(codes, prefix) {
  return 'https://qt.gtimg.cn/q=' + codes.map((c) => prefix + c).join(',');
}

async function fetchTencent() {
  const text = await fetchGBK(qtUrl(SAMPLE_CODES, 's'), 'https://gu.qq.com/', TIMEOUT);
  const map = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^v_s(\d{6})="([^"]*)"/);
    if (!m) continue;
    const f = m[2].split('~');
    map[m[1]] = { name: f[1], price: num(f[3]), day: num(f[31]), pct: num(f[32]) };
  }
  return Object.entries(map).map(([code, v]) => ({ code, name: v.name, nav: v.price, day: v.day, month: null }));
}

async function fetchSina() {
  const text = await fetchGBK(qtUrl(SAMPLE_CODES, 's'), 'https://finance.sina.com.cn/', TIMEOUT);
  const map = {};
  for (const line of text.split('\n')) {
    const m = line.match(/hq_str_s(\d{6})="([^"]*)"/);
    if (!m) continue;
    const f = m[2].split(',');
    const price = num(f[3]), prev = num(f[4]);
    map[m[1]] = { name: f[0], nav: price, day: prev ? +(price - prev).toFixed(3) : num(f[4]), month: null };
  }
  return Object.entries(map).map(([code, v]) => ({ code, name: v.name, nav: v.nav, day: v.day, month: null }));
}

function resolveTab(raw) {
  const k = decodeURIComponent((raw || '').replace(/[\[\]]/g, '')).toLowerCase();
  return TAB_ALIAS[k] || (ALL.has(k) ? k : 'gain');
}

function estHeat(day, month, dir) {
  const d = day || 0, m = month || 0;
  if (dir === 'buy') return Math.max(0, Math.min(100, Math.round(40 + d * 8 + m * 1.2)));
  return Math.max(0, Math.min(100, Math.round(40 + Math.abs(d) * 8 + (m < 0 ? -m : 0) * 1.2)));
}

function build(tab, rows) {
  if (!rows.length) return [];
  let list = rows.filter((x) => x.day != null);
  if (!list.length) list = rows;
  if (tab === 'gain') list.sort((a, b) => (b.day ?? -999) - (a.day ?? -999));
  else if (tab === 'loss') list.sort((a, b) => (a.day ?? 999) - (b.day ?? 999));
  else if (tab === 'buy') {
    list = list.filter((x) => x.day >= 3 && (x.month == null || x.month >= 0)).sort((a, b) => (b.day ?? -999) - (a.day ?? -999));
    list = list.map((x) => ({ ...x, heat: estHeat(x.day, x.month, 'buy') }));
  } else if (tab === 'sell') {
    list = list.filter((x) => x.day <= -2 || (x.day < 0 && (x.month || 0) < 0)).sort((a, b) => (a.day ?? 999) - (b.day ?? 999));
    list = list.map((x) => ({ ...x, heat: estHeat(x.day, x.month, 'sell') }));
  }
  return list.slice(0, 20).map((x) => ({ code: x.code, name: x.name, nav: x.nav, day_change: x.day, month_change: x.month, ...(x.cross ? { cross: x.cross } : {}) }));
}

function crossCheckEMvsTX(emList, txList) {
  const txMap = {};
  for (const r of txList) txMap[r.code] = r;
  const warnings = [];
  let checked = 0;
  for (const it of emList.slice(0, 15)) {
    const t = txMap[it.code];
    if (!t || t.day == null || it.day == null) continue;
    checked++;
    if (Math.abs((it.day || 0) - (t.day || 0)) > 0.3) {
      warnings.push({ code: it.code, name: it.name, eastmoney: it.day, tencent: t.day, diff: +((it.day || 0) - (t.day || 0)).toFixed(3) });
      it.cross = 'warn';
    }
  }
  return { checked, warnings, verified: warnings.length === 0 };
}

const FALLBACK = [
  { code: '110011', name: '易方达中小盘混合', day: 1.2, month: 3.1 },
  { code: '161725', name: '招商中证白酒', day: -0.8, month: 2.4 },
  { code: '005827', name: '易方达蓝筹精选', day: 0.6, month: 1.9 },
  { code: '260108', name: '景顺长城新兴成长', day: 0.3, month: 0.7 },
  { code: '003096', name: '中欧医疗健康', day: -0.5, month: -1.2 },
];

export async function onRequestGet({ params }) {
  const tab = resolveTab(params.tab);

  const result = await multiSource({
    sources: [
      { name: 'eastmoney', fetch: fetchEastmoney },
      { name: 'tencent', fetch: fetchTencent },
      { name: 'sina', fetch: fetchSina },
    ],
    normalize: (raw) => raw,
    compare: (a, b) => (b.day ?? -999) - (a.day ?? -999),
    top: 200,
    crossCheck: (a, b) => crossCheckEMvsTX(a, b),
  });

  let list = result.list;
  let degraded = false;
  if (!list.length) {
    list = FALLBACK;
    degraded = true;
    result.cross = { checked: 0, warnings: [], verified: false };
  }

  const finalList = build(tab, list);
  const liveSources = result.sourceReport.filter((s) => s.ok).map((s) => s.name);

  return jsonResp({
    code: degraded ? 1 : 0,
    msg: degraded ? '全部数据源不可用，返回规则化降级数据' : 'ok',
    tab,
    list: finalList,
    total: finalList.length,
    updated_at: Date.now(),
    source: liveSources.join('+') || 'fallback',
    sources: result.sourceReport,
    cross: result.cross,
    degraded,
  });
}
