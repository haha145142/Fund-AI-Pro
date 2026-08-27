export function onRequest({ params }) {
  const tab = params.tab || "";
  return new Response(JSON.stringify({
    ok: true,
    route: "fundrank",
    tab,
    params
  }), {
    headers: { "content-type": "application/json;charset=utf-8" }
  });
}
