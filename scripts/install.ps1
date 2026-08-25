# Assentor installer (Windows PowerShell)
# Usage:
#   irm https://raw.githubusercontent.com/MasterAkbariDev/Assentor/main/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:ASSENTOR_REPO) { $env:ASSENTOR_REPO } else { "https://github.com/MasterAkbariDev/Assentor.git" }
$InstallDir = if ($env:ASSENTOR_HOME) { $env:ASSENTOR_HOME } else { Join-Path $env:USERPROFILE ".assentor" }
$BinDir = if ($env:ASSENTOR_BIN) { $env:ASSENTOR_BIN } else { Join-Path $env:USERPROFILE ".local\bin" }

Write-Host "==> Assentor installer"
Write-Host "    install dir: $InstallDir"
Write-Host "    bin dir:     $BinDir"

function Require-Command($Name, $Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command '$Name'. $Hint"
  }
}

Require-Command "node" "Install Node.js 20+ from https://nodejs.org"
Require-Command "git" "Install Git from https://git-scm.com"
Require-Command "npm" "Node.js installs should include npm"

$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) {
  throw "Node.js v20+ required (found $(node -v))"
}

if (Test-Path (Join-Path $InstallDir ".git")) {
  Write-Host "==> Updating existing install"
  git -C $InstallDir fetch --depth 1 origin main
  git -C $InstallDir checkout -B main origin/main
} else {
  Write-Host "==> Cloning Assentor"
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  git clone --depth 1 --branch main $RepoUrl $InstallDir
}

Push-Location $InstallDir
try {
  Write-Host "==> Installing dependencies"
  npm install
  Write-Host "==> Building"
  npm run build
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$shim = @"
@echo off
node "%USERPROFILE%\.assentor\dist\cli\index.js" %*
"@
# Prefer ASSENTOR_HOME when set
$cliJs = Join-Path $InstallDir "dist\cli\index.js"
$shim = "@echo off`r`nnode `"$cliJs`" %*"
Set-Content -Path (Join-Path $BinDir "assentor.cmd") -Value $shim -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
$pathParts = $userPath -split ";" | Where-Object { $_ -and $_.Trim() -ne "" }
if ($pathParts -notcontains $BinDir) {
  $newPath = if ($userPath.Trim()) { "$userPath;$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  $env:Path = "$env:Path;$BinDir"
  Write-Host "==> Added $BinDir to your user PATH"
}

Write-Host ""
Write-Host "Assentor installed"
Write-Host "  binary: $(Join-Path $BinDir 'assentor.cmd')"
Write-Host ""
Write-Host "Open a new terminal, then run:"
Write-Host "  assentor doctor"
Write-Host "  assentor run --project . --executor mock --reviewer mock `"Say hello`""
