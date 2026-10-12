$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Resolve-Path (Join-Path $scriptDir "..")
$repoRoot = Resolve-Path (Join-Path $desktopDir "..\..")
$apiDir = Join-Path $repoRoot "services\api"
$binDir = Join-Path $desktopDir "src-tauri\bin"
$tmpDir = Join-Path $repoRoot ".cache\go-tmp"
$buildCacheDir = Join-Path $repoRoot ".cache\go-build"
$outFile = Join-Path $binDir "raven-api-x86_64-pc-windows-msvc.exe"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
New-Item -ItemType Directory -Force -Path $buildCacheDir | Out-Null

$env:TMP = $tmpDir
$env:TEMP = $tmpDir
$env:GOTMPDIR = $tmpDir
$env:GOCACHE = $buildCacheDir

Push-Location $apiDir
try {
  go build -buildvcs=false -o $outFile .\cmd\raven-api
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}
