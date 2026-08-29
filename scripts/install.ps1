# Assentor installer (Windows PowerShell)
# Usage:
#   irm https://raw.githubusercontent.com/MasterAkbariDev/Assentor/main/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:ASSENTOR_REPO) { $env:ASSENTOR_REPO } else { "https://github.com/MasterAkbariDev/Assentor.git" }
$InstallDir = if ($env:ASSENTOR_HOME) { $env:ASSENTOR_HOME } else { Join-Path $env:USERPROFILE ".assentor" }
$BinDir = if ($env:ASSENTOR_BIN) { $env:ASSENTOR_BIN } else { Join-Path $env:USERPROFILE ".local\bin" }

function Write-Banner {
  Write-Host ""
  Write-Host "    +----------------------------------------------+" -ForegroundColor Cyan
  Write-Host "    |  " -NoNewline -ForegroundColor Cyan
  Write-Host "ASSENTOR" -NoNewline -ForegroundColor White
  Write-Host "  AI agent supervisor           |" -ForegroundColor Cyan
  Write-Host "    |  Professional installer                    |" -ForegroundColor Cyan
  Write-Host "    +----------------------------------------------+" -ForegroundColor Cyan
  Write-Host ""
}

function Write-Meta([string]$Label, [string]$Value) {
  Write-Host ("  {0,-10} {1}" -f $Label, $Value) -ForegroundColor DarkGray
}

function Write-Step([int]$Current, [int]$Total, [string]$Message) {
  Write-Host ""
  Write-Host ("  [{0}/{1}] {2}" -f $Current, $Total, $Message) -ForegroundColor Blue
}

function Write-Ok([string]$Message) {
  Write-Host ("      [OK]  {0}" -f $Message) -ForegroundColor Green
}

function Write-Warn([string]$Message) {
  Write-Host ("      [!]   {0}" -f $Message) -ForegroundColor Yellow
}

function Write-Panel([string]$Title, [string[]]$Lines) {
  Write-Host ""
  Write-Host ("  +-- {0}" -f $Title) -ForegroundColor Green
  foreach ($line in $Lines) {
    Write-Host ("  |  {0}" -f $line)
  }
  Write-Host "  +-- --------------------------------------------" -ForegroundColor Green
  Write-Host ""
}

function Require-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command '$Name'. $Hint"
  }
}

Write-Banner
Write-Meta "Install" $InstallDir
Write-Meta "Bin" $BinDir

Write-Step 1 5 "Checking prerequisites"
Require-Command "node" "Install Node.js 20+ from https://nodejs.org"
Require-Command "git" "Install Git from https://git-scm.com"
Require-Command "npm" "Node.js installs should include npm"
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) {
  throw "Node.js v20+ required (found $(node -v))"
}
Write-Ok ("Node.js {0}" -f (node -v))
Write-Ok ("git available")
Write-Ok ("npm {0}" -f (npm --version))

Write-Step 2 5 "Fetching Assentor"
if (Test-Path (Join-Path $InstallDir ".git")) {
  Write-Ok "Existing install detected — updating main"
  git -C $InstallDir fetch --depth 1 origin main
  git -C $InstallDir checkout -B main origin/main
} else {
  Write-Ok ("Cloning {0}" -f $RepoUrl)
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  git clone --depth 1 --branch main $RepoUrl $InstallDir
}

Write-Step 3 5 "Installing dependencies"
Push-Location $InstallDir
try {
  npm install
  Write-Ok "Dependencies installed"
} finally {
  Pop-Location
}

Write-Step 4 5 "Building Assentor"
Push-Location $InstallDir
try {
  npm run build
  Write-Ok "Build complete"
} finally {
  Pop-Location
}

Write-Step 5 5 "Linking CLI"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$cliJs = Join-Path $InstallDir "dist\cli\index.js"
$shim = "@echo off`r`nnode `"$cliJs`" %*"
Set-Content -Path (Join-Path $BinDir "assentor.cmd") -Value $shim -Encoding ASCII
Write-Ok ("Shim created at {0}" -f (Join-Path $BinDir "assentor.cmd"))

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
$pathParts = $userPath -split ";" | Where-Object { $_ -and $_.Trim() -ne "" }
if ($pathParts -notcontains $BinDir) {
  $newPath = if ($userPath.Trim()) { "$userPath;$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  $env:Path = "$env:Path;$BinDir"
  Write-Warn "Added $BinDir to your user PATH — open a new terminal"
} else {
  Write-Ok "Bin directory already on PATH"
}

$version = "unknown"
try {
  $pkg = Get-Content (Join-Path $InstallDir "package.json") -Raw | ConvertFrom-Json
  $version = $pkg.version
} catch {
  # ignore
}

Write-Panel "Installed successfully" @(
  "Binary     $(Join-Path $BinDir 'assentor.cmd')"
  "Version    v$version"
  "Source     $InstallDir"
  ""
  "Open a new terminal, then run:"
  "  assentor doctor"
  "  assentor ui --project ."
  "  assentor run --project . --executor mock --reviewer mock `"Say hello`""
)
