# dsh-minimax-web-api 安装/自检脚本 (幂等)
#
# 顺序是故意的：先验配置与测试，再看后端与 Python 环境，最后校验运行时接线。
# 任何一步失败都立刻停止（$ErrorActionPreference = 'Stop'），不留半成品状态。
#
# 后端目录不再写死在本脚本里：不传 -BackendDir 就交给 lib/paths.js 的解析顺序
# （环境变量 DSH_MINIMAX2API_DIR → 指针文件 → 插件同级 → home 常见位置），
# 解析成功后把结果固化成指针 ~/.dsh/minimax2api.json，供插件直接命中。
param(
  [string]$BackendDir = "",
  [string]$PythonPath = ""
)
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSCommandPath
Set-Location $src

Write-Host "[1/5] 配置结构自检（cordis.patch.yml 装配入口）..."
node test/config_check.mjs
if ($LASTEXITCODE -ne 0) { throw "配置自检失败，停止：先修 cordis.patch.yml" }

Write-Host "[2/5] smoke 与纯函数回归..."
node test/smoke.mjs
if ($LASTEXITCODE -ne 0) { throw "smoke 失败，停止" }

Write-Host "[3/5] 解析并检查 minimax2api 后端..."
$pathsModule = (Join-Path $src 'lib/paths.js') -replace '\\', '/'
$pythonArg = if ($PythonPath -ne "") { $PythonPath } else { "" }
if ($BackendDir -ne "") {
  # 显式指定：校验后写进指针，插件侧配置就不需要再出现绝对路径
  $resolved = node --input-type=module -e "
    import { existsSync } from 'node:fs'
    import { join } from 'node:path'
    import { writePointer, DEFAULT_POINTER_FILE } from 'file:///$pathsModule'
    const dir = process.argv[1]
    const py = process.argv[2] || ''
    if (!existsSync(join(dir, 'run.py')) || !existsSync(join(dir, 'app', 'server.py'))) {
      console.error('NOT_MINIMAX2API'); process.exit(2)
    }
    console.log(writePointer(DEFAULT_POINTER_FILE, dir, null, py))
  " $BackendDir $pythonArg
  if ($LASTEXITCODE -ne 0) { throw "指定的后端目录不合法（缺 run.py 或 app/server.py）: $BackendDir" }
  Write-Host "  指针已写入: $resolved"
}
# 读回解析结果（env → 指针 → 同级 → home 候选）
$probe = node --input-type=module -e "
  import { resolveServerDir } from 'file:///$pathsModule'
  console.log(JSON.stringify(resolveServerDir({})))
"
if ($LASTEXITCODE -ne 0) { throw "后端目录解析失败" }
$info = $probe | ConvertFrom-Json
if (-not $info.dir) { throw "解析不到 minimax2api 后端目录（试过：$($info.notes -join ' | ')）。用 -BackendDir <路径> 指定一次，之后由指针文件接管。" }
$backendDir = $info.dir
Write-Host "  后端目录 = $backendDir（来源 $($info.source)）"
if ($info.source -ne 'pointer') {
  $pinned = node --input-type=module -e "
    import { writePointer, DEFAULT_POINTER_FILE } from 'file:///$pathsModule'
    console.log(writePointer(DEFAULT_POINTER_FILE, process.argv[1], null, process.argv[2] || ''))
  " $backendDir $pythonArg
  Write-Host "  指针已写入: $pinned"
}

# 依赖：fastapi/uvicorn/httpx。没有 .venv 就在后端目录建一个，插件会优先复用它。
$venvPython = Join-Path $backendDir '.venv\Scripts\python.exe'
if ($PythonPath -ne "") {
  $py = $PythonPath
} elseif (Test-Path $venvPython) {
  $py = $venvPython
} else {
  Write-Host "  后端目录没有 .venv，正在创建并安装依赖..."
  python -m venv (Join-Path $backendDir '.venv')
  if ($LASTEXITCODE -ne 0) { throw "创建 venv 失败（exit=$LASTEXITCODE）" }
  $py = $venvPython
}
$probeDeps = & $py -c "import fastapi, uvicorn, httpx; print('deps-ok')" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "  依赖不全，正在安装 requirements.txt..."
  & $py -m pip install -q --disable-pip-version-check -r (Join-Path $backendDir 'requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw "安装 Python 依赖失败（exit=$LASTEXITCODE）" }
  $probeDeps = & $py -c "import fastapi, uvicorn, httpx; print('deps-ok')" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "依赖安装后仍导入失败：$probeDeps" }
}
Write-Host "  Python = $py（依赖就绪）"
$backendRev = ""
if (Test-Path (Join-Path $backendDir '.git')) {
  $backendRev = (& git -C $backendDir rev-parse --short HEAD) 2>$null
  if (-not $backendRev) { $backendRev = "(读取失败)" }
}
Write-Host "  后端 git 版本: $backendRev"
# 指针里的 gitRev 之前一直是 null（写指针时还没读到版本），补写一次：
# 版本信息只在安装时能可靠读到，事后诊断全靠它判断"跑的是哪一版后端"。
if ($backendRev -and $backendRev -ne "(读取失败)") {
  $repin = node --input-type=module -e "
    import { writePointer, DEFAULT_POINTER_FILE } from 'file:///$pathsModule'
    console.log(writePointer(DEFAULT_POINTER_FILE, process.argv[1], process.argv[2], process.argv[3] || ''))
  " $backendDir $backendRev $py
  Write-Host "  指针已更新（含 gitRev）: $repin"
}

Write-Host "[4/5] 校验运行时接线（link 依赖 = junction，全机只有一份代码）..."
# 2026-10-22 起不再往 node_modules 里拷代码：两份副本必然漂移（改错一份就静默跑旧代码），
# 而且 pnpm 视手抄目录为 extraneous，每次 `pnpm install` 都想把它挪进 .ignored——
# 当天那次就对 dsh-deepseek-web-api 真的下手了（本插件只是因为移动失败才侥幸留下）。
# 现在 profile 的 package.json 里有 link: 依赖，node_modules/dsh-minimax-web-api 只是指回本目录的
# junction：改完即生效（仍需重启客户端才重新加载模块），scripts/ 也自动跟着走。
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-minimax-web-api'
$linkSpec = 'dsh-minimax-web-api@link:' + ($src -replace '\\', '/')
if (-not (Test-Path $dst)) {
  throw "运行时未接线（$dst 不存在）。在该 profile 目录执行一次：`n  pnpm add `"$linkSpec`"`n然后重启 DeepSeek Harness.exe。"
}
$dstItem = Get-Item $dst -Force
if ($dstItem.LinkType -eq 'Junction' -or $dstItem.LinkType -eq 'SymbolicLink') {
  if (@($dstItem.Target) -notcontains $src) { throw "接线指向别处：$dst -> $($dstItem.Target)（期望 $src）" }
  Write-Host "  已接线（$($dstItem.LinkType)）：$dst -> $src"
  foreach ($rel in @('lib\provider.js', 'scripts\claim_daily_credits.py')) {
    if (-not (Test-Path (Join-Path $dst $rel))) { throw "接线可见但缺文件：$rel（源码目录里是不是丢了？）" }
  }
  Write-Host "  lib/ 与 scripts/ 均可通过接线看到"
} else {
  # 旧方案留下的实体副本：它会独立于源码漂移，必须显式换成 junction，别默默放行。
  throw "运行时是实体拷贝而不是 junction（改代码不会生效，pnpm 还会把它当 extraneous 删掉）。修复：`n  Remove-Item -Recurse -Force '$dst'`n  New-Item -ItemType Junction -Path '$dst' -Target '$src'`n或改成正式依赖：pnpm add `"$linkSpec`""
}

Write-Host "[5/5] 提示: 请确认 dsh-client-config\profiles\desktop\cordis.patch.yml 已包含配置，"
Write-Host "       再执行 python scripts\sync-profiles.py --profile desktop，"
Write-Host "       最后重启 DeepSeek Harness.exe。"
Write-Host "       账号请在 http://127.0.0.1:4555/admin 导入（号池为空时后端只会报错，不会出字）。"
Write-Host "OK: dsh-minimax-web-api 安装就绪！"