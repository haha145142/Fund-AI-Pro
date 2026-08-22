# Fund AI Pro · 基金智能决策台

> 给普通基金投资者使用的智能基金观察与决策辅助工具。
> 真实数据 · 多源验证 · 不编造 · 不构成投资建议。

## 核心功能

- **基金持仓**：用户自加任意基金，自动识别名称/类型，localStorage 自动保存
- **实时估值**：天天基金/东方财富多源估值，收盘后切换官方净值
- **波段信号**：RSI / BIAS / BOLL / MA / MACD 综合评分（0-100）
- **趋势强弱**：MA5/10/20/60 + MACD 趋势评分
- **波段+趋势组合**：低位+走强=反转观察区，高位+走弱=回撤压力 等
- **8大科技板块**：存储芯片/国产算力/半导体/半导体设备材料/PCB/CPO光模块/通信技术/MLCC
- **资金流向 TOP5**：全市场净流入/流出排行
- **谁在买卖**：主力/超大单/大单/中小单订单分层
- **AI 资金博弈**：基于真实数据的事实/判断/风险分析
- **三源新闻**：华尔街见闻 + 东方财富 + 同花顺，AI 一句话解读
- **基金排行**：涨幅/跌幅 TOP5 实时更新
- **操作建议**：数据规则生成，含置信度和风险等级
- **中长期布局**：产业趋势动态分析
- **组合体检**：行业集中度/相关性/波动/回撤
- **AI 综合解读**：今日一句话/市场/资金/板块/新闻/政策/外围/历史
- **DeepSeek AI**：支持 Cloudflare 代理（安全）或浏览器直连（个人）
- **无 Key 规则版**：AI 不可用时规则引擎生成白话分析，不显示空白
- **PWA**：可添加到主屏幕，离线显示最近数据（不伪装实时）
- **五 Tab 导航**：首页/市场/基金/组合/AI，液态玻璃悬浮导航

## 项目结构

```
Fund-AI-Pro/
├── index.html              # 主应用（单文件，含全部 UI + 逻辑）
├── manifest.json           # PWA 配置
├── service-worker.js       # PWA 离线缓存
├── assets/
│   ├── icon180.png         # Apple Touch Icon
│   ├── icon192.png         # PWA 图标 192x192
│   └── icon512.png         # PWA 图标 512x512
├── functions/
│   └── api/
│       ├── ai.js           # DeepSeek AI 代理（Key 放环境变量）
│       ├── news.js         # 新闻源代理（解决 CORS）
│       ├── funds.js        # 基金估值代理（解决 CORS）
│       ├── market.js       # 板块/指数/订单/基金排行/历史净值代理（解决 CORS）
│       └── global.js       # 外围市场代理（解决 CORS）
└── README.md               # 本文件
```

## 部署方式

### 方式一：GitHub + Cloudflare Pages（推荐）

1. **上传到 GitHub**
   ```bash
   git init
   git add .
   git commit -m "Fund AI Pro 基金智能决策台"
   git branch -M main
   git remote add origin https://github.com/你的用户名/fund-ai-pro.git
   git push -u origin main
   ```

2. **在 Cloudflare Pages 创建项目**
   - 登录 [dash.cloudflare.com](https://dash.cloudflare.com)
   - 进入 **Workers & Pages** → **Pages** → **Create application**
   - 选择 **Connect to Git** → 授权 GitHub → 选择 `fund-ai-pro` 仓库
   - 构建配置：
     - Framework preset: `None`
     - Build command: （留空）
     - Build output directory: `/`（根目录）
   - 点击 **Deploy**

3. **配置环境变量（重要）**
   - 进入项目 → **Settings** → **Environment Variables**
   - 添加：
     - 变量名: `DEEPSEEK_API_KEY`
     - 值: `sk-你的DeepSeek密钥`
   - 重新部署生效

4. **访问**
   - 部署完成后获得 `https://fund-ai-pro.pages.dev` 链接
   - 手机/电脑直接打开即可使用

### 方式二：直接上传（最快）

1. 登录 Cloudflare Pages → **Create application** → **Upload assets**
2. 将项目文件夹内所有文件拖入
3. 点击 **Deploy site**
4. 约 30 秒后获得 `https://xxx.pages.dev` 链接

## 环境变量配置

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥，用于 AI 分析 | 否（不填则使用规则版） |

**安全说明**：
- 生产环境**强烈推荐**使用 Cloudflare 环境变量配置 Key
- 前端通过 `/api/ai` 代理调用 DeepSeek，Key 不会暴露给访客
- 个人本地使用时也可在前端"AI 服务设置"中直接输入 Key（存 localStorage）

## 本地开发

```bash
# 方式一：直接用浏览器打开 index.html 即可运行（大部分功能可用）
# 方式二：用 Cloudflare Pages 本地模拟（支持 Functions 代理）
npx wrangler pages dev .
```

## 数据源说明

| 数据 | 来源 | 说明 |
|------|------|------|
| 基金估值 | 天天基金 / 东方财富 | 多源交叉，失败显示"暂无" |
| 基金历史 | 东方财富 pingzhongdata | 用于计算 RSI/BIAS/BOLL/MACD |
| 板块行情 | 东方财富 clist | 行业+概念板块 |
| 指数 | 东方财富 ulist | 上证/深成/创业/科创 |
| 全A股订单 | 东方财富 clist | 超大/大/中/小单分层 |
| 外围市场 | 腾讯 qt.gtimg.cn | 道琼斯/纳指/恒生等 |
| 新闻 | 华尔街见闻 + 东方财富 + 同花顺 | 三源去重，最新优先 |
| 基金排行 | 东方财富 rankhandler | 涨幅/跌幅 TOP5 |
| AI 分析 | DeepSeek | 通过 /api/ai 代理或浏览器直连 |

## 重要原则

1. **禁止模拟数据**：所有核心行情来自真实数据源，无数据时显示"暂无可靠数据"
2. **多源交叉验证**：基金估值、板块行情尽量多源比对
3. **错误隔离**：单个接口失败不影响其他模块，不会白屏
4. **AI 严禁编造**：AI 只分析已抓到的真实数据，数据不足时明确告知
5. **区分事实与推断**：AI 输出区分【事实】【判断】【风险】
6. **不构成投资建议**：所有分析仅供参考

## 技术栈

- 纯前端 HTML/CSS/JavaScript（无构建步骤）
- Cloudflare Pages Functions（API 代理）
- localStorage（持仓持久化）
- Service Worker（PWA 离线）
- DeepSeek API（AI 分析）

## 仅供参考，不构成投资建议
