// Cloudflare Pages Function: /api/news
// 新闻代理 V3
// 核心原则：绝不使用当前时间冒充新闻发布时间。
// 如果新闻源没有提供可验证的发布时间，就不返回该条新闻。

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

    // YYYY-MM-DD HH:mm:ss / ISO
    if(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)){
      const d=new Date(s.replace(' ','T'));
      if(!isNaN(d.getTime())) return d.getTime();
    }

    // MM-DD HH:mm / MM/DD HH:mm
    const m=s.match(/^(\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if(m){
      const now=new Date();
      const d=new Date(
        now.getFullYear(),
        Number(m[1])-1,
        Number(m[2]),
        Number(m[3]),
        Number(m[4]),0,0
      );
      if(!isNaN(d.getTime())){
        if(d.getTime()>Date.now()+5*60*1000) d.setFullYear(d.getFullYear()-1);
        return d.getTime();
      }
    }

    // “今天 14:30”
    const today=s.match(/今天[ T]*(\d{1,2}):(\d{2})/);
    if(today){
      const now=new Date();
      return new Date(
        now.getFullYear(),now.getMonth(),now.getDate(),
        Number(today[1]),Number(today[2]),0,0
      ).getTime();
    }

    // 相对时间：这些是明确的真实相对时间
    const mins=s.match(/(\d+)\s*分钟前/);
    if(mins) return Date.now()-Number(mins[1])*60000;

    const hours=s.match(/(\d+)\s*小时前/);
    if(hours) return Date.now()-Number(hours[1])*3600000;

    // 单独 HH:mm
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
      const r=await fetch(u,{headers:commonHeaders,cache:'no-store'});
      if(r.ok){
        const j=await r.json();
        const items=j?.data?.items||j?.data?.day_items||[];
        for(const x of items){
          const ts=toTimestamp(
            x.display_time,x.time,x.publish_time,x.ctime,
            x.resource?.display_time,x.resource?.time
          );
          if(!ts) continue;
          results.push({
            title:x.title||x.resource?.title||'',
            summary:x.summary||x.brief||x.content_text||x.resource?.content_text||'',
            time:formatTime(ts),
            timestamp:ts,
            source:'华尔街见闻',
            url:x.uri||x.resource?.uri||''
          });
        }
      }
    }catch(e){}
  }

  // 同花顺：重点修复这里
  if(source==='all'||source==='ths'){
    try{
      const u='https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&pagesize='+limit+'&track=website&_='+Date.now();
      const r=await fetch(u,{headers:commonHeaders,cache:'no-store'});
      if(r.ok){
        const j=await r.json();
        const list=j?.data?.list||[];
        for(const x of list){
          // 同花顺不同版本接口字段可能不同，按优先级逐个取真实发布时间。
          const ts=toTimestamp(
            x.ctime,
            x.time,
            x.showTime,
            x.publish_time,
            x.publishTime,
            x.pub_time,
            x.datetime,
            x.create_time,
            x.createtime
          );

          // 关键：没有真实时间就跳过，绝不 Date.now()
          if(!ts) continue;

          results.push({
            title:x.title||'',
            summary:x.digest||x.summary||x.content||'',
            time:formatTime(ts),
            timestamp:ts,
            source:'同花顺',
            url:x.url||x.articleUrl||''
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
            searchScope:'default',
            sort:'default',
            pageIndex:1,
            pageSize:limit,
            preTag:'',
            postTag:''
          }
        }
      };
      const u='https://search-api-web.eastmoney.com/search/jsonp?cb=jQueryCallback&param='+encodeURIComponent(JSON.stringify(param));
      const r=await fetch(u,{headers:{...commonHeaders,Referer:'https://so.eastmoney.com/'},cache:'no-store'});
      if(r.ok){
        const text=await r.text();
        const m=text.match(/jQueryCallback\(([\s\S]+)\)\s*;?\s*$/);
        const j=m?JSON.parse(m[1]):null;
        const arr=j?.result?.cmsArticleWebOld||j?.data?.cmsArticleWebOld||[];
        for(const x of arr){
          const ts=toTimestamp(x.ctime,x.showTime,x.time,x.publish_time,x.pubTime);
          if(!ts) continue;
          results.push({
            title:x.title||x.brief||'',
            summary:x.content||x.brief||'',
            time:formatTime(ts),
            timestamp:ts,
            source:'东方财富',
            url:x.url||x.articleUrl||''
          });
        }
      }
    }catch(e){}
  }

  results.sort((a,b)=>b.timestamp-a.timestamp);

  return new Response(JSON.stringify({
    items:results,
    count:results.length,
    serverTime:new Date().toISOString()
  }),{headers:corsHeaders});
}
