# Fund AI Pro v2 · 优化版

基于原 `index.html` 重构的基金智能决策台前端，保留原有全部功能与视觉风格，落地以下优化。

## 主要优化

- **架构**：`Store` 响应式状态管理 + `Component` 组件基类，数据与视图自动同步、职责单一。
- **API**：统一 `ApiClient`，支持超时 / 指数退避重试 / 缓存降级；数据并行拉取（`Promise.allSettled`）。
- **性能**：页面级 `content-visibility:auto` 懒渲染；`prefers-reduced-motion` 减少动画；工具函数含防抖/节流。
- **体验**：完整暗色模式（跟随系统）；移动端 `touchstart` 优化消除 300ms 延迟；Toast 替代 alert。
- **安全**：新增 CSP 响应头策略；DeepSeek API Key 建议通过后端代理（见下方），避免前端明文暴露。
- **离线**：配套 `sw.js` Service Worker，静态资源缓存，断网可降级访问。
- **健壮**：所有数据获取 try/catch + 降级；localStorage 读写容错；数据源状态可视化。

## 文件

- `index.html` — 主页面（已内联核心 CSS/JS，单文件可直接打开）。
- `sw.js` — Service Worker 离线缓存（需 HTTPS 或 localhost 生效）。
- `README.md` — 本说明。

## 部署建议

1. **静态托管**：Cloudflare Pages / GitHub Pages / Vercel 均可，将本目录作为站点根目录。
2. **API 代理**：`/api/sectors`、`/api/news`、`/api/fund-rank`、`/api/funds`、`/api/market` 需由部署平台的函数/Workers 提供（代理到天天基金、东方财富、腾讯行情等真实数据源），解决浏览器跨域。
3. **AI Key 安全**：在 Cloudflare Pages 环境变量配置 `DEEPSEEK_API_KEY`，新增 `/api/deepseek` 代理端点，前端不再直接持有 Key。
4. **HTTPS**：Service Worker 与 Geolocation/通知等能力均要求 HTTPS（localhost 除外）。

## 使用

直接用浏览器打开 `index.html` 即可看到界面与交互（数据接口需配合代理环境返回真实数据，否则显示"正在读取…"的空状态，不会编造数据）。

> 本工具仅做数据展示与参考，不构成投资建议。
