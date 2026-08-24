const EM_BASE='https://push2.eastmoney.com';
const HEADERS={
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Referer':'https://quote.eastmoney.com/',
  'Accept':'application/json,text/plain,*/*'
};
const INDEXES=[
  {id:'sse',name:'上证指数',secid:'1.000001',tx:'s_sh000001'},
  {id:'sz',name:'深证成指',secid:'0.399001',tx:'s_sz399001'},
  {id:'cyb',name:'创业板指',secid:'0.399006',tx:'s_sz399006'},
  {id:'kc50',name:'科创50',secid:'1.000688',tx:'s_sh000688'}
];

async function getJson(url){
  const r=await fetch(url,{headers:HEADERS,cf:{cacheTtl:0,cacheEverything:false}});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function getText(url){
  const r=await fetch(url,{headers:{'User-Agent':HEADERS['User-Agent'],'Referer':'https://finance.qq.com/'},cf:{cacheTtl:0,cacheEverything:false}});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null}
function money(v){const n=num(v);return n==null?null:n/1e8}
function parseTencent(text,symbol){
  const m=text.match(new RegExp(`v_${symbol}="([^"]*)"`));
  if(!m)return null;
  const p=m[1].split('~');
  if(p.length<6)return null;
  return {name:p[1],price:num(p[3]),change:num(p[4]),pct:num(p[5]),amount10k:num(p[8])};
}

async function getIndexes(){
  const secids=INDEXES.map(x=>x.secid).join(',');
  const emUrl=`${EM_BASE}/api/qt/ulist.np/get?secids=${secids}&fields=f2,f3,f4,f12,f14&fltt=2&invt=2&_=${Date.now()}`;
  const txUrl=`https://qt.gtimg.cn/q=${INDEXES.map(x=>x.tx).join(',')}`;
  const [em,txText]=await Promise.all([getJson(emUrl),getText(txUrl)]);
  const diff=em?.data?.diff||[];
  const byCode=new Map(diff.map(x=>[String(x.f12),x]));
  const tx=Object.fromEntries(INDEXES.map(x=>[x.id,parseTencent(txText,x.tx)]));
  return INDEXES.map(x=>{
    const e=byCode.get(x.secid.split('.')[1]);
    const east=e?{price:num(e.f2),pct:num(e.f3),change:num(e.f4)}:null;
    const t=tx[x.id];
    const validated=!!(east&&t&&Math.abs(east.price-t.price)<=0.05&&Math.abs(east.pct-t.pct)<=0.03);
    return {id:x.id,name:x.name,price:east?.price??t?.price??null,pct:east?.pct??t?.pct??null,change:east?.change??t?.change??null,validated,source:east?'东方财富':'腾讯'};
  });
}

async function getSnapshot(secid){
  const fields='f43,f57,f58,f48,f62,f66,f72,f78,f84';
  const url=`${EM_BASE}/api/qt/stock/get?secid=${secid}&fields=${fields}&invt=2&fltt=2&_=${Date.now()}`;
  const j=await getJson(url);return j?.data||null;
}
async function getMarketTurnoverAndFlows(){
  const [sh,sz]=await Promise.all([getSnapshot('1.000001'),getSnapshot('0.399001')]);
  const rows=[sh,sz].filter(Boolean);
  let turnover=0,superLarge=0,large=0,medium=0,small=0;
  for(const r of rows){
    turnover+=money(r.f48)||0;
    superLarge+=money(r.f66)||0;
    large+=money(r.f72)||0;
    medium+=money(r.f78)||0;
    small+=money(r.f84)||0;
  }
  return {turnover,superLarge,large,medium,small,source:'东方财富指数快照'};
}

async function getSectorFlows(){
  const fields='f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f204,f205';
  const url=`${EM_BASE}/api/qt/clist/get?pn=1&pz=80&po=1&np=1&fltt=2&invt=2&ut=8dec03ba335b81bf4ebdf7b29ec27d15&fid=f62&fs=m:90+t:2+f:!50&fields=${fields}&_=${Date.now()}`;
  const j=await getJson(url);const rows=j?.data?.diff||[];
  const clean=rows.map(r=>({name:r.f14,code:r.f12,pct:num(r.f3),net:money(r.f62)})).filter(x=>x.name&&x.net!=null);
  return {inflow:[...clean].sort((a,b)=>b.net-a.net).slice(0,5),outflow:[...clean].sort((a,b)=>a.net-b.net).slice(0,5),source:'东方财富行业板块资金流'};
}

export async function onRequestGet(){
  const started=Date.now();
  const [indexes,market,sector]=await Promise.allSettled([getIndexes(),getMarketTurnoverAndFlows(),getSectorFlows()]);
  const data={
    updatedAt:new Date().toISOString(),latencyMs:Date.now()-started,
    indexes:indexes.status==='fulfilled'?indexes.value:[],
    market:market.status==='fulfilled'?market.value:null,
    sectors:sector.status==='fulfilled'?sector.value:null,
    validation:{indexSources:['东方财富','腾讯财经'],validatedCount:0}
  };
  data.validation.validatedCount=data.indexes.filter(x=>x.validated).length;
  const ok=data.indexes.length===4&&data.market!=null&&data.sectors!=null;
  return new Response(JSON.stringify({ok,...data}),{status:ok?200:206,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, no-cache, must-revalidate','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS'}});
}
export function onRequestOptions(){return new Response(null,{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS'}})}
