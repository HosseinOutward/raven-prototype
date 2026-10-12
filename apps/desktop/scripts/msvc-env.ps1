# Ensures the MSVC toolchain (cl.exe, INCLUDE, LIB) is on PATH for native crates.
# webrtc-audio-processing-sys builds via meson/ninja, which invoke bare `cl` and
# fail with "CreateProcess failed: The system cannot find the file specified."
# when the Visual Studio developer environment isn't initialized in this session.
#
# Auto-discovers the install with vswhere so it survives VS major-version bumps
# (the toolchain recently moved to ...\Microsoft Visual Studio\18\BuildTools).
#
# Dot-source this script (`. path\msvc-env.ps1`) so the PATH/env changes land in
# the caller's process — the same process that then runs cargo/tauri.

if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    throw "vswhere.exe not found at $vswhere. Install Visual Studio Build Tools (with the C++ workload), or run from a Developer PowerShell."
  }

  $allVsPaths = & $vswhere -all -products * -sort -property installationPath
  $fallbackPaths = @(
    ($allVsPaths | Where-Object { $_ -match "\\2022\\" })
    ($allVsPaths | Where-Object { $_ -notmatch "\\2022\\" })
  )

  $candidatePaths = @(
    (& $vswhere -latest -products * `
      -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
      -property installationPath)
    $fallbackPaths
  ) | Where-Object { $_ } | Select-Object -Unique

  if (-not $candidatePaths) {
    throw "No Visual Studio Build Tools installs were found. Install Visual Studio Build Tools with the C++ workload, or run from a Developer PowerShell."
  }

  foreach ($vsPath in $candidatePaths) {
    $devShell = Join-Path $vsPath "Common7\Tools\Launch-VsDevShell.ps1"
    if (-not (Test-Path $devShell)) {
      Write-Warning "Launch-VsDevShell.ps1 not found at $devShell; trying the next Visual Studio install."
      continue
    }

    Write-Host "Initializing MSVC dev environment from $vsPath ..."
    & $devShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null

    if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
      break
    }

    Write-Warning "cl.exe was not found after initializing $vsPath; trying the next Visual Studio install."
  }

  if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw "cl.exe still not on PATH after trying the installed Visual Studio dev environments. Repair/reinstall the C++ build tools in Visual Studio Installer."
  }
}
