/* Fund AI Pro · UI + News Guard — safe interaction patch */
(function(){
'use strict';
function restoreTouch(){
 document.documentElement.style.setProperty('touch-action','pan-y','important');
 document.body.style.setProperty('touch-action','pan-y','important');
 document.body.style.setProperty('pointer-events','auto','important');
 document.querySelectorAll('button,a,input,select,textarea').forEach(el=>{el.style.setProperty('pointer-events','auto','important');el.style.setProperty('touch-action','manipulation','important');});
 const dock=document.querySelector('.tabbar');if(dock){dock.style.setProperty('pointer-events','auto','important');dock.style.setProperty('z-index','99999','important');}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',restoreTouch,{once:true});else restoreTouch();
setTimeout(restoreTouch,300);setTimeout(restoreTouch,1200);
const originalFetch=window.fetch.bind(window);let initialNewsWindow=Date.now()+20000,manualNewsUntil=0;
function isNewsRequest(input){try{const url=typeof input==='string'?input:(input&&input.url)||'';return /\/api\/news(?:\?|$)/i.test(url);}catch(e){return false;}}
window.fetch=function(input,init){if(isNewsRequest(input)&&Date.now()>initialNewsWindow&&Date.now()>manualNewsUntil)return Promise.reject(new Error('NEWS_AUTO_POLL_BLOCKED_MANUAL_REFRESH_ONLY'));return originalFetch(input,init);};
function markManual(){manualNewsUntil=Date.now()+15000;}
const refresh=document.getElementById('newsRefreshBtn');if(refresh){refresh.addEventListener('click',markManual,true);refresh.title='手动刷新新闻';refresh.setAttribute('aria-label','手动刷新新闻');}
const icons={home:'<svg viewBox="0 0 24 24"><path d="M3.5 10.8 12 3.8l8.5 7v8.4a1.8 1.8 0 0 1-1.8 1.8h-4.1v-6.2H9.4V21H5.3a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M8.4 10.5h7.2"/></svg>',market:'<svg viewBox="0 0 24 24"><path d="M4 18.5 9.2 13l3.1 2.5L20 7.5"/><path d="M15.8 7.5H20v4.2"/><path d="M4 21h16"/></svg>',funds:'<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16 14h2.5M7 6V4.5h10V6"/></svg>',combo:'<svg viewBox="0 0 24 24"><path d="M9.2 6.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6Z"/><path d="M14.8 6.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6Z"/></svg>',ai:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4"/><circle cx="12" cy="12" r="2.2"/></svg>'};
function applyIcons(){document.querySelectorAll('.tabbar .tab[data-page]').forEach(tab=>{const box=tab.querySelector('.ico'),key=tab.getAttribute('data-page');if(box&&icons[key])box.innerHTML=icons[key];});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',applyIcons,{once:true});else applyIcons();
})();