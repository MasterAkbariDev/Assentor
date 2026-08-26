# Update Assentor to the latest main (or rebuild the current checkout).
# Prefer the installer when this is a managed %USERPROFILE%\.assentor clone.
# Keep this file ASCII-only. Windows PowerShell 5.1 misparses UTF-8 without BOM.
$ErrorActionPreference = "Stop"

$InstallDir = if ($env:ASSENTOR_HOME) { $env:ASSENTOR_HOME } else { Join-Path $env:USERPROFILE ".assentor" }
$BinDir = if ($env:ASSENTOR_BIN) { $env:ASSENTOR_BIN } else { Join-Path $env:USERPROFILE ".local\bin" }
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Binary = Join-Path $BinDir "assentor.cmd"

Write-Host "==> Assentor update"

$sameRoot = [string]::Equals($Root, $InstallDir, [System.StringComparison]::OrdinalIgnoreCase)
if ($sameRoot -or (Test-Path (Join-Path $InstallDir ".git"))) {
  Write-Host "    using installer at $InstallDir"
  & (Join-Path $PSScriptRoot "install.ps1")
  exit $LASTEXITCODE
}

Write-Host "    package root: $Root"
if (Test-Path (Join-Path $Root ".git")) {
  Write-Host "==> Pulling latest"
  git -C $Root pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: git pull failed - rebuilding current checkout" -ForegroundColor Yellow
  }
}

Push-Location $Root
try {
  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    Write-Host "==> Building (pnpm)"
    pnpm install
    pnpm build
  } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
    Write-Host "==> Building (npm)"
    npm install
    npm run build
  } else {
    throw "npm or pnpm is required."
  }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$cliJs = Join-Path $Root "dist\cli\index.js"
$shim = @"
@echo off
node "$cliJs" %*
"@
Set-Content -Path $Binary -Value $shim -Encoding ASCII

Write-Host ""
Write-Host "Assentor updated"
Write-Host "  binary: $Binary"
