# dsh-minimax-web-api TODO —— 首次长时程实跑之后的缺口清单（基于 session-7f8ab623）

> 本文件不是愿望清单。每条都带 **代码位置 + 实测证据（时间戳/seq）+ 建议改法 + 验收**，
> 口径照 `../dsh-deepseek-web-api/TODO.md`：插件只做协议翻译与进程托管，解析与重试的权威留在后端。
>
> 证据来源：DSH 会话 `session-7f8ab623-3a5a-4a6a-8d61-1bab61ab58c3`（本地 00:46 起跑，174 次工具调用 / 111 步 / 跨 6 小时），
> 解码方式见文末「取证方法」。会话本身**在 06:51 被截断**（最后一条是 turn 2 step 34 的 `tool/call`，没有 `tool/result`，也没有 `turn/end`）。

---

## 2026-10-21 07:00-09:50 续跑结论（哪些已闭环、哪些还欠着）

**已闭环**（证据见下）：

- [x] **P0-1 号池为空、整条链从未产出真实推理** → 账号已入池（CN 区，微信扫码登录），
      `minimax-agent` 真实出字 48 字 + 真实工具调用 `get_weather({"city":"北京"})` + 真实 usage（210/27、452/38），
      ttft 2.2s。跑法：`node test/live_e2e.mjs`。
- [x] **P0-4 指针 `gitRev` 永远是 null** → `install.ps1` 现在回写真值，指针实测 `0411037`。
- [x] **P0-5 第三方仓 origin 可 push** → `git remote set-url --push origin DISABLED-local-only`（fetch 仍可用）。
- [x] **P0-3 的一半：LICENSE** → 已补 MIT（同 `dsh-deepseek-web-api`）。
      **偏离既定设计**：本插件**没有**自己的 git 仓，而是暂由外层 `dsh-client-config` 跟踪
      （外层 `.gitignore` 已注明理由：没有远端就忽略它 = 源码完全没进版本管理）。
      若将来要独立成仓，先把它移出外层跟踪再 `git init`。
- [x] **P1-6 4555 是否只绑回环** → 实测监听地址只有 `127.0.0.1`。

**新发现的两个坑**（本次才暴露，之前没人踩过）：

- [x] **P0-6 第三方后端按"大陆区无签到服务"跳过 CN 账号，而 cn 部署其实有完整签到服务**。
      代码：`app/signin.py` → `if account.region == REGION_CN: ... "mainland region, no check-in service"`。
      实测：cn 的 `signin/status`、`signin/claim`、`credit/details`、`/config` **全部可用**，
      每日 400 积分（第 4 天 1000）。不领就是 402 `insufficient_balance_error`（errorCode 50113）。
      已在插件侧提供绕开它的入口：`scripts/claim_daily_credits.py`（见 README「每日积分（签到）」）。
      **自动化已挂**：Windows 计划任务 `MiniMax Daily Credit Claim`，每天 09:05，
      日志 `%USERPROFILE%\.dsh\logs\minimax-claim.log`（已实测触发一次，LastResult=0）。
      **语义坑（已修）**：判断依据必须是 `claimed_today` 而不是"余额够不够"——
      签到按天计，余额没花光的日子跳过就断连续、第 4 天的 1000 分也拿不到。
      验收：连续两天不手动干预，模型请求仍能出字（积分不归零）。
- [x] **P0-7 海外区（`account.minimax.io`）的 agent 主机在本机不可用** → **已解决**。
      当时的实测与误判：`agent.minimax.io` 直连 `ConnectError`（README 说的"锁海外出口"），
      走本机 v2rayN 代理（`http://127.0.0.1:10808`）则 **307 跳到 `agent.minimaxi.com`**。
      当时误以为"全球号换不来额度"，实际**根因是 v2rayN TUN 默认「绕过大陆」规则**：
      `minimax.io` 命中 `geoip:cn` → 直连国内 → Akamai 边缘按出口地域 307 到国内站。
      **换 DNS 没用**（强制连 DoH 解析出的 `2.17.106.x` 依然 307），必须让**出口**在海外。
      解法：在 v2rayN 路由预设加一条按域名的规则（优先于 `geoip:cn` / `geosite:cn`）：
      `{"OutboundTag":"proxy","Domain":["domain:minimax.io"]}`，改完**重启 v2rayN**。
      验证：`agent.minimax.io/v1/api/user/info` 由 307 变 **401**（真 API），
      `agent.minimax.io/` 变 **200**，`account.minimax.io/oauth2/device/code` 变 **200**。
      **海外号已入池**（`minimax-global`，region=global），签到同样有 400 积分/天，
      停掉 CN 号单独跑真实推理 + 真实工具调用全过（ttft 1.1s）。
      **脆弱点**：规则写在路由预设里，换预设就没了 → 插件自带
      `scripts/ensure_v2rayn_minimax_proxy.py` 把规则补进**每个**预设，
      每日任务先跑它再领积分；补了当前生效的预设时会提示需要重启 v2rayN。

---


## 0. 已经确认没问题的部分（别重复劳动）

- 后端拉起链路是通的：`node test/live_lifecycle.mjs`（seq 863，06:51:31）跑出
  `ensure() → pid 18272 → 端口 4555 在听 → 再 ensure() 复用同一 PID → dispose() 后端口释放`，四步全绿。
- `/health` 只有 `{status, accounts, usableAccounts, signinEnabled, upstream, time}`、**没有 capabilities/version**，
  `lib/contract.js` 因此只硬校验"`status` 必须是字符串"，账号数为 0 被明确判为**运行状态**而不是契约失败 —— 这个取舍是对的，别改回照抄 deepseek 的能力清单门槛。
- "号池为空"已经按**帧内错误**处理而不是 HTTP 状态：后端先回 200 再吐一帧 `{"error":{…}}`，
  `lib/openai.js:217` 的 `NO_ACCOUNT → MISSING_CREDENTIAL` 与 `lib/server.js:210` 的 `/号池里没有可用账号/` 去重告警都有 smoke 覆盖（`test/smoke.mjs:152`、`:335`）。
- 入口守卫已经避开了 deepseek 那次的坑：`test/config_check.mjs:176` 用 `pathToFileURL(process.argv[1]).href` 判定。

---

## P0 —— 现在这条链还不能真正给用户用

- [ ] **P0-1 号池为空，整条链从未产出过一次真实推理**（阻塞项）。
  证据：`/health` 实测 `{"status":"degraded","accounts":0,"usableAccounts":0,"signinEnabled":false,"upstream":"https://agent.minimax.io"}`（seq 863）；
  profile 注释也写了「号池为空时后端只会报 no accounts configured，需先在 http://127.0.0.1:4555/admin 导账号」。
  现在缺的不是代码，是**一次真回合**：所有 10 个 smoke 场景都是 mock 的，`MISSING_CREDENTIAL` 至今只在假响应上验过。
  改法：导入 1 个账号 → 在 DSH 里选 `minimax` 模型跑一个带工具的小回合 → 核对界面显示的错误码/正文与 `~/.dsh/logs/minimax-web-api.log` 一致。
  验收：一次真实 completed 回合 + 一次故意清空号池的回合（后者必须报 `MISSING_CREDENTIAL` 且**不进重试**）。

- [ ] **P0-2 复用 4555 之前不校验"那是不是 minimax2api"**。
  代码：`lib/contract.js` 的 `checkContract()` 只要求 `status` 是字符串；`lib/server.js` 的 `ensure()` 命中已在监听的后端就照单复用。
  为什么这是真风险：deepseek 那边已经吃过同款亏 —— 8787 上挂着上一代的 detach 进程（PID 8544），新客户端复用旧构建，
  直到 2026-10-21 01:09 才手动换代；而 minimax 这条链**连 version/capabilities 都没有**，判错的成本更低、发现的成本更高。
  改法（不必改后端）：复用路径上加一条身份校验 —— 顺手 `GET /v1/models`，要求返回体里出现 MiniMax 模型名片段；
  不匹配就拒绝复用并报 `BACKEND_STALE`，提示"4555 上是别的进程，先查 `netstat -ano | findstr 4555` 的 owner PID"。
  验收：把任意一个带 `status` 字段的假服务（比如另一个 FastAPI）挂到 4555，插件必须拒绝复用并给可操作报错。

- [ ] **P0-3 插件没有独立 git 仓、`.gitignore` 与 LICENSE 都缺**。
  实测：`plugins/dsh-minimax-web-api/` 下只有 `README.md cordis.patch.yml install.ps1 lib package.json test`，**没有 `.git`**。
  这与既定设计相反（deepseek 插件是故意做独立仓、外层 `.gitignore` 登记、不并入外层、不做 submodule）。
  外层 `dsh-client-config` 当前未提交的两处改动正好是这条链的账：`+plugins/dsh-minimax-web-api/`（.gitignore 第 28 行）、
  `profiles/desktop/cordis.patch.yml` 的 minimax provider 块（+39 行）。
  改法：`git init` + 远程用**自己的** `banyeshuiwujiao/dsh-minimax-web-api`（红线：绝不新增远端、绝不推第三方）→ 补 LICENSE → 提交外层两处。
  验收：`git -C plugins/dsh-minimax-web-api log -1` 有提交；外层 `git status` 干净；镜像一致性仍由 install.ps1 哈希校验通过。

- [ ] **P0-4 `writePointer(…, null, py)`：指针里的 `gitRev` 永远是 null**。
  代码：`install.ps1:39` 与 `install.ps1:57` 两处都把 gitRev 写成 `null`，没有调 `readGitRev()`；
  实测指针 `~/.dsh/minimax2api.json` → `"gitRev": null`（而后端仓库在 `0411037`，是 git 仓，读得到）。
  同一族的另一个坑也还在：命中 pointer 分支时**不回写过期的 gitRev** —— 这个 deepseek 侧已于 2026-10-21 01:0x 修掉（提交 `fb4f25f`，
  `lib/paths.js` 新增 `shouldRefreshPointer()`）。minimax 的 `lib/paths.js` 是拷贝，没带上这个补丁。
  改法：两处 `writePointer` 补 `readGitRev(dir)`；把 `shouldRefreshPointer` + install.ps1 的 pointer 回写分支 + smoke 断言整套同步过来（注意保留 Python 解释器字段）。
  验收：跑 `install.ps1` 后指针 `gitRev = 后端 HEAD 短版本`；故意把指针 gitRev 改成别的值再跑一次，会被回写并打印 `指针 gitRev 已过期，回写: old -> new`。

- [ ] **P0-5 `git-repo/minimax2api` 的 `origin` 是第三方仓库且可写**。
  实测：`git remote -v` → `origin https://github.com/Zhengyuuuui/minimax2api.git`（fetch **和 push** 都指向第三方），本地领先 0 个提交。
  deepseek 那边是 `origin`（自己的 fork）+ `upstream`（只读），这边只要有一次误点 push，就是把改动推给别人家的仓。
  改法（三选一，按红线"绝不新增远端"→ 推荐第 1 条）：
  ① 把 `origin` 的 URL 置为无效或 `--` 本地存档（`git remote set-url --push origin DISABLED-local-only`）；
  ② 由用户先 fork 到自己的 `banyeshuiwujiao/*` 再把 origin 指过去；
  ③ 保持现状但在 `HANDOFF`/README 顶部写死"此仓禁止 push"。
  验收：`git remote -v` 里不存在能直接把提交推给 Zhengyuuuui 的 URL。

---

## P1 —— 会话里真实出现过、但没被闭环的

- [ ] **P0→P1 交接：模型进没进客户端 —— 已部分实测，仍缺一次真回合**。
  时间线：profile 权威源 06:43 写入 → `sync-profiles` 06:46 完成镜像同步 → **而当时在跑的客户端是 01:11:37 那批进程**，没读到新块；
  会话最后一步（seq 869，06:51:30）正要去重启客户端时被截断。06:53:54 的客户端重启是我今天做运维时由守护拉起的，不是那次任务。
  新证据（06:55:37，即新客户端起来 103 秒后）：4555 上出现了一条**完整挂在客户端树里**的后端进程链 ——
  `13068(main) → 19720(service) → 9660(DSH runner) → 11536(pwsh) → 5544(.venv python run.py) → 18664(python，真正的 4555 监听者，绑 127.0.0.1)`。
  也就是 **provider 已注册、`autoStart` 在真实客户端里生效了**；剩下要验的只是"能不能出字"。
  改法：P0-1 导账号后直接选 minimax 模型跑一个回合即可确认；把"客户端读到新 profile"的判定写成一条可重复的检查（比较 `.dsh/profiles/desktop/cordis.patch.yml` 的 mtime 与 main 进程 StartTime）。
  验收：一次 minimax 模型的 completed 回合，DSH 界面有正文/工具调用，插件日志有对应行。

- [ ] **P1-2 改完 `lib/*.js` 忘了重跑 install.ps1，运行镜像就会落后源码**（会话 seq 822 自述踩到："the runtime mirror is stale now"）。
  今天核对：镜像 `lib/provider.js` 与源码 SHA256 已一致（`2FCDBACE…B07B2`），是**运气好**（06:50 那次 install 覆盖了），机制上没有任何东西会拦住下一次。
  改法：install.ps1 已有逐文件哈希校验 —— 缺的是**反向提醒**：把校验挪成一个可单独跑的 `test/mirror_freshness.mjs`，并在插件 README 的"改完代码"步骤里点名：改 `lib/` → 跑 install.ps1 → 重启客户端。
  验收：故意改一个 `lib/*.js` 不 install，脚本必须红。

- [ ] **P1-3 `max_tokens` 语义（预留 vs 真传）还没被真实回合验证**。
  代码：`lib/provider.js:276-324` 附近（会话 seq 795 于 06:49:01 才补上"把 defaultMaxTokens 当 max_tokens 真传"）；
  profile 注释 `defaultMaxTokens: 32768` 同时承担两个身份 —— 向 DSH 申报的单轮预留，和真的发给 Anthropic Messages 的 `max_tokens`。
  对照事实（deepseek 侧从 `app.asar` 取证）：DSH 把 `defaultMaxTokens` 当 `reservedCompletionTokens` **预留**用，而 minimax 这边把它当**上限**传，两个语义叠在一个字段上，
  一旦上游真的按 32768 截断，DSH 的上下文水位与压缩决策会建立在错数上。
  改法：等 P0-1 跑通后，看后端日志里一次长回合的 completion tokens；若确实受限，拆成两个配置项（申报值 / 上送值），别共用。
  验收：一次 3 万字以上的 `write` 参数回合，正文与工具参数都不被截断，且 usage 与 DSH 显示一致。

- [ ] **P1-4 工具调用参数缺失被判成 `invalid arguments`**（会话里 2 次：seq 112、119，`Error: invalid arguments: missing required property "description"; missing required property "command"`）。
  这是 pwsh 工具的必填参数没被填满 —— 要么模型输出的调用被截/被剥，要么 Anthropic 协议侧的参数拼装丢了字段。
  先取证再动手：把这两个 callId 的原始 arguments 从会话转录里挖出来（文末方法），对照 `lib/provider.js` 的 tool-call 组装路径。
  注：deepseek 后端今天刚上了**空回合归因**（提交 `71db820`，`empty-stream-attribution`），minimax 后端是第三方 Python，**不会有这套诊断**，
  所以插件侧要自带一条：工具回合产出 0 个调用且正文为空时，日志里区分"上游没回内容"与"回了但解析没认出来"。
  验收：连续 10 个带工具的真实回合，不出现 `invalid arguments`；出现时插件日志能指出是哪一半丢了。

- [ ] **P1-5 文档三件事缺**。
  `docs/protocols.md`（Anthropic Messages ↔ DSH 块的映射、以及"200 后再吐 error 帧"这个非标准行为）、
  `docs/troubleshooting.md`（4555 被占 / 号池空 / 镜像过期 / 客户端没读到新 profile 这四类现场）、
  以及安全约束章节（4555 与 `/admin` **完全没有鉴权**，账号池与上游额度就在本地 HTTP 上，靠的只是"只绑回环"这一条 —— 见 P1-6）。

- [ ] **P1-6 `/admin` 与 `/v1` 无鉴权，且已绑到 `100.68.50.x` 这类可达网段的风险未实测**。
  现在唯一防线是 profile 里 `baseUrl: 'http://127.0.0.1:4555'` 与 `run.py --port 4555` 的默认绑定。
  改法：实测 `Get-NetTCPConnection -LocalPort 4555` 看监听地址是否出现非回环；若出现，插件侧 `install.ps1`/config_check 加一条"后端监听必须只回环"的门。
  验收：贴出监听地址证据；config_check 能抓住 `0.0.0.0` 绑定（deepseek 的 `checkSampleHygiene` 已有公网绑定检查，可照搬）。

- [ ] **P1-7 没有 CI，也没有任何文件规模守卫**。
  对照 deepseek：`.github/workflows/ci.yml` 两个 job（ubuntu 结构检查 + **windows-latest** smoke）、`scripts/check-source-lines.mjs` 300 行硬上限、`check-comments.mjs` 英文 ASCII 注释守卫。
  现状：`lib/provider.js` **632 行**、`lib/server.js` **324 行**，没有 `.github/`。
  改法：P0-3 建库之后立刻补 workflow（至少 `node test/config_check.mjs` + `node test/smoke.mjs`）；规模守卫这条对 JS 可以先只做告警不做硬失败，但要记在文档里，否则 provider.js 会继续长。

---

## P2 —— 稳定性与运维口径

- [ ] **P2-1 托管模式（`detach: false`）在客户端重启时的 EPIPE 行为未实测**。
  profile 当前是 `detach: false` + `killTreeOnDispose: true`，而 deepseek 侧的既有事实是：托管 stdio 走管道，拉起者被强杀会让后端 EPIPE 自杀（P2-8 那次就是靠 `detach: true` 解耦）。
  客户端每次被守护重启（今天 00:32、01:09、01:11、06:53 共 4 次）都可能顺手带走 Python 后端；号池导入后这会打断长回合。
  改法：实测一次（起后端 → 杀客户端 → 看 4555 是否还活着），活不下来就照 deepseek 的方式改 detach 并让 stdio 落文件。
  验收：一次客户端强杀之后 4555 的 `/health` 仍可访问，且插件能重新认领 PID。

- [ ] **P2-2 `streamIdleTimeoutMs: 180000` 与 thinking 模型的首 token 延迟没实测过**（真实 ttft 至今为 0 个样本）。
  改法：P0-1 跑通时顺手记录 3 个回合的 ttft，再决定是收紧还是保持；超时必须报可重试的 `TIMEOUT` 而不是 `TRANSPORT`。

- [ ] **P2-3 与第三方后端仓的隔离纪律**。
  今天实测 `minimax2api` 工作区干净、领先 0 提交，`.gitignore` 已排除 `/data/`、`.venv/`、`*.sqlite3`（含 `bridge.sqlite3` 与 210KB 的 `-wal`）—— 这点是好的。
  但插件脚本会在后端目录里落临时文件：会话 seq 827 专门查过 `data-server*.log` 这类 stray 日志。
  改法：任何写进后端目录的临时/日志文件都必须落在 `.gitignore` 已覆盖的路径（或直接落到 `~/.dsh/logs/`），并在 smoke 里加一条"不新增未跟踪文件"的自检（deepseek 有 hermetic 测试的先例）。

- [ ] **P2-4 Python 侧是"两跳解释器"，持 4555 的不是被拉起的那个 PID**。
  实测（06:55:37）：`.venv\Scripts\python.exe`(5544) 起 `run.py`，真正监听 4555 的是它的子进程 `Python312\python.exe`(18664) —— venv 启动器把服务交给了 base 解释器。
  `manager.pid()` 记的是 5544 还是 18664 决定了两件事：`isAlive(pid)` 判活可能只看到壳、`dispose()` 的 `taskkill /T` 必须从壳往下带才能放掉端口。
  `test/live_lifecycle.mjs` 第 4 步已经用"轮询端口是否释放"兜住了（今天 06:51 跑出 `dispose 后 4555 已关闭` ✅），但**真实客户端里那次没验过**（P2-1 一并测）。
  验收：真实客户端里让 provider 起后端 → 杀客户端 → 断言 4555 释放且 `Get-NetTCPConnection -LocalPort 4555` 无残留；若残留，改成按端口 owner 反查进程树回收。

---

- [x] **P0-8 access token 只有 1 小时，过期即 401，且号池会僵死一小时**（2026-10-21 11:05 实测）。
      真实 DSH 会话 `session-a26a2505-…` 三个回合全失败：先 `minimax llm HTTP 401`，
      之后 `accounts unusable: minimax-cn, minimax-global`。
      根因（读 `app/pool.py` + `app/keepalive.py` 得出）：
      1) `pool._record_failure` 在 401 时先试续期，**但请求路径上的续期不复位账号状态**
         （只有 `keepalive.renew_account` 的 `apply()` 会把 status 复位成 active）；
         同一请求的重试/故障转移再打一次 → 又 401 → **续期成功的账号被"退休"**。
      2) `keepalive.sweep` 只在 `token_expires_at - margin <= now` 时才动手，
         而刚被退休的账号 token 还没到期 → `due=0` → 什么都不做 → **没有快速恢复**。
      实测影响：11:05 两号全 401 → 被退休 → 之后 10 次请求全 accounts unusable，
      整整一小时（到 token 自然到期）才可能自愈。
      修复（插件侧）：
      - 新增 `scripts/keep_tokens_alive.py`：复用后端 `Keeper.renew_account`
        （成功即复位 status=active），在"剩余 ≤40 分钟"或"status=invalid"时动手；
      - 插件启动时跑一次，之后每 30 分钟一次（`poolIntervalMs`）→ 客户端开着就不会过期；
      - 脚本是**进程外**写库，续完会通知后端 sweep 重载号池（否则内存里还是旧 token）；
      - 错误分类：`minimax llm HTTP 401` → `AUTH`、`accounts unusable: ...` →
        `MISSING_CREDENTIAL`（都不可重试；原先都落进 TRANSPORT 白重试两轮）。
      **上游缺陷已打本地补丁**（`git-repo/minimax2api` 的分支
      `local/robust-token-recovery`，提交 `f317f34`；`main` 仍与上游一致，
      push 通道锁死、不推远端；说明见仓内 `LOCAL-PATCHES.md`）：
      1) `renew_account` **先写库、后 `print` 报告**；stdout 一断（后台 job 的输出管道
         中途断开——日志从 10:02 之后一行都没有就是它）→ `print` 抛 BrokenPipeError →
         **一次成功的续期被当成失败** → 凭据完好的账号被退休；sweep 的错误处理同样
         `print` → **sweep 一起死**，之后再没有续期。补丁：`print` → `_log()`（吞写失败）。
      2) `pool._record_failure` 把 renewer 抛的异常当"凭据死了" → 退休。补丁：异常只说明
         **没判定** → 走冷却，不退休。
      3) sweep 只管"快到期" → 被误退休的账号没有回来的路。补丁：可续期且
         `status=invalid` 的账号也纳入本轮，续期成功即复位。
      验证：`tests/test_local_patches.py`（4 例）+ 上游 `tests/test_bridge.py`（97 例）
      = 101 passed；并在活着的号池上**复现过原事故**（把 token 换成坏的 → 上游 401），
      结果账号**保持 active**、token 被续上、请求继续出字。
      另注：后端**没有暴露**单账号续期路由（`server.py` 只有 status / sweep），
      所以救急走 `sweep`（它顺带 `pool.load()`）。
      环境侧也改了：后端 stdout **直写文件**（`%TEMP%\mmx-api.log`），不再接会断的管道。

---

## 附：取证方法（下次排障直接抄）

1. 会话转录是**每帧一条记录**的 zstd 拼接：`~/.dsh/sessions/--C-Users-Admin-DeepSeek-Harness--/session-<uuid>/session.v4.jsonl.zstd`。
   Node 25 可用 `zlib.zstdDecompressSync`，但**整文件一次性解只会得到第一条记录**；要按 magic `28 b5 2f fd` 切帧逐帧解
   （切到下一帧起点偶尔会截断，把切片末尾加宽 1–8MB 重试即可）。今天 476 帧 → 872 条记录、4.4MB 明文全部解出。
2. 记录类型分布是任务画像：本会话 `tool/call=174 / tool/result=173 / step/*=111+110 / assistant/message=110 / user/message=10`，
   `job/registered=78 vs settled=77` 的差 1 + 最后一条 `tool/call` 无 result = **会话被截断的位置**。
3. 真错误只看三处：`isError:true`、正文以 `Error:` 开头、`Traceback`。用宽泛关键字（"error|404|failed"）会把 88% 的正常结果也捞出来 —— 别拿它下结论。
4. workspace → sessionId 映射：`~/.dsh/storages/workspace.json`；插件与后端的落盘日志：`~/.dsh/logs/minimax-web-api.log`。
   **两份日志时钟不同**：插件写入的行带 `[…Z]`（UTC，本地 = +8），uvicorn 自己透出的行没有时间戳、按本地顺序追加 —— 对齐现场时先认 `[minimax-web-api 退出] code=1` 这类插件行。
