export function onRequest() {
  return new Response(JSON.stringify({ok:true, source:"market", v:3}), {
    headers: {"content-type":"application/json;charset=utf-8"}
  });
}

