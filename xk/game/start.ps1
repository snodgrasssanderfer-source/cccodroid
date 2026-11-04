param([string]$BalatroStart = 'D:\balatrobot\start-balatro.bat')
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
if (-not (Get-NetTCPConnection -LocalPort 12346 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /c "' + $BalatroStart + '"') -WindowStyle Hidden
}
if (-not (Get-NetTCPConnection -LocalPort 12347 -State Listen -ErrorAction SilentlyContinue)) {
    $uvPath = (Get-Command uv.exe -ErrorAction Stop).Source
    $arguments = 'run --no-project --python ">=3.11" "' + (Join-Path $PSScriptRoot 'bridge.py') + '" --host 0.0.0.0 --port 12347'
    Start-Process -FilePath $uvPath -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'bridge.stdout.log') -RedirectStandardError (Join-Path $logDir 'bridge.stderr.log')
}
Write-Host '牌局桥：电脑 http://127.0.0.1:12347/state；手机用电脑热点 IP 的 12347 端口。'
