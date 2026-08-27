// Cloudflare Pages Function · /api/ai/analyze
// GET  → 返回规则版今日判断（保证前端不卡空）
// POST → 优先 DeepSeek，失败降级规则版

export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json;charset=utf-8',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }

  // 尝试获取市场快照，拿不到也不影响降级
  let market = null;
  try {
    const r = await fetch(new URL('/api/market', request.url), { headers: { 'User-Agent': 'Fund-AI-Pro' } });
    if (r.ok) { const j = await r.json(); market = j.indexes || []; }
  } catch (e) {}

  // ===== 规则版生成（同步，永不卡） =====
  function ruleVersion() {
    const upCount = (market || []).filter(i => (i.changePercent || 0) > 0).length;
    const downCount = (market || []).filter(i => (i.changePercent || 0) < 0).length;
    const avg = market && market.length
      ? market.reduce((s, i) => s + (i.changePercent || 0), 0) / market.length
      : 0;
    const sentiment = avg > 0.5 ? '偏多' : avg < -0.5 ? '偏空' : '震荡';
    const direction = avg > 0 ? '上涨' : '下跌';

    return {
      summary: `今日大盘整体${direction}，${sentiment}。上涨 ${upCount} 个 / 下跌 ${downCount} 个指数。`,
      advice: avg > 0.5
        ? '可关注强势板块，但避免追高；仓位中等，设好止盈。'
        : avg < -0.5
        ? '控制仓位为主，等待企稳信号；勿盲目抄底。'
        : '市场震荡，适合观望或小仓位高抛低吸。',
      risk: avg > 1 ? '中高' : avg < -1 ? '中高' : '中等',
      data: { upCount, downCount, avg: +avg.toFixed(2), sentiment },
    };
  }

  // ===== POST：调 DeepSeek =====
  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const apiKey = env.DEEPSEEK_API_KEY || body.apiKey;
    const userMsg = (body.messages || []).find(m => m.role === 'user')?.content
      || body.prompt
      || '请基于当前市场数据，给出今日 A 股基金投资建议。';

    if (apiKey) {
      try {
        const resp = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          body: JSON.stringify({
            model: body.model || 'deepseek-chat',
            messages: [
              { role: 'system', content: '你是 Fund AI Pro 基金投资助手，输出简洁专业的今日市场判断与仓位建议，中文。' },
              { role: 'user', content: userMsg },
            ],
            temperature: 0.5,
            max_tokens: 600,
          }),
        });
        if (resp.ok) {
          const j = await resp.json();
          const text = j.choices?.[0]?.message?.content || '';
          const rule = ruleVersion();
          return new Response(JSON.stringify({
            code: 0,
            source: 'deepseek',
            summary: text.split('\n')[0] || rule.summary,
            advice: text || rule.advice,
            risk: rule.risk,
            data: rule.data,
          }), { headers: cors });
        }
      } catch (e) {}
    }

    // 无 Key 或调用失败 → 规则降级
    const rule = ruleVersion();
    return new Response(JSON.stringify({ code: 0, source: 'rule', ...rule }), { headers: cors });
  }

  // ===== GET：直接返回规则版 =====
  const rule = ruleVersion();
  return new Response(JSON.stringify({ code: 0, source: 'rule', ...rule }), { headers: cors });
}
