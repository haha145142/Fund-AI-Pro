// 共享工具：多源抓取 + 超时 + GBK 解码 + 交叉验证
// 被 market.js / news.js / fundrank/[tab].js 共用

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// 带超时的 fetch（CF 默认不支持 AbortSignal.timeout）
export function fetchWithTimeout(url, init = {}, ms = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// 取文本（UTF-8）
export async function fetchText(url, referer, ms = 10_000) {
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': UA, Referer: referer, Accept: '*/*' } },
    ms
  );
  if (!res.ok) throw new Error('HTTP ' + res.status + ' @' + url);
  return await res.text();
}

// 取 JSON（自动剥 JSONP 包裹 callback(...) ）
export async function fetchJSON(url, referer, ms = 10_000) {
  const text = await fetchText(url, referer, ms);
  const cleaned = text.trim().replace(/^\s*[\w$]+\(/, '').replace(/\)\s*$/, '');
  return JSON.parse(cleaned);
}

// 取 GBK 编码文本（腾讯/新浪中文名用 GBK，CF 默认 UTF-8 会乱码）
export async function fetchGBK(url, referer, ms = 10_000) {
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': UA, Referer: referer, Accept: '*/*' } },
    ms
  );
  if (!res.ok) throw new Error('HTTP ' + res.status + ' @' + url);
  const buf = await res.arrayBuffer();
  return new TextDecoder('gbk').decode(buf);
}

/**
 * 多源并行抓取 + 交叉验证（核心）
 * @param {Array<{name, fetch: () => Promise<any>}>} sources
 * @param {Function} normalize 把单个源的原始数据归一化成统一结构（数组）
 * @param {(a,b)=>number} compare 排序函数
 * @param {number} top 取前 N 条
 * @param {Function} crossCheck 交叉验证：(primary, secondary) => {warnings:[], score}
 * @returns { sources, list, total, cross: {checked, warnings, verified} }
 */
export async function multiSource({ sources, normalize, compare, top = 20, crossCheck }) {
  const tasks = sources.map(async (s) => {
    try {
      const raw = await s.fetch();
      const list = normalize(raw) || [];
      return { name: s.name, ok: true, list };
    } catch (e) {
      return { name: s.name, ok: false, error: e?.message || String(e), list: [] };
    }
  });
  const settled = await Promise.all(tasks);
  const succeeded = settled.filter((r) => r.ok && r.list.length);

  // 取样本最多的那个作为主源
  let primary = succeeded.sort((a, b) => b.list.length - a.list.length)[0] || null;

  // 交叉验证：主源 vs 第一个成功的备源
  let warnings = [];
  let checked = 0;
  let verified = false;
  if (crossCheck && primary) {
    const secondary = succeeded.find((s) => s.name !== primary.name);
    if (secondary) {
      console.log('[multiSource] primary.name=', primary.name, 'sample=', JSON.stringify(primary.list[0]));
      console.log('[multiSource] secondary.name=', secondary.name, 'sample=', JSON.stringify(secondary.list[0]));
      const result = crossCheck(primary.list, secondary.list);
      warnings = result.warnings || [];
      checked = result.checked || 0;
      verified = warnings.length === 0;
    }
  }

  // 合并所有成功源（去重 by key/title），并累加 sources[] 用于交叉可信度
  const merged = new Map();
  for (const s of succeeded) {
    for (const item of s.list) {
      const key = String(item.key ?? item.code ?? item.title ?? item.name ?? '');
      if (!key) continue;
      const src = item.source || s.name;
      if (merged.has(key)) {
        // 已存在 → 累加来源，字段以首次为准（主源优先）
        const prev = merged.get(key);
        prev.sources = Array.from(new Set([...(prev.sources || [prev.source]), src]));
        continue;
      }
      merged.set(key, { ...item, source: src, sources: [src] });
    }
  }
  const list = Array.from(merged.values()).sort(compare).slice(0, top);
  const sourceReport = settled.map((r) => ({
    name: r.name,
    ok: r.ok && r.list.length > 0,
    count: r.list.length,
    error: r.ok ? undefined : r.error,
  }));

  return { sourceReport, list, total: list.length, cross: { checked, warnings, verified } };
}

// 通用响应包装
export function jsonResp(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
