// Fund AI Pro · Service Worker v5
// 离线策略：缓存外壳，数据显示当前离线，绝不伪装实时数据。
// UI增强：页面加载时注入视觉升级；新闻严禁后台自动轮询，必须由用户手动点击“更新”。

const CACHE_NAME = 'fund-ai-pro-v5';
const CACHE_URLS = ['/', '/index.html', '/manifest.json'];

const UI_PATCH = String.raw`
<style id="fund-ai-pro-ui-v5">
.news-refresh-btn{width:34px!important;height:34px!important;border-radius:12px!important;font-size:12px!important;background:linear-gradient(145deg,rgba(255,255,255,.72),rgba(226,240,255,.42))!important;border:1px solid rgba(255,255,255,.82)!important;box-shadow:0 8px 20px rgba(30,75,125,.12),inset 0 1px 0 rgba(255,255,255,.95)!important}
.news-refresh-btn:active{transform:scale(.92)!important}
.sect-pro{gap:12px!important}
.sc-pro{isolation:isolate!important;transform:translateZ(0);will-change:transform,box-shadow!important;animation:sectorFloatIn .55s cubic-bezier(.2,.8,.2,1) both,sectorBreath 5.5s ease-in-out infinite!important}
.sc-pro .border-glow{opacity:.82!important;filter:saturate(1.15)!important}
.sc-pro .border-glow::before{animation:borderRotatePremium 8s linear infinite!important;background:conic-gradient(from 0deg,transparent 0deg,rgba(74,144,255,.58) 48deg,transparent 105deg,rgba(174,111,255,.42) 165deg,transparent 220deg,rgba(79,205,184,.42) 285deg,transparent 340deg,rgba(74,144,255,.58) 360deg)!important}
.sc-pro::after{animation:sectorSheen 4.8s ease-in-out infinite!important}
.sc-pro .glow{animation:sectorOrb 5s ease-in-out infinite!important}
.sc-pro .flow-bar .bar i{animation:flowShinePro 2.8s linear infinite,flowPulsePremium 3.8s ease-in-out infinite!important}
@keyframes sectorFloatIn{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes sectorBreath{0%,100%{box-shadow:0 24px 68px rgba(20,60,110,.13),0 8px 24px rgba(20,60,110,.06),inset 0 1.5px 0 rgba(255,255,255,.98),inset 0 -1px 0 rgba(180,215,245,.30)}50%{box-shadow:0 28px 76px rgba(35,88,150,.17),0 10px 28px rgba(75,120,180,.08),inset 0 1.5px 0 rgba(255,255,255,1),inset 0 -1px 0 rgba(180,215,245,.34)}}
@keyframes borderRotatePremium{to{transform:rotate(360deg)}}
@keyframes sectorSheen{0%,100%{transform:translateX(-12%);opacity:.35}50%{transform:translateX(12%);opacity:.72}}
@keyframes sectorOrb{0%,100%{transform:scale(.92);opacity:.24}50%{transform:scale(1.08);opacity:.48}}
@keyframes flowPulsePremium{0%,100%{filter:brightness(.96)}50%{filter:brightness(1.14)}}
.tabbar{width:calc(100% - 56px)!important;max-width:440px!important;border-radius:24px!important;padding:4px 5px!important;box-shadow:0 18px 55px rgba(20,60,110,.18),inset 0 1px 0 rgba(255,255,255,.96),inset 0 -1px 0 rgba(170,205,240,.25)!important}
.tabbar .tab{min-width:42px!important;min-height:42px!important;padding:3px 7px!important;border-radius:15px!important;gap:2px!important}
.tabbar .tab .ico{width:21px!important;height:21px!important}
.tabbar .tab .ico svg{width:19px!important;height:19px!important;stroke-width:1.65!important;filter:drop-shadow(0 2px 5px rgba(10,84,150,.16))!important}
.tabbar .tab.active{background:linear-gradient(145deg,rgba(255,255,255,.92),rgba(221,238,255,.58))!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.98),0 5px 16px rgba(10,132,255,.14)!important}
.tabbar .tab.active:after{width:4px!important;height:4px!important;bottom:2px!important}
.sc-pro .names .cn .secicon{width:22px!important;height:22px!important;stroke-width:1.55!important;opacity:1!important;filter:drop-shadow(0 2px 5px rgba(38,95,150,.18))!important;background:linear-gradient(145deg,rgba(255,255,255,.72),rgba(216,235,255,.30));border:1px solid rgba(255,255,255,.82);border-radius:8px;padding:3px;box-shadow:inset 0 1px 0 rgba(255,255,255,.95),0 4px 10px rgba(30,85,135,.10)}
@media(max-width:480px){.tabbar{width:calc(100% - 42px)!important;max-width:390px!important}.sc-pro{animation-duration:.45s,6s!important}.sc-pro .names .cn .secicon{width:21px!important;height:21px!important}}
@media(prefers-reduced-motion:reduce){.sc-pro,.sc-pro .border-glow::before,.sc-pro::after,.sc-pro .glow,.sc-pro .flow-bar .bar i{animation:none!important}}
</style>
<script id="fund-ai-pro-ui-script-v5">
(function(){
'use strict';
const nativeSetInterval=window.setInterval;
window.setInterval=function(fn,delay){try{const src=typeof fn==='function'?Function.prototype.toString.call(fn):String(fn);if(/news|loadNews|fetchNews|refreshNews|renderNews/i.test(src)){console.info('[Fund AI Pro] 新闻自动轮询已关闭，请手动点击更新');return 0;}}catch(e){}return nativeSetInterval.apply(this,arguments);};
const navIcons={
'首页':'<path d="M3.5 10.8 12 4l8.5 6.8v8.1a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6z"/><path d="M9.2 20.5v-5.6h5.6v5.6"/>',
'行情':'<path d="M4 18V9m5 9V5m5 13v-7m5 7V3"/><path d="M3 20.5h18"/>',
'持仓':'<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M8 5V3.5h8V5M8 10h8M8 14h5"/>',
'AI':'<circle cx="12" cy="12" r="7.5"/><path d="M8.5 12h7M12 8.5v7M5 5l1.7 1.7M19 5l-1.7 1.7M5 19l1.7-1.7M19 19l-1.7-1.7"/>',
'设置':'<path d="M12 3.8a2 2 0 0 1 3.8.8l.1.7a7.5 7.5 0 0 1 1.7 1l.7-.3a2 2 0 0 1 2.6 2.6l-.3.7a7.5 7.5 0 0 1 1 1.7l.7.1a2 2 0 0 1 .8 3.8l-.7.1a7.5 7.5 0 0 1-1 1.7l.3.7a2 2 0 0 1-2.6 2.6l-.7-.3a7.5 7.5 0 0 1-1.7 1l-.1.7a2 2 0 0 1-3.8.8l-.1-.7a7.5 7.5 0 0 1-1.7-1l-.7.3a2 2 0 0 1-2.6-2.6l.3-.7a7.5 7.5 0 0 1-1-1.7l-.7-.1a2 2 0 0 1-.8-3.8l.7-.1a7.5 7.5 0 0 1 1-1.7l-.3-.7a2 2 0 0 1 2.6-2.6l.7.3a7.5 7.5 0 0 1 1.7-1z"/><circle cx="12" cy="12" r="2.8"/>'
};
function refreshDockIcons(){document.querySelectorAll('.tabbar .tab').forEach(function(tab){const label=(tab.querySelector('.lb')?.textContent||'').trim();const path=navIcons[label];if(!path)return;const box=tab.querySelector('.ico');if(!box)return;box.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true">'+path+'</svg>';});}
const sectorPaths={
chip:'<rect x="6" y="6" width="12" height="12" rx="2.2"/><path d="M9 3v3m3-3v3m3-3v3M9 18v3m3-3v3m3-3v3M3 9h3m-3 3h3m-3 3h3m12-6h3m-3 3h3m-3 3h3"/><path d="M10 10h4v4h-4z"/>',
server:'<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01M10 7h7M10 17h7"/>',
wave:'<path d="M3 13c3-7 6 7 9 0s6 7 9 0"/><path d="M3 7c3-7 6 7 9 0s6 7 9 0"/>',
robot:'<rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 3v4M8.5 12h.01M15.5 12h.01M9 16h6M3 12h2m14 0h2"/>',
sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5 7 7M17 17l1.5 1.5M18.5 5.5 17 7M7 17l-1.5 1.5"/>',
finance:'<path d="M4 19V9m5 10V5m5 14v-7m5 7V3"/><path d="M3 20.5h18"/>',
shield:'<path d="M12 3.5 19 6v5.3c0 4.4-2.7 7.7-7 9.2-4.3-1.5-7-4.8-7-9.2V6z"/><path d="m9 12 2 2 4-4"/>',
leaf:'<path d="M20 4C10 4 5 7.5 5 14c0 3.3 2.4 5.5 5.5 5.5C17 19.5 20 13 20 4z"/><path d="M4 20c3-5 6-7 11-9"/>',
default:'<circle cx="12" cy="12" r="8"/><path d="M8 12h8M12 8v8"/>'
};
function sectorPath(name){const n=String(name||'');if(/机器人|人形/.test(n))return sectorPaths.robot;if(/算力|服务器|计算|云/.test(n))return sectorPaths.server;if(/半导体|芯片|存储|PCB|电子|光刻|设备|材料|光模块|CPO/.test(n))return sectorPaths.chip;if(/通信|5G|传媒|软件|互联网|AI|人工智能/.test(n))return sectorPaths.wave;if(/新能源|光伏|锂电|储能|风电|环保/.test(n))return sectorPaths.sun;if(/银行|证券|金融|保险/.test(n))return sectorPaths.finance;if(/医药|医疗|生物|创新药/.test(n))return sectorPaths.shield;if(/消费|食品|白酒|农业/.test(n))return sectorPaths.leaf;return sectorPaths.default;}
function refreshSectorIcons(){document.querySelectorAll('.sc-pro .secicon').forEach(function(svg){const name=(svg.closest('.cn')?.textContent||'').trim();svg.innerHTML=sectorPath(name);svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');});}
function polish(){refreshDockIcons();refreshSectorIcons();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',polish);else polish();
new MutationObserver(function(){polish();}).observe(document.documentElement,{childList:true,subtree:true});
})();
</script>`;

async function injectUI(response){
  try{
    const type=response.headers.get('content-type')||'';
    if(!type.includes('text/html'))return response;
    const html=await response.text();
    if(html.includes('fund-ai-pro-ui-v5'))return new Response(html,{status:response.status,statusText:response.statusText,headers:response.headers});
    const patched=html.replace(/<\/body>/i,UI_PATCH+'\n</body>');
    const headers=new Headers(response.headers);headers.delete('content-length');headers.set('Cache-Control','no-cache, no-store, must-revalidate');
    return new Response(patched,{status:response.status,statusText:response.statusText,headers});
  }catch(e){return response;}
}

self.addEventListener('install',(event)=>{event.waitUntil(caches.open(CACHE_NAME).then((cache)=>cache.addAll(CACHE_URLS)).catch(()=>{}));self.skipWaiting();});
self.addEventListener('activate',(event)=>{event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((k)=>k!==CACHE_NAME).map((k)=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',(event)=>{
  const req=event.request;if(req.method!=='GET')return;const url=new URL(req.url);
  if(req.mode==='navigate'){
    event.respondWith(fetch(req).then(async(resp)=>{const patched=await injectUI(resp.clone());caches.open(CACHE_NAME).then((c)=>c.put('/',patched.clone())).catch(()=>{});return patched;}).catch(()=>caches.match('/index.html').then((r)=>r||caches.match('/'))));return;
  }
  if(url.pathname.startsWith('/api/')){event.respondWith(fetch(req).then((resp)=>{if(!resp.ok)throw new Error('api error');return resp;}).catch(()=>new Response(JSON.stringify({error:'offline',message:'当前离线，数据源不可用'}),{status:503,headers:{'Content-Type':'application/json'}})));return;}
  if(url.hostname.includes('eastmoney.com')||url.hostname.includes('tiantianfunds.com')||url.hostname.includes('gtimg.cn')||url.hostname.includes('awtmt.com')||url.hostname.includes('10jqka.com.cn')||url.hostname.includes('deepseek.com')||url.hostname.includes('wallstcn.com')||url.hostname.includes('cls.cn')||url.hostname.includes('jin10.com')){event.respondWith(fetch(req).then((resp)=>resp).catch(()=>new Response(JSON.stringify({error:'offline',message:'当前离线，数据源不可用'}),{status:503,headers:{'Content-Type':'application/json'}})));return;}
  if(url.origin===self.location.origin){event.respondWith(caches.match(req).then((cached)=>cached||fetch(req).then((resp)=>{const copy=resp.clone();caches.open(CACHE_NAME).then((c)=>c.put(req,copy)).catch(()=>{});return resp;}).catch(()=>cached)));}
});
