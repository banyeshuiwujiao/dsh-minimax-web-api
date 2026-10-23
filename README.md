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

1. **直达模型选择器**：`ctx.llm.registerAdapter(['minimax-web-api'], adapter)`，当前只公布一个模型：
   - `minimax-agent`：默认对话模型（上游 `MiniMax-M3.1-Flash`）
   - 2026-10-22 精简：`minimax-m3.1-flash` / `-thinking`、`minimax-m3` / `-thinking` 已从选择器移除。
     前两条与 `minimax-agent` 的后端行为完全相同（`gateway.py` 只把 `upstream_model` 塞进请求体，
     `upstream`/`variant` 两个字段只入库、只用于后台展示，不参与请求构造），所以移除不丢能力；
     `minimax-m3` 系列是另一个上游模型（`MiniMax-M3`），要恢复就照后端目录把条目抄回 `KNOWN_MODELS`。
   - 模型 id 与后端 `app/records.py` 的 `builtin_models()` **逐字一致**——后端按 id 查目录并拒绝未知模型（不会静默替换），写错名字的代价是「能选但一调就 400」。
   - `minimax-image` 刻意不列：它是图像生成模型，走对话链路只会得到错误。
2. **免手动启停**：调用时探活 `http://127.0.0.1:4555/health`，未起则自动拉起 `python run.py --host 127.0.0.1 --port 4555 --data-dir <dir>`；dispose 时按**进程树**回收（Windows `taskkill /T /F`），不留孤儿。
3. **Python 解释器自动解析**：配置 `pythonPath` → 环境变量 `DSH_MINIMAX2API_PYTHON` → 后端目录 `.venv` / `venv` → PATH。`install.ps1` 会在后端目录建 `.venv` 并装依赖，插件直接复用，不必再记一次 `pip install`。
4. **原生流式三通道**：`reasoning_content` → `reasoning-delta`（思考折叠气泡，边生成边推）；`content` → `text-delta`；`tool_calls` → 按 `index` 累积后**整块**下发（分片到达也能合成一个完整调用，不会产出残缺块；缺 `id` 时自增兜底）。
5. **真实 token 计量**：请求带 `stream_options.include_usage`。反代的 `token_usage()` 会把 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` 折成真实 prompt 数——只读 `input_tokens` 会让开了 prompt cache 的长上下文看起来只有几十 token。拿不到真实值时才按真正上线的载荷估算，**绝不发 0** 让宿主误判水位。
6. **稳定错误码**：401/403 `AUTH`、402 `QUOTA`、429 `RATE_LIMIT`（透传 `Retry-After`）、400/413/422 `INVALID_REQUEST`、上下文超长 `CONTEXT_WINDOW_EXCEEDED`、5xx `SERVER`、其余 `HTTP_<status>`；**号池为空报 `MISSING_CREDENTIAL`**（不可重试）——报成 `TRANSPORT` 会让内核白重试两轮并掩盖真正原因。用户点「停止」一律 `ABORTED`。
7. **空回合不静默**：整轮无正文、无思考、无调用时报可重试的 `EMPTY_RESPONSE`，而不是发一个 `stop` 让 DSH 把回合判成「已完成」。
8. **图片能真的被模型看见**（2026-10-21 修）：内核给适配器的图片**不是 URL**，而是持久引用
   `{type:'image', attachment:{attachmentId, …}}`——字节要靠挂载的 attachment 服务
   （`ctx.attachments.readImageRequest`）取。插件用 `lib/images.js` 把它解析成 `data:` URL，
   再由 `lib/openai.js` 转成 OpenAI 的 `image_url`；`data:` 与 `http(s)` 都能直接转发
   （反代会把 `image_url` 变成 Anthropic 的 image 块，实测上游照收）。
   **工具结果里的图片也会转发**（`read_image` 的结果就是 `[文本信封, 图片块]`），
   后端那一侧相应地让 `tool_result` 携带 image 块。
   解析不了的图会换成一句占位文字并告警，**不会静默消失**——"模型看不见图却照样回答"
   是最难查的一类故障。
9. **`max_tokens` 必须传**：Anthropic Messages 的 `max_tokens` 是必填项，反代缺省只有 4096。内核给的预算（`options.maxTokens`，回落到 `defaultMaxTokens`）会真的传下去，否则长文件写入会被上游截断。
10. **空闲超时**：上游连续 `streamIdleTimeoutMs`（默认 180s，MiniMax 首 token 尤其 thinking 可能很慢）不吐字节，按可重试的 `TIMEOUT` 中止，不无限挂着。
11. **每轮一行统计**：`logger.debug` 输出 `ms / ttft / reasonChars / contentChars / toolCalls / usage / outcome`；配 `logFile` 后后端子进程输出落盘（>2MB 轮转 `.1`）。
12. **进程生命周期两种语义**：托管（默认，stdio 管道，可 tail、可收树；拉起者被强杀会让后端因管道断裂退出）／`detach: true`（独立进程组，插件退出不牵连它）。`killTreeOnDispose: false` 退回只杀直接子进程。
13. **子进程环境白名单**：只放 OS 必需项 + **代理变量**（`HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY`，海外版业务接口锁海外出口，代理是常见部署方式）+ `MINIMAX2API_*` 命名空间 + 插件显式 `env`。宿主的 `PORT` / `HOST` 不会渗进去（端口与绑定地址由插件用命令行参数显式给出）。
14. **后端目录可移植**：配置 `serverDir` → 环境变量 `DSH_MINIMAX2API_DIR` → 指针 `~/.dsh/minimax2api.json`（`install.ps1` 写，含 git 版本与 Python 路径）→ 插件同级 → home 常见位置。显式写了但目录不成立时**不一票否决**，继续往下找并记日志。
15. **配置热更新**：适配器每轮 `prepareCall` 读当代配置。只影响请求的项（`defaultMaxTokens`、`toolDescriptionMaxChars`）改完下一轮生效；影响后端进程的项（`baseUrl`、`serverDir`、`pythonPath`、`dataDir`、`detach` 等）变更时自动回收旧管理器并重建。
16. **复用实例可诊断**：探活结果按 `healthTtlMs` 缓存；复用别人起的实例时比对 `/health` 自述，号池为空会告警一次并给出控制台地址。
17. **按内核的真实消息形状回放工具调用**：DSH 内核把工具调用放在 **assistant 消息 `content` 的 `{type:'tool-call'}` 块**里（`dsh-agent-loop` 就是 `message.content.filter((b) => b.type === 'tool-call')`），工具结果消息是 `{role:'tool', toolCallId, content:[...]}`。插件把块转成 OpenAI `tool_calls`，**id 原样带上**——上游校验「tool 结果的 `tool_call_id` 必须有对应的 `tool_call`」，对不上就是 `invalid params, tool result's tool id(...) not found (2013)`。读错字段（以为有 `msg.toolCalls`）会让 tool_calls 整个丢失，**多轮里第一次带工具结果就翻车**。

---

## 安装

```powershell
cd C:\Users\Admin\DeepSeek_Harness\dsh-client-config\plugins\dsh-minimax-web-api
.\install.ps1
```

`install.ps1` 是幂等的，顺序是故意的：配置自检 → smoke → 解析后端与 Python 环境 → 校验运行时接线。任何一步失败立刻停止，不留半成品。

接线本身是一次性动作，走 profile 的 `link:` 依赖（`node_modules/dsh-minimax-web-api` 是指回本目录的 junction，改代码重启即生效，不需要再同步）：

```powershell
cd C:\Users\Admin\.dsh\profiles\desktop
pnpm add "dsh-minimax-web-api@link:C:/Users/Admin/DeepSeek_Harness/dsh-client-config/plugins/dsh-minimax-web-api"
```

手抄进 `node_modules` 的老办法已废弃：那样的目录在 pnpm 眼里是 extraneous，每次 `pnpm install` 都会被挪进 `.ignored`。

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

- **国内区 + 微信扫码**是最省事的一条路：扫码即登录，手机号未注册会自动建号。
  登录后**必须领当日积分**（下节），否则每条请求都 402。
- **海外区**只有 Google/GitHub/邮箱，且它的 agent 主机**必须从海外出口访问**——
  否则 Akamai 边缘会 307 跳到国内站（细节见下一节）。把 v2rayN 的路由规则配好之后，
  海外号是**完全可用**的：独立跑真实推理 + 真实工具调用都通过，ttft 1.1s，
  签到积分**与国内站同一张表**（下面「签到面板实测」一节）。两个区各一个号，
  每天合计 800 积分（≈280 万 token）。

> 设备码 5 分钟过期，且 `expires_in` 是服务端定的、客户端改不了。过期就重新签发一条；
> 浏览器里**登录态会保留**（cookie 在），所以第二次通常直接落到授权页、点一下 Authorize 即可。

### 海外站必须走海外出口（v2rayN 路由规则，踩坑重灾区）

`agent.minimax.io` 有一个很容易被误判成"被墙"的行为：

```
GET https://agent.minimax.io/v1/api/user/info
→ HTTP 307  Location: https://agent.minimaxi.com/v1/api/user/info   body 为空
```

它**不是被墙**，是 Akamai 边缘按**出口地域**做的跳转：国内出口 → 跳国内站。
后果很隐蔽——上游拿到 307 的空 body，minimax2api 报的是
`minimax user info 返回非 JSON:`（空），而导入流程就在这一步死掉，
看起来像"账号登录失败"，其实只是出口不对。

**根因在 v2rayN 的 TUN 默认规则**：TUN 模式下默认是「绕过大陆」，
`minimax.io` 解析到的 Akamai 国内边缘 IP 命中 `geoip:cn` → 直连 → 撞上 307。

> 顺带一提：手动把 DNS 换成 DoH 解析出的海外边缘 IP **也没用**——强制连到
> `2.17.106.x` 依然 307。必须是**出口**真的在海外。

**解法**：在 v2rayN 的路由预设里加一条**按域名**的规则，让它优先于
`geoip:cn` / `geosite:cn` 那两条直连规则：

```json
{"OutboundTag": "proxy", "Domain": ["domain:minimax.io"], "Enabled": true,
 "Remarks": "强制代理MiniMax海外站"}
```

只代理 `.io`，**不代理** `.com` / `.cn`：国内站直连即可，走代理反而多一跳。

改完必须**重启 v2rayN**（路由真源是 DB，跑着的 sing-box 用的是启动时生成的
`binConfigs/configPre.json`；改了 DB 不重启不生效）。生成结果长这样：

```json
{"outbound":"proxy","network":["tcp","udp"],"port_range":["0:65535"],"domain_suffix":["minimax.io"]}
```

验证（加规则前 → 加规则后）：

| 请求 | 加规则前 | 加规则后 |
|---|---|---|
| `agent.minimax.io/v1/api/user/info` | 307 跳国内站 | **401**（真 API 响应） |
| `agent.minimax.io/` | 307 | **200**（海外站 SPA） |
| `account.minimax.io/oauth2/device/code` | ConnectError | **200**（正常发码） |

#### 别让这条规则悄悄丢了

规则写在 v2rayN 的**路由预设**里，而预设是可以切换的——在界面上换成「全局」
或「黑名单」，这条规则就没了，海外号随即开始 307。
所以插件自带一个**自愈脚本**，它把规则补进**每一个**预设：

```powershell
python scripts\ensure_v2rayn_minimax_proxy.py            # 检查 + 补齐
python scripts\ensure_v2rayn_minimax_proxy.py --check    # 只检查
python scripts\ensure_v2rayn_minimax_proxy.py --remove   # 拆掉
```

退出码 `2` = "我补上了，但**需要重启 v2rayN** 才生效"。
插件自己的保活轮次每 30 分钟先跑这个检查（补规则），再续期、再领积分；
补了当前生效的预设时，插件日志里会留一行
`minimax-web-api: v2rayN 的 minimax 海外代理规则被补上了，需要重启 v2rayN 才生效`。

> 后端自己的 `upstream.proxy` 建议**留空**：国内账号直连即可，留空才不会因为
> v2rayN 没开就整个后端不可用。海外账号靠上面那条 TUN 规则出海。


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

#### 签到面板实测（两个区同一张表）

`GET /minimax-cloud/api/v1/signin/status` 返回的是官方给的 7 天积分表。本机两个账号
（国内 CN 号 + 海外 global 号）**逐格一致**：

| 天 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 合计 |
|---|---|---|---|---|---|---|---|---|
| 积分 | 400 | 400 | 400 | **1000** | 400 | 400 | **1000** | **4000** |

- 海外号**实际领到的就是 400 分**（day 1），积分明细里也确实落了一条 `+400`，
  不是"面板写着 400、账上没到"。
- 也就是说：**国内站"每天 400、第 4/7 天各加 1000、全勤 4000"这条属实**；
  **海外站目前看不到任何"不是 400"的证据**——两区面板完全相同。
- **还没被验证的部分**：海外号是新号，只领过第 1 天，第 2~7 天（含 1000 分那天）
  是**面板写明的安排**，还没实际兑现；上游的 `claim` 端点存在"报成功但积分不到账"
  的情况（仓库里叫 `unpaid`），所以每次领取后都会查一次积分明细确认到账
  （`scripts/claim_daily_credits.py` 用的就是这套逻辑）。
- 另外两件事与本插件无关：国内站网页版左下角活动卡片的手动签到，与这里的 API 签到等价；
  订阅用户活动期的"重置卡"（10/10–10/18，今天已过）在签到接口里没有对应字段。

#### ⚠ 第三方后端的一个错误假设（**已在本机后端打补丁修掉**）

`minimax2api` 自带的签到服务对大陆区账号**直接跳过**：

```python
# app/signin.py（第三方仓上游）
if account.region == REGION_CN:
    preflight.reason = "mainland region, no check-in service"
```

这是作者的**假设**，不是上游事实。**cn 部署其实有完整的签到服务**，实测端点全通
（2026-10-23 在本机 CN 号 `7771e5f1…` 上重新验证）：

| 端点 | 作用 |
|---|---|
| `GET /minimax-cloud/api/v1/signin/status` | 7 天签到面板（每天 400 分，第 4 天 1000） |
| `POST /minimax-cloud/api/v1/signin/claim` | 领取当日积分，返回 `points` |
| `GET /minimax-cloud/api/v1/credit/details` | 积分明细（领取是否真的到账） |
| `GET /matrix/api/v1/commerce/get_membership_info` | 余额（`total` / `free` / `purchased`） |
| `GET /minimax-cloud/api/v1/config` | **必须先调**，否则上游"记录了已签到但永不发放积分" |

这些端点都走 `x-signature` / `yy` 签名（`x-signature = md5(second + 'I*7Cf%WZ#S&%1RlZJ&C2' + body)`），
**顺序不能颠倒：先 `/config` 再 `claim`**。

**2026-10-23 已在本地后端打掉这个跳过**（补丁 3，见后端仓的 `LOCAL-PATCHES.md`）：
`app/signin.py` 的 `run_account()` 与 `refresh_credits()` 两处 region 判断都删了。
所以现在**后端控制台自己的「签到」按钮对国内号也生效**，控制台不再显示"跳过"，
而是显示真实的签到结果（`已签` / `OK` + 积分 + 余额）。
上游自己的那条测试钉的正是这个错误行为，已一并改写。

#### 领积分：用本插件自带的脚本

签名、代理、错误分类都在第三方仓的 `app/upstream.py` 里，本插件不重复实现协议，
脚本直接复用后端那套客户端（所以 CN / 海外两个区走的是各自正确的 host）：

```powershell
cd C:\Users\Admin\DeepSeek_Harness\dsh-client-config\plugins\dsh-minimax-web-api
C:\Users\Admin\DeepSeek_Harness\git-repo\minimax2api\.venv\Scripts\python.exe scripts\claim_daily_credits.py
```

输出（已签过时会幂等跳过，不重复领；**两个区的账号都会处理**）：

```
后端目录：C:\Users\Admin\DeepSeek_Harness\git-repo\minimax2api
=== 7771e5f12ab7 (region=cn) ===
    余额 total=400.0 free=400.0 purchased=0.0 plan=/1
    签到面板：claimed_today=True
=== 7a612de8920f (region=global) ===
    余额 total=965.707 free=965.707 purchased=0.0 plan=/1
    签到面板：claimed_today=True
```

参数：

| 参数 | 含义 |
|---|---|
| `--probe` | 只看余额与签到面板，不领取 |
| `--min-balance 50` | 额外保护：余额不低于该值就不领（默认 0 = 不设限，每天都领） |

后端目录解析顺序与插件 `lib/paths.js` 一致：`MINIMAX2API_DIR` → 指针 `~/.dsh/minimax2api.json` → 常见位置。

#### 手工加一个账号（手机号 + 短信验证码）

号池里加号走 `scripts/add_account_by_sms.py`——它替你发设备码、守授权、通知后端重载号池、领积分：

```powershell
cd C:\Users\Admin\DeepSeek_Harness\dsh-client-config\plugins\dsh-minimax-web-api
C:\Users\Admin\DeepSeek_Harness\git-repo\minimax2api\.venv\Scripts\python.exe scripts\add_account_by_sms.py --phone 17653116208
```

输出会给出 `user_code` 与授权链接；你在浏览器里用短信码登录并授权后，脚本会
自动把账号写进号池、通知后端重载（`/admin/api/keepalive/sweep`）、再领当日积分。

两个坑（脚本与技能都绕过了）：

- **设备码要在进程外发**。后端自己的 `POST /admin/api/login-device` 在**跑着的进程**里
  会返回 500（同一段代码在进程外完全正常、重启后又正常一阵子）——上游的状态机缺陷。
  脚本直接用后端自己的 `DeviceLoginService` 在自己的进程里做这件事。
- **短信码有有效期，且会被限流**。拿到后尽快输；同一手机号连续失败多次会收到
  `{"code":1000021,"message":"登陆失败，请稍后再试"}`——那不是验证码错，是节流，等几小时再试。

浏览器端（勾协议、解滑块、填码、点登录）由 `captcha-slider-solve` 技能负责。
#### 想让它自动每天跑

**插件自己就会签到**（随 DSH 客户端加载）：
[lib/credits.js](lib/credits.js) 的保活器在插件启动时跑一轮，之后每 30 分钟复查一轮，
每轮依次做三件事：

1. `ensure_v2rayn_minimax_proxy.py` —— 检查/补齐 v2rayN 的「minimax 海外站走代理」规则
   （海外号要靠它才能出海，见上一节）；
2. `keep_tokens_alive.py` —— 给 1 小时有效的 OAuth token 续期，并把被 401 退休的账号复位；
3. `claim_daily_credits.py` —— 给号池里**每个**账号领当日积分（**国内站、海外站都领**）。

> 以前还有一个 Windows 计划任务 `MiniMax Daily Credit Claim`（每天 09:05）做同样的事，
> 作为"客户端整天不开"的兜底。**2026-10-23 已删除**：客户端不开的时候本来也用不了
> MiniMax，后端自带签到调度也是 09:05，两者时间重合没有额外价值；而计划任务的
> `cmd.exe` 引号在带空格的路径上很容易坏，脚本本身又是 ASCII-only 的绕路产物。
> v2rayN 规则自愈因此搬进了插件自己的复查轮次（上面第 1 步），没有丢。

判定"今天领没领"看的是 `claimed_today`（**签到按天计**），不是"余额够不够"——
上游对当天已领是幂等的（返回 already），每天都调是安全的。

手工跑一次（跟插件跑的是同一套脚本）：

```powershell
C:\Users\Admin\DeepSeek_Harness\git-repo\minimax2api\.venv\Scripts\python.exe scripts\claim_daily_credits.py
C:\Users\Admin\DeepSeek_Harness\git-repo\minimax2api\.venv\Scripts\python.exe scripts\keep_tokens_alive.py --status
```

如果想看插件自己的运行日志：`~/.dsh/logs/minimax-web-api.log`（客户端日志里）
与 `~/.dsh/minimax-web-api/claim-state.json`（每天的领取状态）。

#### 每天都要领，不看余额

签到是**按天**的：面板有 day1..day7，今天不领就断连续，第 4 天那 1000 分也拿不到。
所以判断依据是"今天领没领"（`claimed_today`），**不是**"余额够不够"——
上游对当天已领是幂等的（返回 already），每天都调是安全的。

（脚本早先的默认是"余额 ≥ 1 就跳过"，那样在余额没花光的第二天会**白跑一天并断签**，
已改成看 `claimed_today`；`--min-balance` 保留为可选的额外保护，默认 0 = 不设限。）

**后端自己的调度器也已经能签 CN 号了**（2026-10-23 打补丁，见上文「已在本机后端打补丁修掉」）：
后端每天 09:05 的签到调度（`signin.enabled`）现在**国内号、海外号一起领**，
控制台上的「签到」按钮也对国内号生效，不再显示"跳过"。

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

### access token 只有 1 小时 —— 过期就是 401，账号还会被"退休"

**这是最容易把人坑住的一条**：MiniMax 的 OAuth access token **只活 1 小时**，
过期后上游一律回 401。而后端的失败处理（`app/pool.py`）是：

```
401 → 先试续期 → 续期成功就复用；续期失败才"退休"（status=invalid）
```

实测（2026-10-21 11:05，一次真实 DSH 会话）暴露两个洞：

1. **续期成功了，账号却还是 `invalid`**。同一请求的重试/故障转移会再打一次，
   第二次仍然 401（用的是旧 token，或与续期并发），于是**续期成功的账号又被退休**。
   请求路径上的续期不复位状态（只有 `app/keepalive.py` 的 `renew_account` 会复位）。
2. **号池空了没有快速恢复**。keepalive 的 sweep 只在"token 快到期"时才动手
   （`token_expires_at - margin <= now`），而刚被退休的账号 token 还没到期 →
   判定 `due=0` → 什么都不做 → 之后所有请求都是
   `accounts unusable: minimax-cn, minimax-global`。

实测影响：11:05 两个号全部 401 → 被退休 → 之后 10 次请求全是
`accounts unusable`，**整整一小时**（直到 token 自然到期）才可能自愈。

本插件的处理：

- **主动续期**（`scripts/keep_tokens_alive.py`）：复用后端自己的
  `Keeper.renew_account`（成功即把 `status` 复位成 `active`），
  在"剩余 ≤20 分钟"或"状态是 invalid"时才动手。插件启动时跑一次，之后每 30 分钟一次
  （`poolIntervalMs`）——只要 DSH 客户端开着，token 就不会过期。
- **错误分类**：`minimax llm HTTP 401` → `AUTH`（不可重试），
  `accounts unusable: ...` → `MISSING_CREDENTIAL`（不可重试）。
  认不出来就会当成网络抖动重试两轮，而它俩重试一万次也一样。

手工救活（号池已经空了的时候）：

```powershell
python scripts\keep_tokens_alive.py --force   # 全部续期 + 复位
# 然后让后端重新加载号池：它没有暴露单账号续期路由，sweep 会顺带 pool.load()
Invoke-RestMethod -Method Post http://127.0.0.1:4555/admin/api/keepalive/sweep
```

#### 上游那些洞已经打了本地补丁

`git-repo/minimax2api` 现在停在**本地分支** `local/robust-token-recovery`，
比上游多三个提交（`main` 仍与上游一致；push 通道已锁死，不推任何远端）。
补丁内容与理由见仓里的 **`LOCAL-PATCHES.md`**，一句话版：

| 上游的洞 | 补丁 |
|---|---|
| `renew_account` 先写库后 `print` 报告结果；stdout 一断就抛，被当成"续期失败" → **好账号被退休**；sweep 的错误处理也 `print` → **sweep 一起死** | `print` → `_log()`（吞写失败），日志不再能打断控制流 |
| `pool._record_failure` 把 renewer 抛的异常当成"凭据死了" → 退休 | 异常只说明**没判定** → 走冷却，不退休 |
| sweep 只管"快到期" → 被误退休的账号没有回来的路 | 可续期且 `status=invalid` 的账号也纳入本轮，续期成功即复位 |
| **签到服务假设"大陆区无签到服务"，把 CN 号直接跳过** → CN 号余额停在 0，每条请求都 402 | 删掉 `run_account()` / `refresh_credits()` 里的 region 判断，CN 号照常签到 |

验证：`tests/test_local_patches.py`（4 例）+ `tests/test_local_image_patch.py`（8 例）
+ `tests/test_local_cn_signin_patch.py`（4 例）+ 上游自带 `tests/test_bridge.py`（97 例）
= **113 passed**；另外在活着的号池上**复现过原事故**（把 token 换成坏的 → 上游 401），
结果是账号**保持 active**、token 被续上、请求继续出字。

> 后端进程本身也要注意：**别把它的 stdout 接到会断的管道上**。本机那次事故的触发点
> 就是后台 job 的输出管道中途断开（日志从 10:02 之后一行都没有）。现在后端的输出
> 直接重定向到 `%TEMP%\mmx-api.log`（文件），管道断了也无所谓。

---

### 视觉读图（2026-10-21 实测并修复）

**症状**：模型选择器里能选 MiniMax，文本回合也正常，但**贴图或让模型读图时，模型像没看见**——
它会对着图给出头头是道却完全对不上的回答，而且**不报任何错**。

**根因有三层，逐层都得通**：

| 层 | 原来的行为 | 为什么坏 |
|---|---|---|
| 内核 → 适配器 | 内核给的是持久引用 `{type:'image', attachment:{…}}`，适配器从没去取字节 | 适配器不取，模型就永远看不见这张图 |
| 适配器 → 反代 | `collectContent` 只认 `http(s)://`，`data:` URL 被当"非 URL"丢掉 | 本地图片的正常形态就是 `data:`，于是图片在插件这一层就没了 |
| 反代 → 上游 | 工具结果只取文本（`_text_of`），图片被丢弃 | `read_image` 的结果正是 `[文本信封, 图片块]`，图片在反代这一层也没了 |

**上游本身没问题**——实测四种形状全部正确识图（红/蓝/黄三色图，问三个颜色）：

| 形状 | 结果 |
|---|---|
| OpenAI `image_url` + `data:` URL | ✅ 答对 |
| Anthropic `base64` source | ✅ 答对 |
| Anthropic `url` source + `data:` URL | ✅ 答对 |
| Anthropic `tool_result` 里带 image 块 | ✅ 答对 |

所以要修的是**插件与反代这两层**，不是上游。

**修完之后的链路**：

```
内核 ImageBlock（持久引用）
  → lib/images.js：ctx.attachments.readImageRequest() 取请求版本 → data: URL
  → lib/openai.js：转成 OpenAI image_url（用户消息与工具结果都转）
  → minimax2api：data: 拆成 Anthropic base64 source（tool_result 也带 image 块）
  → MiniMax 上游：看得见
```

**三个容易再犯的点**：

1. **`minimax-agent` 必须声明 `inputModalities: ['text','image']`**。它和 `minimax-m3.1-flash`
   是同一个上游 `MiniMax-M3.1-Flash`（见后端 `app/records.py` 的 `builtin_models`），
   声明成纯文本会让内核把图片换成 `[image omitted because this model accepts text only]`——
   **默认模型反而成了唯一瞎的模型**。
2. **`data:` URL 不能当"非 URL"丢掉**。它就是本地图片的正常形态。
3. **解析失败要留占位文字**。静默丢图等于"用户贴了图、模型看不见却照样回答"，
   事后从日志里完全看不出来。

回归：`node test/vision.mjs`（16 个用例，全 hermetic）。

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
| `maxRequestImageBytes` | `4194304` | 单张图片发给上游的字节上限。内核的 attachment 服务按这个目标挑最接近的压缩档，**降质而不是丢图** |
| `strictBackend` | `true` | 为 `false` 时契约不符只告警不拒用 |
| `dailyCredits` | `true` | 每日签到领积分（当天领过就跳过）。**国内站、海外站都领** |
| `renewTokens` | `true` | 主动续期 1 小时有效的 OAuth token，并把被 401 退休的账号复位 |
| `poolIntervalMs` | `1800000` | 保活复查间隔（30 分钟）。每轮依次：修 v2rayN 规则 → 续期 → 领积分。0 = 只在插件启动时跑一次 |
| `creditStateFile` | `~/.dsh/minimax-web-api/claim-state.json` | 每日领取状态（避免同一天重复跑） |

---

## 测试

```powershell
node test/config_check.mjs   # cordis.patch.yml 结构自检（缩进/必需键/回环/baseUrl）
node test/smoke.mjs          # 43 个用例：纯函数、流式编排、路径解析、契约、保活器、错误分类
node test/preparecall_regression.mjs   # 真实 DSH LlmRuntime 装配（需本机运行时）
node test/kernel_turn_regression.mjs   # 真实 DSH 内核整轮：出字 + 工具调用 + 多轮上下文 + usage
node test/live_e2e.mjs       # 真实出字 + 真实工具调用 + 真实 usage（需本机后端与账号）
```

`kernel_turn_regression.mjs` 是最接近"真实会话"的一个：它用**真实 DSH LlmRuntime**
跑完整回合（内核 → 适配器 → minimax2api → MiniMax 上游 → 回到内核），
包含工具调用和"把工具结果喂回去"的多轮。踩过的两个内核约束写在脚本注释里：
消息 `content` 必须是**块数组**（不是字符串），assistant 消息必须带 `source`。

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

