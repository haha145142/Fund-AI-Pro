/* ============================================================
 * ai-decision-render.js  (Cloudflare Pages 静态托管直接生效)
 * 对接 index.html 真实 DOM ID：
 *   #aiCockpit        今日投资结论（驾驶舱）
 *   #sentimentThermo   市场温度计
 *   #marketScan        市场扫描（最强/最弱/资金）
 *   #moneyBehavior     资金行为 AI 识别（机构/游资/散户）
 *   #attributionCard   涨跌归因
 *   #cockpitDeepBtn    "让 DeepSeek 深度分析"
 *   #indexGrid2x2      四大指数 2x2
 *   .fund-card         持仓卡片（追加诊断条）
 * 依赖：window.DecisionEngine
 * 设计：失败安全，缺节点/缺数据不报错
 * ============================================================ */
(function (global) {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return document.querySelectorAll(sel); };

  function num(v) { var n = parseFloat(v); return Number.isFinite(n) ? n : null; }
  function fmtPct(v) { var n = num(v); if (n == null) return '—'; return (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function clsOf(v) { var n = num(v); if (n == null) return ''; return n > 0 ? 'up' : (n < 0 ? 'down' : ''); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function setText(sel, text) { var el = $(sel); if (el) el.textContent = text; }
  function setHTML(sel, html) { var el = $(sel); if (el) el.innerHTML = html; }

  // ---------- 指数卡片（四大指数 2x2） ----------
  function renderIndexGrid(market) {
    var list = (market && market.indexes) || [];
    list.forEach(function (i) {
      var code = (i.code || i.key || '').replace(/[^0-9]/g, ''); // sh000001 -> 000001
      var card = document.getElementById('idxCard_' + code) || document.getElementById('idxCard_' + i.code);
      if (!card) return;
      var priceEl = card.querySelector('.index-card-price') || document.getElementById('idxPrice_' + code);
      var diffEl = card.querySelector('.index-card-bottom') || document.getElementById('idxDiff_' + code);
      if (priceEl) { priceEl.textContent = (i.price == null ? '—' : num(i.price).toFixed(2)); }
      if (diffEl) {
        diffEl.className = 'index-card-bottom ' + clsOf(i.changePercent);
        diffEl.innerHTML = '<span class="' + (clsOf(i.changePercent) || 'flat') + '">' + fmtPct(i.changePercent) + '</span>' +
                           '<span class="flat">' + (i.changeAmount == null ? '—' : (num(i.changeAmount) > 0 ? '+' : '') + num(i.changeAmount).toFixed(2)) + '</span>';
      }
    });
  }

  // ---------- 今日投资结论（驾驶舱） ----------
  function renderCockpitCard(analyze, market) {
    var el = $('#aiCockpit');
    if (!el) return;

    var summary = analyze && analyze.summary;
    var advice = analyze && analyze.advice;
    var risk = analyze && analyze.risk;
    var data = (analyze && analyze.data) || {};

    // 后端无 summary 时用 market 兜底
    if (!summary && market) {
      summary = '今日大盘整体' + (market.direction || '震荡') + '，' + (market.sentiment || '中性') +
        '。上涨 ' + (market.upCount || 0) + ' 个 / 下跌 ' + (market.downCount || 0) + ' 个指数。';
      advice = advice || '关注强势板块，避免追高；仓位适中，设好止盈止损。';
      risk = risk || ((market.avg && Math.abs(market.avg) > 1) ? '中高' : '中等');
    }

    var source = (analyze && analyze.source) || 'frontend-rule';
    var score = data.sentiment === '偏多' ? 68 : (data.sentiment === '偏空' ? 32 : 50);

    var html =
      '<div class="cockpit-head">' +
        '<span class="cockpit-title">今日投资结论<span class="cockpit-sub">量化多因子 · ' + esc(source) + '</span></span>' +
        '<span class="cockpit-score ' + (score >= 60 ? 'up' : (score <= 40 ? 'down' : '')) + '">' + score + '</span>' +
      '</div>' +
      '<div class="cockpit-grid">' +
        '<div class="cockpit-cell"><div class="cockpit-label">市场情绪</div><div class="cockpit-value">' + esc((data.sentiment) || (market && market.sentiment) || '震荡') + '</div></div>' +
        '<div class="cockpit-cell"><div class="cockpit-label">上涨/下跌</div><div class="cockpit-value ' + (clsOf((market && market.avg) || 0)) + '">' + (data.upCount || (market && market.upCount) || 0) + ' / ' + (data.downCount || (market && market.downCount) || 0) + '</div></div>' +
        '<div class="cockpit-cell"><div class="cockpit-label">风险等级</div><div class="cockpit-value">' + esc(risk || '中等') + '</div></div>' +
      '</div>' +
      '<div class="cockpit-reasons"><ul>' +
        '<li>' + esc(summary || '暂无可用的今日判断') + '</li>' +
        (advice ? '<li>' + esc(advice) + '</li>' : '') +
      '</ul></div>' +
      '<div class="cockpit-action"><b>操作建议</b>' + esc(advice || '等待市场数据加载…') + '</div>';

    el.innerHTML = html;
  }

  // ---------- 市场温度计 ----------
  function renderThermometer(market) {
    var el = $('#sentimentThermo');
    if (!el || !market) return;
    var avg = market.avg == null ? 0 : market.avg;
    var label = avg > 1 ? '偏热' : (avg > 0 ? '温和' : (avg < -1 ? '偏冷' : '中性'));
    var pct = Math.min(100, Math.max(0, 50 + avg * 10)); // -5%~+5% -> 0~100
    el.innerHTML =
      '<div class="thermo-top">' +
        '<div class="thermo-dot">🌡️</div>' +
        '<div class="thermo-main">' +
          '<div class="thermo-val ' + clsOf(avg) + '">' + esc(label) + '<small> ' + fmtPct(avg) + '</small></div>' +
          '<div class="thermo-stats"><span>市场温度</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="thermo-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="thermo-stats"><b class="' + (clsOf(avg) || 'flat') + '">' + (market.upCount || 0) + '涨</b> / <b class="down">' + (market.downCount || 0) + '跌</b></div>';
  }

  // ---------- 市场扫描 ----------
  function renderMarketScan(market) {
    var el = $('#marketScan');
    if (!el || !market) return;
    var list = (market.indexes || []).slice().sort(function (a, b) { return (b.changePercent || 0) - (a.changePercent || 0); });
    if (!list.length) { el.textContent = '暂无数据'; return; }
    var strongest = list[0];
    var weakest = list[list.length - 1];
    var up = list.filter(function (i) { return (i.changePercent || 0) > 0; }).length;
    var flow = up / list.length > 0.6 ? '净流入' : (up / list.length < 0.4 ? '净流出' : '均衡');
    el.innerHTML =
      '<div class="scan-block"><div class="scan-h">📈 最强</div>' +
        '<span class="scan-tag">🔥 ' + esc(strongest.name) + '<b>' + fmtPct(strongest.changePercent) + '</b></span></div>' +
      '<div class="scan-block"><div class="scan-h">📉 最弱</div>' +
        '<span class="scan-tag weak">⚠️ ' + esc(weakest.name) + '<b>' + fmtPct(weakest.changePercent) + '</b></span></div>' +
      '<div class="scan-block"><div class="scan-h">💰 资金</div>' +
        '<span class="scan-tag flow">资金<b>' + esc(flow) + '</b></span></div>';
  }

  // ---------- 资金行为 AI 识别 ----------
  function renderFundBehavior(news) {
    var el = $('#moneyBehavior');
    if (!el) return;
    var list = (news && news.data) || [];
    var txt = list.map(function (n) { return (n.title || '') + (n.content || ''); }).join('');
    var ji = (txt.match(/机构/g) || []).length;
    var you = (txt.match(/游资/g) || []).length;
    var san = (txt.match(/散户/g) || []).length;
    var total = ji + you + san;
    var judge = total === 0 ? '消息面暂无明确主导资金信号，市场以存量博弈为主。' :
      (ji >= you && ji >= san ? '机构资金相对活跃，偏向蓝筹/核心资产。' :
       (you >= ji && you >= san ? '游资主导题材轮动，注意高位波动风险。' : '散户情绪主导，关注情绪拐点。'));
    el.innerHTML =
      '<div class="money-behavior">' +
        '<div class="mb-row"><span>机构</span><b>' + ji + '</b></div>' +
        '<div class="mb-row"><span>游资</span><b>' + you + '</b></div>' +
        '<div class="mb-row"><span>散户</span><b>' + san + '</b></div>' +
        '<div class="mb-judge">💡 <b>研判：</b>' + esc(judge) + '</div>' +
      '</div>';
  }

  // ---------- 涨跌归因 ----------
  function renderAttribution(news) {
    var el = $('#attributionCard');
    if (!el) return;
    var list = (news && news.data) || [];
    if (!list.length) { el.textContent = '—'; return; }
    el.innerHTML = list.slice(0, 3).map(function (n, idx) {
      var title = n.title || n.content || '';
      if (title.length > 42) title = title.slice(0, 42) + '…';
      return '<div class="scan-block"><div class="scan-h">驱动 ' + (idx + 1) + '</div>' +
             '<span class="scan-tag">' + esc(title) + '</span></div>';
    }).join('');
  }

  // ---------- 持仓卡片诊断条 ----------
  function renderFundDiagnosis(code) {
    if (!code) return '';
    var d = global.DecisionEngine.diagnoseFund(code);
    var tag = '<span class="fc-hold-tag fc-hold-' + (d.score >= 70 ? 'best' : (d.score <= 40 ? 'worst' : 'na')) + '">' + esc(d.label) + ' ' + d.score + '</span>';
    return '<div class="fund-diag" style="margin-top:8px;padding:6px 10px;background:rgba(242,247,255,.7);border-radius:10px;font-size:11px;color:var(--text-sec);line-height:1.5;">' +
           tag + ' <span>' + esc(d.reason) + '</span></div>';
  }

  // ---------- 主渲染入口 ----------
  function renderDecisionAll() {
    if (!global.DecisionEngine) return;
    var cockpit = global.DecisionEngine.buildCockpit();
    var m = cockpit.market || {};
    var news = cockpit.news || [];
    renderCockpitCard(cockpit.analyze, m);
    renderThermometer(m);
    renderMarketScan(m);
    renderFundBehavior({ data: news });
    renderAttribution({ data: news });
    renderIndexGrid(m);
    // 持仓卡片诊断（幂等）
    $$('.fund-card').forEach(function (card) {
      if (card.querySelector('.fund-diag')) return;
      var code = card.dataset && card.dataset.code;
      if (!code) return;
      var html = renderFundDiagnosis(code);
      if (html) card.insertAdjacentHTML('beforeend', html);
    });
  }

  // ---------- 拉取数据 + 渲染 ----------
  function refreshAll() {
    if (!global.DecisionEngine) { renderDecisionAll(); return Promise.resolve(); }
    var E = global.DecisionEngine;
    var pMarket = E.fetchMarket().catch(function () { return null; });
    var pNews = E.fetchNews(30).catch(function () { return null; });
    var pAnalyze = E.fetchAnalyze().catch(function () { return null; });
    return Promise.all([pMarket, pNews, pAnalyze]).then(function () { renderDecisionAll(); });
  }

  // ---------- 深度分析按钮 ----------
  function bindDeepBtn() {
    var btn = $('#cockpitDeepBtn');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      var payload = { type: 'cockpit', snapshot: (global.DecisionEngine && global.DecisionEngine.buildCockpit()) || {} };
      fetch('/api/ai/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var data = j && j.data ? j.data : j; // 兼容 {data:{...}} 或平铺
          if (global.DecisionEngine) global.DecisionEngine.getCache().analyze = data;
          renderCockpitCard(data, (global.DecisionEngine && global.DecisionEngine.buildCockpit().market) || {});
          showToast((data && data.summary) || 'AI 暂未返回，已使用规则版判断');
        })
        .catch(function () { showToast('AI 接口暂不可用，已使用规则版判断'); });
    });
  }

  function showToast(msg) {
    var t = $('#toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:88px;transform:translateX(-50%);background:rgba(15,23,42,.92);color:#fff;font-size:13px;padding:9px 18px;border-radius:24px;z-index:9999;pointer-events:none;opacity:0;transition:opacity .25s;white-space:nowrap;max-width:86vw;overflow:hidden;text-overflow:ellipsis;';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(t._timer); t._timer = setTimeout(function () { t.style.opacity = '0'; }, 2600);
  }

  // ---------- 公开 API ----------
  global.DecisionRender = {
    renderDecisionAll: renderDecisionAll,
    renderCockpitCard: renderCockpitCard,
    renderFundDiagnosis: renderFundDiagnosis,
    renderAttribution: renderAttribution,
    refreshAll: refreshAll,
    bindDeepBtn: bindDeepBtn
  };

  // ---------- 自动启动 ----------
  function init() {
    bindDeepBtn();
    renderDecisionAll(); // 先用缓存出画面
    refreshAll();        // 再拉最新
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 兼容 index.html 末尾内联脚本的钩子
  global.renderCockpit = renderDecisionAll;
})(window);
