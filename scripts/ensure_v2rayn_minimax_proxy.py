#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""确保 v2rayN 的路由预设里有一条「minimax 海外站强制走代理」的规则。

为什么需要这个
--------------
MiniMax 海外站（`*.minimax.io`）必须从海外出口访问：

    agent.minimax.io  →  Akamai 边缘在检测到国内出口时直接 **307 跳到
                          agent.minimaxi.com**（国内站），响应体是空的。

这不是被墙，是**按出口地域做的跳转**。而 v2rayN 的 TUN 模式默认走
「绕过大陆」规则集：`minimax.io` 解析到的 Akamai 国内边缘 IP 命中 `geoip:cn`
→ 直连 → 撞上 307 → 上游报 "user info 返回非 JSON"、模型接口直接不可用。

解法是在路由预设里加一条**按域名**的规则，让它优先于 `geoip:cn` / `geosite:cn`
那两条直连规则：

    {"OutboundTag": "proxy", "Domain": ["domain:minimax.io"], ...}

只代理 `.io`，不代理 `.com` / `.cn`：国内站（`agent.minimaxi.com`、
`account.minimaxi.cn`）直连即可，走代理反而多一跳。

这个脚本做什么
--------------
1. 读 v2rayN 的路由预设（DB 真源：`guiNDB.db` 的 `RoutingItem.RuleSet`）；
2. 检查每个预设里有没有这条规则，缺就补（**规则写在每个预设里**，
   这样在界面上切换路由预设也不会把规则弄丢）；
3. 报告是否**需要重启 v2rayN**——路由真源是 DB，但跑着的 sing-box 用的
   是启动时生成的 `binConfigs/configPre.json`，改了 DB 必须重启核心才生效。

用法
----
    python scripts/ensure_v2rayn_minimax_proxy.py           # 检查 + 补齐
    python scripts/ensure_v2rayn_minimax_proxy.py --check   # 只检查，不改
    python scripts/ensure_v2rayn_minimax_proxy.py --remove  # 拆掉这条规则

退出码：0 = 规则齐了（或刚补上）；1 = 出了别的问题；2 = 改了但需要重启 v2rayN。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import time
import uuid
from pathlib import Path

DEFAULT_V2RAYN_DIR = Path(r"C:\AITask\v2rayN\v2rayN-windows-64")
DB_NAME = "guiNDB.db"
CONFIG_NAME = "guiNConfig.json"
DOMAIN_RULE = "domain:minimax.io"
REMARKS = "强制代理MiniMax海外站"
# 规则必须排在这些规则**之前**，否则会被国内直连规则先命中。
MUST_PRECEDE = ("geosite:cn", "geoip:cn")


def v2rayn_dir() -> Path:
    env = os.environ.get("V2RAYN_DIR")
    if env:
        return Path(env)
    return DEFAULT_V2RAYN_DIR


def is_ours(rule: dict) -> bool:
    return REMARKS in str(rule.get("Remarks", "")) or DOMAIN_RULE in (rule.get("Domain") or [])


def make_rule() -> dict:
    return {
        "Id": str(uuid.uuid4()).upper(),
        "OutboundTag": "proxy",
        "Port": "0-65535",
        "Network": "tcp,udp",
        "Domain": [DOMAIN_RULE],
        "Enabled": True,
        "Remarks": REMARKS,
    }


def insert_index(rules: list[dict]) -> int:
    """插在所有 geoip:cn / geosite:cn 直连规则之前。"""
    for idx, rule in enumerate(rules):
        doms = rule.get("Domain") or []
        ips = rule.get("Ip") or []
        if any(tag in doms for tag in MUST_PRECEDE) or any(tag in ips for tag in MUST_PRECEDE):
            return idx
    return len(rules)


def active_preset_id(con: sqlite3.Connection, cfg: dict) -> str | None:
    """当前生效的预设：guiNConfig 的 RoutingIndexId 优先，否则 DB 里 IsActive=1 的。"""
    routing = (cfg or {}).get("RoutingBasicItem") or {}
    index_id = routing.get("RoutingIndexId")
    if index_id:
        return str(index_id)
    row = con.execute("select Id from RoutingItem where IsActive=1 limit 1").fetchone()
    return str(row[0]) if row else None


def main() -> int:
    parser = argparse.ArgumentParser(description="检查/补齐 v2rayN 的 minimax 海外站代理规则")
    parser.add_argument("--check", action="store_true", help="只检查，不修改")
    parser.add_argument("--remove", action="store_true", help="拆掉这条规则")
    args = parser.parse_args()

    base = v2rayn_dir()
    db_path = base / "guiConfigs" / DB_NAME
    cfg_path = base / "guiConfigs" / CONFIG_NAME
    if not db_path.is_file():
        print(f"[WARN] 找不到 v2rayN 数据库 {db_path}；"
              f"设 V2RAYN_DIR 环境变量指向 v2rayN 目录。")
        return 0

    cfg = {}
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cfg = {}

    con = sqlite3.connect(str(db_path))
    try:
        active = active_preset_id(con, cfg)
        rows = con.execute("select Id, Remarks, RuleSet, RuleNum from RoutingItem").fetchall()
        if not rows:
            print("[WARN] RoutingItem 表是空的，v2rayN 可能还没写过路由预设")
            return 0

        changed_active = False
        for pid, remarks, rule_set_json, _ in rows:
            try:
                rules = json.loads(rule_set_json)
            except ValueError:
                print(f"[WARN] 预设 {remarks} 的规则不是合法 JSON，跳过")
                continue
            has = any(is_ours(r) for r in rules)
            is_active = str(pid) == str(active)
            state = "有" if has else "缺"
            print(f"  预设 {remarks} (id={pid}){'  [当前生效]' if is_active else ''}: 规则{state}")

            if args.remove:
                if has:
                    kept = [r for r in rules if not is_ours(r)]
                    con.execute("update RoutingItem set RuleSet=?, RuleNum=? where Id=?",
                                (json.dumps(kept, ensure_ascii=False), len(kept), pid))
                    changed_active = changed_active or is_active
                continue

            if has or args.check:
                continue

            # 补规则：备份后写入
            backup = db_path.with_suffix(f".db.bak-minimaxrule-{time.strftime('%Y%m%d-%H%M%S')}")
            shutil.copy2(str(db_path), str(backup))
            rules.insert(insert_index(rules), make_rule())
            con.execute("update RoutingItem set RuleSet=?, RuleNum=? where Id=?",
                        (json.dumps(rules, ensure_ascii=False), len(rules), pid))
            changed_active = changed_active or is_active
            print(f"       -> 已补上（备份 {backup.name}）")

        if not args.check:
            con.commit()

        if changed_active:
            print()
            print("[需要重启 v2rayN 才生效]：路由真源是 DB，跑着的 sing-box 用的是启动时")
            print("  生成的 binConfigs/configPre.json。重启 v2rayN（托盘图标 → 重启内核，")
            print("  或退出后重开）后规则才会进入实际路由。")
            return 2
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
