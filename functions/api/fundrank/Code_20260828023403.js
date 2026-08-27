// functions/api/health.js
export function onRequest() {
  return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
    headers: { 'content-type': 'application/json' }
  });
}
