#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一个新账号（手机号 + 短信验证码）导进 minimax2api 的号池。

它替你做三件事，人只负责**在浏览器里把验证码输进去**：

  1. **进程外**发起设备码登录（OAuth2 device code + PKCE）并打印授权链接；
     —— 绕开后端 `POST /admin/api/login-device` 在跑着的进程里返回 500 的缺陷
     （同一段代码在进程外完全正常）。
  2. 守候授权：你用短信码在浏览器里登录并点「授权」后，服务端把 token 换回来，
     本脚本用后端自己的 `admin.import_device_token` 把账号写进**同一个 SQLite**
     （跑着的后端看到的也是这份数据）。
  3. 通知跑着的后端重载号池（`POST /admin/api/keepalive/sweep`，它内部会
     `pool.load()`），再给新号领当日积分并打印余额。

用法:
    python add_account_by_sms.py --phone 17653116208
    python add_account_by_sms.py --phone 17653116208 --region global --name minimax-global
    python add_account_by_sms.py --phone 17653116208 --no-claim --timeout 300

注意:
  * 短信码有有效期（上游约 5 分钟），拿到后**尽快**在浏览器里输；
  * 同一手机号连续失败多次会被上游节流
    （`{"code":1000021,"message":"登陆失败，请稍后再试"}`）——那不是验证码错，是限流，
    等几小时再试，别硬撞。
  * 浏览器端（勾协议 / 解滑块 / 填码 / 点登录）由 `captcha-slider-solve` 技能负责。
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from claim_daily_credits import claim, resolve_backend_dir  # noqa: E402


def reload_pool(backend_url: str) -> bool:
    """让跑着的后端重载号池（sweep 内部会 pool.load()）。"""
    try:
        req = urllib.request.Request(f"{backend_url}/admin/api/keepalive/sweep", method="POST")
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
        return True
    except (urllib.error.URLError, OSError) as err:
        print(f"[add-account] 后端没在跑（{err}），号池会在它下次启动时自然加载")
        return False


async def watch(backend_dir: Path, name: str, region: str, timeout: float, backend_url: str,
                do_claim: bool) -> int:
    sys.path.insert(0, str(backend_dir))
    from app.db import Database
    from app import upstream
    from app.admin import AdminService
    from app.device_login import DeviceLoginService
    from app.media import MediaStore

    data_dir = backend_dir / "data"
    db = Database(str(data_dir / "bridge.sqlite3"), str(data_dir))
    await db.connect()
    base = db.settings()
    settings = dataclasses.replace(base, upstream=dataclasses.replace(base.upstream, request_timeout_sec=30))
    client = upstream.MiniMaxClient(lambda: settings)
    media = MediaStore(db, lambda: settings)
    admin = AdminService(db, None, client, media, None, lambda: settings)
    svc = DeviceLoginService(client, admin)

    session = await svc.start(name, region)
    print(f"[add-account] 设备码 user_code = {session['userCode']}", flush=True)
    print(f"[add-account] 请在浏览器打开：\n    {session['verifyUrl']}", flush=True)
    print("[add-account] 登录方式：手机号 + 短信验证码（滑块由浏览器自动化处理）", flush=True)
    print(f"[add-account] 等待授权（{int(timeout)}s）…", flush=True)

    deadline = time.time() + timeout
    account_id = ""
    while time.time() < deadline:
        await asyncio.sleep(3)
        state = svc.get(session["id"])
        if state.get("status") != "pending":
            account_id = state.get("accountId") or ""
            print(f"[add-account] status={state.get('status')} accountId={account_id} "
                  f"name={state.get('accountName')} error={state.get('error')}", flush=True)
            break
    else:
        print("[add-account] 超时未授权（设备码只有 5 分钟有效期，过期就重跑本脚本）", flush=True)
        return 2

    if not account_id:
        return 1

    print("[add-account] 账号已写入号池，通知后端重载…", flush=True)
    reload_pool(backend_url)

    if do_claim:
        print("[add-account] 领取当日积分…", flush=True)
        rc = await claim(backend_dir, False, 0)
        if rc != 0:
            print(f"[add-account] 领取有告警（exit={rc}）", flush=True)

    try:
        row = await db.account_by_id(account_id)
    except Exception:  # noqa: BLE001 - 只是给人看的摘要
        row = None
    if row is not None:
        print(f"[add-account] 完成：{row.name}（region={row.region}，status={row.status}，"
              f"token 到期 {time.strftime('%H:%M:%S', time.localtime(row.token_expires_at)) if row.token_expires_at else '未知'}）")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="把手机号+短信码的新账号导进 minimax2api 号池")
    parser.add_argument("--phone", required=True, help="手机号（用于给账号命名与提示）")
    parser.add_argument("--name", default="", help="账号名（默认按手机号生成）")
    parser.add_argument("--region", default="cn", choices=["cn", "global"], help="账号所在区")
    parser.add_argument("--backend-dir", default="", help="minimax2api 后端目录（默认自动解析）")
    parser.add_argument("--backend-url", default="http://127.0.0.1:4555", help="跑着的后端地址")
    parser.add_argument("--timeout", type=float, default=900, help="等待授权的秒数")
    parser.add_argument("--no-claim", action="store_true", help="不领当日积分")
    args = parser.parse_args()

    backend_dir = Path(args.backend_dir) if args.backend_dir else resolve_backend_dir()
    name = args.name or f"minimax-{args.region}-{args.phone}"
    print(f"[add-account] 后端目录：{backend_dir}")
    return asyncio.run(watch(backend_dir, name, args.region, args.timeout, args.backend_url,
                             not args.no_claim))


if __name__ == "__main__":
    raise SystemExit(main())
