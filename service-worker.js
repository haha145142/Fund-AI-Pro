// Fund AI Pro · Service Worker
// 离线策略：缓存外壳，数据显示"当前离线，数据源不可用"，绝不伪装实时数据

const CACHE_NAME = 'fund-ai-pro-v3';
const CACHE_URLS = ['/', '/index.html', '/manifest.json'];

// 安装：缓存核心外壳
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 请求拦截策略
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理 GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 导航请求（HTML 页面）：网络优先，失败回退缓存
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put('/', copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // API 请求（Cloudflare Functions）：网络优先，失败返回离线标记
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (!resp.ok) throw new Error('api error');
          return resp;
        })
        .catch(() => {
          return new Response(JSON.stringify({ error: 'offline', message: '当前离线，数据源不可用' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        })
    );
    return;
  }

  // 外部 API 请求（行情/新闻/基金数据）：网络优先，失败时返回标记数据
  // 重要：离线时不返回假数据，让前端显示"暂无可靠数据"
  if (url.hostname.includes('eastmoney.com') ||
      url.hostname.includes('tiantianfunds.com') ||
      url.hostname.includes('gtimg.cn') ||
      url.hostname.includes('awtmt.com') ||
      url.hostname.includes('10jqka.com.cn') ||
      url.hostname.includes('deepseek.com')) {
    event.respondWith(
      fetch(req)
        .then((resp) => resp)
        .catch(() => {
          return new Response(JSON.stringify({ error: 'offline', message: '当前离线，数据源不可用' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        })
    );
    return;
  }

  // 同源静态资源：缓存优先
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => cached))
    );
    return;
  }
});
