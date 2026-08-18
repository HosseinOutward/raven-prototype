# Native build environment for the Raven desktop app on Windows.
#
# Fixes three things the webrtc-audio-processing-sys / webrtc-sys crates need when
# building with the MSVC toolchain via meson/ninja. Dot-source this AFTER
# msvc-env.ps1 (which puts `cl` on PATH) so the env lands in the build process.

# 1) MAX_PATH (260). The default Cargo target dir nests the webrtc C++ build so
#    deep (...\src-tauri\target\debug\build\webrtc-audio-processing-sys-<hash>\
#    out\webrtc-audio-processing-build\..\webrtc-audio-processing\subprojects\
#    abseil-cpp-...\absl\...) that abseil's deepest sources exceed 260 chars and
#    cl fails with "C1083: Cannot open source file" even though the file exists.
#    LongPathsEnabled doesn't help: meson uses `..`-relative include paths that go
#    through legacy normalization. `%USERPROFILE%\rv` keeps the worst case ~246.
if (-not $env:CARGO_TARGET_DIR) {
  $env:CARGO_TARGET_DIR = Join-Path $env:USERPROFILE "rv"
}
if (-not (Test-Path $env:CARGO_TARGET_DIR)) {
  New-Item -ItemType Directory -Path $env:CARGO_TARGET_DIR -Force | Out-Null
}

# 2) C++ standard. webrtc-audio-processing's meson.build pins cpp_std=c++17, but
#    its code uses C++20 designated initializers that the updated MSVC rejects
#    under c++17 (error C7555). meson appends env CXXFLAGS after its own /std and
#    MSVC honors the last /std, so this forces C++20 for that build. cc-based
#    crates that set their own /std still override this. Respect a user value.
if ($env:CXXFLAGS -notmatch "/std:c\+\+") {
  $env:CXXFLAGS = (@($env:CXXFLAGS, "/std:c++20") | Where-Object { $_ }) -join " "
}

# 3) libclang for bindgen. webrtc-sys (livekit) generates Rust bindings via
#    bindgen, which needs libclang.dll. clang-sys loads it dynamically and parses
#    with the MSVC target at runtime, so any reasonably recent libclang works.
#
#    Do not trust a synced LIBCLANG_PATH blindly: it is commonly an absolute path
#    from another Windows installation. Validate it, then discover LLVM from this
#    machine's standard locations and from tools already on PATH.
$libclangCandidates = New-Object System.Collections.Generic.List[string]

function Add-LibclangCandidate([string]$candidate) {
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    return
  }

  $candidate = [Environment]::ExpandEnvironmentVariables($candidate.Trim().Trim('"'))
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    $candidate = Split-Path -Parent $candidate
  }

  if ((Test-Path -LiteralPath $candidate -PathType Container) -and
      (Test-Path -LiteralPath (Join-Path $candidate "libclang.dll") -PathType Leaf) -and
      -not $libclangCandidates.Contains($candidate)) {
    $libclangCandidates.Add($candidate)
  }
}

$configuredLibclangPath = $env:LIBCLANG_PATH
Add-LibclangCandidate $configuredLibclangPath
if ($configuredLibclangPath -and $libclangCandidates.Count -eq 0) {
  Write-Warning "Ignoring LIBCLANG_PATH='$configuredLibclangPath' because it does not contain libclang.dll on this machine."
}

# bindgen/clang-sys also consult LLVM_CONFIG_PATH. Clear a stale synced value so
# it cannot override the local libclang discovery below.
if ($env:LLVM_CONFIG_PATH) {
  $configuredLlvmConfigPath = [Environment]::ExpandEnvironmentVariables($env:LLVM_CONFIG_PATH.Trim().Trim('"'))
  if (-not (Test-Path -LiteralPath $configuredLlvmConfigPath -PathType Leaf)) {
    Write-Warning "Ignoring LLVM_CONFIG_PATH='$($env:LLVM_CONFIG_PATH)' because it does not exist on this machine."
    Remove-Item Env:LLVM_CONFIG_PATH -ErrorAction SilentlyContinue
  }
}

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsInstallPaths = @()
if (Test-Path -LiteralPath $vswhere) {
  $vsInstallPaths = & $vswhere -all -products * -sort -property installationPath
}

$llvmRoots = @(
  (Join-Path $env:ProgramFiles "LLVM\bin"),
  (Join-Path ${env:ProgramFiles(x86)} "LLVM\bin"),
  (Join-Path $env:LOCALAPPDATA "Programs\LLVM\bin"),
  (Join-Path $env:USERPROFILE "scoop\apps\llvm\current\bin"),
  (Join-Path $env:ProgramData "chocolatey\bin"),
  (Join-Path $env:ProgramData "chocolatey\lib\llvm\tools\llvm\bin"),
  (Join-Path $env:ProgramFiles "CodeBlocks\MinGW\bin"),
  (Join-Path ${env:ProgramFiles(x86)} "CodeBlocks\MinGW\bin")
)

foreach ($vsInstallPath in $vsInstallPaths) {
  $llvmRoots += @(
    (Join-Path $vsInstallPath "VC\Tools\Llvm\x64\bin"),
    (Join-Path $vsInstallPath "VC\Tools\Llvm\bin")
  )
}

foreach ($llvmRoot in $llvmRoots) {
  Add-LibclangCandidate $llvmRoot
}

# If LLVM was installed through a package manager or custom location, clang on
# PATH is still a reliable anchor for finding its sibling libclang.dll.
foreach ($toolName in @("clang.exe", "clang-cl.exe", "llvm-config.exe")) {
  $tool = Get-Command $toolName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($tool -and $tool.Source) {
    Add-LibclangCandidate (Split-Path -Parent $tool.Source)
  }
}

if ($libclangCandidates.Count -eq 0) {
  throw "libclang.dll not found. Install LLVM (e.g. winget install LLVM.LLVM) or set LIBCLANG_PATH to a local directory containing libclang.dll."
}

$env:LIBCLANG_PATH = $libclangCandidates[0]
# A split libclang (e.g. MinGW's: a thin libclang.dll importing 200+ libLLVM*/
# libclang*.dll + MinGW runtime) only loads if its siblings are findable.
# LoadLibraryExW searches PATH but not the DLL's own dir, so add it. Append
# (don't prepend) so MinGW's gcc/ld/nm don't shadow the MSVC tools or nm shim.
$pathEntries = $env:PATH -split ';'
if ($pathEntries -notcontains $env:LIBCLANG_PATH) {
  $env:PATH = "$env:PATH;$env:LIBCLANG_PATH"
}
