param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TauriArgs
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Resolve-Path (Join-Path $scriptDir "..")
$repoRoot = Resolve-Path (Join-Path $desktopDir "..\..")
$envFile = Join-Path $repoRoot ".env"

# Prepare the native build toolchain (MSVC on PATH, short target dir, C++20 for
# webrtc, and an `nm` shim). Dot-sourced so the env lands in this process, which
# then runs the tauri/cargo build below.
. (Join-Path $scriptDir "msvc-env.ps1")
. (Join-Path $scriptDir "native-build-env.ps1")

# Load .env into the environment for the build/runtime.
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith("#")) {
      return
    }

    $separator = $line.IndexOf("=")
    if ($separator -le 0) {
      return
    }

    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim().Trim('"').Trim("'")
    Set-Item -Path "Env:$name" -Value $value
  }
}

# dev/build need the desktop app's API + LiveKit configuration baked in via VITE_*.
$subcommand = if ($TauriArgs.Count -gt 0) { $TauriArgs[0] } else { "" }
if ($subcommand -eq "dev" -or $subcommand -eq "build") {
  $env:RAVEN_DESKTOP_API_MODE = "remote"

  if (-not $env:VITE_RAVEN_API_URL -and $env:RAVEN_API_ADDR) {
    if ($env:RAVEN_API_ADDR -match "^https?://") {
      $env:VITE_RAVEN_API_URL = $env:RAVEN_API_ADDR
    }
    else {
      $env:VITE_RAVEN_API_URL = "http://$($env:RAVEN_API_ADDR)"
    }
  }

  if (-not $env:VITE_RAVEN_API_URL) {
    throw "Set RAVEN_API_ADDR or VITE_RAVEN_API_URL in $envFile before running desktop $subcommand."
  }

  if (-not $env:VITE_LIVEKIT_URL -and $env:LIVEKIT_URL) {
    $env:VITE_LIVEKIT_URL = $env:LIVEKIT_URL
  }
}

# Resolve the tauri CLI shim (bun emits tauri.exe on Windows; npm/pnpm emit tauri.cmd).
$binDir = Join-Path $desktopDir "node_modules\.bin"
$tauri = @("tauri.exe", "tauri.cmd", "tauri.bunx") |
  ForEach-Object { Join-Path $binDir $_ } |
  Where-Object { Test-Path $_ } |
  Select-Object -First 1
if (-not $tauri) {
  throw "Tauri CLI was not found in $binDir. Run bun install in $desktopDir first."
}

Push-Location $desktopDir
try {
  & $tauri @TauriArgs
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
