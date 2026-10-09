# 一键更新（PowerShell / Windows 宿主机）
#
# 用法：
#   .\scripts\update.ps1              # 拉代码 + 重建 + 重启
#   .\scripts\update.ps1 -NoBuild     # 只重启（不重建镜像）
#
# 说明：这就是 web 界面上「立即更新」做的事，只是手动执行一遍。
# 如果启动了 updater sidecar（docker compose --profile update up -d），
# 可以直接在「管理 → 系统 → 在线更新」里点按钮，不用跑这个脚本。

[CmdletBinding()]
param(
    [switch]$NoBuild,
    [string]$Service = "app"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "!! $msg" -ForegroundColor Red; exit 1 }

if (-not (Test-Path ".git")) { Fail "当前目录不是 git 工作区：$root" }
if (-not (Test-Path "docker-compose.yml")) { Fail "找不到 docker-compose.yml" }

# .env 里需要 MASTER_KEY，否则 compose 会直接拒绝启动
if (-not (Test-Path ".env")) {
    Write-Host "!! 还没有 .env：请先执行" -ForegroundColor Yellow
    Write-Host '   cp .env.example .env' -ForegroundColor Yellow
    Write-Host '   node -e "console.log(''MASTER_KEY='' + require(''crypto'').randomBytes(32).toString(''hex''))" | Add-Content .env' -ForegroundColor Yellow
    exit 1
}

Step "记录当前提交"
$before = git rev-parse --short HEAD

Step "拉取最新代码（git pull --ff-only）"
git pull --ff-only
if ($LASTEXITCODE -ne 0) { Fail "git pull 失败：可能有本地改动或冲突，请手动处理后重试" }

$after = git rev-parse --short HEAD
if ($before -eq $after) {
    Write-Host "    代码无变化（$before）" -ForegroundColor DarkGray
} else {
    Write-Host "    代码已更新：$before -> $after" -ForegroundColor Green
}

# 重建镜像（Dockerfile/依赖变了时必须重建）
if (-not $NoBuild) {
    Step "重建镜像（并把当前提交烧进镜像，供「检查更新」显示版本）"
    $env:APP_COMMIT = (git rev-parse HEAD)
    $env:APP_BUILD_TIME = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    docker compose build $Service
    if ($LASTEXITCODE -ne 0) { Fail "镜像构建失败" }
}

Step "重启容器"
docker compose up -d $Service
if ($LASTEXITCODE -ne 0) { Fail "容器启动失败" }

Step "等待健康检查"
$deadline = (Get-Date).AddSeconds(60)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:8580/api/health" -TimeoutSec 3
        if ($r.ok) { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 2 }
}
if ($healthy) {
    Write-Host "`n✓ 更新完成，服务已就绪：http://127.0.0.1:8580" -ForegroundColor Green
} else {
    Write-Host "`n!! 服务在 60 秒内未通过健康检查，请查看日志：" -ForegroundColor Yellow
    Write-Host "   docker compose logs --tail=100 $Service" -ForegroundColor Yellow
    exit 1
}
