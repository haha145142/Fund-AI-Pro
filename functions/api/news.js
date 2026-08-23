// Cloudflare Pages Function
// 路径：/api/news
// 新闻实时代理
//
// 用法：
// /api/news?source=all&limit=30
// /api/news?source=wscn&limit=20
// /api/news?source=ths&limit=20
// /api/news?source=em&limit=20
//
// 重要：
// 1. 新闻接口禁止缓存
// 2. 多源并行请求
// 3. 单个来源失败不会影响其他来源
// 4. 返回统一 JSON 格式
// 5. AI 解读不在这里处理

export async function onRequestGet(context) {
  const { request } = context;
  const requestUrl = new URL(request.url);

  const source = (
    requestUrl.searchParams.get("source") || "all"
  ).toLowerCase();

  const rawLimit = parseInt(
    requestUrl.searchParams.get("limit") || "30",
    10
  );

  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? rawLimit : 30, 5),
    50
  );

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",

    // 新闻禁止缓存
    "Cache-Control":
      "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "Pragma": "no-cache",
  };

  const commonHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  const shouldFetch = (name) => {
    return source === "all" || source === name;
  };

  // ------------------------------------------------------------
  // 工具函数
  // ------------------------------------------------------------

  function cleanText(value) {
    if (value === null || value === undefined) {
      return "";
    }

    if (typeof value === "object") {
      return (
        cleanText(value.text) ||
        cleanText(value.content) ||
        cleanText(value.summary) ||
        cleanText(value.brief)
      );
    }

    return String(value)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseTime(value) {
    if (!value) return 0;

    if (typeof value === "number") {
      if (!Number.isFinite(value)) return 0;
      return value < 100000000000
        ? value * 1000
        : value;
    }

    const text = String(value).trim();

    if (/^\d{10}$/.test(text)) {
      return Number(text) * 1000;
    }

    if (/^\d{13}$/.test(text)) {
      return Number(text);
    }

    const parsed = Date.parse(
      text.replace(/\./g, "-")
    );

    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatTime(timestamp) {
    if (!timestamp) return "";

    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) {
      return "";
    }

    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  function makeNews({
    title,
    summary,
    time,
    source,
    tier,
    url = "",
    id = "",
  }) {
    const cleanTitle = cleanText(title);

    if (!cleanTitle) {
      return null;
    }

    const timestamp = parseTime(time);

    return {
      id:
        String(id || "") ||
        `${source}-${timestamp}-${cleanTitle.slice(0, 30)}`,

      title: cleanTitle,

      summary: cleanText(summary).slice(0, 600),

      timestamp,

      time: formatTime(timestamp),

      source,

      sources: [source],

      tier,

      url:
        typeof url === "string"
          ? url
          : "",
    };
  }

  async function fetchWithTimeout(
    url,
    options = {},
    timeout = 9000
  ) {
    const controller =
      new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      timeout
    );

    try {
      return await fetch(url, {
        ...options,

        // 每次都重新请求
        cache: "no-store",

        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function safe(name, fn) {
    try {
      const result = await fn();

      return Array.isArray(result)
        ? result
        : [];
    } catch (error) {
      console.log(
        `[NEWS ${name}]`,
        error?.message || error
      );

      return [];
    }
  }

  // ------------------------------------------------------------
  // 华尔街见闻
  // Tier 3
  // ------------------------------------------------------------

  async function fetchWSCN() {
    const url =
      "https://api-one-wscn.awtmt.com/apiv1/content/lives" +
      "?channel=global-channel" +
      "&client=pc" +
      `&limit=${limit}` +
      `&_=${Date.now()}`;

    const response =
      await fetchWithTimeout(
        url,
        {
          headers: {
            ...commonHeaders,
            Referer:
              "https://wallstreetcn.com/",
          },
        }
      );

    if (!response.ok) {
      throw new Error(
        `WSCN HTTP ${response.status}`
      );
    }

    const json =
      await response.json();

    const list =
      json?.data?.items ||
      json?.data?.day_items ||
      [];

    return list
      .map((item) =>
        makeNews({
          title:
            item.title ||
            item.resource?.title,

          summary:
            item.summary ||
            item.brief ||
            item.content_text ||
            item.resource?.content_text,

          time:
            item.display_time ||
            item.publish_time ||
            item.created_at ||
            item.ctime,

          source: "华尔街见闻",

          tier: 3,

          url:
            item.uri ||
            item.resource?.uri ||
            "",

          id:
            item.id ||
            item.resource?.id ||
            "",
        })
      )
      .filter(Boolean);
  }

  // ------------------------------------------------------------
  // 同花顺
  // Tier 4
  // ------------------------------------------------------------

  async function fetchTHS() {
    const url =
      "https://news.10jqka.com.cn/tapp/news/push/stock/" +
      `?page=1&pagesize=${limit}` +
      "&track=website" +
      `&_=${Date.now()}`;

    const response =
      await fetchWithTimeout(
        url,
        {
          headers: {
            ...commonHeaders,
            Referer:
              "https://news.10jqka.com.cn/",
          },
        }
      );

    if (!response.ok) {
      throw new Error(
        `THS HTTP ${response.status}`
      );
    }

    const json =
      await response.json();

    const list =
      json?.data?.list || [];

    return list
      .map((item) =>
        makeNews({
          title: item.title,

          summary:
            item.digest ||
            item.summary ||
            "",

          time:
            item.ctime ||
            item.time ||
            item.showTime,

          source: "同花顺",

          tier: 4,

          url:
            item.url ||
            item.url_pc ||
            "",

          id:
            item.id ||
            item.news_id ||
            "",
        })
      )
      .filter(Boolean);
  }

  // ------------------------------------------------------------
  // 东方财富
  // Tier 4
  // ------------------------------------------------------------

  async function fetchEM() {
    const param = {
      uid: "",

      keyword:
        "A股 股票 市场 政策 业绩 半导体 芯片 AI 算力 基金 ETF",

      type: [
        "cmsArticleWebOld"
      ],

      client: "web",

      clientType: "web",

      clientVersion: "curr",

      param: {
        cmsArticleWebOld: {
          searchScope: "default",
          sort: "default",
          pageIndex: 1,
          pageSize: limit,
          preTag: "",
          postTag: "",
        },
      },
    };

    const url =
      "https://search-api-web.eastmoney.com/search/jsonp" +
      "?cb=jQueryCallback" +
      `&param=${encodeURIComponent(
        JSON.stringify(param)
      )}` +
      `&_=${Date.now()}`;

    const response =
      await fetchWithTimeout(
        url,
        {
          headers: {
            ...commonHeaders,
            Referer:
              "https://so.eastmoney.com/",
          },
        }
      );

    if (!response.ok) {
      throw new Error(
        `EM HTTP ${response.status}`
      );
    }

    const text =
      await response.text();

    const match =
      text.match(
        /jQueryCallback\(([\s\S]+)\)\s*;?\s*$/
      );

    if (!match) {
      return [];
    }

    const json =
      JSON.parse(match[1]);

    const list =
      json?.result?.cmsArticleWebOld ||
      json?.data?.cmsArticleWebOld ||
      [];

    return list
      .map((item) =>
        makeNews({
          title:
            item.title ||
            item.brief,

          summary:
            item.content ||
            item.brief ||
            "",

          time:
            item.ctime ||
            item.showTime ||
            item.publishTime,

          source: "东方财富",

          tier: 4,

          url:
            item.url ||
            item.articleUrl ||
            "",

          id:
            item.id ||
            item.articleId ||
            "",
        })
      )
      .filter(Boolean);
  }

  // ------------------------------------------------------------
  // 东方财富 7×24
  // 兼容 source=emflash
  // ------------------------------------------------------------

  async function fetchEMFlash() {
    const url =
      "https://np-list.eastmoney.com/comm/web/getFastNewsList" +
      "?client=web" +
      "&biz=web_news_col" +
      "&type=1" +
      `&limit=${limit}` +
      "&page=1" +
      `&_=${Date.now()}`;

    const response =
      await fetchWithTimeout(
        url,
        {
          headers: {
            ...commonHeaders,
            Referer:
              "https://kuaixun.eastmoney.com/",
          },
        }
      );

    if (!response.ok) {
      throw new Error(
        `EM Flash HTTP ${response.status}`
      );
    }

    const json =
      await response.json();

    const list =
      json?.data?.fastNewsList ||
      json?.data?.list ||
      json?.result?.list ||
      [];

    return list
      .map((item) =>
        makeNews({
          title:
            item.title ||
            item.content ||
            item.summary,

          summary:
            item.digest ||
            item.content ||
            "",

          time:
            item.showTime ||
            item.ctime ||
            item.time,

          source: "东方财富",

          tier: 4,

          url:
            item.url ||
            item.articleUrl ||
            "",

          id:
            item.id ||
            item.newsId ||
            "",
        })
      )
      .filter(Boolean);
  }

  // ------------------------------------------------------------
  // 新浪财经
  // source=sina
  // ------------------------------------------------------------

  async function fetchSina() {
    const url =
      "https://feed.mix.sina.com.cn/api/roll/get" +
      "?pageid=153" +
      "&lid=2509" +
      "&num=" +
      limit +
      `&_=${Date.now()}`;

    const response =
      await fetchWithTimeout(
        url,
        {
          headers: {
            ...commonHeaders,
            Referer:
              "https://finance.sina.com.cn/",
          },
        }
      );

    if (!response.ok) {
      throw new Error(
        `SINA HTTP ${response.status}`
      );
    }

    const json =
      await response.json();

    const list =
      json?.result?.data || [];

    return list
      .map((item) =>
        makeNews({
          title:
            item.title,

          summary:
            item.intro ||
            item.summary ||
            "",

          time:
            item.ctime ||
            item.timestamp,

          source: "新浪财经",

          tier: 4,

          url:
            item.url ||
            "",

          id:
            item.id ||
            item.url ||
            "",
        })
      )
      .filter(Boolean);
  }

  // ------------------------------------------------------------
  // 财联社
  //
  // 使用公开页面数据作为补充。
  // 如果接口结构变化，安全返回空数组。
  // ------------------------------------------------------------

  async function fetchCLS() {
    const url =
      "https://www.cls.cn/" +
      `?_=${Date.now()}`;

    const response =
      await fetchWithTimeout(
        url,
        {
          headers: {
            ...commonHeaders,
            Accept:
              "text/html,application/xhtml+xml",
            Referer:
              "https://www.cls.cn/",
          },
        }
      );

    if (!response.ok) {
      throw new Error(
        `CLS HTTP ${response.status}`
      );
    }

    const html =
      await response.text();

    const result = [];

    // 尝试从页面中的 JSON 数据寻找标题
    const titleRegex =
      /"title"\s*:\s*"([^"]{4,200})"/g;

    let match;

    while (
      (match = titleRegex.exec(html)) &&
      result.length < limit
    ) {
      const title =
        cleanText(match[1]);

      if (
        !title ||
        result.some(
          (x) => x.title === title
        )
      ) {
        continue;
      }

      result.push(
        makeNews({
          title,

          summary: "",

          // 如果页面没有提供明确发布时间，
          // 不伪造时间。
          time: 0,

          source: "财联社",

          tier: 2,

          url:
            "https://www.cls.cn/",

          id:
            `cls-${title}`,
        })
      );
    }

    return result.filter(Boolean);
  }

  // ------------------------------------------------------------
  // 第一财经
  // source=yicai
  // ------------------------------------------------------------

  async function fetchYicai() {
    const response =
      await fetchWithTimeout(
        "https://www.yicai.com/",
        {
          headers: {
            ...commonHeaders,
            Accept:
              "text/html,application/xhtml+xml",
            Referer:
              "https://www.yicai.com/",
          },
        }
      );

    if (!response.ok) {
      throw new Error(
        `YICAI HTTP ${response.status}`
      );
    }

    const html =
      await response.text();

    const result = [];

    const regex =
      /<a[^>]+href=["'](https?:\/\/(?:www\.)?yicai\.com\/news\/\d+\.html|\/news\/\d+\.html)["'][^>]*>([\s\S]{1,300}?)<\/a>/gi;

    let match;

    const seen =
      new Set();

    while (
      (match = regex.exec(html)) &&
      result.length < limit
    ) {
      const href =
        match[1].startsWith("http")
          ? match[1]
          : `https://www.yicai.com${match[1]}`;

      const title =
        cleanText(match[2]);

      if (
        !title ||
        title.length < 4 ||
        seen.has(href)
      ) {
        continue;
      }

      seen.add(href);

      result.push(
        makeNews({
          title,

          summary: "",

          time: 0,

          source: "第一财经",

          tier: 2,

          url: href,

          id: href,
        })
      );
    }

    return result.filter(Boolean);
  }

  // ------------------------------------------------------------
  // 巨潮资讯
  // source=official
  // Tier 1
  // ------------------------------------------------------------

  async function fetchOfficial() {
    const now =
      new Date();

    const yyyy =
      now.getFullYear();

    const mm =
      String(
        now.getMonth() + 1
      ).padStart(2, "0");

    const dd =
      String(
        now.getDate()
      ).padStart(2, "0");

    const today =
      `${yyyy}-${mm}-${dd}`;

    const form =
      new URLSearchParams();

    form.set(
      "pageNum",
      "1"
    );

    form.set(
      "pageSize",
      String(
        Math.min(limit, 30)
      )
    );

    form.set(
      "column",
      "szse"
    );

    form.set(
      "tabName",
      "latest"
    );

    form.set(
      "plate",
      ""
    );

    form.set(
      "stock",
      ""
    );

    form.set(
      "searchkey",
      ""
    );

    form.set(
      "secid",
      ""
    );

    form.set(
      "category",
      ""
    );

    form.set(
      "trade",
      ""
    );

    form.set(
      "seDate",
      `${today}~${today}`
    );

    const response =
      await fetchWithTimeout(
        "https://www.cninfo.com.cn/new/hisAnnouncement/query",
        {
          method: "POST",

          headers: {
            ...commonHeaders,

            Referer:
              "https://www.cninfo.com.cn/",

            "Content-Type":
              "application/x-www-form-urlencoded; charset=UTF-8",
          },

          body:
            form.toString(),
        },
        10000
      );

    if (!response.ok) {
      throw new Error(
        `CNINFO HTTP ${response.status}`
      );
    }

    const json =
      await response.json();

    const list =
      json?.announcements || [];

    return list
      .map((item) =>
        makeNews({
          title:
            item.announcementTitle ||
            item.title,

          summary:
            item.announcementTitle ||
            "",

          time:
            item.announcementTime ||
            item.seDate ||
            item.publishTime,

          source: "巨潮资讯",

          tier: 1,

          url:
            item.adjunctUrl
              ? `https://static.cninfo.com.cn/${String(
                  item.adjunctUrl
                ).replace(/^\/+/, "")}`
              : "https://www.cninfo.com.cn/",

          id:
            item.announcementId ||
            item.id ||
            item.adjunctUrl ||
            "",
        })
      )
      .filter(Boolean);
  }

  // ------------------------------------------------------------
  // 金十
  // source=jin10
  // ------------------------------------------------------------

  async function fetchJin10() {
    const url =
      "https://flash-api.jin10.com/get_flash_list" +
      "?channel=-8200" +
      `&_=${Date.now()}`;

    const response =
      await fetchWithTimeout(
        url,
        {
          headers: {
            ...commonHeaders,
            Referer:
              "https://www.jin10.com/",
          },
        }
      );

    if (!response.ok) {
      throw new Error(
        `JIN10 HTTP ${response.status}`
      );
    }

    const json =
      await response.json();

    const list =
      json?.data ||
      json?.list ||
      [];

    if (!Array.isArray(list)) {
      return [];
    }

    return list
      .map((item) => {
        const data =
          item?.data ||
          item;

        const text =
          data?.content ||
          data?.title ||
          data?.brief ||
          data?.summary ||
          "";

        return makeNews({
          title: text,

          summary: text,

          time:
            data?.time ||
            data?.ctime ||
            data?.timestamp,

          source: "金十数据",

          tier: 4,

          url:
            data?.link ||
            data?.url ||
            "",

          id:
            data?.id ||
            "",
        });
      })
      .filter(Boolean);
  }

  // ------------------------------------------------------------
  // 去重
  // ------------------------------------------------------------

  function newsKey(title) {
    return cleanText(title)
      .toLowerCase()
      .replace(
        /[，。、“”‘’：；！？,.!?;:()[\]{}【】\s]/g,
        ""
      )
      .replace(
        /^(突发|快讯|重磅|刚刚|最新|速报|市场消息|据悉|消息称)/,
        ""
      )
      .slice(0, 70);
  }

  function mergeNews(lists) {
    const map =
      new Map();

    for (const list of lists) {
      for (const item of list) {
        if (
          !item ||
          !item.title
        ) {
          continue;
        }

        const key =
          newsKey(item.title);

        if (!key) {
          continue;
        }

        const old =
          map.get(key);

        if (!old) {
          map.set(
            key,
            item
          );
          continue;
        }

        // 更高等级来源优先
        // 同等级则更新时间新的优先
        const replace =
          item.tier < old.tier ||
          (
            item.tier === old.tier &&
            item.timestamp > old.timestamp
          );

        const main =
          replace
            ? item
            : old;

        const other =
          replace
            ? old
            : item;

        main.sources =
          [
            ...new Set([
              ...(main.sources || [
                main.source
              ]),
              ...(other.sources || [
                other.source
              ]),
            ]),
          ];

        map.set(
          key,
          main
        );
      }
    }

    return [
      ...map.values()
    ]
      .sort(
        (a, b) =>
          Number(b.timestamp || 0) -
          Number(a.timestamp || 0)
      )
      .slice(
        0,
        Math.min(limit * 2, 80)
      );
  }

  // ------------------------------------------------------------
  // 并行抓取
  // ------------------------------------------------------------

  const tasks = [];

  if (
    source === "all" ||
    source === "wscn"
  ) {
    tasks.push(
      safe(
        "wscn",
        fetchWSCN
      )
    );
  }

  if (
    source === "all" ||
    source === "ths"
  ) {
    tasks.push(
      safe(
        "ths",
        fetchTHS
      )
    );
  }

  if (
    source === "all" ||
    source === "em"
  ) {
    tasks.push(
      safe(
        "em",
        fetchEM
      )
    );
  }

  if (
    source === "all" ||
    source === "emflash"
  ) {
    tasks.push(
      safe(
        "emflash",
        fetchEMFlash
      )
    );
  }

  if (
    source === "all" ||
    source === "sina"
  ) {
    tasks.push(
      safe(
        "sina",
        fetchSina
      )
    );
  }

  if (
    source === "all" ||
    source === "cls"
  ) {
    tasks.push(
      safe(
        "cls",
        fetchCLS
      )
    );
  }

  if (
    source === "all" ||
    source === "yicai"
  ) {
    tasks.push(
      safe(
        "yicai",
        fetchYicai
      )
    );
  }

  if (
    source === "all" ||
    source === "official"
  ) {
    tasks.push(
      safe(
        "official",
        fetchOfficial
      )
    );
  }

  if (
    source === "all" ||
    source === "jin10"
  ) {
    tasks.push(
      safe(
        "jin10",
        fetchJin10
      )
    );
  }

  const lists =
    await Promise.all(
      tasks
    );

  const items =
    mergeNews(lists);

  // ------------------------------------------------------------
  // 返回
  // ------------------------------------------------------------

  const body = {
    items,

    count:
      items.length,

    fetchedAt:
      Date.now(),

    cache:
      "no-store",

    source:
      source,

    serverTime:
      new Date().toISOString(),
  };

  return new Response(
    JSON.stringify(body),
    {
      status: 200,
      headers,
    }
  );
}

// OPTIONS
export async function onRequestOptions() {
  return new Response(
    null,
    {
      status: 204,

      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          "GET, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type",

        "Cache-Control":
          "no-store",
      },
    }
  );
}
