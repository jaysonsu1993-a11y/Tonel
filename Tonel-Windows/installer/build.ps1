<#
.SYNOPSIS
  Build the Tonel-Windows installer end-to-end (publish + Inno Setup compile).

.DESCRIPTION
  Steps:
    1. dotnet publish -c Release  →  self-contained single-file Tonel.exe
    2. iscc Tonel.iss              →  output\Tonel-Setup-X.Y.Z.exe

  Run from any Windows shell:
      powershell -ExecutionPolicy Bypass -File installer\build.ps1

  Prerequisites:
    - .NET 8 SDK     (https://dot.net)
    - Inno Setup 6.2+ on PATH, or set $env:INNO to the iscc.exe path
      (https://jrsoftware.org/isdl.php — free; commercial use OK)

.PARAMETER Version
  Override the version string written into AppVersion (defaults to the
  Version in TonelWindows.csproj).

.PARAMETER SkipPublish
  Use this when iterating on the installer script — re-uses the existing
  publish output instead of rebuilding the WPF app.

.PARAMETER Sign
  Path to a .pfx code-signing cert. If supplied, signs the published
  Tonel.exe before bundling and writes a signtool stanza into Inno's
  SignTool. Skip for unsigned dev builds (users will see SmartScreen).

.PARAMETER SignPassword
  Password for the .pfx (only when -Sign is used).
#>

[CmdletBinding()]
param(
    [string]$Version       = "",
    [switch]$SkipPublish,
    [string]$Sign          = "",
    [string]$SignPassword  = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir     = Resolve-Path (Join-Path $ScriptDir "..")
$ProjectFile = Join-Path $RepoDir "TonelWindows\TonelWindows.csproj"
$PublishDir  = Join-Path $RepoDir "TonelWindows\bin\Release\net8.0-windows\win-x64\publish"
$IssFile     = Join-Path $ScriptDir "Tonel.iss"
$OutputDir   = Join-Path $ScriptDir "output"

# ── Resolve iscc.exe (Inno Setup compiler) ────────────────────────────────
function Resolve-IsccPath {
    if ($env:INNO -and (Test-Path $env:INNO)) { return $env:INNO }
    $candidate = Get-Command iscc.exe -ErrorAction SilentlyContinue
    if ($candidate) { return $candidate.Source }
    foreach ($p in @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles}\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 5\ISCC.exe"
    )) {
        if (Test-Path $p) { return $p }
    }
    throw "Inno Setup not found. Install from https://jrsoftware.org/isdl.php (free; commercial use OK), or set `$env:INNO to ISCC.exe."
}

# ── Read version from .csproj if not overridden ──────────────────────────
if ([string]::IsNullOrEmpty($Version)) {
    $xml = [xml](Get-Content $ProjectFile)
    $Version = $xml.Project.PropertyGroup |
        Where-Object { $_.Version } |
        Select-Object -First 1 -ExpandProperty Version
}
if ([string]::IsNullOrEmpty($Version)) {
    throw "Could not read Version from $ProjectFile and -Version was not supplied."
}

Write-Host "── Tonel-Windows installer build ──" -ForegroundColor Cyan
Write-Host "  Version:      $Version"
Write-Host "  Project:      $ProjectFile"
Write-Host "  Publish dir:  $PublishDir"
Write-Host "  Output dir:   $OutputDir"
Write-Host

# ── Step 1: dotnet publish ────────────────────────────────────────────────
if (-not $SkipPublish) {
    Write-Host "── Step 1/2: dotnet publish ──" -ForegroundColor Cyan
    if (Test-Path $PublishDir) { Remove-Item -Recurse -Force $PublishDir }
    & dotnet publish $ProjectFile `
        -c Release `
        --nologo `
        -p:Version=$Version `
        -p:FileVersion="$Version.0" `
        -p:AssemblyVersion="$Version.0"
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE)" }
} else {
    Write-Host "── Step 1/2: skipped (-SkipPublish) ──" -ForegroundColor Yellow
}

$exePath = Join-Path $PublishDir "Tonel.exe"
if (-not (Test-Path $exePath)) {
    throw "Publish output not found at $exePath — did dotnet publish succeed?"
}
$exeBytes = (Get-Item $exePath).Length / 1MB
Write-Host ("  Tonel.exe = {0:N1} MB" -f $exeBytes)

# ── Optional code signing ────────────────────────────────────────────────
if (-not [string]::IsNullOrEmpty($Sign)) {
    Write-Host "── Signing Tonel.exe ──" -ForegroundColor Cyan
    if (-not (Test-Path $Sign)) { throw "Cert not found: $Sign" }
    & signtool sign /f $Sign /p $SignPassword /tr http://timestamp.digicert.com /td sha256 /fd sha256 $exePath
    if ($LASTEXITCODE -ne 0) { throw "signtool failed" }
}

# ── Step 2: Inno Setup compile ───────────────────────────────────────────
Write-Host "── Step 2/2: iscc.exe ──" -ForegroundColor Cyan
$iscc = Resolve-IsccPath
Write-Host "  iscc:         $iscc"

if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir | Out-Null }

& $iscc $IssFile "/DAppVersion=$Version"
if ($LASTEXITCODE -ne 0) { throw "iscc failed (exit $LASTEXITCODE)" }

$setupExe = Join-Path $OutputDir "Tonel-Windows-v$Version.exe"
if (-not (Test-Path $setupExe)) {
    throw "Setup not produced — check Inno Setup output above."
}
$setupSize = (Get-Item $setupExe).Length / 1MB
Write-Host
Write-Host ("✅ Built: $setupExe  ({0:N1} MB)" -f $setupSize) -ForegroundColor Green
