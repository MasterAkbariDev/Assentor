# Uninstall the Assentor CLI shim (and optionally the managed install dir).
# Does NOT delete project .assentor/ folders.
#
# Usage:
#   .\scripts\uninstall.ps1
#   .\scripts\uninstall.ps1 --purge   # also remove %USERPROFILE%\.assentor
$ErrorActionPreference = "Stop"

$BinDir = if ($env:ASSENTOR_BIN) { $env:ASSENTOR_BIN } else { Join-Path $env:USERPROFILE ".local\bin" }
$InstallDir = if ($env:ASSENTOR_HOME) { $env:ASSENTOR_HOME } else { Join-Path $env:USERPROFILE ".assentor" }
$Purge = $false

foreach ($arg in $args) {
  switch -Regex ($arg) {
    "^--purge$" { $Purge = $true }
    "^(-h|--help)$" {
      Write-Host "Usage: uninstall.ps1 [--purge]"
      Write-Host "  Removes $BinDir\assentor.cmd"
      Write-Host "  --purge also removes $InstallDir (managed install only)"
      exit 0
    }
  }
}

Write-Host "==> Assentor uninstall"

$shim = Join-Path $BinDir "assentor.cmd"
$unixShim = Join-Path $BinDir "assentor"
if (Test-Path $shim) {
  Remove-Item -Force $shim
  Write-Host "Removed $shim"
} elseif (Test-Path $unixShim) {
  Remove-Item -Force $unixShim
  Write-Host "Removed $unixShim"
} else {
  Write-Host "No assentor binary at $shim"
}

$legacy = Join-Path $BinDir "forge.cmd"
if (Test-Path $legacy) {
  Remove-Item -Force $legacy
  Write-Host "Removed legacy $legacy"
}

if ($Purge) {
  if (Test-Path $InstallDir) {
    $pkg = Join-Path $InstallDir "package.json"
    $looksLikeAssentor = $false
    if (Test-Path $pkg) {
      $looksLikeAssentor = Select-String -Path $pkg -Pattern '"name"\s*:\s*"assentor"' -Quiet
    }
    if ($looksLikeAssentor) {
      $normalized = $InstallDir.Replace("\", "/")
      if ($normalized -match "/Developer/" -or $normalized -match "/dev/") {
        Write-Host "Refusing to --purge developer checkout: $InstallDir" -ForegroundColor Red
        Write-Host "Remove the bin shim only, or delete the folder yourself."
        exit 1
      }
      Remove-Item -Recurse -Force $InstallDir
      Write-Host "Removed managed install $InstallDir"
    } else {
      Write-Host "Skip purge: $InstallDir does not look like an Assentor install"
    }
  } else {
    Write-Host "No managed install at $InstallDir"
  }
} else {
  Write-Host "Kept $InstallDir (pass --purge to remove managed install)"
}

Write-Host ""
Write-Host "Project folders (.assentor/) were not touched."
Write-Host "Done."
