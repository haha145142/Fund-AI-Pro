/* Fund AI Pro · UI + News Guard */
(function(){
  'use strict';

  // ---------- 0. 移动端交互保险：UI 优化不能覆盖原有点击/滑动 ----------
  // 某些 Android WebView 对大量 fixed/backdrop-filter 图层会产生“视觉正常但触摸被吃掉”的情况。
  function restoreTouch(){
    document.documentElement.style.setProperty('touch-action','pan-y','important');
    document.body.style.setProperty('touch-action','pan-y','important');
    document.body.style.setProperty('pointer-events','auto','important');
    document.querySelectorAll('button,a,input,select,textarea,.tabbar,.tabbar .tab,.page').forEach(el=>{
      el.style.setProperty('pointer-events','auto','important');
      el.style.setProperty('touch-action','manipulation','important');
    });
    const dock=document.querySelector('.tabbar');
    if(dock){
      dock.style.setProperty('pointer-events','auto','important');
      dock.style.setProperty('z-index','99999','important');
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',restoreTouch,{once:true});
  else restoreTouch();
  setTimeout(restoreTouch,300);
  setTimeout(restoreTouch,1200);

  // ---------- 1. 新闻：只允许首次加载 + 用户手动点击后的请求 ----------
  const originalFetch = window.fetch.bind(window);
  let initialNewsWindow = Date.now() + 20000;
  let manualNewsUntil = 0;

  function isNewsRequest(input){
    try{
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      return /\/api\/news(?:\?|$)/i.test(url);
    }catch(e){ return false; }
  }

  window.fetch = function(input, init){
    if(isNewsRequest(input)){
      const now = Date.now();
      if(now > initialNewsWindow && now > manualNewsUntil){
        return Promise.reject(new Error('NEWS_AUTO_POLL_BLOCKED_MANUAL_REFRESH_ONLY'));
      }
    }
    return originalFetch(input, init);
  };

  function markManualNewsRefresh(){
    manualNewsUntil = Date.now() + 15000;
    document.documentElement.classList.add('manual-news-refresh');
    setTimeout(()=>document.documentElement.classList.remove('manual-news-refresh'),16000);
  }

  const refresh = document.getElementById('newsRefreshBtn');
  if(refresh){
    refresh.addEventListener('click', markManualNewsRefresh, true);
    refresh.title = '手动刷新新闻（不会后台自动轮询）';
    refresh.setAttribute('aria-label','手动刷新新闻');
  }

  // ---------- 2. 底部图标：更简洁的高级线性图标 ----------
  const icons = {
    home:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10.8 12 3.8l8.5 7v8.4a1.8 1.8 0 0 1-1.8 1.8h-4.1v-6.2H9.4V21H5.3a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M8.4 10.5h7.2"/></svg>',
    market:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18.5 9.2 13l3.1 2.5L20 7.5"/><path d="M15.8 7.5H20v4.2"/><path d="M4 21h16"/></svg>',
    funds:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16 14h2.5"/><path d="M7 6V4.5h10V6"/></svg>',
    combo:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 6.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6Z"/><path d="M14.8 6.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6Z"/></svg>',
    ai:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4"/><circle cx="12" cy="12" r="2.2"/></svg>'
  };
  document.querySelectorAll('.tabbar .tab[data-page]').forEach(tab=>{
    const key=tab.getAttribute('data-page');
    const box=tab.querySelector('.ico');
    if(box && icons[key]) box.innerHTML=icons[key];
  });

  // ---------- 3. 新闻 AI 解读：事实与推断分离，禁止凭空指定行业 ----------
  function textOf(el){ return (el && el.textContent || '').replace(/\s+/g,' ').trim(); }
  function getTitle(card){ return textOf(card.querySelector('.news-flat-title,.news-event-title,.news-title')); }
  function getSummary(card){ return textOf(card.querySelector('.news-summary')); }

  function groundedExplain(title, summary){
    const raw=(title+' '+summary).trim();
    if(/王毅|外交部长|外交部|会见|会谈|访问|首相|总统|外长|大使/.test(raw) && !/政策|规划|补贴|支持|产业|行业|措施|资金/.test(raw)){
      return {lead:'这是一条外交与国际关系消息，核心是双方会见、交流或访问本身。',key:'新闻目前能确认的是外交互动及公开表态，没有看到具体产业政策或资金安排。',money:'对A股的直接影响暂不明确，不能仅凭“会见”判断哪个行业会涨。',action:'先看后续有没有正式政策、贸易措施或经济合作文件落地，再判断市场影响。'};
    }
    if(/外交|国际关系|会见|会谈/.test(raw) && !/股|行业|板块|基金|政策|制裁|关税|能源|油价|黄金/.test(raw)){
      return {lead:'这条新闻主要讲国际事务本身，不是直接的产业利好或利空。',key:'当前摘要没有给出明确的行业政策、企业订单或资金变化。',money:'对国内股票和基金的直接影响有限，暂时无法从这条消息推出具体板块。',action:'继续等后续正式文件、经济合作内容或市场实际反应，不要自行脑补行业利好。'};
    }
    if(/政策|规划|补贴|专项|支持|措施|行动方案|产业政策/.test(raw)){
      const sectorMatch=raw.match(/(?:支持|促进|推动|布局|发展|扶持)[^。；，,]{0,20}(?:行业|产业|领域|板块)/);
      const sector=sectorMatch ? sectorMatch[0].replace(/^(支持|促进|推动|布局|发展|扶持)/,'') : '';
      return {lead:'这条新闻的核心是政策/措施本身，先以原文明确写出的内容为准。',key:sector?`新闻明确提到了“${sector}”，这才是可以继续观察的方向。`:'新闻提到了政策，但当前摘要没有明确点名具体行业。',money:'政策是否真正影响股价，还要看后续落地力度、企业订单和资金是否跟上。',action:sector?`先观察${sector}相关标的的实际反应，不因为一条政策标题就追高。`:'先看政策全文和后续落地情况，暂时不要强行给行业贴标签。'};
    }
    const tech=raw.match(/半导体|芯片|算力|CPO|光模块|AI|人工智能|机器人|存储芯片|PCB|通信|新能源|光伏|锂电|储能/ig);
    if(tech){
      const sector=[...new Set(tech.map(x=>x.toUpperCase()==='AI'?'AI':x))].slice(0,3).join('、');
      return {lead:`新闻明确涉及${sector}，重点看消息本身有没有带来订单、技术或产业进展。`,key:'真正能影响股价的不是“科技”两个字，而是订单、业绩、产能、技术突破等可验证信息。',money:'相关板块可能受到情绪带动，但是否持续要看资金和实际业绩验证。',action:'有相关基金先看仓位和板块强弱；没有持仓不要因为标题热就直接追高。'};
    }
    return {lead:'先看新闻本身：当前这条消息暂时没有足够证据判断具体行业方向。',key:'解读只引用标题和摘要中明确出现的事实，不把“市场可能关注”写成已经发生的事实。',money:'对持仓的影响需要结合实际价格、资金和后续公告确认。',action:'先观察，不根据一条新闻强行追涨或减仓。'};
  }

  function renderGrounded(card){
    const title=getTitle(card), summary=getSummary(card);
    const ai=card.querySelector('.news-ai');
    if(!ai || !title) return;
    const current=textOf(ai);
    const mismatch=/国家出政策|说的那个行业|哪个行业好|银行就给|政策点名的行业|政策支持.*行业/.test(current)&&!/政策|规划|补贴|支持|措施|专项|产业|行业/.test(title+' '+summary);
    const diplomacyMismatch=/王毅|外交部长|会见|会谈|首相|总统/.test(title)&&/国家出政策|哪个行业|银行就给|股票就涨/.test(current);
    if(!mismatch&&!diplomacyMismatch)return;
    const e=groundedExplain(title,summary);
    ai.innerHTML=`<div class="ai-line">🤖 ${e.lead}</div><div class="ai-detail-line">📌 <b>关键信息：</b>${e.key}</div><div class="ai-detail-line">💰 <b>对钱包：</b>${e.money}</div><div class="ai-detail-line">👉 <b>该咋办：</b>${e.action}</div>`;
    ai.dataset.groundedFix='1';
  }
  function scanNews(){document.querySelectorAll('#newsList .news-flat-card,#newsList .news-event').forEach(renderGrounded);}
  const newsList=document.getElementById('newsList');
  if(newsList){const mo=new MutationObserver(()=>scanNews());mo.observe(newsList,{subtree:true,childList:true,characterData:true});setTimeout(scanNews,80);setTimeout(scanNews,600);setTimeout(scanNews,1800);}

  // ---------- 4. 科技板块高级流动效果统一 ----------
  document.querySelectorAll('.glass,.fund-card,.band-item,.wc,.combo-glass-card,.news-flat-card,.ai-evidence-step').forEach(el=>el.classList.add('liquid-surface'));

  // ---------- 5. 防止 UI 注入层/伪元素吞掉点击 ----------
  document.addEventListener('click',function(e){
    const target=e.target && e.target.closest ? e.target.closest('button,a,input,select,textarea,.tabbar .tab') : null;
    if(target){
      target.style.pointerEvents='auto';
      target.style.touchAction='manipulation';
    }
  },true);

  const evidence=document.getElementById('newsEvidence');
  if(evidence){
    const observer=new MutationObserver(()=>{
      const txt=textOf(evidence);
      if(txt && !/手动刷新/.test(txt) && /实时资讯已连接|资讯已连接/.test(txt)) evidence.setAttribute('data-refresh-mode','manual');
    });
    observer.observe(evidence,{childList:true,characterData:true,subtree:true});
  }
})();
