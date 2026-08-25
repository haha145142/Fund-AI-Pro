#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A股辅助APP - Flask API 服务
=============================
封装基金持仓估值 + 八大科技板块 两个后端模块，
提供 HTTP API 供前端 HTML 页面调用。

仅个人本地使用，禁止LLM算数，所有计算后端硬算。

启动方式：
    python app.py
    # 浏览器访问 http://localhost:5000

API 列表：
    GET  /api/health                 健康检查
    GET  /api/portfolio              我的持仓总览（股票+基金）
    GET  /api/portfolio/stocks       股票持仓实时估值
    GET  /api/portfolio/funds        基金持仓实时估值
    GET  /api/portfolio/fund/<code>  单只基金估值详情
    GET  /api/sectors                八大科技板块实时涨跌+资金流
    GET  /api/sectors/comment        板块LLM点评
    POST /api/holdings/stocks        设置股票持仓
    POST /api/holdings/funds         设置基金持仓
    GET  /api/holdings               获取持仓配置
"""

import json
import os
from datetime import datetime
from flask import Flask, jsonify, request
from flask_cors import CORS

# 导入两个业务模块
from fund_holdings_valuation import (
    collect_realtime, estimate_fund, estimate_stocks,
    fetch_fund_top10, switch_after_15, is_trading_time,
    REDIS_PREFIX as FUND_REDIS_PREFIX, r,
)
from tech_sectors_valuation import (
    build_sector_data, get_cached_sector_data,
    generate_llm_comment, is_trading_time as sector_is_trading,
    REDIS_PREFIX as SECTOR_REDIS_PREFIX,
)

app = Flask(__name__)
CORS(app)  # 允许跨域，方便前端直接调用

# ============================================================
# 持仓数据持久化（简单版：JSON 文件，生产环境换 SQLite）
# ============================================================

HOLDINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "holdings.json")

DEFAULT_HOLDINGS = {
    "stocks": [
        # 示例数据，用户通过API修改
        # {"ticker": "600519", "name": "贵州茅台", "cost": 1800.0, "shares": 100, "fee": 5.0, "cash": 0},
    ],
    "funds": [
        # 示例数据
        # {"code": "320007", "name": "诺安成长混合", "last_nav": 1.5234, "buy_nav": 1.2000, "shares": 10000.0},
    ],
}


def load_holdings() -> dict:
    """加载持仓数据"""
    if os.path.exists(HOLDINGS_FILE):
        try:
            with open(HOLDINGS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return DEFAULT_HOLDINGS


def save_holdings(data: dict):
    """保存持仓数据"""
    with open(HOLDINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ============================================================
# 工具：统一响应格式
# ============================================================

def ok(data=None, msg="success"):
    return jsonify({"code": 0, "msg": msg, "data": data})


def err(msg="error", code=1):
    return jsonify({"code": code, "msg": msg, "data": None})


# ============================================================
# 健康检查
# ============================================================

@app.route("/api/health", methods=["GET"])
def health():
    """健康检查"""
    try:
        r.ping()
        redis_status = "ok"
    except Exception:
        redis_status = "disconnected"
    
    return ok({
        "status": "running",
        "redis": redis_status,
        "trading_time": is_trading_time(),
        "timestamp": datetime.now().isoformat(),
    })


# ============================================================
# 持仓管理 API
# ============================================================

@app.route("/api/holdings", methods=["GET"])
def get_holdings():
    """获取持仓配置"""
    holdings = load_holdings()
    return ok(holdings)


@app.route("/api/holdings/stocks", methods=["POST"])
def set_stock_holdings():
    """设置股票持仓
    Body: [{"ticker": "600519", "name": "贵州茅台", "cost": 1800, "shares": 100, "fee": 5, "cash": 0}, ...]
    """
    try:
        stocks = request.get_json(force=True)
        if not isinstance(stocks, list):
            return err("股票持仓格式错误，应为数组")
        
        holdings = load_holdings()
        holdings["stocks"] = stocks
        save_holdings(holdings)
        return ok({"count": len(stocks)}, "股票持仓已更新")
    except Exception as e:
        return err(f"保存失败: {e}")


@app.route("/api/holdings/funds", methods=["POST"])
def set_fund_holdings():
    """设置基金持仓
    Body: [{"code": "320007", "name": "诺安成长混合", "last_nav": 1.5234, "buy_nav": 1.2000, "shares": 10000}, ...]
    """
    try:
        funds = request.get_json(force=True)
        if not isinstance(funds, list):
            return err("基金持仓格式错误，应为数组")
        
        holdings = load_holdings()
        holdings["funds"] = funds
        save_holdings(holdings)
        return ok({"count": len(funds)}, "基金持仓已更新")
    except Exception as e:
        return err(f"保存失败: {e}")


# ============================================================
# 持仓估值 API
# ============================================================

@app.route("/api/portfolio", methods=["GET"])
def portfolio_overview():
    """持仓总览（股票+基金合并）"""
    holdings = load_holdings()
    stock_holdings = holdings.get("stocks", [])
    fund_holdings = holdings.get("funds", [])
    
    # 收集所有secid
    stock_codes = [s["ticker"] for s in stock_holdings]
    fund_top10_map = {}
    
    for fund in fund_holdings:
        code = fund["code"]
        top10_codes, _, _ = fetch_fund_top10(code)
        fund_top10_map[code] = top10_codes
    
    # 采集实时行情
    realtime = collect_realtime(stock_codes, fund_top10_map)
    
    # 股票估值
    stock_result = estimate_stocks(stock_holdings, realtime) if stock_holdings else {
        "total_assets": 0, "total_pnl": 0, "today_pnl": 0, "return_pct": 0, "stocks": {}
    }
    
    # 基金估值
    fund_details = []
    fund_total_assets = 0.0
    fund_total_pnl = 0.0
    fund_today_pnl = 0.0
    
    for fund in fund_holdings:
        code = fund["code"]
        # 先看有没有官方净值（15点后）
        official_key = f"{FUND_REDIS_PREFIX}official:{code}"
        official = r.get(official_key)
        
        if official:
            official_data = json.loads(official)
            fund_details.append({
                "code": code,
                "name": fund.get("name", code),
                **official_data,
            })
            fund_total_assets += official_data.get("total_assets", 0)
            fund_total_pnl += official_data.get("floating_pnl", 0)
        else:
            est = estimate_fund(
                code, fund.get("name", ""),
                fund.get("last_nav", 1.0),
                fund.get("buy_nav", 1.0),
                fund.get("shares", 0),
                realtime,
            )
            fund_details.append({
                "code": code,
                "name": fund.get("name", code),
                **est,
            })
            fund_total_assets += est.get("total_assets", 0)
            fund_total_pnl += est.get("floating_pnl", 0)
            # 估算今日盈亏 = 估算净值 - 昨收净值 * 份额
            last_nav = fund.get("last_nav", 1.0)
            shares = fund.get("shares", 0)
            fund_today_pnl += (est.get("est_nav", last_nav) - last_nav) * shares
    
    total_assets = stock_result["total_assets"] + fund_total_assets
    total_pnl = stock_result["total_pnl"] + fund_total_pnl
    today_pnl = stock_result["today_pnl"] + fund_today_pnl
    
    return ok({
        "total_assets": round(total_assets, 2),
        "total_pnl": round(total_pnl, 2),
        "today_pnl": round(today_pnl, 2),
        "stock_assets": round(stock_result["total_assets"], 2),
        "fund_assets": round(fund_total_assets, 2),
        "stocks": stock_result["stocks"],
        "funds": fund_details,
        "timestamp": realtime.get("timestamp", datetime.now().isoformat()),
        "trading_time": is_trading_time(),
    })


@app.route("/api/portfolio/stocks", methods=["GET"])
def portfolio_stocks():
    """股票持仓实时估值"""
    holdings = load_holdings()
    stock_holdings = holdings.get("stocks", [])
    
    if not stock_holdings:
        return ok({"stocks": {}, "total_assets": 0, "total_pnl": 0, "today_pnl": 0})
    
    stock_codes = [s["ticker"] for s in stock_holdings]
    realtime = collect_realtime(stock_codes, {})
    result = estimate_stocks(stock_holdings, realtime)
    
    return ok(result)


@app.route("/api/portfolio/funds", methods=["GET"])
def portfolio_funds():
    """基金持仓实时估值"""
    holdings = load_holdings()
    fund_holdings = holdings.get("funds", [])
    
    if not fund_holdings:
        return ok({"funds": [], "total_assets": 0, "total_pnl": 0})
    
    # 收集重仓股
    fund_top10_map = {}
    for fund in fund_holdings:
        code = fund["code"]
        top10_codes, _, _ = fetch_fund_top10(code)
        fund_top10_map[code] = top10_codes
    
    realtime = collect_realtime([], fund_top10_map)
    
    fund_details = []
    total_assets = 0.0
    total_pnl = 0.0
    
    for fund in fund_holdings:
        code = fund["code"]
        # 检查官方净值
        official_key = f"{FUND_REDIS_PREFIX}official:{code}"
        official = r.get(official_key)
        
        if official:
            official_data = json.loads(official)
            fund_details.append({
                "code": code,
                "name": fund.get("name", code),
                **official_data,
            })
            total_assets += official_data.get("total_assets", 0)
            total_pnl += official_data.get("floating_pnl", 0)
        else:
            est = estimate_fund(
                code, fund.get("name", ""),
                fund.get("last_nav", 1.0),
                fund.get("buy_nav", 1.0),
                fund.get("shares", 0),
                realtime,
            )
            fund_details.append({
                "code": code,
                "name": fund.get("name", code),
                **est,
            })
            total_assets += est.get("total_assets", 0)
            total_pnl += est.get("floating_pnl", 0)
    
    return ok({
        "funds": fund_details,
        "total_assets": round(total_assets, 2),
        "total_pnl": round(total_pnl, 2),
        "timestamp": realtime.get("timestamp", datetime.now().isoformat()),
    })


@app.route("/api/portfolio/fund/<code>", methods=["GET"])
def fund_detail(code):
    """单只基金估值详情（含三路估值数据）"""
    holdings = load_holdings()
    fund_holdings = holdings.get("funds", [])
    
    fund = next((f for f in fund_holdings if f["code"] == code), None)
    if not fund:
        return err(f"未找到基金 {code}")
    
    # 检查官方净值
    official_key = f"{FUND_REDIS_PREFIX}official:{code}"
    official = r.get(official_key)
    if official:
        return ok(json.loads(official))
    
    # 实时估算
    top10_codes, _, _ = fetch_fund_top10(code)
    realtime = collect_realtime([], {code: top10_codes})
    
    est = estimate_fund(
        code, fund.get("name", ""),
        fund.get("last_nav", 1.0),
        fund.get("buy_nav", 1.0),
        fund.get("shares", 0),
        realtime,
    )
    
    # 附加前十大重仓股信息
    top10_codes, top10_weights, quarter = fetch_fund_top10(code)
    top10_detail = []
    stocks = realtime.get("stocks", {})
    for c, w in zip(top10_codes, top10_weights):
        top10_detail.append({
            "code": c,
            "weight": w,
            "name": stocks.get(c, {}).get("name", ""),
            "change_pct": stocks.get(c, {}).get("change_pct"),
        })
    
    est["top10"] = top10_detail
    est["quarter"] = quarter
    
    return ok(est)


# ============================================================
# 科技板块 API
# ============================================================

@app.route("/api/sectors", methods=["GET"])
def sectors_realtime():
    """八大科技板块实时涨跌+资金流"""
    # 优先读缓存
    cached = get_cached_sector_data()
    
    if cached and sector_is_trading():
        # 交易时段：如果缓存太旧（>8秒），主动刷新一次
        try:
            ts = datetime.fromisoformat(cached["timestamp"])
            if (datetime.now() - ts).total_seconds() > 8:
                # 后台异步刷新，这里先返回缓存
                # 实际用定时任务，这里兜底触发一次
                pass
        except Exception:
            pass
        return ok(cached)
    
    # 非交易时段或无缓存，直接采集
    if not cached:
        data = build_sector_data()
        return ok(data)
    
    return ok(cached)


@app.route("/api/sectors/comment", methods=["GET"])
def sectors_comment():
    """板块LLM一句话点评"""
    cached = get_cached_sector_data()
    if not cached:
        # 没有数据就先采一次
        cached = build_sector_data()
    
    # 检查点评缓存
    comment_key = f"{SECTOR_REDIS_PREFIX}comment"
    cached_comment = r.get(comment_key)
    
    if cached_comment:
        return ok(json.loads(cached_comment))
    
    # 生成点评
    comment = generate_llm_comment(cached)
    result = {
        "comment": comment,
        "timestamp": datetime.now().isoformat(),
    }
    
    # 缓存30秒
    r.setex(comment_key, 30, json.dumps(result, ensure_ascii=False))
    
    return ok(result)


# ============================================================
# 手动触发刷新（调试用）
# ============================================================

@app.route("/api/refresh/sectors", methods=["POST"])
def refresh_sectors():
    """手动刷新板块数据"""
    data = build_sector_data()
    return ok({"count": len(data["sectors"]), "timestamp": data["timestamp"]})


@app.route("/api/refresh/portfolio", methods=["POST"])
def refresh_portfolio():
    """手动刷新持仓估值（触发一次实时采集）"""
    holdings = load_holdings()
    stock_codes = [s["ticker"] for s in holdings.get("stocks", [])]
    
    fund_top10_map = {}
    for fund in holdings.get("funds", []):
        code = fund["code"]
        top10_codes, _, _ = fetch_fund_top10(code)
        fund_top10_map[code] = top10_codes
    
    realtime = collect_realtime(stock_codes, fund_top10_map)
    return ok({
        "stock_count": len(realtime["stocks"]),
        "index_count": len(realtime["indices"]),
        "timestamp": realtime["timestamp"],
    })


# ============================================================
# 启动入口
# ============================================================

def start_scheduler():
    """启动定时任务（APScheduler）"""
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
    except ImportError:
        print("[WARN] 未安装 apscheduler，定时任务未启动")
        return None
    
    scheduler = BackgroundScheduler(timezone="Asia/Shanghai")
    
    # --- 持仓相关 ---
    def job_realtime_holdings():
        if not is_trading_time():
            return
        holdings = load_holdings()
        stock_codes = [s["ticker"] for s in holdings.get("stocks", [])]
        fund_top10_map = {}
        for fund in holdings.get("funds", []):
            code = fund["code"]
            top10_codes, _, _ = fetch_fund_top10(code)
            fund_top10_map[code] = top10_codes
        collect_realtime(stock_codes, fund_top10_map)
    
    def job_check_official_nav():
        """15:00后轮询官方净值"""
        now = datetime.now()
        if now.hour < 15 or now.weekday() >= 5:
            return
        holdings = load_holdings()
        for fund in holdings.get("funds", []):
            switch_after_15(
                fund["code"], fund.get("name", ""),
                fund.get("buy_nav", 1.0), fund.get("shares", 0),
            )
    
    # --- 科技板块相关 ---
    def job_refresh_sectors():
        if not sector_is_trading():
            return
        build_sector_data()
    
    def job_llm_comment():
        if not sector_is_trading():
            return
        data = get_cached_sector_data()
        if data:
            comment = generate_llm_comment(data)
            r.setex(f"{SECTOR_REDIS_PREFIX}comment", 30, json.dumps({
                "comment": comment,
                "timestamp": datetime.now().isoformat(),
            }, ensure_ascii=False))
    
    # 注册定时任务
    scheduler.add_job(job_realtime_holdings, 'interval', seconds=5, id='holdings_realtime')
    scheduler.add_job(job_check_official_nav, 'interval', minutes=1, id='official_nav')
    scheduler.add_job(job_refresh_sectors, 'interval', seconds=5, id='sectors_realtime')
    scheduler.add_job(job_llm_comment, 'interval', seconds=30, id='sectors_comment')
    
    scheduler.start()
    print("[OK] 定时任务已启动（5秒刷新行情，60秒轮询净值，30秒生成点评）")
    return scheduler


if __name__ == "__main__":
    print("=" * 60)
    print("A股辅助APP - Flask API 服务")
    print("=" * 60)
    print()
    print("API 地址: http://localhost:5000")
    print()
    print("主要接口：")
    print("  GET  /api/health                 健康检查")
    print("  GET  /api/portfolio              持仓总览")
    print("  GET  /api/portfolio/stocks       股票持仓")
    print("  GET  /api/portfolio/funds        基金持仓")
    print("  GET  /api/portfolio/fund/<code>  单只基金详情")
    print("  GET  /api/sectors                八大科技板块")
    print("  GET  /api/sectors/comment        板块点评")
    print("  POST /api/holdings/stocks        设置股票持仓")
    print("  POST /api/holdings/funds         设置基金持仓")
    print()
    
    # 启动定时任务
    scheduler = start_scheduler()
    
    # 启动 Flask
    app.run(host="0.0.0.0", port=5000, debug=False)
