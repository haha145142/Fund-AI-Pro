// Cloudflare Pages Function · /api/ai/analyze
// AI 结论「交叉验证」：DeepSeek（主）→ 规则引擎（备，永远可用）
// 策略：有 Key 先调 DeepSeek；任一异常 → 自动降级规则版结构化结论
//       返回 { code, source:'deepseek'|'rule', data, fallback? }
// Key 存服务端环境变量，浏览器无需填写（"其余交给 DeepSeek"）

import { fetchWithTimeout, UA, jsonResp } from '../_lib.js';

const SYSTEM = '你是专业基金投资助手。基于结构化市场快照给出审慎、非投资建议的判断，输出严格 JSON：{summary,risks:[],tips:[],keyQuote}。';

function buildPrompt(type, snapshot) {
  return `请基于以下市场快照给出今日判断（JSON：{summary,risks,tips,keyQuote}）：\n类型=${type}\n快照=${JSON.stringify(snapshot || {})}`;
}

function ruleSummary(s = {}) {
  const m = s.marketState?.label || '震荡';
  return `今日市场${m}，${s.action?.title || '建议持有为主'}：${s.action?.desc || ''}（规则版结论，未调用大模型）`;
}

// 主：DeepSeek
async function callDeepSeek(apiKey, type, snapshot) {
  const upstream = await fetchWithTimeout(
    'https://api.deepseek.com/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildPrompt(type, snapshot) },
        ],
        response_format: { type: 'json_object' },
      }),
    },
    30_000
  );
  if (!upstream.ok) throw new Error('DeepSeek HTTP ' + upstream.status);
  const j = await upstream.json();
  const text = j?.choices?.[0]?.message?.content || '';
  let data; try { data = JSON.parse(text); } catch (e) { data = { summary: text }; }
  return data;
}

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch (e) { /* allow empty */ }
  const { type = 'daily', snapshot = {} } = body;
  const apiKey = env?.DEEPSEEK_API_KEY;

  // 无 Key → 直接规则版（不报错，离线可用）
  if (!apiKey) {
    return jsonResp({ code: 0, source: 'rule', fallback: true, data: { summary: ruleSummary(snapshot) } });
  }

  try {
    const data = await callDeepSeek(apiKey, type, snapshot);
    return jsonResp({ code: 0, source: 'deepseek', data });
  } catch (e) {
    // DeepSeek 失败 → 自动降级规则版（交叉容灾）
    return jsonResp({
      code: 0,
      source: 'rule',
      fallback: true,
      reason: e?.message || String(e),
      data: { summary: ruleSummary(snapshot) },
    });
  }
}

// GET：前端探测服务端是否配了 Key
export async function onRequestGet({ env }) {
  return jsonResp({ code: 0, configured: Boolean(env?.DEEPSEEK_API_KEY) });
}
