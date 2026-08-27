/* ============================================================
 * ai-decision-engine.js  (Cloudflare Pages 静态托管直接生效)
 * 职责：数据抓取 / 缓存 / 指标计算 / cockpit 快照
 * 不操作 DOM，纯逻辑，方便测试与复用
 * ============================================================ */
(function (global) {
  'use strict';

  var CACHE_TTL = 60_000;
  var cache = { ts: 0, market: null, news: null, fundrank: null, analyze: null };

  function now() { return Date.now(); }
  function fresh() { return now() - cache.ts < CACHE_TTL; }

  function num(v) { var n = parseFloat(v); return Number.isFinite(n) ? n : null; }

  function fetchJSON(url, timeout) {
    timeout = timeout || 10_000;
    var ctrl = (global.AbortController ? new global.AbortController() : null);
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeout) : null;
    return fetch(url, { headers: { 'Accept': 'application/json' }, signal: (ctrl ? ctrl.signal : undefined) })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (timer) clearTimeout(timer);
        return j;
      });
  }

  function fetchMarket() {
    if (cache.market && fresh()) return Promise.resolve(cache.market);
    return fetchJSON('/api/market').then(function (j) { cache.market = j; cache.ts = now(); return j; });
  }

  function fetchNews(n) {
    n = n || 30;
    if (cache.news && fresh()) return Promise.resolve(cache.news);
    return fetchJSON('/api/news?n=' + n).then(function (j) { cache.news = j; cache.ts = now(); return j; });
  }

  function fetchFundrank(tab) {
    tab = tab || 'gain';
    return fetchJSON('/api/fundrank/' + encodeURIComponent(tab)).then(function (j) { return j; });
  }

  function fetchAnalyze() {
    if (cache.analyze && fresh()) return Promise.resolve(cache.analyze);
    return fetchJSON('/api/ai/analyze').then(function (j) { cache.analyze = j; cache.ts = now(); return j; });
  }

  function buildCockpit() {
    var m = cache.market || {};
    var indexes = (m.indexes || []).map(function (i) {
      return {
        code: i.code || i.key, name: i.name, price: num(i.price),
        changePercent: num(i.changePercent), changeAmount: num(i.changeAmount), source: i.source
      };
    });
    var avg = indexes.length ? indexes.reduce(function (s, i) { return s + (i.changePercent || 0); }, 0) / indexes.length : 0;
    var sentiment = avg > 0.5 ? '偏多' : (avg < -0.5 ? '偏空' : '震荡');
    var direction = avg > 0 ? '上涨' : (avg < 0 ? '下跌' : '横盘');
    var upCount = indexes.filter(function (i) { return (i.changePercent || 0) > 0; }).length;
    var downCount = indexes.length - upCount;

    return {
      generatedAt: new Date().toISOString(),
      market: {
        indexes: indexes, main: indexes[0] || null, avg: +avg.toFixed(2),
        sentiment: sentiment, direction: direction,
        upCount: upCount, downCount: downCount,
        sources: (m.sources || []).filter(function (s) { return s.ok; }).map(function (s) { return s.name; }),
        verified: !!(m.cross && m.cross.verified),
      },
      news: (cache.news && cache.news.data) ? cache.news.data.slice(0, 20) : [],
      analyze: cache.analyze || null,
    };
  }

  function diagnoseFund(code, holding) {
    code = String(code || '');
    holding = holding || {};
    var cockpit = buildCockpit();
    var market = cockpit.market;
    var upCount = market.indexes.filter(function (i) { return (i.changePercent || 0) > 0; }).length;
    var total = market.indexes.length || 1;
    var breadth = upCount / total;
    var signal = breadth > 0.6 ? '偏强' : (breadth < 0.4 ? '偏弱' : '中性');
    var day = num(holding.dayChangePct) || 0;
    var est = (holding.estNav != null) ? num(holding.estNav) : null;
    var score = Math.max(0, Math.min(100, Math.round(
      50 + (breadth - 0.5) * 40 + (day > 0 ? 10 : -10) + (signal === '偏强' ? 5 : (signal === '偏弱' ? -5 : 0))
    )));
    var level = score >= 70 ? 'high' : (score <= 40 ? 'low' : 'neutral');
    var label = score >= 70 ? '可关注' : (score <= 40 ? '谨慎' : '中性');
    return {
      code: code, signal: signal, score: score, level: level, label: label,
      reason: '市场' + market.sentiment + '（' + upCount + '/' + total + '上涨），' +
        '该基金当日' + (day > 0 ? '上涨' : (day < 0 ? '下跌' : '持平')) + (est != null ? '，预估净值 ' + est : '') + '。',
      estNav: est,
    };
  }

  // 兼容 index.html 内联脚本的 renderCockpit 钩子
  global.renderDecisionAll = function () { /* 由 render 层实现 */ };

  global.DecisionEngine = {
    CACHE_TTL: CACHE_TTL, num: num,
    fetchMarket: fetchMarket, fetchNews: fetchNews, fetchFundrank: fetchFundrank, fetchAnalyze: fetchAnalyze,
    buildCockpit: buildCockpit, diagnoseFund: diagnoseFund,
    getCache: function () { return cache; },
    clearCache: function () { cache = { ts: 0, market: null, news: null, fundrank: null, analyze: null }; },
  };
})(window);
