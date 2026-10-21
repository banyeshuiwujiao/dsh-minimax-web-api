# dsh-minimax-web-api 安装与同步脚本 (幂等)
#
# 顺序是故意的：先验配置与测试，再看后端与 Python 环境，最后才动运行时镜像。
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

Write-Host "[4/5] 同步插件至运行时镜像并校验一致性..."
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-minimax-web-api'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force (Join-Path $src 'lib'), (Join-Path $src 'scripts'), (Join-Path $src 'package.json'), (Join-Path $src 'README.md') $dst

# 脚本跑过之后会生成 __pycache__：它不是源码，不该进镜像（也会污染"多出来的文件"）。
Get-ChildItem -Path (Join-Path $dst 'scripts') -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# 逐文件比哈希：半复制/漏复制（比如新加了 lib/*.js 却没同步）都能当场发现。
# scripts/ 也要校验：插件在运行时找不到 claim_daily_credits.py 就领不到积分，
# 而这个缺失是静默的（只在日志里留一行 warn）。
$mismatch = @()
$mirrored = @('package.json', 'README.md') `
  + (Get-ChildItem -Path (Join-Path $src 'lib') -Filter *.js | ForEach-Object { "lib/$($_.Name)" }) `
  + (Get-ChildItem -Path (Join-Path $src 'scripts') -File -ErrorAction SilentlyContinue | ForEach-Object { "scripts/$($_.Name)" })
foreach ($rel in $mirrored) {
  $a = Join-Path $src $rel
  $b = Join-Path $dst $rel
  if (-not (Test-Path $b)) { $mismatch += "$rel (镜像缺失)"; continue }
  if ((Get-FileHash $a -Algorithm SHA256).Hash -ne (Get-FileHash $b -Algorithm SHA256).Hash) { $mismatch += $rel }
}
if ($mismatch.Count -gt 0) { throw "运行时镜像与源码不一致: $($mismatch -join ', ')" }
Write-Host "  已同步并校验一致: $dst"

Write-Host "[5/5] 提示: 请确认 dsh-client-config\profiles\desktop\cordis.patch.yml 已包含配置，"
Write-Host "       再执行 python scripts\sync-profiles.py --profile desktop，"
Write-Host "       最后重启 DeepSeek Harness.exe。"
Write-Host "       账号请在 http://127.0.0.1:4555/admin 导入（号池为空时后端只会报错，不会出字）。"
Write-Host "OK: dsh-minimax-web-api 安装就绪！"