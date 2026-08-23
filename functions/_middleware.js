// Fund-AI-Pro 全局 UI/新闻增强中间件
export async function onRequest(context) {
  const response = await context.next();
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.delete('Content-Length');

  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append('<link rel="stylesheet" href="/ui-fix.css?v=20260824-2">', { html: true });
        element.append('<link rel="stylesheet" href="/dock.css?v=20260824-1">', { html: true });
      }
    })
    .on('body', {
      element(element) {
        element.append('<script src="/ui-fix.js?v=20260824"></script>', { html: true });
      }
    })
    .transform(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
}
