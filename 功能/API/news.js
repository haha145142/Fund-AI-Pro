// Cloudflare Pages Function: /api/news
// 新闻代理 V4
// 核心原则：
// 1. 绝不使用当前时间冒充新闻发布时间。
// 2. 新闻源没有可验证发布时间就丢弃。
// 3. 与 index.html 的 source 参数完整匹配：wscn / ths / jin10 / cls / yicai / em / emflash / sina / official。
// 4. 所有来源统一输出 title / summary / time / timestamp / source / url。
// 5. _=Date.now() 只用于接口防缓存，绝不参与新闻发布时间。

function toTimestamp(...values){
  for(const raw of values){
    if(raw===null||raw===undefined||raw==='') continue;

    if(typeof raw==='number'){
      if(!isFinite(raw)||raw<=0) continue;
      return raw<1e12 ? raw*1000 : raw;
    }

    const s=String(raw).trim();
    if(!s) continue;

    if(/^\d{10}$/.test(s)) return parseInt(s,10)*1000;
    if(/^\d{13}$/.test(s)) return parseInt(s,10);

    if(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)){
      const d=new Date(s.replace(' ','T'));
      if(!isNaN(d.getTime())) return d.getTime();
    }

    const md=s.match(/^(\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if(md){
      const now=new Date();
      const d=new Date(
        now.getFullYear(),
        Number(md[1])-1,
        Number(md[2]),
        Number(md[3]),
        Number(md[4]),0,0
      );
      if(!isNaN(d.getTime())){
        if(d.getTime()>Date.now()+5*60*1000) d.setFullYear(d.getFullYear()-1);
        return d.getTime();
      }
    }

    const today=s.match(/今天[ T]*(\d{1,2}):(\d{2})/);
    if(today){
      const now=new Date();
      return new Date(
        now.getFullYear(),now.getMonth(),now.getDate(),
        Number(today[1]),Number(today[2]),0,0
      ).getTime();
    }

    const mins=s.match(/(\d+)\s*分钟前/);
    if(mins) return Date.now()-Number(mins[1])*60000;

    const hours=s.match(/(\d+)\s*小时前/);
    if(hours) return Date.now()-Number(hours[1])*3600000;

    const hm=s.match(/^(\d{1,2}):(\d{2})$/);
    if(hm){
      const now=new Date();
      const d=new Date(
        now.getFullYear(),now.getMonth(),now.getDate(),
        Number(hm[1]),Number(hm[2]),0,0
      );
      if(d.getTime()>Date.now()+5*60*1000) d.setDate(d.getDate()-1);
      return d.getTime();
    }
  }
  return 0;
}

function formatTime(ts){
  if(!ts) return '';
  const d=new Date(ts);
  const now=new Date();
  const same=d.toDateString()===now.toDateString();
  const hh=String(d.getHours()).padStart(2,'0');
  const mm=String(d.getMinutes()).padStart(2,'0');
  if(same) return `${hh}:${mm}`;
  const y=new Date(now);
  y.setDate(now.getDate()-1);
  if(d.toDateString()===y.toDateString()) return `昨天 ${hh}:${mm}`;
  return `${d.getMonth()+1}/${d.getDate()} ${hh}:${mm}`;
}

function clean(v){
  return String(v??'').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
}

function pushResult(results, item){
  if(!item.title || !item.timestamp) return;
  results.push({
    title:clean(item.title),
    summary:clean(item.summary||''),
    time:formatTime(item.timestamp),
    timestamp:item.timestamp,
    source:item.source,
    url:item.url||''
  });
}

async function fetchJson(url, options={}){
  const r=await fetch(url,{
    cache:'no-store',
    ...options
  });
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r;
}

export async function onRequestGet(context){
  const {request}=context;
  const url=new URL(request.url);
  const source=url.searchParams.get('source')||'all';
  const limit=Math.min(Math.max(parseInt(url.searchParams.get('limit')||'30',10)||30,1),100);

  const corsHeaders={
    'Access-Control-Allow-Origin':'*',
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store, no-cache, must-revalidate, max-age=0'
  };

  const commonHeaders={
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept':'application/json, text/plain, */*',
    'Accept-Language':'zh-CN,zh;q=0.9',
    'Cache-Control':'no-cache'
  };

  const results=[];

  // 华尔街见闻
  if(source==='all'||source==='wscn'){
    try{
      const u='https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&client=pc&limit='+limit;
      const j=await (await fetchJson(u,{headers:commonHeaders})).json();
      const items=j?.data?.items||j?.data?.day_items||[];
      for(const x of items){
        const ts=toTimestamp(
          x.display_time,x.time,x.publish_time,x.ctime,
          x.resource?.display_time,x.resource?.time
        );
        pushResult(results,{
          title:x.title||x.resource?.title,
          summary:x.summary||x.brief||x.content_text||x.resource?.content_text,
          timestamp:ts,source:'华尔街见闻',
          url:x.uri||x.resource?.uri||''
        });
      }
    }catch(e){}
  }

  // 同花顺
  if(source==='all'||source==='ths'){
    try{
      const u='https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&pagesize='+limit+'&track=website&_='+Date.now();
      const j=await (await fetchJson(u,{headers:commonHeaders})).json();
      const list=j?.data?.list||[];
      for(const x of list){
        const ts=toTimestamp(
          x.ctime,x.time,x.showTime,x.publish_time,x.publishTime,
          x.pub_time,x.datetime,x.create_time,x.createtime
        );
        pushResult(results,{
          title:x.title,
          summary:x.digest||x.summary||x.content,
          timestamp:ts,source:'同花顺',
          url:x.url||x.articleUrl||''
        });
      }
    }catch(e){}
  }

  // 金十数据
  if(source==='all'||source==='jin10'){
    try{
      const urls=[
        'https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1&_='+Date.now(),
        'https://flash-api.jin10.com/get_flash_list?channel=-8200&_='+Date.now()
      ];
      for(const u of urls){
        try{
          const j=await (await fetchJson(u,{headers:{...commonHeaders,Referer:'https://www.jin10.com/'}})).json();
          const list=j?.data||j?.list||[];
          if(!Array.isArray(list)||!list.length) continue;
          for(const x of list){
            const content=x.data?.content||x.content||x.title||'';
            const ts=toTimestamp(x.data?.time,x.time,x.ctime,x.timestamp);
            pushResult(results,{
              title:clean(content).slice(0,80),
              summary:clean(content).slice(0,220),
              timestamp:ts,source:'金十数据',
              url:x.data?.link||x.url||''
            });
          }
          break;
        }catch(e){}
      }
    }catch(e){}
  }

  // 财联社
  if(source==='all'||source==='cls'){
    try{
      const urls=[
        'https://www.cls.cn/api/sw?app=CailianpressWeb&os=web&sv=8.4.6',
        'https://www.cls.cn/nodeapi/telegraphList?app=CailianpressWeb&os=web&sv=8.4.6&lastTime=&rn='+limit
      ];
      for(const u of urls){
        try{
          const j=await (await fetchJson(u,{headers:{...commonHeaders,Referer:'https://www.cls.cn/'}})).json();
          const list=j?.data?.roll_data||j?.data||[];
          if(!Array.isArray(list)||!list.length) continue;
          for(const x of list){
            const ts=toTimestamp(x.ctime,x.time,x.showTime,x.publish_time,x.pubTime);
            pushResult(results,{
              title:x.title||(x.content||'').slice(0,50),
              summary:x.brief||x.content||x.description,
              timestamp:ts,source:'财联社',
              url:x.shareurl||x.url||''
            });
          }
          break;
        }catch(e){}
      }
    }catch(e){}
  }

  // 第一财经
  if(source==='all'||source==='yicai'){
    try{
      const u='https://www.yicai.com/api/ajax/getlatestnews?page=1&pagesize='+Math.min(limit,30);
      const j=await (await fetchJson(u,{headers:commonHeaders})).json();
      const list=j?.data?.list||j?.data||j?.list||[];
      if(Array.isArray(list)){
        for(const x of list){
          const ts=toTimestamp(x.createtime,x.createTime,x.time,x.ctime,x.showTime,x.publish_time);
          pushResult(results,{
            title:x.title||x.name,
            summary:x.summary||x.brief||x.content,
            timestamp:ts,source:'第一财经',
            url:x.url||x.link||''
          });
        }
      }
    }catch(e){}
  }

  // 东方财富搜索
  if(source==='all'||source==='em'){
    try{
      const param={
        uid:'',
        keyword:'科技 半导体 算力 PCB CPO 基金 ETF 公募',
        type:['cmsArticleWebOld'],
        client:'web',
        clientType:'web',
        clientVersion:'curr',
        param:{
          cmsArticleWebOld:{
            searchScope:'default',sort:'default',
            pageIndex:1,pageSize:limit,preTag:'',postTag:''
          }
        }
      };
      const u='https://search-api-web.eastmoney.com/search/jsonp?cb=jQueryCallback&param='+encodeURIComponent(JSON.stringify(param));
      const text=await (await fetchJson(u,{headers:{...commonHeaders,Referer:'https://so.eastmoney.com/'}})).text();
      const m=text.match(/jQueryCallback\(([\s\S]+)\)\s*;?\s*$/);
      const j=m?JSON.parse(m[1]):null;
      const arr=j?.result?.cmsArticleWebOld||j?.data?.cmsArticleWebOld||[];
      for(const x of arr){
        const ts=toTimestamp(x.ctime,x.showTime,x.time,x.publish_time,x.pubTime);
        pushResult(results,{
          title:x.title||x.brief,
          summary:x.content||x.brief,
          timestamp:ts,source:'东方财富',
          url:x.url||x.articleUrl||''
        });
      }
    }catch(e){}
  }

  // 东方财富 7x24
  if(source==='all'||source==='emflash'){
    try{
      const u='https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize='+limit+'&type=0&_='+Date.now();
      const j=await (await fetchJson(u,{headers:commonHeaders})).json();
      const list=j?.data?.list||j?.data||[];
      if(Array.isArray(list)){
        for(const x of list){
          const ts=toTimestamp(x.showTime,x.ctime,x.create_time,x.time,x.publish_time);
          pushResult(results,{
            title:x.title||x.content,
            summary:x.digest||x.summary||x.content,
            timestamp:ts,source:'东方财富',
            url:x.url_unique||x.url||''
          });
        }
      }
    }catch(e){}
  }

  // 新浪财经
  if(source==='all'||source==='sina'){
    try{
      const u='https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num='+limit+'&page=1&_='+Date.now();
      const j=await (await fetchJson(u,{headers:commonHeaders})).json();
      const list=j?.data||[];
      if(Array.isArray(list)){
        for(const x of list){
          const ts=toTimestamp(x.ctime,x.create_time,x.showTime,x.time,x.publish_time);
          pushResult(results,{
            title:x.title,
            summary:x.intro||x.summary,
            timestamp:ts,source:'新浪财经',
            url:x.url||''
          });
        }
      }
    }catch(e){}
  }

  // 官方/政策
  if(source==='all'||source==='official'){
    try{
      const u='https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&page_index=1&page_size='+Math.min(limit,30);
      const j=await (await fetchJson(u,{headers:commonHeaders})).json();
      const list=j?.data?.list||[];
      if(Array.isArray(list)){
        for(const x of list){
          const ts=toTimestamp(x.showTime,x.ctime,x.create_time,x.time,x.publish_time);
          pushResult(results,{
            title:x.title,
            summary:x.digest||x.summary||x.content,
            timestamp:ts,source:'官方',
            url:x.url_unique||x.url||''
          });
        }
      }
    }catch(e){}
  }

  // 同一标题跨来源去重：保留时间更可信、来源更多的一条
  const map=new Map();
  for(const item of results){
    const key=clean(item.title).toLowerCase().replace(/\s+/g,'').slice(0,100);
    if(!key) continue;
    const old=map.get(key);
    if(!old || item.timestamp>old.timestamp) map.set(key,item);
  }

  const finalItems=[...map.values()]
    .filter(x=>x.timestamp>0)
    .sort((a,b)=>b.timestamp-a.timestamp)
    .slice(0,Math.min(limit*2,100));

  return new Response(JSON.stringify({
    items:finalItems,
    count:finalItems.length,
    serverTime:new Date().toISOString()
  }),{headers:corsHeaders});
}
