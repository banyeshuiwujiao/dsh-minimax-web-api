# dsh-minimax-web-api (MiniMax Agent 反代 Provider 插件)

把 [`Zhengyuuuui/minimax2api`](https://github.com/Zhengyuuuui/minimax2api)（minimaxcode2api）作为本地反代后端，接入 DeepSeek Harness 桌面客户端的**模型选择器**。

> **只注册 Provider，不注册任何工具。** DSH 自带的工具能力（PowerShell、文件操作、审批流）仍由 DSH 原生机制接管。

---

## 为什么需要这一层

`minimax2api` 已经把 MiniMax Agent 的上游（`/mavis/api/v1/llm/v1/messages`，Anthropic Messages 协议）翻成了 OpenAI Chat Completions。但 DSH 需要的是一个 **`LlmAdapter`**：声明模型目录、申报上下文与输出预算、把 SSE 增量翻成 `StreamChunk`、按内核词表报错误码、并负责后端进程的生死。这些都在本插件里。

与本机另一个反代插件 `dsh-deepseek-web-api` **同构**（同一套目录解析、进程托管、流式编排骨架），差异只在三处：

| | deepseek-web-api | minimax2api |
|---|---|---|
| 后端形态 | Node（`dist/index.js`，需 build） | **Python**（`run.py`，uvicorn 同进程） |
| 工具协议 | 提示词注入 + DSML/JSON 文本解析 | **原生 Anthropic `tool_use`** → 标准 `tool_calls` |
| `/health` | 自述 version + capabilities + 开关 | `{status, accounts, usableAccounts, …}`，**无版本/能力字段** |

最后一行决定了契约校验不能照抄：那边缺能力清单就拒用，这边若也这样判，每台机器都会被当成旧构建。本插件的门槛只有一条——`/health` 必须是带 `status` 字符串的 JSON 对象。**号池为空只是运行状态**（还没导账号），只告警一次，不拒用。

---

## 核心特性

1. **直达模型选择器**：`ctx.llm.registerAdapter(['minimax-web-api'], adapter)`，可选模型：
   - `minimax-agent`：默认对话模型（上游 `MiniMax-M3.1-Flash`）
   - `minimax-m3.1-flash` / `minimax-m3.1-flash-thinking`：M3.1 Flash 及深度思考变体
   - `minimax-m3` / `minimax-m3-thinking`：M3 及深度思考变体
   - 模型 id 与后端 `app/records.py` 的 `builtin_models()` **逐字一致**——后端按 id 查目录并拒绝未知模型（不会静默替换），写错名字的代价是「能选但一调就 400」。
   - `minimax-image` 刻意不列：它是图像生成模型，走对话链路只会得到错误。
2. **免手动启停**：调用时探活 `http://127.0.0.1:4555/health`，未起则自动拉起 `python run.py --host 127.0.0.1 --port 4555 --data-dir <dir>`；dispose 时按**进程树**回收（Windows `taskkill /T /F`），不留孤儿。
3. **Python 解释器自动解析**：配置 `pythonPath` → 环境变量 `DSH_MINIMAX2API_PYTHON` → 后端目录 `.venv` / `venv` → PATH。`install.ps1` 会在后端目录建 `.venv` 并装依赖，插件直接复用，不必再记一次 `pip install`。
4. **原生流式三通道**：`reasoning_content` → `reasoning-delta`（思考折叠气泡，边生成边推）；`content` → `text-delta`；`tool_calls` → 按 `index` 累积后**整块**下发（分片到达也能合成一个完整调用，不会产出残缺块；缺 `id` 时自增兜底）。
5. **真实 token 计量**：请求带 `stream_options.include_usage`。反代的 `token_usage()` 会把 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` 折成真实 prompt 数——只读 `input_tokens` 会让开了 prompt cache 的长上下文看起来只有几十 token。拿不到真实值时才按真正上线的载荷估算，**绝不发 0** 让宿主误判水位。
6. **稳定错误码**：401/403 `AUTH`、402 `QUOTA`、429 `RATE_LIMIT`（透传 `Retry-After`）、400/413/422 `INVALID_REQUEST`、上下文超长 `CONTEXT_WINDOW_EXCEEDED`、5xx `SERVER`、其余 `HTTP_<status>`；**号池为空报 `MISSING_CREDENTIAL`**（不可重试）——报成 `TRANSPORT` 会让内核白重试两轮并掩盖真正原因。用户点「停止」一律 `ABORTED`。
7. **空回合不静默**：整轮无正文、无思考、无调用时报可重试的 `EMPTY_RESPONSE`，而不是发一个 `stop` 让 DSH 把回合判成「已完成」。
8. **图片 URL 透传**：DSH 的 `image` / `image_url` / `input_image` 块会转成 OpenAI `image_url`，后端再转成 Anthropic `image` 块。**只支持 http(s) URL**——`data:` base64 会被后端当成 url source 发给上游而失败，插件显式告警丢弃，不静默变空串。
9. **`max_tokens` 必须传**：Anthropic Messages 的 `max_tokens` 是必填项，反代缺省只有 4096。内核给的预算（`options.maxTokens`，回落到 `defaultMaxTokens`）会真的传下去，否则长文件写入会被上游截断。
10. **空闲超时**：上游连续 `streamIdleTimeoutMs`（默认 180s，MiniMax 首 token 尤其 thinking 可能很慢）不吐字节，按可重试的 `TIMEOUT` 中止，不无限挂着。
11. **每轮一行统计**：`logger.debug` 输出 `ms / ttft / reasonChars / contentChars / toolCalls / usage / outcome`；配 `logFile` 后后端子进程输出落盘（>2MB 轮转 `.1`）。
12. **进程生命周期两种语义**：托管（默认，stdio 管道，可 tail、可收树；拉起者被强杀会让后端因管道断裂退出）／`detach: true`（独立进程组，插件退出不牵连它）。`killTreeOnDispose: false` 退回只杀直接子进程。
13. **子进程环境白名单**：只放 OS 必需项 + **代理变量**（`HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY`，海外版业务接口锁海外出口，代理是常见部署方式）+ `MINIMAX2API_*` 命名空间 + 插件显式 `env`。宿主的 `PORT` / `HOST` 不会渗进去（端口与绑定地址由插件用命令行参数显式给出）。
14. **后端目录可移植**：配置 `serverDir` → 环境变量 `DSH_MINIMAX2API_DIR` → 指针 `~/.dsh/minimax2api.json`（`install.ps1` 写，含 git 版本与 Python 路径）→ 插件同级 → home 常见位置。显式写了但目录不成立时**不一票否决**，继续往下找并记日志。
15. **配置热更新**：适配器每轮 `prepareCall` 读当代配置。只影响请求的项（`defaultMaxTokens`、`toolDescriptionMaxChars`）改完下一轮生效；影响后端进程的项（`baseUrl`、`serverDir`、`pythonPath`、`dataDir`、`detach` 等）变更时自动回收旧管理器并重建。
16. **复用实例可诊断**：探活结果按 `healthTtlMs` 缓存；复用别人起的实例时比对 `/health` 自述，号池为空会告警一次并给出控制台地址。

---

## 安装

```powershell
cd C:\Users\Admin\DeepSeek_Harness\dsh-client-config\plugins\dsh-minimax-web-api
.\install.ps1
```

`install.ps1` 是幂等的，顺序是故意的：配置自检 → smoke → 解析后端与 Python 环境 → 同步运行时镜像并逐文件比哈希。任何一步失败立刻停止，不留半成品。

首次（或换了机器）用 `-BackendDir` 指定一次后端位置，之后由指针文件接管：

```powershell
.\install.ps1 -BackendDir C:\Users\Admin\DeepSeek_Harness\git-repo\minimax2api
```

### 接入 profile

把 `cordis.patch.yml` 里的 `insert` 块合进权威源 `dsh-client-config\profiles\desktop\cordis.patch.yml`，然后：

```powershell
cd C:\Users\Admin\DeepSeek_Harness\dsh-client-config
python scripts\sync-profiles.py --profile desktop
```

最后重启 `DeepSeek Harness.exe`。

---

## 必须先导账号

后端起来 ≠ 能出字。`/health` 返回 `status: degraded` 且 `usableAccounts: 0` 时，任何请求都只会得到：

```
no accounts configured; add one in the console
```

本插件把这句话判成 `MISSING_CREDENTIAL`（不可重试），不会伪装成网络故障重试两轮。

导入方式（打开 <http://127.0.0.1:4555/admin>）：

- **方式 A 浏览器一键登录**（推荐）：控制台「号池」→ 选区域 →「开始登录」→ 官方授权页 → 账号自动入池。走 OAuth2 设备码 + PKCE，不读 Cookie。
- **方式 B 手动粘贴 JWT**：登录 `agent.minimax.io` → DevTools → Local Storage → 复制 `_token` → 粘贴导入。
- **方式 D 邮箱密码批量导入**：每行 `邮箱 密码`，导入时自动登录换取 access/refresh token。

> **网络要求**：海外版业务接口锁海外出口。本机不在海外时，在控制台「设置」里填 `proxy`，或设置 `MINIMAX2API_UPSTREAM__PROXY` 环境变量（插件已把代理变量加进子进程白名单）。国内版（`agent.minimaxi.com`）直连即可。

### 登录页长什么样（选路依据）

两个区域的登录页**不是一回事**，选错会白折腾：

| | 国内区 `account.minimax.cn` | 海外区 `account.minimax.io` |
|---|---|---|
| 登录方式 | **微信扫码**（默认）、手机号+短信、账号密码 | **Continue with Google / Github / 邮箱**，无微信、无手机号 |
| 人机验证 | 点「获取验证码」会弹**腾讯 TCaptcha 滑块**（协议层伪造不了） | reCAPTCHA（登录页） |
| 每日签到积分 | **有**（见下节；第三方后端误判为"无"） | 有 |
| 余额不足 | 签到领的积分就够用 | 签到领的积分就够用 |

所以：

- **国内区 + 微信扫码**是当前最省事的一条路：扫码即登录，手机号未注册会自动建号。
  登录后**必须领当日积分**（下节），否则每条请求都 402。
- **海外区**只有 Google/GitHub/邮箱，且它的 agent 主机（`agent.minimax.io`）会按出口地区
  307 跳到国内站（实测：本机无论直连还是走 v2rayN 代理都是这个结果），
  所以**海外号在这台机器上基本不可用**——别在它上面浪费时间。

> 设备码 5 分钟过期，且 `expires_in` 是服务端定的、客户端改不了。过期就重新签发一条；
> 浏览器里**登录态会保留**（cookie 在），所以第二次通常直接落到授权页、点一下 Authorize 即可。

### 每日积分（签到）—— CN 账号怎么领

**"免费"的准确含义是"免费套餐 + 每天签到送额度"，不是无限免费。**
账号本身不花钱，插件也不花钱；花的是 **MiniMax 账号的积分**，而积分来自每日签到。

实测（2026-10-21，本机 CN 账号）：

| 步骤 | 结果 |
|---|---|
| 领之前查余额 | `plan=免费/1`，但 `total=0 / free=0 / purchased=0` |
| 不领直接发模型请求 | `402 insufficient_balance_error (1008)`，`errorCode 50113` |
| 领 400 积分后**同一条请求** | ✅ 真实出字 + 真实工具调用 + 真实 usage |
| 两次真实回合后余额 | `399.796`（400 − 0.204，约合 140 万 token 的量级） |

> 消费级网页聊天（`chat.minimaxi.com`）的免费额度与 Agent/Code 模型 API **不是同一个计费池**，
> 网页上能白聊不代表模型 API 能白用。

#### ⚠ 第三方后端的一个错误假设

`minimax2api` 自带的签到服务对大陆区账号**直接跳过**：

```python
# app/signin.py（第三方仓，read-only）
if account.region == REGION_CN:
    preflight.reason = "mainland region, no check-in service"
```

这是作者的**假设**，不是上游事实。**cn 部署其实有完整的签到服务**，实测三个端点全通：

| 端点 | 作用 |
|---|---|
| `GET /minimax-cloud/api/v1/signin/status` | 7 天签到面板（每天 400 分，第 4 天 1000） |
| `POST /minimax-cloud/api/v1/signin/claim` | 领取当日积分，返回 `points` |
| `GET /matrix/api/v1/commerce/get_membership_info` | 余额（`total` / `free` / `purchased`） |
| `GET /minimax-cloud/api/v1/config` | **必须先调**，否则上游"记录了已签到但永不发放积分" |

这三个端点都走 `x-signature` / `yy` 签名（`x-signature = md5(second + 'I*7Cf%WZ#S&%1RlZJ&C2' + body)`），
**顺序不能颠倒：先 `/config` 再 `claim`**。

#### 领积分：用本插件自带的脚本

签名、代理、错误分类都在第三方仓的 `app/upstream.py` 里，本插件不重复实现协议，
只提供一个**绕开"大陆区跳过"判断**的入口：

```powershell
cd C:\Users\Admin\DeepSeek_Harness\dsh-client-config\plugins\dsh-minimax-web-api
C:\Users\Admin\DeepSeek_Harness\git-repo\minimax2api\.venv\Scripts\python.exe scripts\claim_daily_credits.py
```

输出（已签过时会幂等跳过，不重复领）：

```
后端目录：C:\Users\Admin\DeepSeek_Harness\git-repo\minimax2api
=== minimax-cn (region=cn) ===
    余额 total=399.796 free=399.796 purchased=0.0 plan=/1
    余额已够（399.796 ≥ 1.0），跳过领取
```

参数：

| 参数 | 含义 |
|---|---|
| `--probe` | 只看余额与签到面板，不领取 |
| `--min-balance 50` | 余额低于该值才领（默认 1，即余额为 0 时领） |

后端目录解析顺序与插件 `lib/paths.js` 一致：`MINIMAX2API_DIR` → 指针 `~/.dsh/minimax2api.json` → 常见位置。

#### 想让它自动每天跑

**已经挂好了 Windows 计划任务**（每天 09:05，与后端自带签到调度同一时刻）：

| 项 | 值 |
|---|---|
| 任务名 | `MiniMax Daily Credit Claim` |
| 触发 | 每天 **09:05**（下一次：2026-10-22 09:05） |
| 执行 | `cmd.exe /c "…\plugins\dsh-minimax-web-api\scripts\claim_daily_credits.cmd"` |
| 运行身份 | 当前用户（`Admin`），仅在已登录时运行，不需要存密码 |
| 错过补偿 | `StartWhenAvailable`：关机错过会在下次开机后补跑 |
| 日志 | `%USERPROFILE%\.dsh\logs\minimax-claim.log`（>512KB 自动轮转成 `.1`） |

```powershell
schtasks /Query /TN "MiniMax Daily Credit Claim"          # 看状态与下次运行
schtasks /Run   /TN "MiniMax Daily Credit Claim"           # 想立刻试一次
```

包装脚本 `scripts\claim_daily_credits.cmd` 是 **ASCII-only** 的：cmd.exe 按系统 ANSI
码页（这台机器是 GBK）读 `.cmd`，UTF-8 的中文注释会变成乱码并**连带把后面的行解析坏**
（真踩过：整份脚本因为一行注释崩掉）。所以注释一律英文，脚本输出用
`PYTHONIOENCODING=utf-8` 强制 UTF-8 落盘。

#### 每天都要领，不看余额

签到是**按天**的：面板有 day1..day7，今天不领就断连续，第 4 天那 1000 分也拿不到。
所以判断依据是"今天领没领"（`claimed_today`），**不是**"余额够不够"——
上游对当天已领是幂等的（返回 already），每天都调是安全的。

（脚本早先的默认是"余额 ≥ 1 就跳过"，那样在余额没花光的第二天会**白跑一天并断签**，
已改成看 `claimed_today`；`--min-balance` 保留为可选的额外保护，默认 0 = 不设限。）

如果你更想让**第三方后端自己的调度器**来领（而不是计划任务），就要给
`app/signin.py` 打一个本地补丁去掉它对 CN 的跳过——代价是克隆仓与上游产生一处本地差异
（见 `TODO.md` 的 P0-6）。

### 余额不足长什么样

上游把「余额不足」包成 **HTTP 500**，正文里才藏着真正的 402：

```
minimax llm HTTP 500: {"error":"...unexpected status code: 402...
  \"type\":\"insufficient_balance_error\",\"message\":\"insufficient balance (1008)\"}","errorCode":50113}
```

只看 HTTP 状态码会把它判成 `SERVER` → 进重试列表 → 白等两轮退避，而它其实是"账号没钱了"。
本插件按**正文**识别，报成 `QUOTA`（不可重试），并在错误里附上下一步该做什么：

```
（MiniMax 账号余额不足：给该账号充值，或在 http://127.0.0.1:4555/admin 换一个账号）
```

---

## 配置项

见 [`cordis.patch.yml`](./cordis.patch.yml)，每一项都有注释。要点：

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:4555` | **只允许回环**。后端完全没有鉴权（控制台与 `/v1` 都开放），绑到 `0.0.0.0` 等于把号池和额度交给整个网络 |
| `serverDir` / `pythonPath` / `dataDir` | 空 | 留空交给解析层与指针文件；换机器不用改配置 |
| `maxContextWindow` | `512000` | M3.1 Flash 标称 512K（可选 1M）。申报值决定内核压缩线 |
| `defaultMaxTokens` | `32768` | 既向 DSH 申报单轮输出预留，也作为 `max_tokens` 传给后端 |
| `streamIdleTimeoutMs` | `180000` | MiniMax 首 token 可能很慢，比 deepseek 那套的 120s 更宽 |
| `strictBackend` | `true` | 为 `false` 时契约不符只告警不拒用 |

---

## 测试

```powershell
node test/config_check.mjs   # cordis.patch.yml 结构自检（缩进/必需键/回环/baseUrl）
node test/smoke.mjs          # 28 个用例：纯函数、流式编排、路径解析、契约
node test/preparecall_regression.mjs   # 真实 DSH LlmRuntime 集成（需本机运行时）
```

smoke 全部 hermetic：不联网、不依赖本机后端、不读写真实指针文件。

---

## 排错

| 现象 | 看哪里 | 判定 |
|---|---|---|
| 模型能选，一调就报 `MISSING_CREDENTIAL` | `http://127.0.0.1:4555/admin` | 号池空。导账号，不是插件问题 |
| 一调就报 `BACKEND_STALE` | 插件日志里的契约问题 | 4555 上跑的不是 minimax2api（或被别的服务占了端口） |
| 起不来，报「PID 已退出」 | `~/.dsh/logs/minimax-web-api.log` | 多半是 Python 依赖缺失或端口被占。跑 `install.ps1` 补依赖 |
| 一直 `TIMEOUT` | 后端日志 / 控制台审计页 | 上游慢或代理不通。海外版没配代理会 401/超时 |
| 回复被截断 | 请求体里的 `max_tokens` | 反代缺省 4096；确认 `defaultMaxTokens` 已传下去 |

---

## 安全边界

- 后端**无鉴权**：`/v1` 与 `/admin/api/*` 对所有能连上端口的人开放。插件强制 `baseUrl` 只绑回环（`config_check.mjs` 会红）。
- 凭据、Cookie、`bridge.sqlite3` 内容**绝不**写进日志或错误文本；本插件只记「账号数 / 可用数」这类计数。
- 插件不新增任何远端、不上传任何数据。
