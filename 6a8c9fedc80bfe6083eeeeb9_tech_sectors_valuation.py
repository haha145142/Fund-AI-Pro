#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TechSectors - 八大科技板块盘中实时涨跌 + 四档资金流模块
=========================================================
仅个人本地使用，禁止LLM算数，所有计算后端硬算。

八大板块：
  1. 半导体            → 行业板块（stock_board_industry_name_em 过滤"半导体"）
  2. 半导体设备材料    → 概念板块"半导体设备" + "半导体材料" 合并展示
  3. 存储芯片          → 概念板块
  4. 国产算力          → 概念板块（找不到用"AI算力芯片"兜底）
  5. PCB               → 概念板块（"PCB" 或 "印制电路板"）
  6. CPO光模块         → 概念板块（"共封装光模块(CPO)"）
  7. 通信技术          → 行业板块（"通信设备"）
  8. MLCC              → 概念板块

核心函数：
  1. collect_sectors_push2()   — 主采集：push2 clist 行业+概念两次请求
  2. collect_sectors_akshare() — 兜底采集：AKShare 行业/概念板 + 资金流排名
  3. cross_validate_sector()   — 三路交叉验证（push2 / AKShare资金流 / 成分股反推）
  4. build_sector_data()       — 组装8条板块数据 + 亿元转换 + 状态标记
  5. generate_llm_comment()    — LLM一句话点评（零算术，纯文本排序）

依赖：requests, akshare(兜底), apscheduler, redis, json
"""

import re
import json
import time
import requests
import redis
from datetime import datetime, date
from typing import List, Dict, Tuple, Optional

# ============================================================
# 配置
# ============================================================

REDIS_PREFIX = "tech_sector:"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/",
}

# 八大科技板块配置
# type: industry(行业) / concept(概念) / merge(多概念合并)
SECTOR_CONFIG = [
    {
        "key": "semiconductor",
        "name": "半导体",
        "type": "industry",
        "match_names": ["半导体"],
    },
    {
        "key": "semi_equipment_material",
        "name": "半导体设备材料",
        "type": "merge",
        "match_names": ["半导体设备", "半导体材料"],
        "merge_keys": ["semi_equipment", "semi_material"],  # 内部临时key
    },
    {
        "key": "storage_chip",
        "name": "存储芯片",
        "type": "concept",
        "match_names": ["存储芯片"],
    },
    {
        "key": "domestic_computing",
        "name": "国产算力",
        "type": "concept",
        "match_names": ["国产算力", "AI算力芯片"],  # 第一个优先，第二个兜底
    },
    {
        "key": "pcb",
        "name": "PCB",
        "type": "concept",
        "match_names": ["PCB", "印制电路板"],
    },
    {
        "key": "cpo",
        "name": "CPO光模块",
        "type": "concept",
        "match_names": ["共封装光模块(CPO)", "CPO", "光模块"],
    },
    {
        "key": "communication",
        "name": "通信技术",
        "type": "industry",
        "match_names": ["通信设备"],
    },
    {
        "key": "mlcc",
        "name": "MLCC",
        "type": "concept",
        "match_names": ["MLCC"],
    },
]

# push2 clist 接口地址
PUSH2_CLIST_URL = "https://push2.eastmoney.com/api/qt/clist/get"

# 行业板 fs 参数
INDUSTRY_FS = "m:90+t:1"
# 概念板 fs 参数
CONCEPT_FS = "m:90+t:3"

# 请求字段（涨跌幅/价格/四档资金流/涨跌家数/领涨股）
CLIST_FIELDS = "f12,f14,f2,f3,f62,f66,f69,f72,f75,f78,f81,f84,f87,f104,f105,f128"

r = redis.Redis(host="localhost", port=6379, db=0, decode_responses=True)


# ============================================================
# 工具函数
# ============================================================

def is_trading_time() -> bool:
    """判断是否在A股交易时段（9:30-11:30, 13:00-15:00）"""
    now = datetime.now()
    if now.weekday() >= 5:
        return False
    t = now.time()
    morning = (t.hour == 9 and t.minute >= 30) or (t.hour == 10) or (t.hour == 11 and t.minute <= 30)
    afternoon = (t.hour == 13) or (t.hour == 14) or (t.hour == 15 and t.minute == 0)
    return morning or afternoon


def yuan_to_yi(value) -> Optional[float]:
    """元 → 亿元，保留1位小数；None或非数字返回None"""
    if value is None:
        return None
    try:
        v = float(value)
        return round(v / 1e8, 1)
    except (ValueError, TypeError):
        return None


def _safe_float(val) -> Optional[float]:
    """安全转float，失败返回None"""
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _match_sector(board_name: str, match_names: List[str]) -> bool:
    """板块名匹配（模糊包含匹配）"""
    for name in match_names:
        if name in board_name:
            return True
    return False


# ============================================================
# 函数1：主采集 — push2 clist 行业+概念两次请求
# ============================================================

def _fetch_push2_clist(fs: str) -> Dict[str, Dict]:
    """
    拉取 push2 clist 板块列表
    
    Args:
        fs: 板块分类参数（行业 m:90+t:1 / 概念 m:90+t:3）
    
    Returns:
        {板块名称: {f2, f3, f62, f66, ...}} 字典
    """
    try:
        params = {
            "pn": 1,
            "pz": 200,
            "po": 1,
            "np": 1,
            "fltt": 2,
            "invt": 2,
            "fid": "f3",
            "fs": fs,
            "fields": CLIST_FIELDS,
            "ut": "fa5fd1943c7b386f172d6893dbfba10b",
        }
        resp = requests.get(PUSH2_CLIST_URL, params=params, headers=HEADERS, timeout=8)
        data = resp.json()
        
        result = {}
        if data.get("data") and data["data"].get("diff"):
            for item in data["data"]["diff"]:
                name = item.get("f14", "")
                if not name:
                    continue
                result[name] = {
                    "f2": _safe_float(item.get("f2")),     # 最新价
                    "f3": _safe_float(item.get("f3")),     # 涨跌幅%
                    "f62": _safe_float(item.get("f62")),   # 主力净流入(元)
                    "f66": _safe_float(item.get("f66")),   # 超大单净流入(元)
                    "f69": _safe_float(item.get("f69")),   # 超大单净占比%
                    "f72": _safe_float(item.get("f72")),   # 大单净流入(元)
                    "f75": _safe_float(item.get("f75")),   # 大单净占比%
                    "f78": _safe_float(item.get("f78")),   # 中单净流入(元)
                    "f81": _safe_float(item.get("f81")),   # 中单净占比%
                    "f84": _safe_float(item.get("f84")),   # 小单净流入(元)
                    "f87": _safe_float(item.get("f87")),   # 小单净占比%
                    "f104": _safe_float(item.get("f104")), # 上涨家数
                    "f105": _safe_float(item.get("f105")), # 下跌家数
                    "f128": item.get("f128", ""),          # 领涨股名
                }
        return result
    
    except Exception as e:
        print(f"[ERROR] push2 clist 采集失败 (fs={fs}): {e}")
        return {}


def collect_sectors_push2() -> Dict[str, Dict]:
    """
    主采集：push2 clist 行业板 + 概念板，两次请求
    返回按 SECTOR_CONFIG 匹配好的8条板块数据（原始单位，未转亿元）
    
    Returns:
        {sector_key: {name, change_pct, price, main_net_in, super_large_net, ...}}
    """
    # 1. 拉行业板
    industry_boards = _fetch_push2_clist(INDUSTRY_FS)
    
    # 2. 拉概念板
    concept_boards = _fetch_push2_clist(CONCEPT_FS)
    
    result = {}
    
    for sector in SECTOR_CONFIG:
        key = sector["key"]
        s_type = sector["type"]
        match_names = sector["match_names"]
        
        if s_type == "industry":
            # 行业板匹配
            for board_name, board_data in industry_boards.items():
                if _match_sector(board_name, match_names):
                    result[key] = {
                        "name": sector["name"],
                        "board_name": board_name,
                        "source": "push2_industry",
                        **board_data,
                    }
                    break
        
        elif s_type == "concept":
            # 概念板匹配（按match_names顺序，第一个命中优先）
            found = False
            for match_name in match_names:
                for board_name, board_data in concept_boards.items():
                    if match_name in board_name:
                        result[key] = {
                            "name": sector["name"],
                            "board_name": board_name,
                            "source": "push2_concept",
                            **board_data,
                        }
                        found = True
                        break
                if found:
                    break
        
        elif s_type == "merge":
            # 合并型：半导体设备 + 半导体材料 → 半导体设备材料
            # 取主力净额之和、涨跌幅取均值（按主力资金加权更合理，这里简化为均值）
            merged_items = []
            for match_name in match_names:
                for board_name, board_data in concept_boards.items():
                    if match_name in board_name:
                        merged_items.append({
                            "board_name": board_name,
                            **board_data,
                        })
                        break
            
            if merged_items:
                # 涨跌幅：简单平均
                avg_change = sum(item["f3"] for item in merged_items if item["f3"] is not None) / len(merged_items)
                # 主力净额：求和（两个概念板块资金相加）
                sum_main = sum(item["f62"] for item in merged_items if item["f62"] is not None)
                sum_super = sum(item["f66"] for item in merged_items if item["f66"] is not None)
                sum_large = sum(item["f72"] for item in merged_items if item["f72"] is not None)
                sum_mid = sum(item["f78"] for item in merged_items if item["f78"] is not None)
                sum_small = sum(item["f84"] for item in merged_items if item["f84"] is not None)
                # 上涨/下跌家数：求和
                sum_up = sum(item["f104"] for item in merged_items if item["f104"] is not None)
                sum_down = sum(item["f105"] for item in merged_items if item["f105"] is not None)
                # 领涨股：取涨幅高的那个的领涨股
                top_item = max(merged_items, key=lambda x: x["f3"] if x["f3"] is not None else -999)
                
                result[key] = {
                    "name": sector["name"],
                    "board_name": " + ".join(item["board_name"] for item in merged_items),
                    "source": "push2_concept_merge",
                    "f2": None,  # 合并板块无统一指数价
                    "f3": round(avg_change, 2),
                    "f62": sum_main,
                    "f66": sum_super,
                    "f69": None,  # 净占比合并无意义
                    "f72": sum_large,
                    "f75": None,
                    "f78": sum_mid,
                    "f81": None,
                    "f84": sum_small,
                    "f87": None,
                    "f104": sum_up,
                    "f105": sum_down,
                    "f128": top_item.get("f128", ""),
                    "merge_count": len(merged_items),
                }
    
    return result


# ============================================================
# 函数2：兜底采集 — AKShare
# ============================================================

def collect_sectors_akshare() -> Dict[str, Dict]:
    """
    兜底采集：AKShare 行业/概念板块 + 资金流排名
    主接口挂掉时降级使用，仅提供涨跌幅和主力净额作交叉参照
    
    Returns:
        {sector_key: {name, change_pct, main_net_in_yi, source: "akshare"}}
    """
    try:
        import akshare as ak
    except ImportError:
        print("[WARN] AKShare 未安装，兜底不可用")
        return {}
    
    result = {}
    
    try:
        # 行业板
        ind_df = ak.stock_board_industry_name_em()
        # 概念板
        con_df = ak.stock_board_concept_name_em()
    except Exception as e:
        print(f"[ERROR] AKShare 板块列表采集失败: {e}")
        return {}
    
    # 资金流排名（行业 + 概念）
    ind_fund = None
    con_fund = None
    try:
        ind_fund = ak.stock_sector_fund_flow_rank(indicator="今日", sector_type="行业资金流")
    except Exception:
        pass
    try:
        con_fund = ak.stock_sector_fund_flow_rank(indicator="今日", sector_type="概念资金流")
    except Exception:
        pass
    
    def _find_in_df(df, match_names, name_col="板块名称", 
                    change_col="涨跌幅", price_col="最新价"):
        """在DataFrame中找匹配行"""
        for match_name in match_names:
            for _, row in df.iterrows():
                if match_name in str(row.get(name_col, "")):
                    return {
                        "change_pct": _safe_float(row.get(change_col)),
                        "price": _safe_float(row.get(price_col)),
                        "board_name": str(row.get(name_col, "")),
                    }
        return None
    
    def _find_fund(fund_df, match_names, name_col="名称",
                   main_col="今日主力净流入-净额"):
        """在资金流排名中找匹配"""
        if fund_df is None:
            return None
        for match_name in match_names:
            for _, row in fund_df.iterrows():
                if match_name in str(row.get(name_col, "")):
                    val = _safe_float(row.get(main_col))
                    # AKShare 资金流单位通常是亿元，直接用
                    return val
        return None
    
    for sector in SECTOR_CONFIG:
        key = sector["key"]
        s_type = sector["type"]
        match_names = sector["match_names"]
        
        board_data = None
        fund_val = None
        
        if s_type == "industry":
            board_data = _find_in_df(ind_df, match_names)
            fund_val = _find_fund(ind_fund, match_names)
        
        elif s_type == "concept":
            board_data = _find_in_df(con_df, match_names)
            fund_val = _find_fund(con_fund, match_names)
        
        elif s_type == "merge":
            # 合并型：分别找两个概念板块
            items = []
            fund_items = []
            for match_name in match_names:
                item = _find_in_df(con_df, [match_name])
                if item:
                    items.append(item)
                fv = _find_fund(con_fund, [match_name])
                if fv is not None:
                    fund_items.append(fv)
            
            if items:
                avg_change = sum(i["change_pct"] for i in items if i["change_pct"] is not None) / len(items)
                sum_fund = sum(fund_items) if fund_items else None
                result[key] = {
                    "name": sector["name"],
                    "change_pct": round(avg_change, 2),
                    "price": None,
                    "main_net_in_yi": sum_fund,
                    "board_name": " + ".join(i["board_name"] for i in items),
                    "source": "akshare_merge",
                }
            continue
        
        if board_data:
            result[key] = {
                "name": sector["name"],
                "change_pct": board_data["change_pct"],
                "price": board_data["price"],
                "main_net_in_yi": fund_val,  # 亿元，AKShare返回就是亿
                "board_name": board_data["board_name"],
                "source": "akshare",
            }
    
    return result


# ============================================================
# 函数3：三路交叉验证
# ============================================================

def _estimate_by_constituents(sector_key: str, sector_name: str, 
                              s_type: str, match_names: List[str]) -> Optional[float]:
    """
    路C：成分股实时资金反推板块主力净额
    拿成分股列表 → push2 批量拉每只股 f62 → 近似求和
    
    注意：这是近似值，仅作交叉验证参照，不作为主数据
    
    Returns:
        主力净额（元），失败返回None
    """
    try:
        import akshare as ak
    except ImportError:
        return None
    
    try:
        # 获取成分股列表
        cons_codes = []
        if s_type == "industry":
            for name in match_names:
                try:
                    df = ak.stock_board_industry_cons_em(symbol=name)
                    if not df.empty and "代码" in df.columns:
                        cons_codes = [str(c).zfill(6) for c in df["代码"].tolist()[:50]]  # 取前50只
                        break
                except Exception:
                    continue
        elif s_type in ("concept", "merge"):
            for name in match_names:
                try:
                    df = ak.stock_board_concept_cons_em(symbol=name)
                    if not df.empty and "代码" in df.columns:
                        new_codes = [str(c).zfill(6) for c in df["代码"].tolist()[:30]]
                        cons_codes.extend(new_codes)
                        if s_type != "merge":
                            break
                except Exception:
                    continue
            # 去重
            cons_codes = list(dict.fromkeys(cons_codes))
        
        if not cons_codes:
            return None
        
        # 用 push2 ulist 批量拉成分股 f62（主力净额）
        # 注意：ulist 的 f62 字段在个股上可能不可用，这里用 f62 尝试
        # 如果拉不到，返回None
        from fund_holdings_valuation import secid_of
        
        secids = []
        for code in cons_codes[:30]:  # 最多30只
            try:
                secids.append(secid_of(code))
            except ValueError:
                continue
        
        if not secids:
            return None
        
        url = "https://push2.eastmoney.com/api/qt/ulist.np/get"
        params = {
            "secids": ",".join(secids),
            "fields": "f12,f62,f20",  # f62=主力净额, f20=总市值
            "ut": "fa5fd1943c7b386f172d6893dbfba10b",
        }
        resp = requests.get(url, params=params, headers=HEADERS, timeout=8)
        data = resp.json()
        
        total_main = 0.0
        count = 0
        if data.get("data") and data["data"].get("diff"):
            for item in data["data"]["diff"]:
                main = _safe_float(item.get("f62"))
                if main is not None:
                    total_main += main
                    count += 1
        
        if count == 0:
            return None
        
        # 简单按比例外推（前N只占板块比例的粗略估计）
        # 假设前30只占板块总资金的60%，外推到全板块
        estimated_total = total_main / 0.6
        
        return estimated_total
    
    except Exception as e:
        print(f"[WARN] 成分股反推失败 ({sector_name}): {e}")
        return None


def cross_validate_sector(sector_key: str, sector_name: str,
                          push2_data: Dict, akshare_data: Optional[Dict]) -> Tuple[str, float]:
    """
    三路交叉验证
    
    路A = push2 clist 的 f62（主力净额，元）
    路B = AKShare stock_sector_fund_flow_rank 的"今日主力净流入-净额"（亿元）
    路C = 成分股实时资金反推（元，近似值）
    
    判定规则：
      |A-B| < 5%  → status=ok
      |A-B| 5%~10% → status=warn
      |A-B| > 10% 或 |A-C| > 15% → status=check
    
    Args:
        push2_data: push2采集到的板块数据（含f62等）
        akshare_data: AKShare采集到的板块数据（含main_net_in_yi）
    
    Returns:
        (status, main_net_in_yi)
        status: "ok" | "warn" | "check"
    """
    # 路A：push2 主力净额（转亿元）
    road_a_yi = yuan_to_yi(push2_data.get("f62"))
    if road_a_yi is None:
        return "check", 0.0
    
    # 路B：AKShare 资金流（亿元）
    road_b_yi = None
    if akshare_data and akshare_data.get("main_net_in_yi") is not None:
        road_b_yi = akshare_data["main_net_in_yi"]
    
    # 如果没有路B，直接用路A，标warn（缺少交叉验证）
    if road_b_yi is None:
        return "warn", road_a_yi
    
    # 计算偏差（相对于较大绝对值的百分比）
    base = max(abs(road_a_yi), abs(road_b_yi), 0.1)  # 避免除零，最小0.1亿
    diff_pct = abs(road_a_yi - road_b_yi) / base * 100
    
    if diff_pct < 5:
        return "ok", road_a_yi
    elif diff_pct < 10:
        return "warn", road_a_yi
    else:
        # 偏差 >10%，尝试路C验证
        sector = next((s for s in SECTOR_CONFIG if s["key"] == sector_key), None)
        if sector:
            road_c_raw = _estimate_by_constituents(
                sector_key, sector["name"], 
                sector["type"], sector["match_names"]
            )
            if road_c_raw is not None:
                road_c_yi = yuan_to_yi(road_c_raw)
                diff_ac = abs(road_a_yi - road_c_yi) / max(abs(road_a_yi), abs(road_c_yi), 0.1) * 100
                if diff_ac > 15:
                    return "check", road_a_yi
        
        return "check", road_a_yi


# ============================================================
# 函数4：组装板块数据 + 亿元转换 + 状态标记
# ============================================================

def build_sector_data() -> Dict:
    """
    组装完整的8条板块数据：
    - 主数据用 push2
    - 亿元转换
    - 交叉验证状态
    - 写入 Redis hash
    
    Returns:
        {
          "timestamp": "...",
          "sectors": {
            "semiconductor": {name, change_pct, price, main_net_in_yi, super_large_yi, ...},
            ...
          }
        }
    """
    # 路A：push2 主数据
    push2_data = collect_sectors_push2()
    
    # 路B：AKShare 兜底/交叉验证（异步或低频调用，这里简化为同步）
    # 实际生产中 AKShare 比较慢，可以降低频率（比如每30秒验一次）
    akshare_data = {}
    try:
        akshare_data = collect_sectors_akshare()
    except Exception as e:
        print(f"[WARN] AKShare 兜底采集失败: {e}")
    
    sectors_result = {}
    
    for sector in SECTOR_CONFIG:
        key = sector["key"]
        name = sector["name"]
        
        p_data = push2_data.get(key)
        a_data = akshare_data.get(key)
        
        if not p_data:
            # push2 没拿到，试试 AKShare
            if a_data:
                sectors_result[key] = {
                    "name": name,
                    "change_pct": a_data.get("change_pct"),
                    "price": a_data.get("price"),
                    "main_net_in_yi": a_data.get("main_net_in_yi"),
                    "super_large_yi": None,
                    "large_yi": None,
                    "mid_small_yi": None,
                    "up_count": None,
                    "down_count": None,
                    "leading_stock": "",
                    "status": "fallback",
                    "source": "akshare",
                }
            else:
                sectors_result[key] = {
                    "name": name,
                    "change_pct": None,
                    "price": None,
                    "main_net_in_yi": None,
                    "super_large_yi": None,
                    "large_yi": None,
                    "mid_small_yi": None,
                    "up_count": None,
                    "down_count": None,
                    "leading_stock": "",
                    "status": "offline",
                    "source": "none",
                }
            continue
        
        # 交叉验证
        status, main_yi = cross_validate_sector(key, name, p_data, a_data)
        
        # 四档资金：超大单 + 大单 + 中单 + 小单
        super_large_yi = yuan_to_yi(p_data.get("f66"))
        large_yi = yuan_to_yi(p_data.get("f72"))
        mid_yi = yuan_to_yi(p_data.get("f78"))
        small_yi = yuan_to_yi(p_data.get("f84"))
        
        # 中单+小单合并
        mid_small_yi = None
        if mid_yi is not None and small_yi is not None:
            mid_small_yi = round(mid_yi + small_yi, 1)
        elif mid_yi is not None:
            mid_small_yi = mid_yi
        elif small_yi is not None:
            mid_small_yi = small_yi
        
        sectors_result[key] = {
            "name": name,
            "change_pct": p_data.get("f3"),       # 涨跌幅%
            "price": p_data.get("f2"),            # 最新价
            "main_net_in_yi": main_yi,             # 主力净流入(亿元) = 路A值
            "super_large_yi": super_large_yi,      # 超大单净流入(亿元)
            "large_yi": large_yi,                  # 大单净流入(亿元)
            "mid_small_yi": mid_small_yi,          # 中单+小单净流入(亿元)
            "up_count": int(p_data["f104"]) if p_data.get("f104") is not None else None,    # 上涨家数
            "down_count": int(p_data["f105"]) if p_data.get("f105") is not None else None,  # 下跌家数
            "leading_stock": p_data.get("f128", ""),  # 领涨股名
            "status": status,                      # ok / warn / check / fallback / offline
            "source": p_data.get("source", "push2"),
        }
    
    result = {
        "timestamp": datetime.now().isoformat(),
        "sectors": sectors_result,
    }
    
    # 写入 Redis hash：tech_sector:realtime
    # 每条板块一个 field，值为 JSON
    hash_key = f"{REDIS_PREFIX}realtime"
    r.hset(hash_key, "timestamp", result["timestamp"])
    for key, data in sectors_result.items():
        r.hset(hash_key, key, json.dumps(data, ensure_ascii=False))
    # 整体60秒过期
    r.expire(hash_key, 60)
    
    return result


def get_cached_sector_data() -> Optional[Dict]:
    """从 Redis 读取缓存的板块数据"""
    hash_key = f"{REDIS_PREFIX}realtime"
    if not r.exists(hash_key):
        return None
    
    timestamp = r.hget(hash_key, "timestamp")
    sectors = {}
    
    for sector in SECTOR_CONFIG:
        key = sector["key"]
        val = r.hget(hash_key, key)
        if val:
            sectors[key] = json.loads(val)
    
    if not sectors:
        return None
    
    return {"timestamp": timestamp, "sectors": sectors}


# ============================================================
# 函数5：LLM 一句话点评（零算术）
# ============================================================

SECTOR_COMMENT_PROMPT = """你是一个A股科技板块盘面点评助手。
用户会给你8个科技板块的实时数据（板块名、涨跌幅、主力净流入亿元、领涨股）。
请你输出一句话的人话排序点评，要求：
1. 按涨跌幅从高到低排序，说清楚谁涨谁跌
2. 提一下资金流向（主力进/出多少亿）
3. 语气像老股民看盘，简洁口语化，不超过40字
4. 禁止做任何数值计算，所有数字直接用给你的原始数据
5. 只输出点评内容，不要解释，不要markdown

输出格式：严格JSON
{"comment": "你的点评"}"""


def generate_llm_comment(sector_data: Dict, llm_client=None) -> str:
    """
    生成LLM一句话点评（零算术，纯文本排序）
    
    Args:
        sector_data: build_sector_data() 返回的完整数据
        llm_client: LLM客户端对象（需有 chat 方法）
    
    Returns:
        点评字符串
    """
    if llm_client is None:
        # 没有LLM时，用模板生成一句简单描述
        sectors = sector_data.get("sectors", {})
        sorted_sectors = sorted(
            [(k, v) for k, v in sectors.items() if v.get("change_pct") is not None],
            key=lambda x: x[1]["change_pct"],
            reverse=True
        )
        
        if not sorted_sectors:
            return "暂无板块数据"
        
        top = sorted_sectors[0][1]
        bottom = sorted_sectors[-1][1]
        
        top_main = top.get("main_net_in_yi", 0)
        bottom_main = bottom.get("main_net_in_yi", 0)
        
        top_dir = "流入" if top_main and top_main > 0 else "流出"
        bottom_dir = "流入" if bottom_main and bottom_main > 0 else "流出"
        
        comment = (f"{top['name']}+{top['change_pct']:.1f}%主力{top_dir}"
                   f"{abs(top_main) if top_main else 0:.0f}亿，"
                   f"{bottom['name']}{bottom['change_pct']:.1f}%{bottom_dir}"
                   f"{abs(bottom_main) if bottom_main else 0:.0f}亿")
        return comment
    
    # 有LLM时调用
    try:
        # 组装精简数据给LLM（只给必要字段，减少token）
        sectors_for_llm = []
        for key, data in sector_data.get("sectors", {}).items():
            sectors_for_llm.append({
                "name": data["name"],
                "change_pct": data.get("change_pct"),
                "main_net_in_yi": data.get("main_net_in_yi"),
                "leading_stock": data.get("leading_stock", ""),
            })
        
        user_msg = json.dumps(sectors_for_llm, ensure_ascii=False)
        
        # 调用LLM（示例，实际替换为你的客户端）
        # resp = llm_client.chat(SECTOR_COMMENT_PROMPT, user_msg)
        # result = json.loads(resp)
        # return result.get("comment", "")
        
        # 占位：返回模板版
        return generate_llm_comment(sector_data, None)
    
    except Exception as e:
        print(f"[WARN] LLM点评生成失败: {e}")
        return generate_llm_comment(sector_data, None)


# ============================================================
# Redis 键设计
# ============================================================
"""
=== Redis 键设计 ===

前缀: tech_sector:

1. 实时板块数据（hash，60秒过期）
   tech_sector:realtime
     - "timestamp" → ISO时间戳字符串
     - "semiconductor" → JSON {name, change_pct, main_net_in_yi, ...}
     - "semi_equipment_material" → JSON {...}
     - "storage_chip" → JSON {...}
     - "domestic_computing" → JSON {...}
     - "pcb" → JSON {...}
     - "cpo" → JSON {...}
     - "communication" → JSON {...}
     - "mlcc" → JSON {...}

2. LLM点评缓存（string，30秒过期）
   tech_sector:comment → JSON {comment: "...", timestamp: "..."}

3. 成分股列表缓存（string，每日更新一次，盘前刷新）
   tech_sector:cons:{sector_key} → JSON [code1, code2, ...]
   过期时间：当日收盘后自动失效（设到次日9:00）

4. 历史快照（可选，用于日内回顾）
   tech_sector:snapshot:{HH:MM} → hash，同 realtime 结构
   每5分钟存一帧，保留当日

=== 数据流向 ===
push2 clist(行业+概念) → 匹配8板块 → 亿元转换 → 交叉验证(AKShare+成分股反推)
                                                                ↓
                                                           Redis Hash
                                                                ↓
前端API ← Flask服务 ← 读Redis ← LLM点评（排序+人话描述）

=== 单位说明 ===
- push2 f62/f66/f72/f78/f84 单位是"元"
- 后端统一 ÷1e8 转"亿元"，保留1位小数，正负号原样保留
- 前端根据正负渲染红绿，后端不碰颜色逻辑
- 板块用 clist 不需要 secid（secid 是个股/指数用的，板块用名称匹配）
"""


# ============================================================
# 定时任务入口（APScheduler）伪代码
# ============================================================
"""
from apscheduler.schedulers.background import BackgroundScheduler

scheduler = BackgroundScheduler()

# 交易时段：每5秒刷新板块数据
def job_refresh_sectors():
    if not is_trading_time():
        return
    build_sector_data()

# 每30秒生成一次LLM点评（低频，节省token）
def job_llm_comment():
    if not is_trading_time():
        return
    data = get_cached_sector_data()
    if data:
        comment = generate_llm_comment(data)
        r.setex(f"{REDIS_PREFIX}comment", 30, json.dumps({
            "comment": comment,
            "timestamp": datetime.now().isoformat(),
        }, ensure_ascii=False))

# 盘前：刷新成分股列表缓存（可选，加速路C验证）
def job_refresh_cons():
    # 每交易日8:50执行，预取成分股列表存Redis
    pass

scheduler.add_job(job_refresh_sectors, 'interval', seconds=5)
scheduler.add_job(job_llm_comment, 'interval', seconds=30)
scheduler.add_job(job_refresh_cons, 'cron', hour=8, minute=50, day_of_week='mon-fri')

scheduler.start()
"""


# ============================================================
# 依赖清单
# ============================================================
"""
=== 依赖 ===
requests>=2.31.0       # HTTP请求，东财push2接口
akshare>=1.12.0        # 兜底数据源 + 成分股列表 + 资金流交叉验证（可选）
apscheduler>=3.10.0    # 定时任务调度
redis>=5.0.0           # 实时数据缓存
python-dotenv>=1.0.0   # 环境变量
openai>=1.0.0          # LLM调用（可选，DeepSeek兼容OpenAI格式）

=== 安装 ===
pip install requests akshare apscheduler redis python-dotenv

=== 运行环境 ===
- Python 3.10+
- Redis 6.0+
- 个人本地使用，频率<10次/秒
  - 主接口：每5秒1次（行业+概念=2次请求）→ 0.4次/秒，远低于限流
  - AKShare兜底/验证：低频（每30秒或更久）
- 服务器在境外/IDC可能被东财502，建议本地运行
"""


if __name__ == "__main__":
    print("=" * 60)
    print("TechSectors - 八大科技板块实时涨跌+资金流模块")
    print("=" * 60)
    print()
    print("八大板块：半导体、半导体设备材料、存储芯片、国产算力、PCB、CPO光模块、通信技术、MLCC")
    print()
    print("核心函数：")
    print("  1. collect_sectors_push2()   — push2 行业+概念两次请求")
    print("  2. collect_sectors_akshare() — AKShare 兜底采集")
    print("  3. cross_validate_sector()   — 三路交叉验证")
    print("  4. build_sector_data()       — 组装数据+亿元转换+写Redis")
    print("  5. generate_llm_comment()    — LLM一句话点评（零算术）")
    print()
    print("Redis键：tech_sector:realtime (hash，8条+timestamp)")
    print("单位：push2元 → 后端÷1e8 → 亿元（保留1位小数）")
    print("板块匹配用名称，不需要secid")
    print()
