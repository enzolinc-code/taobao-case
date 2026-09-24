# 把仓库里的技能挂到 Codex 的 skills 目录（用目录联接，以后 git pull 就自动生效）
# 用法：powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$skillsDir = Join-Path $env:USERPROFILE '.codex\skills'
New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null

$names = @('taobao-phonecase-listing')
foreach ($name in $names) {
  $src = Join-Path $repo $name
  $dst = Join-Path $skillsDir $name
  if (-not (Test-Path $src)) { Write-Warning "仓库里没有 $src，跳过"; continue }

  if (Test-Path $dst) {
    $item = Get-Item $dst -Force
    if ($item.LinkType) {
      # 用 rmdir 删链接：只摘掉联接本身，绝不会碰到源目录里的文件
      Write-Host "$name 已经是链接，先摘掉旧的"
      cmd /c rmdir "$dst" | Out-Null
    } else {
      Write-Host "$name 已存在（真实目录），备份成 $name.bak"
      if (Test-Path "$dst.bak") { Remove-Item "$dst.bak" -Recurse -Force }
      Move-Item $dst "$dst.bak"
    }
  }
  cmd /c mklink /J "$dst" "$src" | Out-Null
  Write-Host "✓ $name -> $src"
}

Write-Host ''
Write-Host '接下来（每台机器只做一次）：'
Write-Host '  1. 启动带调试端口的 Chrome，保持这个窗口开着：'
Write-Host '     & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\taobao-automation-profile"'
Write-Host '  2. 在这个窗口里手动登录一次淘宝卖家中心'
Write-Host '  3. node "$skillsDir\taobao-phonecase-listing\scripts\check-env.js" 自检'
Write-Host ''
Write-Host '注意：素材图片（商品图片/）和运行产物（_listing-work/）不入库，'
Write-Host '      换机器时这两样要单独拷贝，否则没有图可以上架。'
