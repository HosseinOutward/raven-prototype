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
#    Point it at whatever's installed (a real LLVM install is preferred).
if (-not $env:LIBCLANG_PATH) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $vsInstallPaths = @()
  if (Test-Path $vswhere) {
    $vsInstallPaths = & $vswhere -all -products * -sort -property installationPath
  }

  $clangDirs = New-Object System.Collections.Generic.List[string]
  foreach ($clangDir in @(
    (Join-Path $env:ProgramFiles "LLVM\bin"),
    (Join-Path $env:ProgramFiles "CodeBlocks\MinGW\bin")
  )) {
    if ($clangDir -and -not $clangDirs.Contains($clangDir)) {
      $clangDirs.Add($clangDir)
    }
  }
  foreach ($vsInstallPath in $vsInstallPaths) {
    foreach ($clangDir in @(
      (Join-Path $vsInstallPath "VC\Tools\Llvm\x64\bin"),
      (Join-Path $vsInstallPath "VC\Tools\Llvm\bin")
    )) {
      if ($clangDir -and -not $clangDirs.Contains($clangDir)) {
        $clangDirs.Add($clangDir)
      }
    }
  }

  $env:LIBCLANG_PATH = $clangDirs | Where-Object { Test-Path (Join-Path $_ "libclang.dll") } | Select-Object -First 1
  if (-not $env:LIBCLANG_PATH) {
    throw "libclang.dll not found. Install LLVM (e.g. winget install LLVM.LLVM) or set LIBCLANG_PATH to a dir containing libclang.dll."
  }
  # A split libclang (e.g. MinGW's: a thin libclang.dll importing 200+ libLLVM*/
  # libclang*.dll + MinGW runtime) only loads if its siblings are findable.
  # LoadLibraryExW searches PATH but not the DLL's own dir, so add it. Append
  # (don't prepend) so MinGW's gcc/ld/nm don't shadow the MSVC tools or nm shim.
  $env:PATH = "$env:PATH;$env:LIBCLANG_PATH"
}
