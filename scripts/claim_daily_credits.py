#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 minimax2api 号池里的账号领取每日积分（签到）。

为什么需要这个脚本
------------------
`minimax2api` 自带的签到服务对**大陆区账号直接跳过**（app/signin.py）：

    if account.region == REGION_CN:
        preflight.reason = "mainland region, no check-in service"

但那是第三方作者的**假设**，不是上游事实。实测（2026-10-21，本机）：
cn 部署**有**完整的签到服务，状态与领取端点都通：

    GET  /minimax-cloud/api/v1/signin/status   → 7 天签到面板（每天 400 分，第 4 天 1000）
    POST /minimax-cloud/api/v1/signin/claim    → 当日领取，返回 points
    GET  /matrix/api/v1/commerce/get_membership_info → 余额（total / free / purchased）

签到前**必须先调 `/config`**（app.upstream.MiniMaxClient.prepare），否则上游会记录
"当天已签到"却**永远不发放积分**——这也是上游 README 里点名的那条顺序要求。

不用这个脚本的表现是：账号能登录、能进号池，但**每条模型请求都回 402**
（`insufficient_balance_error`，`errorCode 50113`），插件会把它报成 `QUOTA`。

用法
----
    python scripts/claim_daily_credits.py            # 领当日积分并打印余额
    python scripts/claim_daily_credits.py --probe    # 只看状态与余额，不领
    python scripts/claim_daily_credits.py --min-balance 50   # 余额低于 50 才领

后端目录解析顺序（与插件 lib/paths.js 一致）：
    环境变量 MINIMAX2API_DIR → 指针 ~/.dsh/minimax2api.json → 插件同级/常见位置
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

APP_DIR_ENV = "MINIMAX2API_DIR"
POINTER = Path.home() / ".dsh" / "minimax2api.json"
FALLBACK_DIRS = [
    Path.home() / "DeepSeek_Harness" / "git-repo" / "minimax2api",
    Path.home() / "DeepSeek_Harness" / "minimax2api",
    Path.cwd() / "git-repo" / "minimax2api",
]


def resolve_backend_dir() -> Path:
    """找到 minimax2api 后端目录。"""
    env = os.environ.get(APP_DIR_ENV)
    if env:
        return Path(env).expanduser()
    if POINTER.is_file():
        try:
            pointer = json.loads(POINTER.read_text(encoding="utf-8"))
            server_dir = pointer.get("serverDir")
            if server_dir:
                return Path(server_dir)
        except (OSError, ValueError):
            pass
    for candidate in FALLBACK_DIRS:
        if (candidate / "run.py").is_file():
            return candidate
    raise SystemExit(
        "找不到 minimax2api 后端目录。设 MINIMAX2API_DIR，"
        "或跑一次插件的 install.ps1 让它写指针。"
    )


async def claim(backend_dir: Path, probe_only: bool, min_balance: float) -> int:
    # 让后端目录里的 app 包可导入：它自带完整实现（签名、代理、错误分类），
    # 这里只借用它的客户端与数据库，不复制任何协议细节。
    sys.path.insert(0, str(backend_dir))
    from app.db import Database  # noqa: E402
    from app import upstream  # noqa: E402

    db = Database(str(backend_dir / "data" / "bridge.sqlite3"), str(backend_dir / "data"))
    await db.connect()
    client = upstream.MiniMaxClient(lambda: db.settings())
    failures = 0
    try:
        accounts = await db.list_accounts()
        if not accounts:
            print("号池为空：先在 http://127.0.0.1:4555/admin 导入账号")
            return 2
        for account in accounts:
            name = account.name or account.id
            cred = upstream.credential_of(account)
            print(f"=== {name} (region={account.region}) ===")
            try:
                info = await client.credit(cred)
                print(f"    余额 total={info.total} free={info.free} purchased={info.purchased} "
                      f"plan={info.plan_name}/{info.plan_type}")
            except Exception as err:  # noqa: BLE001 - 单个账号失败不该中断整轮
                print(f"    查余额失败：{type(err).__name__}: {err}")
                failures += 1
                continue

            if probe_only:
                try:
                    panel = await client.signin_status(cred)
                    claimed = getattr(panel, "claimed_today", None)
                    print(f"    签到面板：claimed_today={claimed}")
                except Exception as err:  # noqa: BLE001
                    print(f"    查签到状态失败：{type(err).__name__}: {err}")
                continue

            if info.total >= min_balance:
                print(f"    余额已够（{info.total} ≥ {min_balance}），跳过领取")
                continue

            # 顺序不能颠倒：先 /config 建立账号记录，再领取。
            try:
                await client.prepare(cred)
            except Exception as err:  # noqa: BLE001
                print(f"    /config 准备失败（上游会因此不发积分）：{type(err).__name__}: {err}")
                failures += 1
                continue

            try:
                panel = await client.signin_status(cred)
                if getattr(panel, "claimed_today", False):
                    print("    今天已签过，不重复领")
                else:
                    claim_result = await client.signin_claim(cred)
                    print(f"    领取结果：points={claim_result.points} day_no={claim_result.day_no} "
                          f"result={claim_result.result}")
            except Exception as err:  # noqa: BLE001
                print(f"    签到失败：{type(err).__name__}: {err}")
                failures += 1
                continue

            try:
                after = await client.credit(cred)
                print(f"    领取后余额 total={after.total} free={after.free} purchased={after.purchased}")
            except Exception as err:  # noqa: BLE001
                print(f"    复查余额失败：{type(err).__name__}: {err}")
        return 1 if failures else 0
    finally:
        await db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="给 minimax2api 号池账号领取每日积分（签到）")
    parser.add_argument("--probe", action="store_true", help="只看状态与余额，不领取")
    parser.add_argument("--min-balance", type=float, default=1.0,
                        help="余额低于该值才领（默认 1，即余额为 0 时领）")
    args = parser.parse_args()

    backend_dir = resolve_backend_dir()
    print(f"后端目录：{backend_dir}")
    return asyncio.run(claim(backend_dir, args.probe, args.min_balance))


if __name__ == "__main__":
    raise SystemExit(main())
