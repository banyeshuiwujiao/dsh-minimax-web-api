#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给号池里的账号续期 OAuth token，并把"失效"账号救回来。

为什么需要这个（2026-10-21 的真实事故）
--------------------------------------
MiniMax 的 access token **只有 1 小时**有效期。后端自带 keepalive 会在到期前
续期，但实测这���链路有两个洞：

1. **续期成功后账号仍可能停在 `status=invalid`**。
   后端 `app/pool.py` 的失败处理是：凭据被拒（401）→ 先试续期 → 续期成功就复用，
   续期失败才"退休"（status=invalid）。但同一请求的重试 / 故障转移会再打一次，
   第二次仍然 401（用的是旧 token 或与续期并发），于是**续期成功的账号又被退休**。
   `app/keepalive.py` 的 `renew_account` 在成功时会把 status 复位成 active，
   但那条路**只在 keepalive 自己的调度里走**——请求路径上的续期不复位。

2. **号池一旦空掉就没有快速恢复**。
   keepalive 的 sweep 只在"token 快到期"时才续期（`token_expires_at - margin <= now`）。
   账号被退休后 token 明明还没到期，sweep 判定 due=0 → 什么都不做 → 账号一直
   invalid → 所有请求都是 `accounts unusable: ...`，直到下一个续期窗口才可能恢复。

   实测：11:05 两个号全部 401 → 被退休 → 之后 10 次请求全是 accounts unusable，
   直到 12:05（token 自然到期）才可能自愈——整整一小时的空池。

这个脚本的定位：**在 token 到期前主动续期，并在账号处于 invalid 时强制续期
（续期成功即复位 status=active）**。它复用后端自己的 `Keeper.renew_account`，
所以签名、origin 选择、refresh token 轮换、状态复位全部是后端那套逻辑。

用法
----
    python scripts/keep_tokens_alive.py            # 续期（到期或失效的才动）
    python scripts/keep_tokens_alive.py --force    # 每个账号都续一次
    python scripts/keep_tokens_alive.py --status   # 只看状态

退出码：0 = 都正常（或没有需要续的）；1 = 有账号续期失败。
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import sys
import time
from pathlib import Path

# 复用同目录脚本里的后端目录解析（与环境变量/指针文件的一致性保持同一套）。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from claim_daily_credits import resolve_backend_dir  # noqa: E402

# 提前多久续期（秒）。后端自己的 margin 在 app/keepalive.py 里，这里取同样的量级：
# 令牌 1 小时有效，续期请求本身要几秒到几十秒，20 分钟足够安全。
MARGIN_SEC = 20 * 60


async def keep_alive(backend_dir: Path, force: bool, status_only: bool) -> int:
    sys.path.insert(0, str(backend_dir))
    from app.db import Database  # noqa: E402
    from app import upstream, keepalive as keepalive_mod  # noqa: E402

    db = Database(str(backend_dir / "data" / "bridge.sqlite3"), str(backend_dir / "data"))
    await db.connect()
    # 上游默认读超时 300s（给流式回合留的），这里只是一次性续期：压到 20s，
    # 卡住就当失败，等下一次复查。
    base_settings = db.settings()
    settings = dataclasses.replace(
        base_settings,
        upstream=dataclasses.replace(base_settings.upstream, request_timeout_sec=20),
    )
    client = upstream.MiniMaxClient(lambda: settings)
    keeper = keepalive_mod.Keeper(db, client, lambda: settings)

    failures = 0
    try:
        accounts = await db.list_accounts()
        if not accounts:
            print("号池为空：先在 http://127.0.0.1:4555/admin 导入账号")
            return 2
        now = time.time()
        for account in accounts:
            if account.kind != "oauth" or not account.enabled:
                continue
            expires_in = (account.token_expires_at - now) if account.token_expires_at else 0
            broken = account.status == "invalid"
            due = expires_in <= MARGIN_SEC
            print(
                f"=== {account.name or account.id} (region={account.region}) ==="
                f" status={account.status} 剩余={int(expires_in // 60)}分钟"
            )
            if status_only:
                continue
            if not force and not broken and not due:
                print("    还早，不动")
                continue
            reason = "强制" if force else ("失效需复位" if broken else "即将到期")
            try:
                result = await keeper.renew_account(account.id)
            except Exception as err:  # noqa: BLE001 - 单个账号失败不中断整轮
                print(f"    续期异常（{reason}）：{type(err).__name__}: {err}")
                failures += 1
                continue
            if getattr(result, "ok", False):
                print(f"    已续期（{reason}），新的到期时间 +{int((result.expires_at - now) // 60)} 分钟，"
                      f"status 已复位为 active")
            else:
                print(f"    续期失败（{reason}）：{getattr(result, 'error', '?')}")
                failures += 1
        return 1 if failures else 0
    finally:
        await db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="给 minimax2api 号池账号续期 OAuth token")
    parser.add_argument("--force", action="store_true", help="每个账号都续一次（不看是否到期）")
    parser.add_argument("--status", action="store_true", help="只看状态，不续期")
    args = parser.parse_args()
    backend_dir = resolve_backend_dir()
    print(f"后端目录：{backend_dir}")
    return asyncio.run(keep_alive(backend_dir, args.force, args.status))


if __name__ == "__main__":
    raise SystemExit(main())
