<#
.SYNOPSIS
  Builds, signs and publishes a Raven desktop release. See docs/releasing.md.

.EXAMPLE
  .\release.ps1 build   -Version 0.1.0
  .\release.ps1 publish -Version 0.1.0
  .\release.ps1 repoint -Version 0.1.0
  .\release.ps1 status
  .\release.ps1 images -Version 0.1.0   # server images to Docker Hub
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet("help", "build", "publish", "repoint", "status", "images")]
  [string]$Command = "help",
  [string]$Version,
  # Release notes shown in the app. Defaults to release-notes-<version>.md when it exists.
  [string]$NotesFile,
  # The server a fresh install signs in to (people can change it on the sign-in screen).
  [string]$ApiUrl = "https://mimir.rvn.bluehour.cloud",
  [string]$SshTarget = "vala",
  [string]$WslDistro = "Ubuntu",
  # Build from a tree with uncommitted changes. For rehearsals, not for real releases.
  [switch]$AllowDirty,
  # Publish into a folder beside the real releases (for example "test") and leave the
  # real latest.json alone. Point a debug build at it with RAVEN_UPDATE_ENDPOINT.
  [string]$Scratch,
  # images: the Docker Hub account the server images are pushed to.
  [string]$ImageNamespace = "soroushtaheri",
  # images: push only the X.Y.Z tag, not :latest.
  [switch]$NoLatest,
  # images: build both platforms but push nothing.
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = $PSScriptRoot
$Desktop = Join-Path $Root "apps\desktop"
$PublicBase = "https://updates.rvn.bluehour.cloud"
$RemoteRoot = "/home/ubuntu/services/raven/releases"
$PublicKey = Join-Path $Desktop "src-tauri\updater\raven-updater.key.pub"
$KeepVersions = 5

if ($Scratch) {
  if ($Scratch -notmatch '^[a-z0-9-]+$') { throw "-Scratch must be a simple folder name such as 'test'." }
  $PublicBase = "$PublicBase/$Scratch"
  $RemoteRoot = "$RemoteRoot/$Scratch"
}

function Invoke-Native {
  param([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = $Root)
  Push-Location $WorkingDirectory
  # Windows PowerShell turns a native program's stderr into errors when it is captured;
  # the exit code is what counts.
  $ErrorActionPreference = "Continue"
  try {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
  }
  finally { Pop-Location }
}

# Bash scripts go to Vala and WSL as files: piped from Windows PowerShell they would
# arrive with a byte-order mark and CRLF line endings, and bash rejects both.
function New-BashScript {
  param([string]$Script)
  $file = Join-Path ([IO.Path]::GetTempPath()) "raven-release-$([Guid]::NewGuid().ToString('N')).sh"
  [IO.File]::WriteAllText($file, (($Script -replace "`r", "") + "`n"), (New-Object Text.UTF8Encoding($false)))
  return $file
}

function Invoke-Remote {
  param([string]$Script)
  $file = New-BashScript $Script
  $ErrorActionPreference = "Continue"
  try {
    $output = & cmd.exe /d /c "ssh -o BatchMode=yes -o ConnectTimeout=8 $SshTarget bash -s < `"$file`""
    if ($LASTEXITCODE -ne 0) { throw "The command on $SshTarget failed with exit code $LASTEXITCODE." }
    return $output
  }
  finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}

function Assert-Version {
  if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { throw "Pass -Version as a semantic version, for example 0.1.0." }
  $declared = [ordered]@{
    "apps/desktop/package.json"              = (Get-Content -Raw (Join-Path $Desktop "package.json") | ConvertFrom-Json).version
    "apps/desktop/src-tauri/tauri.conf.json" = (Get-Content -Raw (Join-Path $Desktop "src-tauri\tauri.conf.json") | ConvertFrom-Json).version
    "apps/desktop/src-tauri/Cargo.toml"      = [regex]::Match((Get-Content -Raw (Join-Path $Desktop "src-tauri\Cargo.toml")), '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
    "packages/shared/package.json"           = (Get-Content -Raw (Join-Path $Root "packages\shared\package.json") | ConvertFrom-Json).version
  }
  foreach ($entry in $declared.GetEnumerator()) {
    if ($entry.Value -ne $Version) { throw "$($entry.Key) says version $($entry.Value), not $Version. Set the same version in all four files first." }
  }
}

function Get-Stage {
  $stage = Join-Path $Root ".release\$Version"
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  return $stage
}

function Get-Artifacts {
  param([string]$Stage)
  return [ordered]@{
    "windows-x86_64" = Join-Path $Stage "Raven_${Version}_x64-setup.exe"
    "linux-x86_64"   = Join-Path $Stage "Raven_${Version}_amd64.AppImage"
  }
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-TauriCli {
  foreach ($name in @("tauri.exe", "tauri.cmd")) {
    $candidate = Join-Path $Desktop "node_modules\.bin\$name"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw "The Tauri CLI is missing. Run 'bun install' in apps/desktop."
}

function Invoke-Sign {
  param([string]$Artifact)
  $keyDirectory = Join-Path $env:USERPROFILE ".raven\updater"
  $key = Join-Path $keyDirectory "raven-updater.key"
  $passwordFile = Join-Path $keyDirectory "raven-updater.password.dpapi"
  if (-not (Test-Path -LiteralPath $key) -or -not (Test-Path -LiteralPath $passwordFile)) {
    throw "The updater signing key or its password file is missing from $keyDirectory."
  }
  $secure = ConvertTo-SecureString ((Get-Content -Raw -LiteralPath $passwordFile).Trim())
  $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $key
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Net.NetworkCredential]::new("", $secure).Password
  try {
    Remove-Item -LiteralPath "$Artifact.sig" -ErrorAction SilentlyContinue
    Invoke-Native (Get-TauriCli) @("signer", "sign", $Artifact) $Desktop | Out-Null
  }
  finally {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  }
  Assert-Signature $Artifact
}

# Checks the artifact against the public key built into the app, exactly as Raven will.
function Assert-Signature {
  param([string]$Artifact)
  if (-not (Test-Path -LiteralPath "$Artifact.sig")) { throw "$Artifact has no signature." }
  $manifest = Join-Path $Root "tools\release\signature-verify\Cargo.toml"
  Invoke-Native "cargo" @("run", "--quiet", "--locked", "--manifest-path", $manifest, "--", $Artifact, "$Artifact.sig", $PublicKey) | Out-Null
}

function Build-Windows {
  param([string]$Stage, [string]$Destination)
  Write-Host "== Building the Windows installer"
  $env:VITE_RAVEN_API_URL = $ApiUrl
  # A target directory of its own, so a running 'tauri dev' is not disturbed.
  $env:CARGO_TARGET_DIR = Join-Path $env:USERPROFILE "rvr"
  $bundles = Join-Path $env:CARGO_TARGET_DIR "release\bundle\nsis"
  Remove-Item -Recurse -Force -LiteralPath $bundles -ErrorAction SilentlyContinue
  Invoke-Native "bun" @("run", "tauri", "build", "--bundles", "nsis", "--config", (Join-Path $Root "infra\release\tauri.windows.release.conf.json"), "--ci") $Desktop
  $built = @(Get-ChildItem -LiteralPath $bundles -File -Filter "*.exe")
  if ($built.Count -ne 1) { throw "Expected exactly one Windows installer in $bundles, found $($built.Count)." }
  Copy-Item -LiteralPath $built[0].FullName -Destination $Destination -Force
}

function Build-Linux {
  param([string]$Stage, [string]$Destination, [string]$Commit)
  Write-Host "== Building the Linux AppImage in WSL ($WslDistro)"
  $dist = Join-Path $Desktop "dist"
  if (-not (Test-Path -LiteralPath (Join-Path $dist "index.html"))) { throw "apps/desktop/dist is missing; the Windows build creates it." }
  $sourceTar = Join-Path $Stage "source.tar"
  $distTar = Join-Path $Stage "dist.tar"
  # 'git archive' gives the committed line endings (LF), which the shell scripts need.
  Invoke-Native "git" @("archive", "--format=tar", "--output=$sourceTar", $Commit)
  Invoke-Native "tar.exe" @("-cf", $distTar, "-C", $Root, "apps/desktop/dist")
  $stageInWsl = (& wsl.exe -d $WslDistro -- wslpath -a ($Stage -replace '\\', '/')).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $stageInWsl) { throw "Could not reach the WSL distro '$WslDistro'." }
  $script = @"
set -euo pipefail
command -v docker >/dev/null || { echo 'Docker is not installed in this WSL distro. See docs/releasing.md.' >&2; exit 3; }
base="`$HOME/raven-build"
rm -rf "`$base/source"
mkdir -p "`$base/source" "`$base/out"
tar -xf '$stageInWsl/source.tar' -C "`$base/source"
tar -xf '$stageInWsl/dist.tar' -C "`$base/source"
bash "`$base/source/infra/release/build-linux-appimage.sh" "`$base/source" '$Version' "`$base/out"
cp "`$base/out/Raven_${Version}_amd64.AppImage" "`$base/out/compatibility-linux.txt" '$stageInWsl/'
"@
  $scriptFile = Join-Path $Stage "build-linux.sh"
  [IO.File]::WriteAllText($scriptFile, (($script -replace "`r", "") + "`n"), (New-Object Text.UTF8Encoding($false)))
  $ErrorActionPreference = "Continue"
  & wsl.exe -d $WslDistro --cd $Stage -- bash ./build-linux.sh
  $ErrorActionPreference = "Stop"
  if ($LASTEXITCODE -ne 0) { throw "The Linux build failed with exit code $LASTEXITCODE." }
  Remove-Item -LiteralPath $scriptFile -Force
  Remove-Item -LiteralPath $sourceTar, $distTar -Force
  if (-not (Test-Path -LiteralPath $Destination)) { throw "The Linux build did not produce $Destination." }
}

function Invoke-Build {
  Assert-Version
  $dirty = @(& git -C $Root status --porcelain)
  if ($dirty.Count -gt 0 -and -not $AllowDirty) {
    throw "The working tree has uncommitted changes. Commit them, or pass -AllowDirty for a rehearsal."
  }
  $commit = (& git -C $Root rev-parse HEAD).Trim()
  if ($dirty.Count -gt 0) {
    # A throwaway commit of the working tree (new files included), made through a
    # temporary index so the real index and branch are untouched. Both platforms then
    # build the same source.
    $ErrorActionPreference = "Continue"
    $env:GIT_INDEX_FILE = Join-Path ([IO.Path]::GetTempPath()) "raven-release-index-$PID"
    try {
      & git -C $Root read-tree HEAD 2>$null
      & git -C $Root add -A 2>$null
      $tree = (& git -C $Root write-tree 2>$null)
      $snapshot = (& git -C $Root commit-tree $tree -p HEAD -m "release rehearsal snapshot" 2>$null)
    }
    finally {
      Remove-Item -LiteralPath $env:GIT_INDEX_FILE -Force -ErrorAction SilentlyContinue
      Remove-Item Env:GIT_INDEX_FILE
      $ErrorActionPreference = "Stop"
    }
    if (-not $snapshot) { throw "Could not snapshot the working tree." }
    $commit = "$snapshot".Trim()
    Write-Warning "Building with uncommitted changes (rehearsal)."
  }
  $stage = Get-Stage
  $artifacts = Get-Artifacts $stage
  # Each installer is signed, and the signature checked, as soon as it exists.
  Build-Windows $stage $artifacts["windows-x86_64"]
  Invoke-Sign $artifacts["windows-x86_64"]
  Build-Linux $stage $artifacts["linux-x86_64"] $commit
  Invoke-Sign $artifacts["linux-x86_64"]

  $notesPath = if ($NotesFile) { $NotesFile } else { Join-Path $Root "release-notes-$Version.md" }
  $notes = if (Test-Path -LiteralPath $notesPath) { (Get-Content -Raw -Encoding UTF8 -LiteralPath $notesPath).Trim() } else { "" }
  $platforms = [ordered]@{}
  foreach ($entry in $artifacts.GetEnumerator()) {
    $platforms[$entry.Key] = [ordered]@{
      signature = (Get-Content -Raw -LiteralPath "$($entry.Value).sig").Trim()
      url       = "$PublicBase/$Version/$(Split-Path -Leaf $entry.Value)"
    }
  }
  $manifest = [ordered]@{
    version   = $Version
    notes     = $notes
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    commit    = $commit
    platforms = $platforms
  }
  [IO.File]::WriteAllText((Join-Path $stage "latest.json"), ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))

  Write-Host ""
  Write-Host "Raven $Version is built and signed in $stage"
  foreach ($artifact in $artifacts.Values) { Write-Host ("  {0}  {1:N1} MB" -f (Split-Path -Leaf $artifact), ((Get-Item $artifact).Length / 1MB)) }
  Write-Host "Send these two files to friends for a first install. Then: .\release.ps1 publish -Version $Version"
}

# Fetches the manifest and both installers the way a friend's Raven will (through the
# CDN) and compares them with what was built.
function Assert-PublicRelease {
  param([string]$Stage)
  Write-Host "== Checking the public download path"
  $expected = Get-Content -Raw -LiteralPath (Join-Path $Stage "latest.json") | ConvertFrom-Json
  $live = $null
  foreach ($attempt in 1..5) {
    try {
      $live = Invoke-RestMethod -Uri "$PublicBase/latest.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -Headers @{ "Cache-Control" = "no-cache" } -TimeoutSec 30
      if ($live.version -eq $expected.version) { break }
    }
    catch { $live = $null }
    Start-Sleep -Seconds 4
  }
  if (-not $live -or $live.version -ne $expected.version) { throw "$PublicBase/latest.json does not show version $($expected.version) yet." }
  $download = Join-Path $Stage "public-check.tmp"
  try {
    foreach ($artifact in (Get-Artifacts $Stage).Values) {
      $url = "$PublicBase/$Version/$(Split-Path -Leaf $artifact)"
      Invoke-WebRequest -Uri $url -OutFile $download -TimeoutSec 900 -UseBasicParsing
      if ((Get-Sha256 $download) -ne (Get-Sha256 $artifact)) { throw "$url does not match the file that was built." }
      Write-Host "  ok  $url"
    }
  }
  finally { Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue }
}

function Invoke-Publish {
  Assert-Version
  $stage = Get-Stage
  $artifacts = Get-Artifacts $stage
  $manifest = Join-Path $stage "latest.json"
  $files = @($artifacts.Values) + @($artifacts.Values | ForEach-Object { "$_.sig" }) + @($manifest)
  foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file)) { throw "$file is missing. Run: .\release.ps1 build -Version $Version" }
  }
  foreach ($artifact in $artifacts.Values) { Assert-Signature $artifact }
  if ((Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).platforms."windows-x86_64".url -notlike "$PublicBase/*") {
    throw "This build was made for a different destination. Rebuild with the same -Scratch value you publish with."
  }

  $checksums = ($files | ForEach-Object { "$(Get-Sha256 $_)  $(Split-Path -Leaf $_)" }) -join "`n"
  $incoming = "$RemoteRoot/.incoming-$Version"
  $final = "$RemoteRoot/$Version"

  Write-Host "== Uploading to $SshTarget"
  $state = Invoke-Remote @"
set -euo pipefail
mkdir -p '$RemoteRoot'
if [ -d '$final' ]; then
  cd '$final'
  if printf '%s\n' '$checksums' | grep -v ' latest.json$' | sha256sum --check --status -; then echo same; else echo different; fi
else
  rm -rf '$incoming'; mkdir -p '$incoming'; echo new
fi
"@
  if ("$state".Trim() -eq "different") {
    throw "Version $Version is already published with different files. A published version never changes: bump the version and build again."
  }
  if ("$state".Trim() -eq "new") {
    foreach ($file in $files) { Invoke-Native "scp" @("-q", "-o", "BatchMode=yes", $file, "${SshTarget}:$incoming/") }
    Invoke-Remote @"
set -euo pipefail
cd '$incoming'
printf '%s\n' '$checksums' | sha256sum --check --quiet -
chmod 0644 ./*
mv '$incoming' '$final'
"@ | Out-Null
  }
  else { Write-Host "  version $Version is already on the server with identical files" }

  Set-Latest
  Assert-PublicRelease $stage
  Write-Host ""
  Write-Host "Raven $Version is published. Friends will be told about it the next time their Raven checks."
}

# Makes <version>/latest.json the live manifest. The swap is a rename, so a client never
# reads a half-written file; the manifest it replaces is kept as latest.previous.json.
function Set-Latest {
  Write-Host "== Pointing latest.json at $Version"
  Invoke-Remote @"
set -euo pipefail
cd '$RemoteRoot'
test -f '$Version/latest.json' || { echo 'Version $Version is not on the server.' >&2; exit 4; }
if [ -f latest.json ]; then cp -p latest.json latest.previous.json; fi
cp '$Version/latest.json' .latest.json.new
mv .latest.json.new latest.json
# Keep the newest $KeepVersions versions (and always the live one); the disk here is small.
ls -1d [0-9]*/ 2>/dev/null | tr -d / | sort -V | head -n -$KeepVersions | while read -r old; do
  [ "`$old" = '$Version' ] || rm -rf -- "`$old"
done
"@ | Out-Null
}

function Invoke-Repoint {
  Assert-Version
  Set-Latest
  $live = Invoke-RestMethod -Uri "$PublicBase/latest.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -TimeoutSec 30
  Write-Host "latest.json now offers Raven $($live.version)."
  Write-Host "Raven only installs versions newer than the one running, so nobody is downgraded."
  Write-Host "Anyone already on a bad version reinstalls from: $($live.platforms.'windows-x86_64'.url) or $($live.platforms.'linux-x86_64'.url)"
}

function Invoke-Status {
  $remote = Invoke-Remote @"
cd '$RemoteRoot' 2>/dev/null || { echo '(nothing published yet)'; exit 0; }
ls -1d [0-9]*/ 2>/dev/null | tr -d / | sort -V | sed 's/^/  /'
du -sh . | cut -f1 | sed 's/^/Disk used: /'
"@
  Write-Host "Versions on ${SshTarget}:"
  $remote | ForEach-Object { Write-Host $_ }
  try {
    $live = Invoke-RestMethod -Uri "$PublicBase/latest.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -TimeoutSec 30
    Write-Host "Offered to friends: Raven $($live.version), published $($live.pub_date)"
  }
  catch { Write-Host "Offered to friends: nothing ($PublicBase/latest.json is not reachable)" }
}

function Invoke-Images {
  Assert-Version
  $dirty = @(& git -C $Root status --porcelain)
  if ($dirty.Count -gt 0 -and -not $AllowDirty) {
    throw "The working tree has uncommitted changes. Commit them, or pass -AllowDirty for a rehearsal."
  }
  if ($dirty.Count -gt 0 -and -not $DryRun) { throw "-AllowDirty only works with -DryRun: published images must come from a commit." }
  $commit = "HEAD"
  if ($dirty.Count -gt 0) { Write-Warning "Building the last commit (HEAD); uncommitted changes are not in the images." }
  $stage = Get-Stage
  Write-Host "== Building the server images in WSL ($WslDistro)"
  $sourceTar = Join-Path $Stage "source.tar"
  # 'git archive' gives the committed line endings (LF), which the Dockerfiles and scripts need.
  Invoke-Native "git" @("archive", "--format=tar", "--output=$sourceTar", $commit)
  $stageInWsl = (& wsl.exe -d $WslDistro -- wslpath -a ($stage -replace '\\', '/')).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $stageInWsl) { throw "Could not reach the WSL distro '$WslDistro'." }
  $tags = if ($NoLatest) { "" } else { " -t $ImageNamespace/raven-`$name:latest" }
  $output = if ($DryRun) { "--output type=image,push=false" } else { "--push" }
  $script = @"
set -euo pipefail
command -v docker >/dev/null || { echo 'Docker is not installed in this WSL distro. See docs/releasing.md.' >&2; exit 3; }
docker buildx version >/dev/null || { echo 'docker buildx is missing in this WSL distro.' >&2; exit 3; }
docker buildx inspect raven-multi >/dev/null 2>&1 || docker buildx create --name raven-multi >/dev/null
base="`$HOME/raven-images"
rm -rf "`$base/source"
mkdir -p "`$base/source"
tar -xf '$stageInWsl/source.tar' -C "`$base/source"
cd "`$base/source"
for name in api admin; do
  docker buildx build --builder raven-multi --platform linux/amd64,linux/arm64     -f infra/homelab/`$name.Dockerfile --build-arg RAVEN_VERSION=$Version     -t $ImageNamespace/raven-`$name:$Version$tags $output .
done
if [ '$DryRun' = 'False' ]; then
  for name in api admin; do
    docker buildx imagetools inspect $ImageNamespace/raven-`$name:$Version | grep -E '^(Name|Digest)'
  done
fi
"@
  $scriptFile = Join-Path $stage "build-images.sh"
  [IO.File]::WriteAllText($scriptFile, (($script -replace "`r", "") + "`n"), (New-Object Text.UTF8Encoding($false)))
  $ErrorActionPreference = "Continue"
  & wsl.exe -d $WslDistro --cd $stage -- bash ./build-images.sh
  $code = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  Remove-Item -LiteralPath $scriptFile, $sourceTar -Force -ErrorAction SilentlyContinue
  if ($code -ne 0) { throw "The image build failed with exit code $code. If the push was refused, run 'docker login' in WSL once." }
  if ($DryRun) { Write-Host "Dry run: both images build for amd64 and arm64; nothing was pushed." }
  else { Write-Host "Pushed $ImageNamespace/raven-api and $ImageNamespace/raven-admin $Version." }
}

switch ($Command) {
  "build" { Invoke-Build }
  "publish" { Invoke-Publish }
  "repoint" { Invoke-Repoint }
  "status" { Invoke-Status }
  "images" { Invoke-Images }
  default { Get-Help $PSCommandPath -Examples }
}
