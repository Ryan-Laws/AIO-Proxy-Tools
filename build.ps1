# 构建全部平台（Windows，pwsh 7）：pwsh ./build.ps1 [-Version v1.0.0] [-SkipWeb]
param([string]$Version = "dev", [switch]$SkipWeb)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$name = "aio-proxy-tools"

if (-not $SkipWeb) {
    Push-Location web
    npm ci; if ($LASTEXITCODE) { throw "npm ci 失败" }
    npm run build; if ($LASTEXITCODE) { throw "前端构建失败" }
    Pop-Location
}

Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory dist | Out-Null
$targets = "windows/amd64", "windows/arm64", "darwin/amd64", "darwin/arm64", "linux/amd64", "linux/arm64"
$env:CGO_ENABLED = "0"
foreach ($t in $targets) {
    $os, $arch = $t.Split("/")
    $ext = if ($os -eq "windows") { ".exe" } else { "" }
    $dir = "dist/$name-$Version-$os-$arch"
    New-Item -ItemType Directory $dir | Out-Null
    Write-Host "构建 $os/$arch"
    $env:GOOS = $os; $env:GOARCH = $arch
    go build -trimpath -ldflags "-s -w -X main.version=$Version" -o "$dir/$name$ext" ./cmd/aio-proxy-tools
    if ($LASTEXITCODE) { throw "构建 $t 失败" }
    Copy-Item README.md, README.zh-CN.md, LICENSE $dir
    if ($os -eq "windows") {
        Compress-Archive -Path $dir -DestinationPath "$dir.zip"
    } else {
        tar -C dist -czf "$dir.tar.gz" (Split-Path $dir -Leaf)
    }
    Remove-Item $dir -Recurse -Force
}
Remove-Item Env:GOOS, Env:GOARCH
Get-ChildItem dist -File | Where-Object Name -ne SHA256SUMS | ForEach-Object {
    "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name
} | Set-Content dist/SHA256SUMS -Encoding utf8NoBOM
Get-ChildItem dist
