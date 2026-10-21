#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在**进程外**跑 minimax2api 的设备码登录，把新账号导进号池。

为什么不用后端自带的 `POST /admin/api/login-device`
--------------------------------------------------
那个接口在**跑着的后端进程**里会返回 500（"Internal Server Error"），
而同��段代码在进程外完全正常、重启后端也能恢复好一阵子 —— 上游的状态机类缺陷
（`app/device_login.py` 的 `start()` 会在 `self._sessions` 里堆会话，
跑久了就起不来；`self._client.public_client()` 还在 `try` 之外，异常会一路逃成 500）。

本脚本绕开它：直接用后端自己的 `DeviceLoginService`（含 PKCE 与 token 交换），
在**自己的进程**里发起与轮询；授权成功后它会调用 `admin.import_device_token`
把账号写进同一个 SQLite（后端进程看到的也是这份数据），随后调用方触发一次
`POST /admin/api/keepalive/sweep` 让后端重载号池即可。

用法:
    python device_login_watch.py            # 发起并守到授权成功，然后退出
    python device_login_watch.py --code     # 只发码、打印 user_code 后继续守
    python device_login_watch.py --timeout 600
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import sys
import time
from pathlib import Path

DEFAULT_BACKEND = Path(r"C:\Users\Admin\DeepSeek_Harness\git-repo\minimax2api")


async def run(backend_dir: Path, name: str, region: str, timeout: float) -> int:
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
    print(f"[device-login] user_code={session['userCode']}", flush=True)
    print(f"[device-login] {session['verifyUrl']}", flush=True)
    print("[device-login] 守候授权中（用户完成后自动入池）…", flush=True)

    deadline = time.time() + timeout
    while time.time() < deadline:
        await asyncio.sleep(3)
        state = svc.get(session["id"])
        status = state.get("status")
        if status != "pending":
            print(f"[device-login] status={status} accountId={state.get('accountId')} "
                  f"name={state.get('accountName')} error={state.get('error')}", flush=True)
            if status == "authorized":
                return 0
            return 1
    print("[device-login] 超时", flush=True)
    return 2


def main() -> int:
    parser = argparse.ArgumentParser(description="进程外跑 minimax2api 设备码登录")
    parser.add_argument("--backend", default=str(DEFAULT_BACKEND))
    parser.add_argument("--name", default="minimax-device")
    parser.add_argument("--region", default="cn")
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args()
    return asyncio.run(run(Path(args.backend), args.name, args.region, args.timeout))


if __name__ == "__main__":
    raise SystemExit(main())
