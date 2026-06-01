<#
.SYNOPSIS
  Full release pipeline — build, tag, push, and upload to GitHub.

.DESCRIPTION
  Reads version from package.json, builds Windows .exe + Linux .tar.gz,
  creates a git tag, generates release notes from commits since the last tag,
  pushes everything and uploads assets to GitHub.

.EXAMPLE
  .\scripts\release.ps1                          # uses version from package.json
  .\scripts\release.ps1 -Version 0.2.0            # override version
  .\scripts\release.ps1 -SkipBuild                # skip build (use existing artifacts)
  .\scripts\release.ps1 -DryRun                   # print what would happen, no actions

.PARAMETER Version
  Semver override. Defaults to reading "version" from package.json.

.PARAMETER SkipBuild
  Skip npm run build — use artifacts already in release/.

.PARAMETER DryRun
  Print every action without executing.

.PARAMETER Token
  GitHub PAT. Defaults to extracting from git remote origin URL.
#>

param(
  [string]$Version,
  [switch]$SkipBuild,
  [switch]$DryRun,
  [string]$Token
)

$ErrorActionPreference = "Stop"
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:PkgJson = Get-Content "$RepoRoot\package.json" -Raw | ConvertFrom-Json

# ── version ───────────────────────────────────────────────────────────
if (-not $Version) { $Version = $script:PkgJson.version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid version: $Version" }
$Tag = "v$Version"
Write-Host "=== Pantoufa Release v$Version ===" -ForegroundColor Cyan

# ── token (NEVER stored in this file — read at runtime) ────────────
if (-not $Token) {
  # 1. GH_TOKEN environment variable (recommended)
  $Token = $env:GH_TOKEN
}
if (-not $Token) {
  # 2. .env file
  $envFile = Join-Path $RepoRoot ".env"
  if (Test-Path $envFile) {
    $envContent = Get-Content $envFile -Raw
    if ($envContent -match 'GH_TOKEN=(\S+)') { $Token = $Matches[1] }
  }
}
if (-not $Token) {
  # 3. Extract from git remote (local .git/config — never committed)
  $remote = git remote get-url origin 2>$null
  if ($remote -match 'https://([^@]+)@github.com') {
    $Token = $Matches[1]
  }
}
if (-not $Token) {
  throw "No GitHub token found. Set GH_TOKEN env var, add GH_TOKEN= to .env, or pass -Token"
}
$ApiBase = "https://api.github.com/repos/techvibedz/anime-desktop"
$ApiHeaders = @{ Authorization = "token $Token"; Accept = "application/vnd.github+json" }

# ── build ─────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
  Write-Host "`n[1/4] Building…" -ForegroundColor Yellow
  $cmds = @(
    "npm run icons",
    "npm run build:renderer",
    "npm run build:electron"
  )
  foreach ($cmd in $cmds) {
    Write-Host "  > $cmd"
    if (-not $DryRun) {
      Invoke-Expression $cmd
      if ($LASTEXITCODE -ne 0) { throw "Build step failed: $cmd" }
    }
  }

  # Windows NSIS installer
  Write-Host "  > electron-builder --win"
  if (-not $DryRun) {
    npx electron-builder --win --publish never
    if ($LASTEXITCODE -ne 0) { throw "Windows build failed" }
  }

  # Linux tar.gz (deb/AppImage need native Linux tools, tar.gz works from Windows)
  Write-Host "  > electron-builder --linux tar.gz"
  if (-not $DryRun) {
    npx electron-builder --linux tar.gz --publish never
    if ($LASTEXITCODE -ne 0) { throw "Linux build failed" }
  }
}

# ── release notes ─────────────────────────────────────────────────────
Write-Host "`n[2/4] Generating release notes…" -ForegroundColor Yellow
$LastTag = git describe --tags --abbrev=0 2>$null
if ($LastTag) {
  $Log = git log "$LastTag..HEAD" --pretty="format:- %s" 2>$null
} else {
  $Log = git log --oneline --pretty="format:- %s" 2>$null
}
if (-not $Log) { $Log = "- Pantoufa v$Version" }
$Body = @"
## Changes

$Log

## Downloads

| Platform | File |
|----------|------|
| Windows  | `Pantoufa-Setup-$Version.exe` |
| Linux    | `Pantoufa-$Version.tar.gz` |
"@
Write-Host ($Body -split "`n" | ForEach-Object { "  $_" })

# ── tag & push ────────────────────────────────────────────────────────
Write-Host "`n[3/4] Tagging & pushing…" -ForegroundColor Yellow
if (-not $DryRun) {
  # NOTE: do NOT `git add release/` — it's gitignored (build artifacts), and
  # with $ErrorActionPreference="Stop" the ignored-path warning aborts the
  # whole pipeline before tagging/pushing. Stage only tracked release files.
  git add package.json 2>$null
  git commit -m "v$Version" --allow-empty 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Host "  (nothing to commit, continuing)" }
  git tag -a $Tag -m "v$Version" -f
  git push origin main --follow-tags -f
  if ($LASTEXITCODE -ne 0) { throw "Push failed" }
} else {
  Write-Host "  [dry] git tag $Tag && git push origin main --follow-tags"
}

# ── GitHub release ────────────────────────────────────────────────────
Write-Host "`n[4/4] Creating GitHub release & uploading assets…" -ForegroundColor Yellow
if (-not $DryRun) {
  $Release = @{ tag_name = $Tag; name = "v$Version"; body = $Body; draft = $false; prerelease = $false }
  try {
    $rel = Invoke-RestMethod -Uri "$ApiBase/releases" -Method Post -Headers $ApiHeaders -Body ($Release | ConvertTo-Json -Compress) -ContentType "application/json"
  } catch {
    if ($_.Exception.Response.StatusCode -eq [System.Net.HttpStatusCode]::UnprocessableEntity) {
      Write-Host "  Release $Tag already exists, using existing."
      $rel = Invoke-RestMethod -Uri "$ApiBase/releases/tags/$Tag" -Headers $ApiHeaders
    } else { throw }
  }

  # Upload assets
  $UploadBase = "https://uploads.github.com/repos/techvibedz/anime-desktop/releases/$($rel.id)/assets"
  $Assets = @()

  # Windows
  $exeFile = "$RepoRoot\release\Pantoufa-Setup-$Version.exe"
  if (Test-Path $exeFile) { $Assets += @{ Path = $exeFile; Name = "Pantoufa-Setup-$Version.exe"; Label = "Windows Installer" } }
  $blockmap = "$RepoRoot\release\Pantoufa-Setup-$Version.exe.blockmap"
  if (Test-Path $blockmap) { $Assets += @{ Path = $blockmap; Name = "Pantoufa-Setup-$Version.exe.blockmap"; Label = "Windows blockmap" } }

  # Linux
  $tarFile = "$RepoRoot\release\Pantoufa-$Version.tar.gz"
  if (Test-Path $tarFile) { $Assets += @{ Path = $tarFile; Name = "Pantoufa-$Version.tar.gz"; Label = "Linux (tar.gz)" } }

  # latest.yml
  $ymlFile = "$RepoRoot\release\latest.yml"
  if (Test-Path $ymlFile) { $Assets += @{ Path = $ymlFile; Name = "latest.yml"; Label = "Auto-update manifest" } }

  foreach ($a in $Assets) {
    $sizeMB = [math]::Round((Get-Item $a.Path).Length / 1MB, 1)
    Write-Host "  Uploading $($a.Name) ($sizeMB MB)…"
    $url = $UploadBase + "?name=$($a.Name)&label=$($a.Label)"
    Invoke-RestMethod -Uri $url -Method Post -Headers (@{ Authorization = "token $Token"; Accept = "application/vnd.github+json"; "Content-Type" = "application/octet-stream" }) -InFile $a.Path -TimeoutSec 300
  }

  Write-Host "`n  https://github.com/techvibedz/anime-desktop/releases/tag/$Tag" -ForegroundColor Green
}

Write-Host "`nDone!" -ForegroundColor Green
