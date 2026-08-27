export async function onRequest() {
  try {
    // 1. 获取大盘指数（上证、深证、创业板等）
    const indexUrl = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f4,f12,f14&secids=1.000001,0.399001,0.399006,1.000688,1.000300';
    
    const indexResp = await fetch(indexUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://quote.eastmoney.com/'
      }
    });
    
    let indexes = [];
    if (indexResp.ok) {
      const text = await indexResp.text();
      const data = JSON.parse(text);
      indexes = (data.data?.diff || []).map(item => ({
        code: item.f12,
        name: item.f14,
        price: item.f2,
        changePercent: item.f3,
        changeAmount: item.f4
      }));
    }

    // 2. 获取市场概况（涨跌家数等）
    const marketUrl = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f4,f12,f14&secids=1.000001';
    
    const marketResp = await fetch(marketUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://quote.eastmoney.com/'
      }
    });

    let marketData = null;
    if (marketResp.ok) {
      const text = await marketResp.text();
      const data = JSON.parse(text);
      if (data.data?.diff?.[0]) {
        const d = data.data.diff[0];
        marketData = {
          code: d.f12,
          name: d.f14,
          price: d.f2,
          changePercent: d.f3,
          turnover: null
        };
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      updatedAt: new Date().toISOString(),
      indexes,
      market: marketData,
      sectors: []
    }), {
      headers: {'content-type': 'application/json;charset=utf-8'}
    });

  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: err.message,
      updatedAt: new Date().toISOString()
    }), {
      headers: {'content-type': 'application/json;charset=utf-8'}
    });
  }
}
