// Cloudflare Pages Function: 市场数据代理
// 路径：/api/market
// 数据源：东方财富 + 腾讯财经交叉校验
// 说明：资金流向使用东方财富大盘资金字段 f62/f66/f72/f78/f84，避免把指数快照的非资金字段误当资金。

const EM_BASE = 'https://push2.eastmoney.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
  Accept: 'application/json,text/plain,*/*'
};

const INDEXES = [
  { id: 'sse', name: '上证指数', secid: '1.000001', code: '000001', tx: 's_sh000001' },
  { id: 'sz', name: '深证成指', secid: '0.399001', code: '399001', tx: 's_sz399001' },
  { id: 'cyb', name: '创业板指', secid: '0.399006', code: '399006', tx: 's_sz399006' },
  { id: 'kc50', name: '科创50', secid: '1.000688', code: '000688', tx: 's_sh000688' }
];

async function getJson(url, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: HEADERS,
      cache: 'no-store',
      cf: { cacheTtl: 0, cacheEverything: false },
      signal: controller.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        Referer: 'https://finance.qq.com/',
        Accept: '*/*'
      },
      cache: 'no-store',
      cf: { cacheTtl: 0, cacheEverything: false },
      signal: controller.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v) {
  const n = num(v);
  return n == null ? null : n / 1e8; // 元 -> 亿元
}

function parseTencent(text, symbol) {
  const m = text.match(new RegExp(`v_${symbol}="([^"]*)"`));
  if (!m) return null;

  const p = m[1].split('~');
  if (p.length < 9) return null;

  return {
    name: p[1],
    price: num(p[3]),
    change: num(p[4]),
    pct: num(p[32] ?? p[5]),
    amount10k: num(p[8])
  };
}

/**
 * 一次请求拿到四大指数 + 沪深大盘资金。
 * 关键修复：
 * 之前使用 /stock/get 读取指数的 f66/f72/f78/f84，
 * 现在改用 /ulist.np/get 的大盘资金字段，口径与东方财富大盘资金流页面一致。
 */
async function getMarketSnapshot() {
  const secids = INDEXES.map(x => x.secid).join(',');
  const fields = 'f2,f3,f4,f6,f12,f14,f62,f66,f72,f78,f84';

  const emUrl =
    `${EM_BASE}/api/qt/ulist.np/get?secids=${secids}` +
    `&fields=${fields}&fltt=2&invt=2&_=${Date.now()}`;

  const txUrl = `https://qt.gtimg.cn/q=${INDEXES.map(x => x.tx).join(',')}`;

  const [em, txText] = await Promise.all([
    getJson(emUrl),
    getText(txUrl)
  ]);

  const rows = Array.isArray(em?.data?.diff)
    ? em.data.diff
    : Object.values(em?.data?.diff || {});

  const byCode = new Map(rows.map(x => [String(x.f12), x]));

  const indexes = INDEXES.map(x => {
    const e = byCode.get(x.code);
    const east = e
      ? {
          price: num(e.f2),
          pct: num(e.f3),
          change: num(e.f4)
        }
      : null;

    const t = parseTencent(txText, x.tx);

    const validated = !!(
      east &&
      t &&
      east.price != null &&
      t.price != null &&
      Math.abs(east.price - t.price) <= 0.05 &&
      Math.abs((east.pct ?? 0) - (t.pct ?? 0)) <= 0.03
    );

    return {
      id: x.id,
      name: x.name,
      price: east?.price ?? t?.price ?? null,
      pct: east?.pct ?? t?.pct ?? null,
      change: east?.change ?? t?.change ?? null,
      validated,
      source: east ? '东方财富' : '腾讯'
    };
  });

  // 沪深两市资金合计。所有值均为“净额”，单位最终统一为亿元。
  const sh = byCode.get('000001');
  const sz = byCode.get('399001');
  const rows2 = [sh, sz].filter(Boolean);

  let turnover = 0;
  let superLarge = 0;
  let large = 0;
  let medium = 0;
  let small = 0;

  for (const r of rows2) {
    turnover += money(r.f6) || 0;
    superLarge += money(r.f66) || 0;
    large += money(r.f72) || 0;
    medium += money(r.f78) || 0;
    small += money(r.f84) || 0;
  }

  const shTx = parseTencent(txText, 's_sh000001');
  const szTx = parseTencent(txText, 's_sz399001');

  // 腾讯 amount10k 的单位是万元；万元 / 10000 = 亿元。
  const txTurnover = ((shTx?.amount10k || 0) + (szTx?.amount10k || 0)) / 1e4;

  const turnoverValidated =
    txTurnover > 0 &&
    Math.abs(turnover - txTurnover) / txTurnover < 0.03;

  return {
    indexes,
    market: {
      turnover,
      superLarge,
      large,
      medium,
      small,
      turnoverValidated,
      txTurnover,
      source: '东方财富大盘资金流'
    }
  };
}

async function getSectorFlows() {
  const fields =
    'f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f204,f205';

  const url =
    `${EM_BASE}/api/qt/clist/get?pn=1&pz=500&po=1&np=1` +
    `&fltt=2&invt=2&ut=8dec03ba335b81bf4ebdf7b29ec27d15` +
    `&fid=f62&fs=m:90+t:2+f:!50&fields=${fields}&_=${Date.now()}`;

  const j = await getJson(url, 6000);

  const rows = Array.isArray(j?.data?.diff)
    ? j.data.diff
    : Object.values(j?.data?.diff || {});

  const clean = rows
    .map(r => ({
      name: r.f14,
      code: r.f12,
      pct: num(r.f3),
      net: money(r.f62)
    }))
    .filter(x => x.name && x.net != null && Number.isFinite(x.net));

  return {
    inflow: [...clean]
      .filter(x => x.net > 0)
      .sort((a, b) => b.net - a.net)
      .slice(0, 5),

    outflow: [...clean]
      .filter(x => x.net < 0)
      .sort((a, b) => a.net - b.net)
      .slice(0, 5),

    source: '东方财富行业板块资金流'
  };
}

export async function onRequestGet() {
  const started = Date.now();

  const [snapshot, sector] = await Promise.allSettled([
    getMarketSnapshot(),
    getSectorFlows()
  ]);

  const snapshotData =
    snapshot.status === 'fulfilled' ? snapshot.value : null;

  const indexes = snapshotData?.indexes || [];
  const market = snapshotData?.market || null;
  const sectors = sector.status === 'fulfilled' ? sector.value : null;

  const validation = {
    indexSources: ['东方财富', '腾讯财经'],
    validatedCount: indexes.filter(x => x.validated).length,
    turnoverValidated: !!market?.turnoverValidated
  };

  const ok =
    indexes.length === 4 &&
    market != null &&
    sectors != null &&
    validation.validatedCount >= 3;

  return new Response(
    JSON.stringify({
      ok,
      updatedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      indexes,
      market,
      sectors,
      validation
    }),
    {
      status: ok ? 200 : 206,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'CDN-Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS'
      }
    }
  );
}

export function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS'
    }
  });
}
