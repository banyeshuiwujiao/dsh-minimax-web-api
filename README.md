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
| 每日签到积分 | **没有**（`app/signin.py`：*"mainland region, no check-in service"*） | **有**（每日签到送积分，够白嫖） |
| 余额不足 | 只能**充值** | 签到领的积分就够用 |

所以：

- **只想用现成的微信账号** → 国内区扫码登录，但账号**必须充值**才有额度。
- **想要免费额度** → 海外区，用 Google/GitHub 登录，然后打开控制台「设置 → 每日签到」并跑一次
  `POST /admin/api/signin/run`，签到积分到账后即可出字。

> 设备码 5 分钟过期，且 `expires_in` 是服务端定的、客户端改不了。过期就重新签发一条；
> 浏览器里**登录态会保留**（cookie 在），所以第二次通常直接落到授权页、点一下 Authorize 即可。

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
