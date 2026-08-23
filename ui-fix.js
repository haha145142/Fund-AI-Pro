/* Fund AI Pro · UI enhancement only
 * IMPORTANT: this file must never intercept navigation, touch, or data fetches.
 */
(function(){
'use strict';

// 只替换 Dock 图标外观，不修改原页面的点击绑定、导航逻辑和数据请求。
const icons={
 home:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10.8 12 3.8l8.5 7v8.4a1.8 1.8 0 0 1-1.8 1.8h-4.1v-6.2H9.4V21H5.3a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M8.4 10.5h7.2"/></svg>',
 market:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18.5 9.2 13l3.1 2.5L20 7.5"/><path d="M15.8 7.5H20v4.2"/><path d="M4 21h16"/></svg>',
 funds:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16 14h2.5M7 6V4.5h10V6"/></svg>',
 combo:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 6.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6Z"/><path d="M14.8 6.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6Z"/></svg>',
 ai:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4"/><circle cx="12" cy="12" r="2.2"/></svg>'
};
function applyIcons(){
 document.querySelectorAll('.tabbar .tab[data-page]').forEach(tab=>{
   const box=tab.querySelector('.ico');
   const key=tab.getAttribute('data-page');
   if(box&&icons[key]) box.innerHTML=icons[key];
 });
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',applyIcons,{once:true});
else applyIcons();
})();