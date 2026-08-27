// Cloudflare Pages Middleware · 边缘缓存 + CORS + 健康检查
// 对应需求：减少重复请求压力（30s/60s/5min 分级缓存）
export async function onRequest({ request, next, env }) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 健康检查（含版本标识）
  if (path.endsWith('/api/health')) {
    return json({ code: 0, msg: 'ok', version: '2.0', ts: Date.now() });
  }

  // 只读 GET 接口：按路径设置 CDN 缓存
  const cacheTTL = (
    /fundrank/.test(path) ? 60 :
    /news/.test(path) ? 300 :
    /market/.test(path) ? 120 :
    /sector/.test(path) ? 120 :
    /indices/.test(path) ? 60 :
    /global/.test(path) ? 60 : 0
  );
  const resp = await next();

  // AI 接口不缓存（个性化），其余按 TTL 缓存
  if (request.method === 'GET' && cacheTTL > 0 && !path.includes('/ai/')) {
    const headers = new Headers(resp.headers);
    headers.set('Cache-Control', 'public, max-age=' + cacheTTL + ', s-maxage=' + cacheTTL);
    headers.set('CF-Cache-Tag', path.replace(/\//g, '_'));
    return new Response(resp.body, { status: resp.status, headers });
  }
  // 统一 CORS（开发期允许本地 file:// 调试）
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(resp.body, { status: resp.status, headers });
}

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
}
