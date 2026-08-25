#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FundHoldings - A股+场外基金持仓盘中实时估值模块
=========================================================
仅个人本地使用，禁止LLM算数，所有计算后端硬算。

四大核心函数：
  1. collect_realtime()    — 采集：股票+基金重仓股+指数 实时行情
  2. estimate_fund()       — 估算：三路反推盘中估值
  3. cross_validate()      — 交叉验证：路A/路B/路C 分歧判定
  4. switch_after_15()     — 15点切换：轮询官方净值，拿到即停估算

依赖：requests, akshare(兜底), apscheduler, redis, json, hashlib
"""

import re
import json
import time
import hashlib
import requests
import redis
from datetime import datetime, date, timedelta
from typing import List, Dict, Tuple, Optional

# ============================================================
# 配置
# ============================================================

REDIS_PREFIX = "fundhold:"

# 兜底四指数（风格指数）
STYLE_INDICES = {
    "hs300":   {"code": "000300", "name": "沪深300",   "secid": "0.000300"},
    "zz500":   {"code": "000905", "name": "中证500",   "secid": "0.000905"},
    "cyb":     {"code": "399006", "name": "创业板指",  "secid": "0.399006"},
    "zzxf":    {"code": "000932", "name": "中证消费",  "secid": "0.000932"},
}

# 指数基金关键词 → 对应指数secid
INDEX_FUND_MAP = {
    "沪深300":    "0.000300",
    "中证500":    "0.000905",
    "创业板":     "0.399006",
    "科创50":     "0.000688",
    "中证半导体": "0.931865",
    "半导体":     "0.931865",
    "中证芯片":   "0.932419",
    "芯片":       "0.932419",
    "中证AI":     "0.931039",
    "人工智能":   "0.931039",
    "算力":       "0.931785",
    "中证算力":   "0.931785",
    "消费":       "0.000932",
    "医药":       "0.000933",
    "新能源":     "0.931038",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/",
}

r = redis.Redis(host="localhost", port=6379, db=0, decode_responses=True)


# ============================================================
# 工具函数
# ============================================================

def secid_of(code: str) -> str:
    """东财 secid 拼接：1.沪市 0.深市/指数"""
    code = code.strip()
    if code.startswith(("600", "601", "603", "688", "605", "689")):
        return f"1.{code}"
    if code.startswith(("000", "001", "002", "003", "300", "301", "159", "510", "512", "513", "515", "516", "518", "560", "561", "562", "563", "588")):
        return f"0.{code}"
    # 指数默认深市
    if len(code) == 6:
        return f"0.{code}"
    raise ValueError(f"无法识别交易所前缀: {code}")


def is_trading_time() -> bool:
    """判断是否在A股交易时段（9:30-11:30, 13:00-15:00）"""
    now = datetime.now()
    if now.weekday() >= 5:
        return False
    t = now.time()
    morning = (t.hour == 9 and t.minute >= 30) or (t.hour == 10) or (t.hour == 11 and t.minute <= 30)
    afternoon = (t.hour == 13) or (t.hour == 14) or (t.hour == 15 and t.minute == 0)
    return morning or afternoon


def is_index_fund(fund_name: str, fund_code: str) -> Optional[str]:
    """判断是否指数基金/ETF联接，返回对应指数secid，不是返回None"""
    name = fund_name or ""
    for keyword, secid in INDEX_FUND_MAP.items():
        if keyword in name:
            return secid
    if "ETF联接" in name or "ETF" in name:
        # ETF联接基金，尝试从名称提取标的
        # 简单处理：如果名称里有指数名就匹配，没有就用沪深300兜底
        return "0.000300"
    return None


# ============================================================
# 函数1：采集 — collect_realtime()
# ============================================================
def collect_realtime(stock_codes: List[str], fund_top10_map: Dict[str, List[str]]) -> Dict:
    """
    批量采集实时行情：股票 + 基金重仓股 + 风格指数 + 指数基金标的
    
    Args:
        stock_codes: A股持仓股票代码列表
        fund_top10_map: {fund_code: [stock_code1, stock_code2, ...]} 基金前十大重仓股代码
    
    Returns:
        dict: {"stocks": {}, "indices": {}, "timestamp": ""}
    
    接口：push2.eastmoney.com/api/qt/ulist.np/get
          单次请求拉所有标的，fields=f2,f3,f12,f14,f43,f169
    """
    # 收集所有需要查询的secid
    all_secids = set()
    
    # 1. 股票持仓
    for code in stock_codes:
        try:
            all_secids.add(secid_of(code))
        except ValueError:
            continue
    
    # 2. 基金前十大重仓股
    for fund_code, top10 in fund_top10_map.items():
        for stock_code in top10:
            try:
                all_secids.add(secid_of(stock_code))
            except ValueError:
                continue
    
    # 3. 风格指数（四档兜底）
    for idx_key, idx_info in STYLE_INDICES.items():
        all_secids.add(idx_info["secid"])
    
    if not all_secids:
        return {"stocks": {}, "indices": {}, "timestamp": datetime.now().isoformat()}
    
    secids_str = ",".join(sorted(all_secids))
    
    try:
        url = "https://push2.eastmoney.com/api/qt/ulist.np/get"
        params = {
            "secids": secids_str,
            "fields": "f2,f3,f12,f13,f14,f43,f169",
            "ut": "fa5fd1943c7b386f172d6893dbfba10b",
        }
        resp = requests.get(url, params=params, headers=HEADERS, timeout=8)
        data = resp.json()
        
        result = {"stocks": {}, "indices": {}, "timestamp": datetime.now().isoformat()}
        
        if data.get("data") and data["data"].get("diff"):
            for item in data["data"]["diff"]:
                code = str(item.get("f12", ""))
                name = item.get("f14", "")
                price = item.get("f43")    # 现价
                prev_close = item.get("f169")  # 昨收
                change_pct = item.get("f3")     # 涨跌幅%
                
                # 东财数字是放大100倍的整数，需要还原
                if isinstance(price, (int, float)) and price > 1000:
                    price = price / 100
                if isinstance(prev_close, (int, float)) and prev_close > 1000:
                    prev_close = prev_close / 100
                if isinstance(change_pct, (int, float)) and abs(change_pct) > 100:
                    change_pct = change_pct / 100
                
                entry = {
                    "code": code,
                    "name": name,
                    "price": price,
                    "prev_close": prev_close,
                    "change_pct": change_pct,  # 百分比，如 +1.23 表示 +1.23%
                }
                
                # 区分是股票还是指数
                is_index = code in [v["code"] for v in STYLE_INDICES.values()]
                if is_index:
                    result["indices"][code] = entry
                else:
                    result["stocks"][code] = entry
        
        # 写入Redis缓存
        r.setex(f"{REDIS_PREFIX}realtime:stocks", 60, json.dumps(result["stocks"], ensure_ascii=False))
        r.setex(f"{REDIS_PREFIX}realtime:indices", 60, json.dumps(result["indices"], ensure_ascii=False))
        r.setex(f"{REDIS_PREFIX}realtime:ts", 60, result["timestamp"])
        
        return result
    
    except Exception as e:
        # 东财接口失败，用AKShare兜底
        try:
            import akshare as ak
            # 简单兜底：用ak.stock_zh_a_spot_em() 但这个太慢
            # 实际使用中优先保证push2可用
            pass
        except ImportError:
            pass
        
        print(f"[ERROR] 采集失败: {e}")
        # 返回Redis缓存的旧数据
        cached_stocks = r.get(f"{REDIS_PREFIX}realtime:stocks")
        cached_indices = r.get(f"{REDIS_PREFIX}realtime:indices")
        return {
            "stocks": json.loads(cached_stocks) if cached_stocks else {},
            "indices": json.loads(cached_indices) if cached_indices else {},
            "timestamp": r.get(f"{REDIS_PREFIX}realtime:ts") or datetime.now().isoformat(),
        }


# ============================================================
# 函数2：基金持仓估算 — estimate_fund()
# ============================================================

def fetch_fund_top10(fund_code: str) -> Tuple[List[str], List[float], str]:
    """
    抓取基金前十大重仓股代码和占净值比
    接口：fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc
    
    Returns:
        (stock_codes, weights, quarter)
        stock_codes: 前十大股票代码列表
        weights: 占净值比列表（百分比，如8.52表示8.52%）
        quarter: 披露季度，如 "2024Q4"
    """
    cache_key = f"{REDIS_PREFIX}top10:{fund_code}"
    cached = r.get(cache_key)
    if cached:
        data = json.loads(cached)
        return data["codes"], data["weights"], data["quarter"]
    
    try:
        url = "https://fundf10.eastmoney.com/FundArchivesDatas.aspx"
        params = {"type": "jjcc", "code": fund_code, "topline": "10"}
        headers = {**HEADERS, "Referer": "https://fundf10.eastmoney.com/"}
        resp = requests.get(url, params=params, headers=headers, timeout=10)
        resp.encoding = "utf-8"
        html = resp.text
        
        # 提取占净值比（百分比）
        pcts = re.findall(r"(\d{1,2}\.\d{2})\s*%", html)
        weights = [float(x) for x in pcts[:10]]
        
        # 提取股票代码（6位数字，紧跟在名称或链接后）
        # 东财jjcc页面股票代码在a标签href里，形如 /s?code=688981
        stock_codes = re.findall(r"/s\?code=(\d{6})", html)
        stock_codes = stock_codes[:10]
        
        # 提取季度（页面里有"第X季度"或"XXXX年X季度"）
        quarter_match = re.search(r"(\d{4})年第?([一二三四1234])季度", html)
        if quarter_match:
            year = quarter_match.group(1)
            q_map = {"一": "1", "二": "2", "三": "3", "四": "4",
                     "1": "1", "2": "2", "3": "3", "4": "4"}
            quarter = f"{year}Q{q_map.get(quarter_match.group(2), '4')}"
        else:
            quarter = f"{date.today().year}Q4"  # 兜底
        
        if len(stock_codes) < len(weights):
            # 股票代码不够，补齐空字符串
            stock_codes += [""] * (len(weights) - len(stock_codes))
        
        # 缓存到Redis（季度内有效，最长90天）
        r.setex(cache_key, 86400 * 90, json.dumps({
            "codes": stock_codes,
            "weights": weights,
            "quarter": quarter,
        }, ensure_ascii=False))
        
        return stock_codes[:10], weights[:10], quarter
    
    except Exception as e:
        print(f"[ERROR] 抓取基金{fund_code}重仓股失败: {e}")
        return [], [], ""


def get_style_weights(fund_code: str, top10_codes: List[str], 
                      top10_weights: List[float], quarter: str,
                      llm_client=None) -> Dict[str, float]:
    """
    获取基金风格权重（沪深300/中证500/创业板/中证消费 四档）
    先查缓存，没有则丢给LLM判一次，结果缓存
    
    缓存key签名：fund_code + quarter + 持仓签名（前十大代码+权重）
    """
    # 计算持仓签名
    sig_src = f"{fund_code}:{quarter}:" + ",".join(
        f"{c}:{w:.2f}" for c, w in zip(top10_codes, top10_weights)
    )
    sig = hashlib.md5(sig_src.encode()).hexdigest()[:12]
    
    cache_key = f"{REDIS_PREFIX}style:{sig}"
    cached = r.get(cache_key)
    if cached:
        return json.loads(cached)
    
    # LLM判断风格权重
    if llm_client is None:
        # 没有LLM时，用规则兜底：按重仓股所属板块粗略分配
        # 简单规则：创业板占比高 → 创业板风格；主板大票多 → 沪深300
        cyb_count = sum(1 for c in top10_codes if c.startswith(("300", "301")))
        kc_count = sum(1 for c in top10_codes if c.startswith(("688", "689")))
        total = len(top10_codes) or 1
        
        default_style = {
            "hs300": max(0.2, 1 - cyb_count/total - kc_count/total),
            "zz500": 0.15,
            "cyb":    cyb_count / total,
            "zzxf":   0.05,
        }
        # 归一化
        s = sum(default_style.values())
        default_style = {k: v/s for k, v in default_style.items()}
        r.setex(cache_key, 86400 * 90, json.dumps(default_style))
        return default_style
    
    # 有LLM时调用（system prompt 见文件末尾 STYLE_IDENTIFY_PROMPT）
    try:
        holdings_desc = "\n".join(
            f"{i+1}. 股票代码 {c}，占净值比 {w:.2f}%"
            for i, (c, w) in enumerate(zip(top10_codes, top10_weights))
        )
        prompt = f"基金代码：{fund_code}\n披露季度：{quarter}\n前十大重仓股：\n{holdings_desc}"
        
        # 这里调用LLM，返回JSON格式
        # result = llm_client.chat(STYLE_IDENTIFY_PROMPT, prompt)
        # style_weights = json.loads(result)
        # r.setex(cache_key, 86400 * 90, json.dumps(style_weights))
        # return style_weights
        pass  # 实际使用时替换为真实LLM调用
    except Exception as e:
        print(f"[WARN] LLM风格识别失败，用规则兜底: {e}")
    
    # 兜底返回规则版
    return get_style_weights(fund_code, top10_codes, top10_weights, quarter, None)


def estimate_fund(fund_code: str, fund_name: str, 
                  last_official_nav: float, buy_nav: float, shares: float,
                  realtime_data: Dict, llm_client=None) -> Dict:
    """
    估算基金盘中涨跌（三路反推）
    
    Args:
        fund_code: 基金代码
        fund_name: 基金名称（用于判断是否指数基金）
        last_official_nav: 最新官方净值（昨收净值）
        buy_nav: 买入成本净值
        shares: 持有份额
        realtime_data: collect_realtime() 返回的实时行情数据
        llm_client: LLM客户端（用于风格识别，可选）
    
    Returns:
        dict: {
            "status": "estimating" | "official",
            "est_change_pct": float,    # 估算涨跌幅%
            "est_nav": float,           # 估算净值
            "floating_pnl": float,      # 浮动盈亏
            "return_pct": float,        # 持有收益率%
            "total_assets": float,      # 持仓市值
            "road_a": float,            # 路A：纯重仓加权
            "road_b": float,            # 路B：重仓+风格指数兜底
            "road_c": Optional[float],  # 路C：指数基金用跟踪指数
            "divergence": str,          # 分歧状态: ok / yellow / suspect
            "method": str,              # 最终使用的估算方法
            "timestamp": str,
        }
    """
    stocks = realtime_data.get("stocks", {})
    indices = realtime_data.get("indices", {})
    
    # 检查是不是指数基金/ETF联接
    index_secid = is_index_fund(fund_name, fund_code)
    road_c = None
    
    if index_secid:
        # 路C：直接用跟踪指数涨跌
        idx_code = index_secid.split(".")[1]
        if idx_code in indices:
            road_c = indices[idx_code]["change_pct"]
        elif idx_code in stocks:
            road_c = stocks[idx_code]["change_pct"]
    
    # 抓取前十大重仓股
    top10_codes, top10_weights, quarter = fetch_fund_top10(fund_code)
    
    # 路A：纯重仓加权
    road_a = 0.0
    total_weight = 0.0
    for code, weight in zip(top10_codes, top10_weights):
        if code and code in stocks and stocks[code]["change_pct"] is not None:
            road_a += weight * stocks[code]["change_pct"] / 100
            total_weight += weight
    
    # 路B：重仓 + 风格指数兜底（补剩余仓位）
    style_weights = get_style_weights(fund_code, top10_codes, top10_weights, quarter, llm_client)
    remaining_ratio = max(0, 100 - total_weight) / 100  # 剩余仓位比例
    
    style_contribution = 0.0
    for style_key, style_w in style_weights.items():
        idx_info = STYLE_INDICES.get(style_key)
        if idx_info and idx_info["code"] in indices:
            idx_change = indices[idx_info["code"]]["change_pct"] or 0
            style_contribution += style_w * idx_change / 100  # 风格指数涨跌幅×风格权重
    
    road_b = road_a + style_contribution * remaining_ratio
    
    # 选择最终估值
    final_est, divergence, method = cross_validate(road_a, road_b, road_c)
    
    # 计算估算净值和盈亏
    est_change_pct = final_est * 100  # 转成百分比
    est_nav = last_official_nav * (1 + final_est)
    floating_pnl = (est_nav - buy_nav) * shares
    return_pct = (est_nav - buy_nav) / buy_nav * 100 if buy_nav > 0 else 0
    total_assets = est_nav * shares
    
    return {
        "status": "estimating",
        "est_change_pct": round(est_change_pct, 4),
        "est_nav": round(est_nav, 4),
        "floating_pnl": round(floating_pnl, 2),
        "return_pct": round(return_pct, 2),
        "total_assets": round(total_assets, 2),
        "road_a": round(road_a * 100, 4),     # 转百分比
        "road_b": round(road_b * 100, 4),
        "road_c": round(road_c, 4) if road_c is not None else None,
        "divergence": divergence,
        "method": method,
        "quarter": quarter,
        "timestamp": datetime.now().isoformat(),
    }


# ============================================================
# 函数3：交叉验证 — cross_validate()
# ============================================================

def cross_validate(road_a: float, road_b: float, road_c: Optional[float]) -> Tuple[float, str, str]:
    """
    三路估值交叉验证
    
    Args:
        road_a: 路A（纯重仓加权）涨跌幅，小数形式（如0.0123 = +1.23%）
        road_b: 路B（重仓+风格兜底）涨跌幅，小数
        road_c: 路C（指数基金跟踪指数）涨跌幅，None表示不是指数基金
    
    Returns:
        (final_est, divergence, method)
        final_est: 最终采用的估算涨跌幅
        divergence: "ok" | "yellow" | "suspect"
        method: 使用的方法描述
    """
    # 指数基金：路C最准，直接用路C
    if road_c is not None:
        road_c_decimal = road_c / 100  # 转小数
        # 如果路A有路C也有，交叉验证一下
        diff_ac = abs(road_a - road_c_decimal)
        if diff_ac < 0.003:  # < 0.3%
            return road_c_decimal, "ok", "指数基金·跟踪指数（路C）"
        elif diff_ac < 0.008:  # 0.3%~0.8%
            return (road_a + road_c_decimal) / 2, "yellow", "指数基金·跟踪指数与重仓加权有分歧（取均值）"
        else:
            return road_c_decimal, "suspect", "指数基金·疑似调仓（重仓与跟踪指数偏差大）"
    
    # 主动基金：路A vs 路B
    diff_ab = abs(road_a - road_b)
    
    if diff_ab < 0.003:  # < 0.3%，一致
        return road_b, "ok", "主动基金·重仓+风格兜底（路B）"
    elif diff_ab < 0.008:  # 0.3% ~ 0.8%，有分歧
        return (road_a + road_b) / 2, "yellow", "主动基金·两路估值有分歧（取均值）"
    else:  # > 0.8%，疑似调仓
        return road_b, "suspect", "主动基金·疑似调仓（两路偏差>0.8%）"


# ============================================================
# 函数4：15点切换 — switch_after_15()
# ============================================================

def fetch_official_nav(fund_code: str) -> Optional[Dict]:
    """
    抓取基金官方净值（收盘后用）
    接口：fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz
    
    Returns:
        {"nav": float, "date": "YYYY-MM-DD", "change_pct": float} 或 None
    """
    try:
        # 方法1：东财F10历史净值接口
        url = "https://fund.eastmoney.com/f10/F10DataApi.aspx"
        params = {
            "type": "lsjz",
            "code": fund_code,
            "page": 1,
            "sdate": "",
            "edate": "",
            "per": 5,
        }
        headers = {**HEADERS, "Referer": "https://fund.eastmoney.com/"}
        resp = requests.get(url, params=params, headers=headers, timeout=8)
        resp.encoding = "utf-8"
        text = resp.text
        
        # 解析：每行格式 日期|净值|累计净值|增长率
        # 正则提取最新一条
        rows = re.findall(r"(\d{4}-\d{2}-\d{2})\|([\d.]+)\|[\d.]+\|(-?[\d.]+)%", text)
        if rows:
            latest = rows[0]  # 最新的在最前面
            return {
                "date": latest[0],
                "nav": float(latest[1]),
                "change_pct": float(latest[2]),
            }
        
        # 方法2：AKShare兜底
        try:
            import akshare as ak
            df = ak.fund_open_fund_info_em(symbol=fund_code, indicator="单位净值走势")
            if not df.empty:
                latest = df.iloc[0]
                return {
                    "date": str(latest.iloc[0]),
                    "nav": float(latest.iloc[1]),
                    "change_pct": float(latest.iloc[2]) if len(latest) > 2 else 0,
                }
        except (ImportError, Exception):
            pass
        
        return None
    
    except Exception as e:
        print(f"[ERROR] 抓取基金{fund_code}官方净值失败: {e}")
        return None


def switch_after_15(fund_code: str, fund_name: str,
                    buy_nav: float, shares: float) -> Optional[Dict]:
    """
    15:00后轮询官方净值，拿到就切official状态
    
    逻辑：
    - 15:00开始，每60秒调用一次 fetch_official_nav()
    - 拿到当日净值 → 状态置official，前端停估算改显官方净值
    - 次日9:30自动切回 estimating（由定时任务控制）
    
    Returns:
        官方净值数据dict，包含status="official"，未拿到返回None
    """
    result = fetch_official_nav(fund_code)
    if not result:
        return None
    
    today = date.today().isoformat()
    
    # 判断是不是今天的净值
    if result["date"] == today:
        # 是今日官方净值
        nav = result["nav"]
        floating_pnl = (nav - buy_nav) * shares
        return_pct = (nav - buy_nav) / buy_nav * 100 if buy_nav > 0 else 0
        total_assets = nav * shares
        
        official_data = {
            "status": "official",
            "official_nav": nav,
            "official_date": result["date"],
            "change_pct": result["change_pct"],
            "floating_pnl": round(floating_pnl, 2),
            "return_pct": round(return_pct, 2),
            "total_assets": round(total_assets, 2),
            "timestamp": datetime.now().isoformat(),
        }
        
        # 写入Redis
        r.setex(f"{REDIS_PREFIX}official:{fund_code}", 86400, 
                json.dumps(official_data, ensure_ascii=False))
        
        return official_data
    
    return None  # 还没出今天的净值


# ============================================================
# 股票持仓估值（简单版）
# ============================================================

def estimate_stocks(stock_holdings: List[Dict], realtime_data: Dict) -> Dict:
    """
    股票持仓实时估值（直接算，不用LLM）
    
    Args:
        stock_holdings: [{"ticker": "600519", "market": 1, "cost": 1800, "shares": 100, "fee": 5.0, "cash": 0}, ...]
        realtime_data: collect_realtime() 返回的数据
    
    Returns:
        {"total_assets": float, "total_pnl": float, "today_pnl": float, 
         "return_pct": float, "stocks": {...}}
    """
    stocks = realtime_data.get("stocks", {})
    total_assets = 0.0
    total_cost = 0.0
    total_pnl = 0.0
    today_pnl = 0.0
    stock_details = {}
    
    for h in stock_holdings:
        code = h["ticker"]
        cost = h["cost"]
        shares = h["shares"]
        fee = h.get("fee", 0)
        cash = h.get("cash", 0)
        
        if code in stocks and stocks[code]["price"] is not None:
            price = stocks[code]["price"]
            prev_close = stocks[code].get("prev_close", price)
            
            market_value = price * shares
            cost_value = cost * shares + fee
            pnl = market_value - cost_value
            day_pnl = (price - prev_close) * shares
            
            total_assets += market_value
            total_cost += cost_value
            total_pnl += pnl
            today_pnl += day_pnl
            
            stock_details[code] = {
                "name": stocks[code]["name"],
                "price": price,
                "prev_close": prev_close,
                "change_pct": stocks[code]["change_pct"],
                "shares": shares,
                "cost": cost,
                "market_value": round(market_value, 2),
                "pnl": round(pnl, 2),
                "return_pct": round(pnl / cost_value * 100, 2) if cost_value > 0 else 0,
                "today_pnl": round(day_pnl, 2),
            }
        else:
            # 没有行情数据，用成本价
            total_assets += cost * shares + cash
            total_cost += cost * shares + fee
    
    total_assets += sum(h.get("cash", 0) for h in stock_holdings)
    return_pct = total_pnl / total_cost * 100 if total_cost > 0 else 0
    
    return {
        "total_assets": round(total_assets, 2),
        "total_pnl": round(total_pnl, 2),
        "today_pnl": round(today_pnl, 2),
        "return_pct": round(return_pct, 2),
        "stocks": stock_details,
        "timestamp": datetime.now().isoformat(),
    }


# ============================================================
# LLM System Prompt：基金风格识别
# ============================================================

STYLE_IDENTIFY_PROMPT = """你是一个专业的基金风格分析助手。根据基金前十大重仓股的代码和占净值比，判断该基金的投资风格偏向于以下四类指数的权重分配：

四类风格指数：
1. 沪深300（大盘价值/成长风格，主板大市值蓝筹）
2. 中证500（中盘成长风格，中等市值公司）
3. 创业板（成长风格，创业板股票，代码300/301开头）
4. 中证消费（消费主题，食品饮料、医药消费等）

判断规则：
- 重仓股中688开头（科创板）和300/301开头（创业板）占比高 → 创业板/成长风格权重高
- 重仓股中600/601/603开头且都是大市值蓝筹 → 沪深300权重高
- 重仓股中002开头（中小板）和中等市值公司多 → 中证500权重高
- 重仓股中食品饮料、医药、消费类股票多 → 中证消费权重高
- 四个权重之和必须等于 1.0（即100%）
- 只看前十大持仓，剩余仓位的风格也要按已知持仓推断

输出格式：严格的JSON，不要任何其他文字。
{
  "hs300": 0.xx,
  "zz500": 0.xx,
  "cyb": 0.xx,
  "zzxf": 0.xx,
  "confidence": "high/medium/low",
  "reason": "一句话说明判断依据"
}

注意：
- 不要编造股票名称，只根据代码前缀和占比判断
- 四个权重加起来必须等于 1.0
- 只输出JSON，不要解释，不要markdown"""


# ============================================================
# Redis 键设计
# ============================================================
"""
=== Redis 键设计 ===

前缀: fundhold:

1. 实时行情缓存（60秒过期）
   fundhold:realtime:stocks    → JSON {code: {price, change_pct, ...}}
   fundhold:realtime:indices   → JSON {code: {price, change_pct, ...}}
   fundhold:realtime:ts        → ISO时间戳字符串

2. 基金前十大重仓股缓存（季度内有效，90天过期）
   fundhold:top10:{fund_code}  → JSON {codes: [...], weights: [...], quarter: "2024Q4"}

3. 基金风格权重缓存（季度+持仓签名，90天过期）
   fundhold:style:{md5sig}     → JSON {hs300: 0.x, zz500: 0.x, cyb: 0.x, zzxf: 0.x}
   sig = md5(fund_code:quarter:code1:w1,code2:w2,...)[:12]

4. 官方净值缓存（24小时过期）
   fundhold:official:{fund_code} → JSON {status:"official", nav, date, change_pct, ...}

5. 股票持仓（本地持久化，用SQLite或JSON，Redis只存实时计算结果）
   fundhold:stock_holdings      → JSON list，用户手动维护
   fundhold:fund_holdings       → JSON list，用户手动维护

6. 估算偏差历史（用于连续3日偏差检测）
   fundhold:deviation:{fund_code}:{date} → float 当日估算与官方偏差绝对值%

7. 状态标记
   fundhold:status:mode         → "estimating" | "official" （全局模式）
   fundhold:status:last_switch  → ISO时间戳，上次切换时间

=== 数据流向 ===
采集(collect_realtime) → Redis(realtime:*) → 估算(estimate_fund) → 前端API
                                 ↓
                           交叉验证(cross_validate)
                                 ↓
15:00后 → switch_after_15 → 抓取官方净值 → Redis(official:*) → 前端切official模式
次日9:30 → 定时任务 → 切回estimating模式
"""


# ============================================================
# 定时任务入口（APScheduler）
# ============================================================
"""
from apscheduler.schedulers.background import BackgroundScheduler

scheduler = BackgroundScheduler()

# 交易时段：每5秒刷新股票行情，每15秒刷新基金估值
def job_realtime():
    if not is_trading_time():
        return
    stock_codes = [...]  # 从持仓表读
    fund_top10 = {...}   # 从缓存读
    collect_realtime(stock_codes, fund_top10)

# 15:00后：每60秒轮询官方净值
def job_check_official_nav():
    now = datetime.now()
    if now.hour < 15:
        return
    if now.weekday() >= 5:
        return
    fund_codes = [...]  # 从基金持仓读
    for code in fund_codes:
        switch_after_15(code, ...)

# 次日9:30：切回估算模式
def job_reset_estimating():
    r.set(f"{REDIS_PREFIX}status:mode", "estimating")

scheduler.add_job(job_realtime, 'interval', seconds=5)
scheduler.add_job(job_check_official_nav, 'interval', minutes=1)
scheduler.add_job(job_reset_estimating, 'cron', hour=9, minute=29, day_of_week='mon-fri')

scheduler.start()
"""


# ============================================================
# 依赖清单
# ============================================================
"""
=== 依赖 ===
requests>=2.31.0       # HTTP请求，东财接口
akshare>=1.12.0        # 兜底数据源（可选，东财挂了才用）
apscheduler>=3.10.0    # 定时任务调度
redis>=5.0.0           # 实时数据缓存
python-dotenv>=1.0.0   # 环境变量
openai>=1.0.0          # LLM调用（DeepSeek兼容OpenAI格式，可选）

=== 安装 ===
pip install requests akshare apscheduler redis python-dotenv

=== 运行环境 ===
- Python 3.10+
- Redis 6.0+
- 个人本地使用，频率<10次/秒，东财接口不会被限流
- 服务器在境外/IDC可能被东财502，建议本地运行
"""

if __name__ == "__main__":
    # 快速测试
    print("=" * 60)
    print("FundHoldings - 持仓估值模块")
    print("=" * 60)
    print()
    print("四大核心函数：")
    print("  1. collect_realtime()    — 采集实时行情")
    print("  2. estimate_fund()       — 基金盘中估值（三路反推）")
    print("  3. cross_validate()      — 三路交叉验证")
    print("  4. switch_after_15()     — 15点后切官方净值")
    print()
    print("Redis键设计：见文件内 REDIS_PREFIX 注释")
    print("LLM风格识别Prompt：STYLE_IDENTIFY_PROMPT")
    print("依赖：requests, akshare, apscheduler, redis")
    print()
