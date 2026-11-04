param(
    [Parameter(Mandatory=$true)][string]$Adb,
    [Parameter(Mandatory=$true)][string]$Apk,
    [Parameter(Mandatory=$true)][string]$Mods,
    [string]$Package = 'org.xiaoke.balatro.bridge',
    [Parameter(Mandatory=$true)][string]$Serial
)
$ErrorActionPreference = 'Stop'
if ($Package -eq 'com.playstack.balatro.android' -or $Package -notmatch '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$') {
    throw 'Use a separate Android package; the official Balatro package must remain untouched.'
}
$Adb = (Resolve-Path -LiteralPath $Adb).Path
$Apk = (Resolve-Path -LiteralPath $Apk).Path
$Mods = (Resolve-Path -LiteralPath $Mods).Path
$recordPath = [IO.Path]::ChangeExtension($Apk, '.build.json')
$record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($record.package -ne $Package -or (Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash -ne $record.apk.sha256) {
    throw 'APK and package do not match the build record.'
}
$deviceArgs = @()
if ($Serial) { $deviceArgs = @('-s', $Serial) }
function Invoke-Adb {
    param([string[]]$Command)
    & $Adb @deviceArgs @Command
    if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Command -join ' ')" }
}

Invoke-Adb -Command @('install', '-r', $Apk)
Invoke-Adb -Command @('shell', 'am', 'force-stop', $Package)
$remoteStage = '/data/local/tmp/xk-balatro-' + [Guid]::NewGuid().ToString('N')
Invoke-Adb -Command @('shell', 'mkdir', '-p', $remoteStage)
Invoke-Adb -Command @('push', $Mods, ($remoteStage + '/Mods'))
Invoke-Adb -Command @('shell', 'run-as', $Package, 'mkdir', '-p', 'files/save/ASET/Mods')
Invoke-Adb -Command @('shell', 'run-as', $Package, 'cp', '-R', ($remoteStage + '/Mods/.'), 'files/save/ASET/Mods/')
Invoke-Adb -Command @('shell', 'am', 'start', '-n', ($Package + '/org.love2d.android.GameActivity'))
Write-Host "Installed $Package; Mods: files/save/ASET/Mods; game RPC: port 12346."
