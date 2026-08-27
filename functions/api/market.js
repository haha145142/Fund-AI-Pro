// Cloudflare Pages Function · /api/market
// 多源 + 交叉验证 + 自动降级
// 主源：东财 push2（在 CF 边缘实测被反爬 → 通常失败，作为「首选尝试」）
// 备源：腾讯 qt.gtimg.cn（主）+ 新浪 hq.sinajs.cn（备）
// 策略：三源并行抓取 → 两两交叉验证涨跌幅 → 偏差>0.1% 标记 warn
// 返回：{ ok, updatedAt, source, indexes, market, sectors, cross:{checked,warnings,verified}, sources }

import { fetchJSON, fetchGBK, multiSource, jsonResp, num } from './_lib.js';

const INDEXES = [
  { key: 'sh000001', name: '上证指数', em: '1.000001' },
  { key: 'sz399001', name: '深证成指', em: '0.399001' },
  { key: 'sz399006', name: '创业板指', em: '0.399006' },
  { key: 'sh000688', name: '科创50',   em: '1.000688' },
  { key: 'sh000300', name: '沪深300',  em: '1.000300' },
];

// ---- 源A：东财 push2 ----
async function fetchEastmoney() {
  const ids = INDEXES.map((i) => i.em).join(',');
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f4,f12,f14&secids=' + ids;
  const j = await fetchJSON(url, 'https://quote.eastmoney.com/');
  return (j?.data?.diff || []).map((d) => ({
    key: String(d.f12),
    name: d.f14,
    price: num(d.f2),
    changePercent: num(d.f3),
    changeAmount: num(d.f4),
  }));
}

// ---- 源B：腾讯 qt ----
// 腾讯行情协议：f[1]名 f[3]现价 f[4]昨收，涨跌幅由 (现价-昨收)/昨收 推导，避免依赖易偏移的固定索引
async function fetchTencent() {
  const url = 'https://qt.gtimg.cn/q=' + INDEXES.map((i) => i.key).join(',');
  const text = await fetchGBK(url, 'https://gu.qq.com/');
  const map = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^v_(sh|sz)(\d{6})="([^"]*)"/);
    if (!m) continue;
    const f = m[3].split('~');
    const price = num(f[3]), prev = num(f[4]);
    let changePercent = num(f[32]); // 优先用官方涨跌幅
    if (changePercent == null && price != null && prev) {
      changePercent = +(price - prev) / prev * 100; // 推导兜底
    }
    map[m[1] + m[2]] = { name: f[1], price, prevClose: prev, changePercent, changeAmount: num(f[31]) ?? (price != null && prev ? +(price - prev).toFixed(3) : null) };
  }
  return INDEXES.map((i) => ({ key: i.key, name: map[i.key]?.name || i.name, ...map[i.key] }));
}

// ---- 源C：新浪 sinajs ----
async function fetchSina() {
  const url = 'https://hq.sinajs.cn/list=' + INDEXES.map((i) => 's_' + i.key).join(',');
  const text = await fetchGBK(url, 'https://finance.sina.com.cn/');
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/hq_str_(s_[a-z0-9]+)="([^"]*)"/);
    if (!m) continue;
    const cfg = INDEXES.find((i) => 's_' + i.key === m[1]);
    if (!cfg) continue;
    const f = m[2].split(',');
    if (f.length < 4) continue;
    out.push({ key: cfg.key, name: f[0] || cfg.name, price: num(f[1]), changeAmount: num(f[2]), changePercent: num(f[3]) });
  }
  return out;
}

// 归一化：统一成 {key,name,price,changePercent,changeAmount}
function normalize(rows) {
  return (rows || [])
    .map((r) => ({
      key: String(r.key || r.code || ''),
      name: String(r.name || ''),
      price: num(r.price),
      changePercent: num(r.changePercent ?? r.pct),
      changeAmount: num(r.changeAmount ?? r.change),
    }))
    .filter((r) => r.key && r.name);
}

// 按 key 建索引，便于交叉比对
function toMap(rows) {
  const m = {};
  for (const r of rows) m[r.key] = r;
  return m;
}

// 交叉验证：对比两源涨跌幅，偏差>0.1% 标记；某源为 null 时用另一源回填
function crossCheck(a, b) {
  const ma = toMap(a), mb = toMap(b);
  const warnings = [];
  let checked = 0;
  // 回填：把 b 有而 a 缺的字段补到 a（反之亦然在下面对称处理）
  for (const key of new Set([...Object.keys(ma), ...Object.keys(mb)])) {
    const va = ma[key]?.changePercent, vb = mb[key]?.changePercent;
    if (va == null && vb != null && ma[key]) ma[key].changePercent = vb; // 回填 a
    if (vb == null && va != null && mb[key]) mb[key].changePercent = va; // 回填 b
  }
  for (const key of Object.keys(ma)) {
    const va = ma[key]?.changePercent, vb = mb[key]?.changePercent;
    if (va == null || vb == null) continue;
    checked++;
    if (Math.abs(va - vb) > 0.1) {
      warnings.push({ key, name: ma[key]?.name, sourceA: va, sourceB: vb, diff: +(va - vb).toFixed(3) });
    }
  }
  return { checked, warnings };
}

export async function onRequest() {
  const updatedAt = new Date().toISOString();

  const result = await multiSource({
    sources: [
      { name: 'eastmoney', fetch: fetchEastmoney },
      { name: 'tencent', fetch: fetchTencent },
      { name: 'sina', fetch: fetchSina },
    ],
    normalize,
    compare: (a, b) => (b.changePercent ?? -999) - (a.changePercent ?? -999),
    top: 30,
    crossCheck,
  });

  // 兜底：三源全挂时给骨架（前端不空白）
  let indexes = result.list;
  if (!indexes.length) {
    indexes = INDEXES.map((i) => ({ key: i.key, name: i.name, price: null, changePercent: null, changeAmount: null }));
    result.cross = { checked: 0, warnings: [], verified: false };
  }

  const sh = indexes.find((i) => i.key === 'sh000001') || indexes[0];
  const market = sh
    ? { key: sh.key, name: sh.name, price: sh.price, changePercent: sh.changePercent, changeAmount: sh.changeAmount, turnover: null }
    : null;

  const liveSources = result.sourceReport.filter((s) => s.ok).map((s) => s.name);
  const source = liveSources.length === 0 ? 'snapshot' : liveSources.join('+');

  return jsonResp({
    ok: true,
    updatedAt,
    source,
    indexes,
    market,
    sectors: [],
    cross: result.cross,
    sources: result.sourceReport,
  });
}
