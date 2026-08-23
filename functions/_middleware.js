// Fund-AI-Pro 全局 UI/新闻增强中间件
// 不改 index.html 主体，统一注入 UI 修复与新闻解读修复。
export async function onRequest(context) {
  const response = await context.next();
  const contentType = response.headers.get('content-type') || '';

  // API/JSON 等非 HTML 请求原样返回，避免影响现有 /api/news。
  if (!contentType.includes('text/html')) return response;

  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.delete('Content-Length');

  const html = new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append('<link rel="stylesheet" href="/ui-fix.css?v=20260824">', { html: true });
      }
    })
    .on('body', {
      element(element) {
        element.append('<script src="/ui-fix.js?v=20260824"></script>', { html: true });
      }
    })
    .transform(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));

  return html;
}
