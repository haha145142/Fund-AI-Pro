const CACHE='fund-ai-pro-v1';
const ASSETS=['/','/index.html','/manifest.json','/assets/icon192.png','/assets/icon180.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('fetch',e=>{const req=e.request;if(req.method!=='GET')return;
 e.respondWith(caches.match(req).then(r=>r||fetch(req).then(res=>{if(res.ok&&req.url.startsWith(self.location.origin))caches.open(CACHE).then(c=>c.put(req,res.clone()));return res;}).catch(()=>caches.match('/index.html'))));
});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))));
