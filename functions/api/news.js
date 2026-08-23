// Cloudflare Pages Function: 新闻代理（实时版 v3）
// 路径：/api/news
//
// 设计目标：
// 1. 用户打开 App 时由前端请求一次 /api/news；本函数每次都重新抓取上游，不使用新闻缓存。
// 2. 多新闻源并行请求，避免“一个源慢导致全部新闻慢”。
// 3. 统一返回 title / summary / timestamp / time / source / sources / tier / url。
// 4. 同一事件去重时优先保留更高等级来源；同等级再保留更新时间更新的版本。
// 5. source 参数兼容旧版：wscn / ths / em / emflash / sina / cls / official / yicai / jin10 / guba / thsforum / all。
// 6. AI 解读不在这里处理，前端拿到新闻后自行异步生成 AI 解读。
// 7. 新闻接口明确禁止 CDN / 浏览器缓存。
//
// 来源等级：
// Tier 1：官方公告/监管（巨潮资讯、证监会等）
// Tier 2：权威财经快讯（财联社、第一财经）
// Tier 3：市场资讯（华尔街见闻）
// Tier 4：综合资讯（东方财富、同花顺、金十）
//
// 注意：部分财经网站会调整未公开接口。本文件对单个来源采用“失败即跳过”策略，
// 某一个源失效不会拖垮整个新闻接口。

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);

  const source = (url.searchParams.get('source') || 'all').toLowerCase();
  const limitRaw = parseInt(url.searchParams.get('limit') || '30', 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 30, 5), 60);

  const commonHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',

    // 新闻不能走旧缓存。
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    Pragma: 'no-cache',
  };

  const should = (name) => source === 'all' || source === name;

  const cleanText = (value) => {
    if (value == null) return '';
    if (typeof value === 'object') {
      if (value.text != null) return cleanText(value.text);
      if (value.content != null) return cleanText(value.content);
      if (value.summary != null) return cleanText(value.summary);
      if (value.brief != null) return cleanText(value.brief);
      return '';
    }

    return String(value)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const parseTimestamp = (value) => {
    if (value == null || value === '') return 0;

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 0;
      return value < 1e12 ? value * 1000 : value;
    }

    const s = String(value).trim();

    if (/^\d{10}$/.test(s)) return Number(s) * 1000;
    if (/^\d{13}$/.test(s)) return Number(s);

    const t = Date.parse(s.replace(/\./g, '-'));
    return Number.isFinite(t) ? t : 0;
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '';

    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return '';

    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  };

  const normalize = ({
    title,
    summary,
    timestamp,
    sourceName,
    tier,
    url: itemUrl = '',
    id = '',
  }) => {
    const cleanTitleValue = cleanText(title);
    if (!cleanTitleValue) return null;

    const ts = parseTimestamp(timestamp);

    return {
      id: id ? String(id) : `${sourceName}-${ts}-${cleanTitleValue.slice(0, 32)}`,
      title: cleanTitleValue,
      summary: cleanText(summary).slice(0, 500),
      timestamp: ts || 0,
      time: formatTime(ts),
      source: sourceName,
      sources: [sourceName],
      tier,
      url: typeof itemUrl === 'string' ? itemUrl : '',
    };
  };

  const fetchText = async (target, init = {}, timeout = 9000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(target, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return response;
    } finally {
      clearTimeout(timer);
    }
  };

  const safeTask = async (name, fn) => {
    try {
      const items = await fn();
      return Array.isArray(items) ? items : [];
    } catch (error) {
      console.log(`[news:${name}] unavailable`, error?.message || error);
      return [];
    }
  };

  // ------------------------------------------------------------
  // Tier 3：华尔街见闻
  // ------------------------------------------------------------
  const fetchWSCN = async () => {
    const target =
      `https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&client=pc&limit=${limit}&_=${Date.now()}`;

    const response = await fetchText(target, {
      headers: {
        ...commonHeaders,
        Referer: 'https://wallstreetcn.com/',
      },
    });

    const json = await response.json();
    const items = json?.data?.items || json?.data?.day_items || [];

    return items
      .map((x) =>
        normalize({
          title: x.title || x.resource?.title,
          summary:
            x.summary ||
            x.brief ||
            x.content_text ||
            x.resource?.content_text,
          timestamp:
            x.display_time ||
            x.publish_time ||
            x.created_at ||
            x.ctime,
          sourceName: '华尔街见闻',
          tier: 3,
          url: x.uri || x.resource?.uri || '',
          id: x.id || x.resource?.id || '',
        }),
      )
      .filter(Boolean);
  };

  // ------------------------------------------------------------
  // Tier 4：同花顺
  // ------------------------------------------------------------
  const fetchTHS = async () => {
    const target =
      `https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&pagesize=${limit}&track=website&_=${Date.now()}`;

    const response = await fetchText(target, {
      headers: {
        ...commonHeaders,
        Referer: 'https://news.10jqka.com.cn/',
      },
    });

    const json = await response.json();
    const list = json?.data?.list || [];

    return list
      .map((x) =>
        normalize({
          title: x.title,
          summary: x.digest || x.summary || '',
          timestamp: x.ctime || x.time || x.showTime,
          sourceName: '同花顺',
          tier: 4,
          url: x.url || x.url_pc || '',
          id: x.id || x.news_id || '',
        }),
      )
      .filter(Boolean);
  };

  // ------------------------------------------------------------
  // Tier 4：东方财富
  // ------------------------------------------------------------
  const fetchEM = async () => {
    const param = {
      uid: '',
      keyword: 'A股 股票 市场 政策 业绩 半导体 芯片 AI 算力 基金 ETF',
      type: ['cmsArticleWebOld'],
      client: 'web',
      clientType: 'web',
      clientVersion: 'curr',
      param: {
        cmsArticleWebOld: {
          searchScope: 'default',
          sort: 'default',
          pageIndex: 1,
          pageSize: limit,
          preTag: '',
          postTag: '',
        },
      },
    };

    const target =
      `https://search-api-web.eastmoney.com/search/jsonp?cb=jQueryCallback&param=${encodeURIComponent(
        JSON.stringify(param),
      )}&_=${Date.now()}`;

    const response = await fetchText(target, {
      headers: {
        ...commonHeaders,
        Referer: 'https://so.eastmoney.com/',
      },
    });

    const text = await response.text();
    const match = text.match(/jQueryCallback\(([\s\S]+)\)\s*;?\s*$/);

    if (!match) return [];

    const json = JSON.parse(match[1]);
    const list =
      json?.result?.cmsArticleWebOld ||
      json?.data?.cmsArticleWebOld ||
      [];

    return list
      .map((x) =>
        normalize({
          title: x.title || x.brief,
          summary: x.content || x.brief || x.summary,
          timestamp: x.ctime || x.showTime || x.publishTime,
          sourceName: '东方财富',
          tier: 4,
          url: x.url || x.articleUrl || '',
          id: x.id || x.articleId || '',
        }),
      )
      .filter(Boolean);
  };

  // ------------------------------------------------------------
  // Tier 2：财联社
  //
  // 说明：
  // 财联社旧 telegraph 接口在 2026 年已经出现 404，不能继续把
  // /nodeapi/updateTelegraphList 当作可靠实时接口。
  // 这里使用当前仍可访问的 depth/hot 数据作为 Tier 2 备用来源。
  // ------------------------------------------------------------
  const sha1Hex = async (text) => {
    const data = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-1', data);
    return [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };

  // 财联社接口的 sign 为 md5(sha1(sorted query string))。
  // Cloudflare Workers 没有 Node crypto，因此这里实现纯 Web Crypto MD5。
  const md5Hex = (input) => {
    const bytes = new TextEncoder().encode(input);

    const rotateLeft = (x, c) => (x << c) | (x >>> (32 - c));
    const add = (a, b) => (a + b) >>> 0;

    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
      K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    }

    const S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];

    const bitLen = bytes.length * 8;
    const paddedLength = (((bytes.length + 8) >> 6) + 1) * 64;
    const buffer = new Uint8Array(paddedLength);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;

    const view = new DataView(buffer.buffer);
    view.setUint32(paddedLength - 8, bitLen >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(bitLen / 4294967296), true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    for (let offset = 0; offset < paddedLength; offset += 64) {
      const M = new Uint32Array(16);
      for (let i = 0; i < 16; i++) {
        M[i] = view.getUint32(offset + i * 4, true);
      }

      let A = a0;
      let B = b0;
      let C = c0;
      let D = d0;

      for (let i = 0; i < 64; i++) {
        let F;
        let g;

        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) % 16;
        }

        const temp = D;
        const sum = add(add(add(A, F >>> 0), K[i]), M[g]);
        D = C;
        C = B;
        B = add(B, rotateLeft(sum, S[i]));
        A = temp;
      }

      a0 = add(a0, A);
      b0 = add(b0, B);
      c0 = add(c0, C);
      d0 = add(d0, D);
    }

    const words = [a0, b0, c0, d0];
    return words
      .map((word) => {
        let out = '';
        for (let i = 0; i < 4; i++) {
          out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
        }
        return out;
      })
      .join('');
  };

  const getCLSSignedParams = async (extra = {}) => {
    const params = new URLSearchParams({
      appName: 'CailianpressWeb',
      os: 'web',
      sv: '7.7.5',
      ...extra,
    });

    params.sort();

    const sha1 = await sha1Hex(params.toString());
    const sign = md5Hex(sha1);
    params.set('sign', sign);

    return params;
  };

  const fetchCLS = async () => {
    // 当前可用的财联社深度接口。
    // 如果接口返回结构变化，安全地返回空数组，不影响其他来源。
    const params = await getCLSSignedParams();

    const urls = [
      `https://www.cls.cn/v3/depth/home/assembled/1000?${params.toString()}`,
      `https://www.cls.cn/v2/article/hot/list?${params.toString()}`,
    ];

    for (const target of urls) {
      try {
        const response = await fetchText(target, {
          headers: {
            ...commonHeaders,
            Referer: 'https://www.cls.cn/',
          },
        });

        const json = await response.json();

        const raw =
          json?.data?.data ||
          json?.data?.list ||
          json?.data?.articles ||
          json?.data ||
          [];

        const list = Array.isArray(raw) ? raw : [];

        const items = list
          .map((x) =>
            normalize({
              title:
                x.title ||
                x.brief ||
                x.article_title ||
                x.content?.title,
              summary:
                x.brief ||
                x.content ||
                x.article_brief ||
                x.summary,
              timestamp:
                x.ctime ||
                x.create_time ||
                x.publish_time ||
                x.article_time,
              sourceName: '财联社',
              tier: 2,
              url:
                x.shareurl ||
                x.url ||
                (x.id ? `https://www.cls.cn/detail/${x.id}` : ''),
              id: x.id || x.article_id || '',
            }),
          )
          .filter(Boolean);

        if (items.length) return items.slice(0, limit);
      } catch (error) {
        console.log('[news:cls] endpoint failed', error?.message || error);
      }
    }

    return [];
  };

  // ------------------------------------------------------------
  // Tier 1：巨潮资讯 / 上市公司公告
  //
  // 使用巨潮公告查询接口获取当天最新公告。
  // 这是“官方信息”而不是把东方财富包装成官方。
  // ------------------------------------------------------------
  const fetchOfficial = async () => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const today = `${yyyy}-${mm}-${dd}`;

    const form = new URLSearchParams();
    form.set('pageNum', '1');
    form.set('pageSize', String(Math.min(limit, 30)));
    form.set('column', 'szse');
    form.set('tabName', 'latest');
    form.set('plate', '');
    form.set('stock', '');
    form.set('searchkey', '');
    form.set('secid', '');
    form.set('category', '');
    form.set('trade', '');
    form.set('seDate', `${today}~${today}`);

    const response = await fetchText(
      'https://www.cninfo.com.cn/new/hisAnnouncement/query',
      {
        method: 'POST',
        headers: {
          ...commonHeaders,
          Referer: 'https://www.cninfo.com.cn/',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: form.toString(),
      },
      10000,
    );

    const json = await response.json();
    const announcements = json?.announcements || [];

    return announcements
      .map((x) =>
        normalize({
          title: x.announcementTitle || x.title,
          summary: x.announcementTitle || '',
          timestamp: x.announcementTime || x.seDate || x.publishTime,
          sourceName: '巨潮资讯',
          tier: 1,
          url: x.adjunctUrl
            ? `https://static.cninfo.com.cn/${String(x.adjunctUrl).replace(/^\/+/, '')}`
            : 'https://www.cninfo.com.cn/',
          id: x.announcementId || x.id || x.adjunctUrl || '',
        }),
      )
      .filter(Boolean);
  };

  // ------------------------------------------------------------
  // Tier 2：第一财经
  //
  // 第一财经公开首页没有一个稳定、公开、长期承诺的新闻 JSON API。
  // 因此这里采用首页结构中的新闻链接作为“补充源”，解析失败则跳过。
  // 不伪造时间：拿不到真实时间就 timestamp=0。
  // ------------------------------------------------------------
  const fetchYicai = async () => {
    const response = await fetchText('https://www.yicai.com/', {
      headers: {
        ...commonHeaders,
        Accept: 'text/html,application/xhtml+xml',
        Referer: 'https://www.yicai.com/',
      },
    });

    const html = await response.text();
    const results = [];
    const seen = new Set();

    // 提取 /news/数字.html 链接附近的标题。
    const re =
      /<a[^>]+href=["'](https?:\/\/(?:www\.)?yicai\.com\/news\/\d+\.html|\/news\/\d+\.html)["'][^>]*>([\s\S]{1,300}?)<\/a>/gi;

    let match;
    while ((match = re.exec(html)) && results.length < limit * 2) {
      const href = match[1].startsWith('http')
        ? match[1]
        : `https://www.yicai.com${match[1]}`;

      const title = cleanText(match[2]);

      if (!title || title.length < 4 || seen.has(href)) continue;
      seen.add(href);

      results.push(
        normalize({
          title,
          summary: '',
          timestamp: 0,
          sourceName: '第一财经',
          tier: 2,
          url: href,
          id: href,
        }),
      );
    }

    return results.filter(Boolean).slice(0, limit);
  };

  // ------------------------------------------------------------
  // Tier 4：金十数据（补充快讯）
  // ------------------------------------------------------------
  const fetchJin10 = async () => {
    const targets = [
      `https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1&_=${Date.now()}`,
      `https://flash-api.jin10.com/get_flash_list?channel=-8200&_=${Date.now()}`,
    ];

    for (const target of targets) {
      try {
        const response = await fetchText(target, {
          headers: {
            ...commonHeaders,
            Referer: 'https://www.jin10.com/',
          },
        });

        const json = await response.json();
        const list = json?.data || json?.list || [];

        if (!Array.isArray(list) || !list.length) continue;

        const items = list
          .map((x) => {
            const data = x?.data || x;
            const text =
              data?.content ||
              data?.title ||
              data?.brief ||
              data?.summary ||
              '';

            return normalize({
              title: text,
              summary: text,
              timestamp: data?.time || data?.ctime || data?.timestamp,
              sourceName: '金十数据',
              tier: 4,
              url: data?.link || data?.url || '',
              id: data?.id || '',
            });
          })
          .filter(Boolean);

        if (items.length) return items.slice(0, limit);
      } catch (error) {
        console.log('[news:jin10] endpoint failed', error?.message || error);
      }
    }

    return [];
  };



  // ------------------------------------------------------------
  // Tier 4：东方财富 7x24 实时快讯
  // 前端会以 source=emflash 单独请求这一源。
  // 这是比搜索结果更适合“最新快讯”的接口。
  // ------------------------------------------------------------
  const fetchEMFlash = async () => {
    const target =
      `https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=${limit}&type=0&_=${Date.now()}`;

    const response = await fetchText(target, {
      headers: {
        ...commonHeaders,
        Referer: 'https://kuaixun.eastmoney.com/',
      },
    });

    const json = await response.json();
    const list = json?.data?.fastList || json?.data?.list || [];

    return (Array.isArray(list) ? list : [])
      .map((x) =>
        normalize({
          title: x.title || x.content,
          summary: x.content || x.digest || x.summary || '',
          timestamp: x.showTime || x.ctime || x.publishTime || x.time,
          sourceName: '东方财富',
          tier: 4,
          url: x.url_unique || x.url || '',
          id: x.id || x.newsId || '',
        }),
      )
      .filter(Boolean)
      .filter((x) => x.timestamp > 0)
      .slice(0, limit);
  };

  // ------------------------------------------------------------
  // Tier 4：新浪财经 7x24 滚动新闻
  // ------------------------------------------------------------
  const fetchSina = async () => {
    const target =
      `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=${limit}&page=1&_=${Date.now()}`;

    const response = await fetchText(target, {
      headers: {
        ...commonHeaders,
        Referer: 'https://finance.sina.com.cn/',
      },
    });

    const json = await response.json();
    const list = json?.data || [];

    return (Array.isArray(list) ? list : [])
      .map((x) =>
        normalize({
          title: x.title,
          summary: x.intro || x.summary || x.content || '',
          timestamp: x.ctime || x.create_time || x.time,
          sourceName: '新浪财经',
          tier: 4,
          url: x.url || '',
          id: x.id || x.docid || '',
        }),
      )
      .filter(Boolean)
      .filter((x) => x.timestamp > 0)
      .slice(0, limit);
  };

  // ------------------------------------------------------------
  // Tier 4：东方财富股吧热度（三级情绪）
  // 注意：这里不是新闻源，不进入主新闻列表。
  // ------------------------------------------------------------
  const fetchGuba = async () => {
    const target =
      'https://guba.eastmoney.com/interface/GetData.aspx?path=topics/hotlist&param=ps=20&p=1';

    const response = await fetchText(target, {
      headers: {
        ...commonHeaders,
        Referer: 'https://guba.eastmoney.com/',
      },
    });

    const json = await response.json();
    const list = json?.Data || json?.data || [];

    return (Array.isArray(list) ? list : [])
      .slice(0, Math.min(limit, 20))
      .map((x) => ({
        title: cleanText(x.title || x.topic_title || ''),
        summary: cleanText(x.desc || x.content || ''),
        heat: x.hit_count || x.read_count || x.views || 0,
        reply: x.reply_count || x.post_count || 0,
        source: '东方财富股吧',
        url: x.url || x.topic_url || '',
      }))
      .filter((x) => x.title);
  };

  // ------------------------------------------------------------
  // Tier 4：同花顺社区/论股堂热帖（三级情绪）
  // ------------------------------------------------------------
  const fetchTHSForum = async () => {
    const target =
      'https://t.10jqka.com.cn/newlt/lthot/lthotlist/?type=hot&page=1&pagesize=20';

    const response = await fetchText(target, {
      headers: {
        ...commonHeaders,
        Referer: 'https://t.10jqka.com.cn/',
      },
    });

    const json = await response.json();
    const list = json?.data?.list || json?.result || [];

    return (Array.isArray(list) ? list : [])
      .slice(0, Math.min(limit, 20))
      .map((x) => ({
        title: cleanText(x.title || ''),
        summary: cleanText(x.content || x.desc || ''),
        heat: x.views || x.read_num || 0,
        reply: x.reply_num || x.comment_num || 0,
        source: '同花顺社区',
        url: x.url || x.share_url || '',
      }))
      .filter((x) => x.title);
  };

  // ------------------------------------------------------------
  // 同一事件去重
  // ------------------------------------------------------------
  const normalizeKey = (title) =>
    cleanText(title)
      .toLowerCase()
      .replace(/[，。、“”‘’：；！？,.!?;:()[\]{}【】\s]/g, '')
      .replace(
        /^(突发|快讯|重磅|刚刚|最新|速报|市场消息|据悉|消息称|财联社电报)/,
        '',
      )
      .slice(0, 60);

  const mergeNews = (lists) => {
    const map = new Map();

    for (const list of lists) {
      for (const item of list) {
        if (!item || !item.title) continue;

        const key = normalizeKey(item.title);
        if (!key) continue;

        const old = map.get(key);

        if (!old) {
          map.set(key, item);
          continue;
        }

        // 更高权威等级优先；同等级取更新时间更新的一条。
        const shouldReplace =
          item.tier < old.tier ||
          (item.tier === old.tier &&
            Number(item.timestamp || 0) > Number(old.timestamp || 0));

        const main = shouldReplace ? item : old;
        const secondary = shouldReplace ? old : item;

        const sources = [
          ...new Set([
            ...(main.sources || [main.source]),
            ...(secondary.sources || [secondary.source]),
          ]),
        ];

        map.set(key, {
          ...main,
          sources,
          source: main.source,
        });
      }
    }

    return [...map.values()]
      .sort((a, b) => {
        // 主列表永远优先最新时间；时间相近时再优先权威来源。
        const ta = Number(a.timestamp || 0);
        const tb = Number(b.timestamp || 0);
        if (ta !== tb) return tb - ta;
        return (a.tier || 99) - (b.tier || 99);
      })
      .slice(0, Math.min(limit * 2, 80));
  };

  // ------------------------------------------------------------
  // 并行抓取
  // ------------------------------------------------------------
  const tasks = [];

  if (should('wscn')) tasks.push(safeTask('wscn', fetchWSCN));
  if (should('ths')) tasks.push(safeTask('ths', fetchTHS));
  if (should('em')) tasks.push(safeTask('em', fetchEM));
  if (should('emflash')) tasks.push(safeTask('emflash', fetchEMFlash));
  if (should('sina')) tasks.push(safeTask('sina', fetchSina));
  if (should('cls')) tasks.push(safeTask('cls', fetchCLS));
  if (should('official')) tasks.push(safeTask('official', fetchOfficial));
  if (should('yicai')) tasks.push(safeTask('yicai', fetchYicai));
  if (should('jin10')) tasks.push(safeTask('jin10', fetchJin10));
  if (should('guba')) tasks.push(safeTask('guba', fetchGuba));
  if (should('thsforum')) tasks.push(safeTask('thsforum', fetchTHSForum));

  // all：一次并行请求全部来源。
  const lists = await Promise.all(tasks);
  const merged = mergeNews(lists);

  const latestTimestamp = merged.length ? Number(merged[0].timestamp || 0) : 0;
  const responseBody = {
    items: merged,
    count: merged.length,
    fetchedAt: Date.now(),
    latestTimestamp,
    cache: 'no-store',
    sources: [
      ...new Set(merged.flatMap((x) => x.sources || [x.source])),
    ],
  };

  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: corsHeaders,
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
    },
  });
}
