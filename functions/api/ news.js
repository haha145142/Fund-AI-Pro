export function onRequest() {
  return new Response(JSON.stringify({ok:true, source:"news", data:[]}), {
    headers: {"content-type":"application/json;charset=utf-8"}
  });
}
