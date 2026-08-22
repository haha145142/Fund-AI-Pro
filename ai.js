// Cloudflare Pages Function: AI 代理
// 路径: /api/ai
// 作用: 安全代理 DeepSeek API，API Key 存放在 Cloudflare 环境变量，不暴露给前端
// 配置: 在 Cloudflare Pages 项目设置 → Environment Variables 中添加 DEEPSEEK_API_KEY

export async function onRequestPost(context) {
  const { request, env } = context;

  // CORS 头
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // 处理预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await request.json();
    const { messages, model, temperature, max_tokens } = body;

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'messages 字段必填且为数组' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 优先使用环境变量中的 Key（生产环境推荐）
    // 降级：允许前端传入 Key（个人本地使用，不推荐生产环境）
    const apiKey = env.DEEPSEEK_API_KEY || body.apiKey;
    if (!apiKey) {
      return new Response(JSON.stringify({
        error: '未配置 DEEPSEEK_API_KEY 环境变量，且前端未提供 apiKey',
        fallback: '建议在 Cloudflare Pages 环境变量中配置 DEEPSEEK_API_KEY',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages,
        stream: false,
        temperature: temperature ?? 0.5,
        max_tokens: max_tokens ?? 2000,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(JSON.stringify({ error: 'DeepSeek API 错误: ' + resp.status, detail: errText }), {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const data = await resp.json();
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: '服务器内部错误: ' + e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}

// 支持 GET 请求返回状态
export async function onRequestGet(context) {
  const { env } = context;
  const hasKey = !!(env.DEEPSEEK_API_KEY);
  return new Response(JSON.stringify({
    endpoint: '/api/ai',
    method: 'POST',
    configured: hasKey,
    message: hasKey ? 'DeepSeek API Key 已配置（环境变量）' : '未配置环境变量 DEEPSEEK_API_KEY，前端可降级为浏览器直连或规则版',
  }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
