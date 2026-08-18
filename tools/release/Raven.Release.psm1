Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RavenRepoRoot {
  [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}

function Test-RavenSemanticVersion {
  param([string]$Version)
  [bool]($Version -match '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$')
}

function Assert-RavenReleaseIdentity {
  param([string]$Version, [string]$Channel, [string]$Classification)
  if (-not (Test-RavenSemanticVersion -Version $Version)) {
    throw "Version must be a valid semantic version without a leading v."
  }
  if ($Channel -notin @("alpha", "stable")) {
    throw "Channel must be alpha or stable."
  }
  if ($Classification -notin @("optional", "recommended", "required")) {
    throw "Classification must be optional, recommended, or required."
  }
  if ($Channel -eq "stable" -and $Version.Contains("-")) {
    throw "Stable releases cannot use a prerelease semantic version."
  }
}

function Invoke-RavenNative {
  param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory)
  $previous = Get-Location
  try {
    if ($WorkingDirectory) {
      Set-Location $WorkingDirectory
    }
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$FilePath failed with exit code $LASTEXITCODE."
    }
  }
  finally {
    Set-Location $previous
  }
}

function Get-RavenNativeOutput {
  param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory)
  $previous = Get-Location
  try {
    if ($WorkingDirectory) {
      Set-Location $WorkingDirectory
    }
    $output = & $FilePath @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
      throw "$FilePath failed with exit code $LASTEXITCODE."
    }
    ($output | Out-String).Trim()
  }
  finally {
    Set-Location $previous
  }
}

function Get-RavenGitState {
  $root = Get-RavenRepoRoot
  $top = Get-RavenNativeOutput -FilePath "git" -Arguments @("rev-parse", "--show-toplevel") -WorkingDirectory $root
  if ([IO.Path]::GetFullPath($top) -ne $root) {
    throw "Release tooling is not running at the Raven repository root."
  }
  try {
    $commit = Get-RavenNativeOutput -FilePath "git" -Arguments @("rev-parse", "--verify", "HEAD^{commit}") -WorkingDirectory $root
  }
  catch {
    throw "Raven has no committed HEAD. Commit the complete release before preparing it."
  }
  if ($commit -notmatch '^[0-9a-f]{40,64}$') {
    throw "Git returned an invalid commit identifier."
  }
  $status = Get-RavenNativeOutput -FilePath "git" -Arguments @("status", "--porcelain=v1", "--untracked-files=all") -WorkingDirectory $root
  if ($status) {
    throw "The Git working tree is not clean. Commit or remove every tracked and untracked change before release."
  }
  [ordered]@{ Commit = $commit; Clean = $true }
}

function Get-RavenVersionDeclarations {
  $root = Get-RavenRepoRoot
  $desktopPackage = Get-Content -Raw -LiteralPath (Join-Path $root "apps\desktop\package.json") | ConvertFrom-Json
  $operationsPackage = Get-Content -Raw -LiteralPath (Join-Path $root "apps\operations\package.json") | ConvertFrom-Json
  $sharedPackage = Get-Content -Raw -LiteralPath (Join-Path $root "packages\shared\package.json") | ConvertFrom-Json
  $tauri = Get-Content -Raw -LiteralPath (Join-Path $root "apps\desktop\src-tauri\tauri.conf.json") | ConvertFrom-Json
  $cargo = Get-Content -Raw -LiteralPath (Join-Path $root "apps\desktop\src-tauri\Cargo.toml")
  $packageSection = [regex]::Match($cargo, '(?ms)^\[package\]\s*(.*?)(?=^\[|\z)')
  $cargoVersion = [regex]::Match($packageSection.Groups[1].Value, '(?m)^version\s*=\s*"([^"]+)"\s*$')
  if (-not $cargoVersion.Success) {
    throw "Could not read the Rust package version."
  }
  [ordered]@{
    "apps/desktop/package.json" = [string]$desktopPackage.version
    "apps/desktop/src-tauri/tauri.conf.json" = [string]$tauri.version
    "apps/desktop/src-tauri/Cargo.toml" = $cargoVersion.Groups[1].Value
    "apps/operations/package.json" = [string]$operationsPackage.version
    "packages/shared/package.json" = [string]$sharedPackage.version
  }
}

function Assert-RavenVersionsAgree {
  param([string]$Version)
  $declarations = Get-RavenVersionDeclarations
  foreach ($entry in $declarations.GetEnumerator()) {
    if ($entry.Value -ne $Version) {
      throw "Version mismatch: $($entry.Key) declares $($entry.Value), expected $Version."
    }
  }
  $declarations
}

function Get-RavenStagePath {
  param([string]$Version, [string]$Channel)
  Assert-RavenReleaseIdentity -Version $Version -Channel $Channel -Classification "optional"
  $root = Get-RavenRepoRoot
  $stageRoot = [IO.Path]::GetFullPath((Join-Path $root ".release\staging"))
  $path = [IO.Path]::GetFullPath((Join-Path $stageRoot "$Channel\$Version"))
  if (-not $path.StartsWith($stageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Release staging path escaped its boundary."
  }
  $path
}

function Remove-RavenSafeDirectory {
  param([string]$Path, [string]$AllowedParent)
  $target = [IO.Path]::GetFullPath($Path)
  $parent = [IO.Path]::GetFullPath($AllowedParent).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ($target -eq $parent -or -not $target.StartsWith($parent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a directory outside the intended boundary."
  }
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}

function Save-RavenState {
  param([object]$State, [string]$StagePath)
  New-Item -ItemType Directory -Force -Path $StagePath | Out-Null
  $path = Join-Path $StagePath "release-state.json"
  $temp = "$path.tmp"
  $json = $State | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($temp, $json, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temp -Destination $path -Force
}

function Get-RavenState {
  param([string]$Version, [string]$Channel)
  $stage = Get-RavenStagePath -Version $Version -Channel $Channel
  $path = Join-Path $stage "release-state.json"
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Release is not prepared."
  }
  [ordered]@{ Stage = $stage; State = (Get-Content -Raw -LiteralPath $path | ConvertFrom-Json) }
}

function Assert-RavenPinnedState {
  param([object]$State)
  $git = Get-RavenGitState
  if ($git.Commit -ne $State.commit) {
    throw "HEAD no longer matches the prepared release commit."
  }
  Assert-RavenVersionsAgree -Version $State.version | Out-Null
}

function Read-RavenNotes {
  param([string]$NotesFile, [string]$Version)
  if (-not $NotesFile) {
    return "Raven $Version"
  }
  if (-not (Test-Path -LiteralPath $NotesFile -PathType Leaf)) {
    throw "Release notes file does not exist."
  }
  $notes = (Get-Content -Raw -LiteralPath $NotesFile).Trim()
  if (-not $notes) {
    throw "Release notes cannot be empty."
  }
  $notes
}

function New-RavenReleaseStage {
  param(
    [string]$Version,
    [string]$Channel,
    [string]$Classification,
    [string]$NotesFile,
    [int]$ClientProtocolVersion,
    [string]$MinimumServerVersion,
    [string]$MaximumServerVersion,
    [string[]]$RequiredCapabilities,
    [string]$GraceEndsAt,
    [int]$LocalDataSchemaVersion,
    [bool]$LocalMigrationReversible,
    [bool]$RollbackSafe
  )
  Assert-RavenReleaseIdentity -Version $Version -Channel $Channel -Classification $Classification
  if ($ClientProtocolVersion -lt 1 -or $LocalDataSchemaVersion -lt 1) {
    throw "Protocol and local data schema versions must be positive."
  }
  if ($RollbackSafe -and -not $LocalMigrationReversible) {
    throw "RollbackSafe requires LocalMigrationReversible."
  }
  if ($MinimumServerVersion -and -not (Test-RavenSemanticVersion $MinimumServerVersion)) {
    throw "MinimumServerVersion is not valid semantic versioning."
  }
  if ($MaximumServerVersion -and -not (Test-RavenSemanticVersion $MaximumServerVersion)) {
    throw "MaximumServerVersion is not valid semantic versioning."
  }
  if ($GraceEndsAt) {
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($GraceEndsAt, [ref]$parsed)) {
      throw "GraceEndsAt must be an RFC 3339 timestamp."
    }
    $GraceEndsAt = $parsed.ToUniversalTime().ToString("o")
  }
  $git = Get-RavenGitState
  Assert-RavenVersionsAgree -Version $Version | Out-Null
  $stage = Get-RavenStagePath -Version $Version -Channel $Channel
  if (Test-Path -LiteralPath $stage) {
    throw "This release is already staged. Use clean for the exact version before preparing again."
  }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  $state = [ordered]@{
    schemaVersion = 1
    version = $Version
    channel = $Channel
    classification = $Classification
    notes = Read-RavenNotes -NotesFile $NotesFile -Version $Version
    commit = $git.Commit
    repositoryClean = $true
    clientProtocolVersion = $ClientProtocolVersion
    minimumServerVersion = $MinimumServerVersion
    maximumServerVersion = $MaximumServerVersion
    requiredCapabilities = @($RequiredCapabilities | Where-Object { $_ } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Sort-Object -Unique)
    graceEndsAt = $GraceEndsAt
    localDataSchemaVersion = $LocalDataSchemaVersion
    localMigrationReversible = $LocalMigrationReversible
    rollbackSafe = $RollbackSafe
    createdAt = [DateTime]::UtcNow.ToString("o")
    phase = "prepared"
    testsCompleted = $false
    windowsBuilt = $false
    linuxBuilt = $false
    validated = $false
    uploaded = $false
    registered = $false
    artifacts = @()
    uploadObjects = @()
    uploadedObjectKeys = @()
    releaseId = $null
  }
  Save-RavenState -State $state -StagePath $stage
  Write-Output "Prepared Raven $Version ($Channel) at commit $($git.Commit)."
}

function Invoke-RavenReleaseTests {
  param([string]$Version, [string]$Channel)
  $context = Get-RavenState -Version $Version -Channel $Channel
  $state = $context.State
  Assert-RavenPinnedState -State $state
  $root = Get-RavenRepoRoot
  Invoke-RavenNative -FilePath "go" -Arguments @("test", "./...") -WorkingDirectory (Join-Path $root "services\api")
  foreach ($app in @("apps\desktop", "apps\operations")) {
    $directory = Join-Path $root $app
    Invoke-RavenNative -FilePath "bun" -Arguments @("install", "--frozen-lockfile") -WorkingDirectory $directory
    Invoke-RavenNative -FilePath "bun" -Arguments @("run", "test") -WorkingDirectory $directory
    Invoke-RavenNative -FilePath "bun" -Arguments @("run", "build") -WorkingDirectory $directory
  }
  . (Join-Path $root "apps\desktop\scripts\msvc-env.ps1")
  . (Join-Path $root "apps\desktop\scripts\native-build-env.ps1")
  Invoke-RavenNative -FilePath "cargo" -Arguments @("test", "--locked", "--lib") -WorkingDirectory (Join-Path $root "apps\desktop\src-tauri")
  Assert-RavenPinnedState -State $state
  $state.testsCompleted = $true
  $state.phase = "tested"
  Save-RavenState -State $state -StagePath $context.Stage
}

function Get-RavenTauriExecutable {
  $root = Get-RavenRepoRoot
  foreach ($name in @("tauri.exe", "tauri.cmd", "tauri.bunx")) {
    $candidate = Join-Path $root "apps\desktop\node_modules\.bin\$name"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  throw "The pinned Tauri CLI is missing. Run bun install in apps/desktop."
}

function Unprotect-RavenDpapiSecret {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "DPAPI secret file is missing."
  }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $Path).Trim())
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Get-RavenSigningPaths {
  $root = Get-RavenRepoRoot
  $key = if ($env:TAURI_SIGNING_PRIVATE_KEY_PATH) { $env:TAURI_SIGNING_PRIVATE_KEY_PATH } else { Join-Path $env:USERPROFILE ".raven\updater\raven-updater.key" }
  $public = if ($env:RAVEN_UPDATER_PUBLIC_KEY_PATH) { $env:RAVEN_UPDATER_PUBLIC_KEY_PATH } else { "$key.pub" }
  if (-not (Test-Path -LiteralPath $key -PathType Leaf) -or -not (Test-Path -LiteralPath $public -PathType Leaf)) {
    throw "The Raven updater signing key pair is not available on this workstation."
  }
  $tauri = Get-Content -Raw -LiteralPath (Join-Path $root "apps\desktop\src-tauri\tauri.conf.json") | ConvertFrom-Json
  $embedded = [string]$tauri.plugins.updater.pubkey
  if (-not $embedded -or $embedded.Trim() -ne (Get-Content -Raw -LiteralPath $public).Trim()) {
    throw "The local updater public key does not match the trust root embedded in Raven."
  }
  [ordered]@{ Private = $key; Public = $public }
}

function Invoke-RavenSignArtifact {
  param([string]$Artifact)
  $paths = Get-RavenSigningPaths
  $password = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  if (-not $password) {
    $passwordFile = if ($env:RAVEN_UPDATER_PASSWORD_DPAPI_FILE) { $env:RAVEN_UPDATER_PASSWORD_DPAPI_FILE } else { Join-Path $env:USERPROFILE ".raven\updater\raven-updater.password.dpapi" }
    $password = Unprotect-RavenDpapiSecret -Path $passwordFile
  }
  $oldKey = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
  $oldPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  try {
    $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $paths.Private
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $password
    $null = Get-RavenNativeOutput -FilePath (Get-RavenTauriExecutable) -Arguments @("signer", "sign", $Artifact) -WorkingDirectory (Join-Path (Get-RavenRepoRoot) "apps\desktop")
  }
  finally {
    if ($null -eq $oldKey) { Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue } else { $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $oldKey }
    if ($null -eq $oldPassword) { Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue } else { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $oldPassword }
    $password = $null
  }
  $signature = "$Artifact.sig"
  if (-not (Test-Path -LiteralPath $signature -PathType Leaf)) {
    throw "Tauri did not create an updater signature."
  }
  Invoke-RavenVerifySignature -Artifact $Artifact -Signature $signature
}

function Invoke-RavenVerifySignature {
  param([string]$Artifact, [string]$Signature)
  $root = Get-RavenRepoRoot
  $paths = Get-RavenSigningPaths
  $null = Get-RavenNativeOutput -FilePath "cargo" -Arguments @("run", "--quiet", "--locked", "--manifest-path", (Join-Path $root "tools\release\signature-verify\Cargo.toml"), "--", $Artifact, $Signature, $paths.Public) -WorkingDirectory $root
}

function Invoke-RavenWindowsBuild {
  param([string]$Version, [string]$Channel)
  $context = Get-RavenState -Version $Version -Channel $Channel
  $state = $context.State
  Assert-RavenPinnedState -State $state
  if (-not $state.testsCompleted) {
    throw "Tests must pass before building release artifacts."
  }
  $root = Get-RavenRepoRoot
  $target = Join-Path $env:USERPROFILE "rvr"
  Remove-RavenSafeDirectory -Path $target -AllowedParent $env:USERPROFILE
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  $oldTarget = $env:CARGO_TARGET_DIR
  try {
    $env:CARGO_TARGET_DIR = $target
    Invoke-RavenNative -FilePath "bun" -Arguments @("run", "tauri", "build", "--bundles", "nsis", "--config", (Join-Path $root "infra\release\tauri.windows.release.conf.json"), "--ci") -WorkingDirectory (Join-Path $root "apps\desktop")
  }
  finally {
    if ($null -eq $oldTarget) { Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue } else { $env:CARGO_TARGET_DIR = $oldTarget }
  }
  $built = @(Get-ChildItem -LiteralPath (Join-Path $target "release\bundle\nsis") -File -Filter "*.exe")
  if ($built.Count -ne 1) {
    throw "Expected exactly one Windows NSIS updater artifact."
  }
  $destination = Join-Path $context.Stage "artifacts\windows\raven_${Version}_windows_x86_64-setup.exe"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $built[0].FullName -Destination $destination
  Invoke-RavenSignArtifact -Artifact $destination
  $state.windowsBuilt = $true
  $state.phase = if ($state.linuxBuilt) { "built" } else { "windows_built" }
  Save-RavenState -State $state -StagePath $context.Stage
}

function Invoke-RavenLinuxBuild {
  param([string]$Version, [string]$Channel, [string]$SshTarget)
  $context = Get-RavenState -Version $Version -Channel $Channel
  $state = $context.State
  Assert-RavenPinnedState -State $state
  if (-not $state.testsCompleted) {
    throw "Tests must pass before building release artifacts."
  }
  if (-not $SshTarget) {
    $SshTarget = if ($env:RAVEN_RELEASE_SSH_TARGET) { $env:RAVEN_RELEASE_SSH_TARGET } else { "soroush@homelab" }
  }
  $root = Get-RavenRepoRoot
  $gitArchive = Join-Path $context.Stage "source-git.tar"
  Invoke-RavenNative -FilePath "git" -Arguments @("archive", "--format=tar", "--output=$gitArchive", $state.commit) -WorkingDirectory $root
  $dist = Join-Path $root "apps\desktop\dist"
  if (-not (Test-Path -LiteralPath (Join-Path $dist "index.html") -PathType Leaf)) {
    throw "The tested desktop frontend output is missing."
  }
  $distArchive = Join-Path $context.Stage "frontend-dist.tar"
  if (Test-Path -LiteralPath $distArchive) { Remove-Item -LiteralPath $distArchive -Force }
  Invoke-RavenNative -FilePath "tar.exe" -Arguments @("-cf", $distArchive, "-C", $root, "apps/desktop/dist") -WorkingDirectory $root
  $gitArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $gitArchive).Hash.ToLowerInvariant()
  $distArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $distArchive).Hash.ToLowerInvariant()
  $remote = "/home/soroush/services/raven/builds/$($state.commit)"
  $prepare = "set -eu; base='$remote'; case `$base in /home/soroush/services/raven/builds/*) ;; *) exit 2 ;; esac; mkdir -p `$base; rm -rf `$base/source `$base/out; rm -f `$base/source-git.tar `$base/frontend-dist.tar; mkdir -p `$base/source `$base/out"
  Invoke-RavenNative -FilePath "ssh" -Arguments @("-o", "BatchMode=yes", $SshTarget, $prepare) -WorkingDirectory $root
  Invoke-RavenNative -FilePath "scp" -Arguments @($gitArchive, "${SshTarget}:$remote/source-git.tar") -WorkingDirectory $root
  Invoke-RavenNative -FilePath "scp" -Arguments @($distArchive, "${SshTarget}:$remote/frontend-dist.tar") -WorkingDirectory $root
  $build = "set -eu; cd '$remote'; printf '%s  %s\n' '$gitArchiveHash' 'source-git.tar' '$distArchiveHash' 'frontend-dist.tar' | sha256sum -c -; tar -xf source-git.tar -C source; tar -xf frontend-dist.tar -C source; bash source/infra/release/build-linux-appimage.sh source '$Version' '$($state.commit)'"
  Invoke-RavenNative -FilePath "ssh" -Arguments @("-o", "BatchMode=yes", $SshTarget, $build) -WorkingDirectory $root
  $linuxDirectory = Join-Path $context.Stage "artifacts\linux"
  New-Item -ItemType Directory -Force -Path $linuxDirectory | Out-Null
  $artifactName = "raven_${Version}_linux_x86_64.AppImage"
  foreach ($name in @($artifactName, "toolchain-linux.txt", "compatibility-linux.txt")) {
    Invoke-RavenNative -FilePath "scp" -Arguments @("${SshTarget}:$remote/out/$name", (Join-Path $linuxDirectory $name)) -WorkingDirectory $root
  }
  $artifact = Join-Path $linuxDirectory $artifactName
  Invoke-RavenSignArtifact -Artifact $artifact
  $state.linuxBuilt = $true
  $state.phase = if ($state.windowsBuilt) { "built" } else { "linux_built" }
  Save-RavenState -State $state -StagePath $context.Stage
}

function Get-RavenFileHash {
  param([string]$Path)
  (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-RavenToolchain {
  param([string]$Platform, [string]$StagePath)
  if ($Platform -eq "linux") {
    $path = Join-Path $StagePath "artifacts\linux\toolchain-linux.txt"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Linux toolchain evidence is missing."
    }
    return @((Get-Content -LiteralPath $path) | Where-Object { $_ })
  }
  $root = Get-RavenRepoRoot
  @(
    "git=" + (Get-RavenNativeOutput -FilePath "git" -Arguments @("--version") -WorkingDirectory $root),
    "go=" + (Get-RavenNativeOutput -FilePath "go" -Arguments @("version") -WorkingDirectory $root),
    "bun=" + (Get-RavenNativeOutput -FilePath "bun" -Arguments @("--version") -WorkingDirectory $root),
    "rustc=" + (Get-RavenNativeOutput -FilePath "rustc" -Arguments @("--version") -WorkingDirectory $root),
    "cargo=" + (Get-RavenNativeOutput -FilePath "cargo" -Arguments @("--version") -WorkingDirectory $root),
    "tauri=" + (Get-RavenNativeOutput -FilePath (Get-RavenTauriExecutable) -Arguments @("--version") -WorkingDirectory (Join-Path $root "apps\desktop"))
  )
}

function Add-RavenSbomComponent {
  param([hashtable]$Components, [string]$Type, [string]$Name, [string]$Version, [string]$License)
  if (-not $Name -or -not $Version) {
    return
  }
  $key = "$Type`:$Name@$Version"
  if ($Components.ContainsKey($key)) {
    return
  }
  $component = [ordered]@{ type = $Type; name = $Name; version = $Version }
  if ($License) {
    $component.licenses = @([ordered]@{ license = [ordered]@{ name = $License } })
  }
  $Components[$key] = $component
}

function New-RavenSbom {
  param([object]$State, [string]$Artifact, [string]$Platform, [string]$Destination)
  $root = Get-RavenRepoRoot
  $components = @{}
  $goModules = Get-RavenNativeOutput -FilePath "go" -Arguments @("list", "-m", "-f", "{{.Path}}|{{.Version}}", "all") -WorkingDirectory (Join-Path $root "services\api")
  foreach ($line in ($goModules -split "`r?`n")) {
    $parts = $line -split '\|', 2
    if ($parts.Count -eq 2 -and $parts[1]) {
      Add-RavenSbomComponent -Components $components -Type "library" -Name $parts[0] -Version $parts[1] -License ""
    }
  }
  $cargoTree = Get-RavenNativeOutput -FilePath "cargo" -Arguments @("tree", "--locked", "--target", "all", "--prefix", "none", "--format", "{p}|{l}") -WorkingDirectory (Join-Path $root "apps\desktop\src-tauri")
  foreach ($line in ($cargoTree -split "`r?`n")) {
    $match = [regex]::Match($line, '^(\S+) v(\S+)(?: \(.+\))?\|(.*?)(?: \(\*\))?$')
    if (-not $match.Success) {
      continue
    }
    Add-RavenSbomComponent -Components $components -Type "library" -Name $match.Groups[1].Value -Version $match.Groups[2].Value -License $match.Groups[3].Value
  }
  foreach ($line in Get-Content -LiteralPath (Join-Path $root "apps\desktop\bun.lock")) {
    $match = [regex]::Match($line, '^\s{4}"[^"]+": \["([^"]+)"')
    if (-not $match.Success) {
      continue
    }
    $identity = $match.Groups[1].Value
    $at = $identity.LastIndexOf('@')
    if ($at -le 0 -or $at -eq $identity.Length - 1) {
      continue
    }
    Add-RavenSbomComponent -Components $components -Type "library" -Name $identity.Substring(0, $at) -Version $identity.Substring($at + 1) -License ""
  }
  $hash = Get-RavenFileHash -Path $Artifact
  $sbom = [ordered]@{
    bomFormat = "CycloneDX"
    specVersion = "1.5"
    serialNumber = "urn:uuid:$([guid]::NewGuid())"
    version = 1
    metadata = [ordered]@{
      timestamp = [DateTime]::UtcNow.ToString("o")
      tools = [ordered]@{ components = @([ordered]@{ type = "application"; name = "Raven release orchestrator"; version = "1" }) }
      component = [ordered]@{
        type = "application"
        name = "Raven desktop"
        version = $State.version
        hashes = @([ordered]@{ alg = "SHA-256"; content = $hash })
        properties = @(
          [ordered]@{ name = "raven:platform"; value = $Platform },
          [ordered]@{ name = "raven:architecture"; value = "x86_64" },
          [ordered]@{ name = "raven:git-commit"; value = $State.commit }
        )
      }
    }
    components = @($components.Values | Sort-Object { $_.name }, { $_.version })
  }
  [IO.File]::WriteAllText($Destination, ($sbom | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
}

function New-RavenProvenance {
  param([object]$State, [string]$Artifact, [string]$Signature, [string]$Platform, [string]$Destination, [string]$StagePath)
  $provenance = [ordered]@{
    schemaVersion = 1
    version = $State.version
    channel = $State.channel
    gitCommit = $State.commit
    repositoryClean = [bool]$State.repositoryClean
    buildTimestamp = [DateTime]::UtcNow.ToString("o")
    platform = $Platform
    architecture = "x86_64"
    toolchains = @(Get-RavenToolchain -Platform $Platform -StagePath $StagePath)
    artifact = [ordered]@{
      name = [IO.Path]::GetFileName($Artifact)
      size = (Get-Item -LiteralPath $Artifact).Length
      sha256 = Get-RavenFileHash -Path $Artifact
      signature = [ordered]@{
        name = [IO.Path]::GetFileName($Signature)
        sha256 = Get-RavenFileHash -Path $Signature
        verified = $true
      }
    }
  }
  [IO.File]::WriteAllText($Destination, ($provenance | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
}

function New-RavenArtifactRecord {
  param([object]$State, [string]$StagePath, [string]$Platform, [string]$Artifact, [string]$Format)
  $signature = "$Artifact.sig"
  Invoke-RavenVerifySignature -Artifact $Artifact -Signature $signature
  $directory = Split-Path -Parent $Artifact
  $baseName = [IO.Path]::GetFileName($Artifact)
  $checksum = Join-Path $directory "$baseName.sha256"
  $artifactHash = Get-RavenFileHash -Path $Artifact
  [IO.File]::WriteAllText($checksum, "$artifactHash  $baseName`n", (New-Object Text.UTF8Encoding($false)))
  $sbom = Join-Path $directory "$baseName.cdx.json"
  New-RavenSbom -State $State -Artifact $Artifact -Platform $Platform -Destination $sbom
  $provenance = Join-Path $directory "$baseName.provenance.json"
  New-RavenProvenance -State $State -Artifact $Artifact -Signature $signature -Platform $Platform -Destination $provenance -StagePath $StagePath
  $prefix = "desktop/$($State.channel)/$($State.version)/$Platform/x86_64"
  [ordered]@{
    platform = $Platform
    architecture = "x86_64"
    format = $Format
    artifactPath = $Artifact
    signaturePath = $signature
    checksumPath = $checksum
    sbomPath = $sbom
    provenancePath = $provenance
    objectKey = "$prefix/$baseName"
    signatureObjectKey = "$prefix/$([IO.Path]::GetFileName($signature))"
    checksumObjectKey = "$prefix/$([IO.Path]::GetFileName($checksum))"
    sbomObjectKey = "$prefix/$([IO.Path]::GetFileName($sbom))"
    provenanceObjectKey = "$prefix/$([IO.Path]::GetFileName($provenance))"
    sha256 = $artifactHash
    signatureSha256 = Get-RavenFileHash -Path $signature
    checksumSha256 = Get-RavenFileHash -Path $checksum
    sbomSha256 = Get-RavenFileHash -Path $sbom
    provenanceSha256 = Get-RavenFileHash -Path $provenance
    size = (Get-Item -LiteralPath $Artifact).Length
  }
}

function Test-RavenArtifactRecord {
  param([object]$Record, [object]$State)
  foreach ($name in @("artifactPath", "signaturePath", "checksumPath", "sbomPath", "provenancePath")) {
    if (-not (Test-Path -LiteralPath $Record.$name -PathType Leaf)) {
      throw "Release artifact metadata references a missing file."
    }
  }
  if ((Get-RavenFileHash $Record.artifactPath) -ne $Record.sha256 -or (Get-RavenFileHash $Record.signaturePath) -ne $Record.signatureSha256 -or (Get-RavenFileHash $Record.checksumPath) -ne $Record.checksumSha256 -or (Get-RavenFileHash $Record.sbomPath) -ne $Record.sbomSha256 -or (Get-RavenFileHash $Record.provenancePath) -ne $Record.provenanceSha256) {
    throw "Release artifact hashes do not match."
  }
  $checksumLine = (Get-Content -Raw -LiteralPath $Record.checksumPath).Trim()
  if ($checksumLine -ne "$($Record.sha256)  $([IO.Path]::GetFileName($Record.artifactPath))") {
    throw "Checksum file content is invalid."
  }
  $prefix = "desktop/$($State.channel)/$($State.version)/$($Record.platform)/x86_64/"
  foreach ($keyName in @("objectKey", "signatureObjectKey", "checksumObjectKey", "sbomObjectKey", "provenanceObjectKey")) {
    if (-not ([string]$Record.$keyName).StartsWith($prefix, [StringComparison]::Ordinal)) {
      throw "Artifact object key escaped its immutable version prefix."
    }
  }
  $sbom = Get-Content -Raw -LiteralPath $Record.sbomPath | ConvertFrom-Json
  if ($sbom.bomFormat -ne "CycloneDX" -or $sbom.specVersion -ne "1.5") {
    throw "SBOM is invalid."
  }
  $provenance = Get-Content -Raw -LiteralPath $Record.provenancePath | ConvertFrom-Json
  if ($provenance.gitCommit -ne $State.commit -or -not $provenance.repositoryClean -or $provenance.artifact.sha256 -ne $Record.sha256) {
    throw "Build provenance is invalid."
  }
  Invoke-RavenVerifySignature -Artifact $Record.artifactPath -Signature $Record.signaturePath
}

function Invoke-RavenValidateRelease {
  param([string]$Version, [string]$Channel)
  $context = Get-RavenState -Version $Version -Channel $Channel
  $state = $context.State
  Assert-RavenPinnedState -State $state
  if (-not $state.testsCompleted -or -not $state.windowsBuilt -or -not $state.linuxBuilt) {
    throw "Tests and both target builds must complete before validation."
  }
  $windows = Join-Path $context.Stage "artifacts\windows\raven_${Version}_windows_x86_64-setup.exe"
  $linux = Join-Path $context.Stage "artifacts\linux\raven_${Version}_linux_x86_64.AppImage"
  $records = @(
    New-RavenArtifactRecord -State $state -StagePath $context.Stage -Platform "windows" -Artifact $windows -Format "nsis"
    New-RavenArtifactRecord -State $state -StagePath $context.Stage -Platform "linux" -Artifact $linux -Format "appimage"
  )
  foreach ($record in $records) {
    Test-RavenArtifactRecord -Record $record -State $state
  }
  $objects = @()
  foreach ($record in $records) {
    $objects += [ordered]@{ localPath = $record.artifactPath; objectKey = $record.objectKey; sha256 = $record.sha256 }
    $objects += [ordered]@{ localPath = $record.signaturePath; objectKey = $record.signatureObjectKey; sha256 = $record.signatureSha256 }
    $objects += [ordered]@{ localPath = $record.checksumPath; objectKey = $record.checksumObjectKey; sha256 = $record.checksumSha256 }
    $objects += [ordered]@{ localPath = $record.sbomPath; objectKey = $record.sbomObjectKey; sha256 = $record.sbomSha256 }
    $objects += [ordered]@{ localPath = $record.provenancePath; objectKey = $record.provenanceObjectKey; sha256 = $record.provenanceSha256 }
  }
  if (@($objects.objectKey | Sort-Object -Unique).Count -ne $objects.Count) {
    throw "Release object keys are not unique."
  }
  $state.artifacts = $records
  $state.uploadObjects = $objects
  $state.validated = $true
  $state.phase = "validated"
  Save-RavenState -State $state -StagePath $context.Stage
}

function Import-RavenS3Environment {
  param([string]$Path)
  $root = Get-RavenRepoRoot
  if (-not $Path) { $Path = Join-Path $root ".env" }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "S3 environment file is missing."
  }
  $allowed = @("S3_ENDPOINT", "S3_HOST", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_PATH_STYLE")
  $previous = @{}
  foreach ($name in $allowed) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  try {
    foreach ($line in Get-Content -LiteralPath $Path) {
      if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
      $name = $matches[1]
      if ($name -notin $allowed) { continue }
      $value = $matches[2].Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
    foreach ($required in @("S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY")) {
      if (-not [Environment]::GetEnvironmentVariable($required, "Process")) {
        throw "$required is missing from the release environment."
      }
    }
    if (-not $env:S3_ENDPOINT -and -not $env:S3_HOST) {
      throw "S3_ENDPOINT or S3_HOST is missing from the release environment."
    }
    $previous
  }
  catch {
    Restore-RavenEnvironment -Previous $previous
    throw
  }
}

function Restore-RavenEnvironment {
  param([hashtable]$Previous)
  foreach ($entry in $Previous.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
  }
}

function Get-RavenS3Command {
  $root = Get-RavenRepoRoot
  $bin = Join-Path $root ".release\bin"
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $executable = Join-Path $bin "raven-s3cmd.exe"
  Invoke-RavenNative -FilePath "go" -Arguments @("build", "-trimpath", "-o", $executable, ".") -WorkingDirectory (Join-Path $root "tools\release\s3cmd")
  $executable
}

function Invoke-RavenUploadRelease {
  param([string]$Version, [string]$Channel, [string]$S3EnvFile)
  $context = Get-RavenState -Version $Version -Channel $Channel
  $state = $context.State
  Assert-RavenPinnedState -State $state
  if (-not $state.validated) {
    throw "Release must be validated before upload."
  }
  if ($state.uploaded) {
    throw "Release objects are already marked uploaded."
  }
  $previous = Import-RavenS3Environment -Path $S3EnvFile
  try {
    $s3 = Get-RavenS3Command
    foreach ($object in @($state.uploadObjects)) {
      $json = Get-RavenNativeOutput -FilePath $s3 -Arguments @("exists", "--key", $object.objectKey) -WorkingDirectory (Get-RavenRepoRoot)
      $result = $json | ConvertFrom-Json
      if ($result.exists) {
        throw "Immutable object already exists: $($object.objectKey). Use a new release version."
      }
    }
    $uploaded = @()
    try {
      foreach ($object in @($state.uploadObjects)) {
        $null = Get-RavenNativeOutput -FilePath $s3 -Arguments @("put", "--key", $object.objectKey, "--file", $object.localPath) -WorkingDirectory (Get-RavenRepoRoot)
        $uploaded += $object.objectKey
        $state.uploadedObjectKeys = @($uploaded)
        Save-RavenState -State $state -StagePath $context.Stage
        $null = Get-RavenNativeOutput -FilePath $s3 -Arguments @("verify", "--key", $object.objectKey, "--file", $object.localPath) -WorkingDirectory (Get-RavenRepoRoot)
      }
    }
    catch {
      $state.phase = "upload_failed"
      $state.uploadedObjectKeys = @($uploaded)
      Save-RavenState -State $state -StagePath $context.Stage
      throw "Release upload failed after $($uploaded.Count) stored objects. Historical objects were preserved; burn this version and prepare a new one."
    }
    $state.uploaded = $true
    $state.phase = "uploaded"
    $state.uploadedObjectKeys = @($uploaded)
    Save-RavenState -State $state -StagePath $context.Stage
  }
  finally {
    Restore-RavenEnvironment -Previous $previous
  }
}

function Read-RavenSessionSecret {
  param([string]$EnvironmentName, [string]$FilePath)
  $value = [Environment]::GetEnvironmentVariable($EnvironmentName, "Process")
  if ($value) { return $value.Trim() }
  if (-not $FilePath -or -not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    throw "$EnvironmentName or its secure file is required."
  }
  if ($FilePath.EndsWith(".dpapi", [StringComparison]::OrdinalIgnoreCase)) {
    return Unprotect-RavenDpapiSecret -Path $FilePath
  }
  (Get-Content -Raw -LiteralPath $FilePath).Trim()
}

function Invoke-RavenOpsRequest {
  param([string]$Method, [string]$Path, [object]$Body, [string]$AccountSessionFile, [string]$OpsSessionFile, [string]$OpsSessionOverride, [string]$IdempotencyKey)
  $base = if ($env:RAVEN_OPS_URL) { $env:RAVEN_OPS_URL.TrimEnd('/') } else { "https://ops.rvn.bluehour.cloud" }
  $account = Read-RavenSessionSecret -EnvironmentName "RAVEN_ACCOUNT_SESSION_ID" -FilePath $AccountSessionFile
  $ops = if ($OpsSessionOverride) { $OpsSessionOverride } else { Read-RavenSessionSecret -EnvironmentName "RAVEN_OPS_SESSION" -FilePath $OpsSessionFile }
  $edgePasswordPath = if ($env:RAVEN_OPS_EDGE_PASSWORD_DPAPI_FILE) { $env:RAVEN_OPS_EDGE_PASSWORD_DPAPI_FILE } else { Join-Path $env:USERPROFILE ".raven\ops-edge\raven-ops.password.dpapi" }
  $edgePassword = Unprotect-RavenDpapiSecret -Path $edgePasswordPath
  try {
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("raven-ops:$edgePassword"))
    $headers = @{
      "X-Session-ID" = $account
      "X-Raven-Ops-Session" = $ops
      "X-Idempotency-Key" = if ($IdempotencyKey) { $IdempotencyKey } else { "release-cli-$([guid]::NewGuid())" }
      Authorization = "Basic $basic"
      Accept = "application/json"
    }
    $parameters = @{ Method = $Method; Uri = "$base$Path"; Headers = $headers; TimeoutSec = 60 }
    if ($null -ne $Body) {
      $parameters.ContentType = "application/json"
      $parameters.Body = $Body | ConvertTo-Json -Depth 20 -Compress
    }
    try {
      Invoke-RestMethod @parameters
    }
    catch {
      $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
      throw "Operations API request failed with status $status."
    }
  }
  finally {
    $account = $null
    $ops = $null
    $edgePassword = $null
    $basic = $null
    $headers = $null
  }
}

function New-RavenOpsSession {
  param([string]$AccountSessionFile, [string]$OpsPasswordFile)
  $base = if ($env:RAVEN_OPS_URL) { $env:RAVEN_OPS_URL.TrimEnd('/') } else { "https://ops.rvn.bluehour.cloud" }
  $account = Read-RavenSessionSecret -EnvironmentName "RAVEN_ACCOUNT_SESSION_ID" -FilePath $AccountSessionFile
  $password = Read-RavenSessionSecret -EnvironmentName "RAVEN_OPS_ACCOUNT_PASSWORD" -FilePath $OpsPasswordFile
  $edgePasswordPath = if ($env:RAVEN_OPS_EDGE_PASSWORD_DPAPI_FILE) { $env:RAVEN_OPS_EDGE_PASSWORD_DPAPI_FILE } else { Join-Path $env:USERPROFILE ".raven\ops-edge\raven-ops.password.dpapi" }
  $edgePassword = Unprotect-RavenDpapiSecret -Path $edgePasswordPath
  try {
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("raven-ops:$edgePassword"))
    $headers = @{
      "X-Session-ID" = $account
      Authorization = "Basic $basic"
      Accept = "application/json"
    }
    $body = [ordered]@{ password = $password } | ConvertTo-Json -Compress
    try {
      $response = Invoke-RestMethod -Method Post -Uri "$base/v1/ops/session" -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 60
    }
    catch {
      $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
      throw "Operations session request failed with status $status."
    }
    if (-not $response.opsSessionToken) {
      throw "Operations API did not return a short-lived session."
    }
    [string]$response.opsSessionToken
  }
  finally {
    $account = $null
    $password = $null
    $edgePassword = $null
    $basic = $null
    $headers = $null
    $body = $null
  }
}

function New-RavenDraftRequest {
  param([object]$State)
  $minimumServerVersion = if ([string]::IsNullOrWhiteSpace([string]$State.minimumServerVersion)) { $null } else { [string]$State.minimumServerVersion }
  $maximumServerVersion = if ([string]::IsNullOrWhiteSpace([string]$State.maximumServerVersion)) { $null } else { [string]$State.maximumServerVersion }
  $graceEndsAt = if ([string]::IsNullOrWhiteSpace([string]$State.graceEndsAt)) { $null } else { [string]$State.graceEndsAt }
  $artifacts = @()
  foreach ($record in @($State.artifacts)) {
    foreach ($name in @("platform", "architecture", "format", "objectKey", "signaturePath", "sha256", "size", "checksumObjectKey", "checksumSha256", "sbomObjectKey", "sbomSha256", "provenanceObjectKey", "provenanceSha256")) {
      if ($null -eq $record.$name -or [string]$record.$name -eq "") {
        throw "Draft artifact metadata is incomplete: $name."
      }
    }
    $artifacts += [ordered]@{
      platform = $record.platform
      architecture = $record.architecture
      format = $record.format
      objectKey = $record.objectKey
      signature = (Get-Content -Raw -LiteralPath $record.signaturePath).Trim()
      sha256 = $record.sha256
      size = [int64]$record.size
      checksumObjectKey = $record.checksumObjectKey
      checksumSha256 = $record.checksumSha256
      sbomObjectKey = $record.sbomObjectKey
      sbomSha256 = $record.sbomSha256
      provenanceObjectKey = $record.provenanceObjectKey
      provenanceSha256 = $record.provenanceSha256
    }
  }
  if ($artifacts.Count -ne 2) {
    throw "A complete Raven draft requires Windows and Linux artifacts."
  }
  [ordered]@{
    version = $State.version
    channel = $State.channel
    classification = $State.classification
    notes = $State.notes
    gitCommit = $State.commit
    clientProtocolVersion = [int]$State.clientProtocolVersion
    minimumServerVersion = $minimumServerVersion
    maximumServerVersion = $maximumServerVersion
    requiredCapabilities = @($State.requiredCapabilities)
    graceEndsAt = $graceEndsAt
    localDataSchemaVersion = [int]$State.localDataSchemaVersion
    localMigrationReversible = [bool]$State.localMigrationReversible
    rollbackSafe = [bool]$State.rollbackSafe
    artifacts = $artifacts
  }
}

function Assert-RavenRecoveredDraft {
  param([object]$Release, [object]$Request)
  if (-not $Release.id -or $Release.state -ne "draft" -or $Release.version -ne $Request.version -or $Release.channel -ne $Request.channel -or $Release.gitCommit -ne $Request.gitCommit) {
    throw "The existing release is not the expected inactive draft."
  }
  foreach ($field in @("classification", "notes", "clientProtocolVersion", "minimumServerVersion", "maximumServerVersion", "graceEndsAt", "localDataSchemaVersion", "localMigrationReversible", "rollbackSafe")) {
    $releaseProperty = $Release.PSObject.Properties[$field]
    $releaseValue = if ($null -eq $releaseProperty) { $null } else { $releaseProperty.Value }
    $requestValue = if ($Request -is [System.Collections.IDictionary]) {
      if ($Request.Contains($field)) { $Request[$field] } else { $null }
    }
    else {
      $requestProperty = $Request.PSObject.Properties[$field]
      if ($null -eq $requestProperty) { $null } else { $requestProperty.Value }
    }
    if ([string]$releaseValue -cne [string]$requestValue) {
      throw "The existing draft has different release metadata: $field."
    }
  }
  $releasedCapabilities = @($Release.requiredCapabilities | ForEach-Object { [string]$_ } | Sort-Object -Unique)
  $requestedCapabilities = @($Request.requiredCapabilities | ForEach-Object { [string]$_ } | Sort-Object -Unique)
  if (($releasedCapabilities -join "`n") -cne ($requestedCapabilities -join "`n")) {
    throw "The existing draft has different release metadata."
  }
  if (@($Release.artifacts).Count -ne @($Request.artifacts).Count) {
    throw "The existing draft has different artifact metadata."
  }
  $fields = @("format", "objectKey", "signature", "sha256", "size", "checksumObjectKey", "checksumSha256", "sbomObjectKey", "sbomSha256", "provenanceObjectKey", "provenanceSha256")
  foreach ($requested in @($Request.artifacts)) {
    $matches = @($Release.artifacts | Where-Object { $_.platform -eq $requested.platform -and $_.architecture -eq $requested.architecture })
    if ($matches.Count -ne 1) {
      throw "The existing draft does not contain the expected target artifact."
    }
    foreach ($field in $fields) {
      if ([string]$matches[0].$field -cne [string]$requested.$field) {
        throw "The existing draft has different artifact metadata."
      }
    }
  }
}

function Invoke-RavenRegisterDraft {
  param([string]$Version, [string]$Channel, [string]$AccountSessionFile, [string]$OpsSessionFile, [string]$OpsPasswordFile)
  $context = Get-RavenState -Version $Version -Channel $Channel
  $state = $context.State
  Assert-RavenPinnedState -State $state
  if (-not $state.uploaded) {
    throw "All release objects must upload and verify before draft registration."
  }
  if ($state.registered) {
    throw "Release draft is already registered."
  }
  $body = New-RavenDraftRequest -State $state
  $opsOverride = $null
  if (-not $env:RAVEN_OPS_SESSION -and (-not $OpsSessionFile -or -not (Test-Path -LiteralPath $OpsSessionFile -PathType Leaf))) {
    $opsOverride = New-RavenOpsSession -AccountSessionFile $AccountSessionFile -OpsPasswordFile $OpsPasswordFile
  }
  try {
    $idempotencyKey = "raven-release-$($state.channel)-$($state.version)-$($state.commit)"
    try {
      $response = Invoke-RavenOpsRequest -Method Post -Path "/v1/ops/releases" -Body $body -AccountSessionFile $AccountSessionFile -OpsSessionFile $OpsSessionFile -OpsSessionOverride $opsOverride -IdempotencyKey $idempotencyKey
      $release = $response.release
    }
    catch {
      if ($_.Exception.Message -notmatch 'status 409') {
        throw
      }
      $existing = Invoke-RavenOpsRequest -Method Get -Path "/v1/ops/releases" -Body $null -AccountSessionFile $AccountSessionFile -OpsSessionFile $OpsSessionFile -OpsSessionOverride $opsOverride -IdempotencyKey $idempotencyKey
      $candidates = @($existing.releases | Where-Object { $_.version -eq $body.version -and $_.channel -eq $body.channel -and $_.gitCommit -eq $body.gitCommit })
      if ($candidates.Count -ne 1) {
        throw "Release registration conflicted and the expected draft could not be recovered."
      }
      $release = $candidates[0]
    }
    Assert-RavenRecoveredDraft -Release $release -Request $body
  }
  finally {
    $opsOverride = $null
  }
  $state.registered = $true
  $state.releaseId = $release.id
  $state.phase = "draft_registered"
  Save-RavenState -State $state -StagePath $context.Stage
  Write-Output "Registered inactive Raven release draft $($release.id)."
  Write-Output "Operations: https://ops.rvn.bluehour.cloud/releases/$($release.id)"
}

function Invoke-RavenInspectRelease {
  param([string]$Version, [string]$Channel, [string]$ReleaseId, [string]$AccountSessionFile, [string]$OpsSessionFile)
  if (-not $ReleaseId -and $Version) {
    $context = Get-RavenState -Version $Version -Channel $Channel
    $ReleaseId = $context.State.releaseId
    if (-not $ReleaseId) {
      $context.State | ConvertTo-Json -Depth 20
      return
    }
  }
  $path = if ($ReleaseId) { "/v1/ops/releases/$ReleaseId" } else { "/v1/ops/releases" }
  $response = Invoke-RavenOpsRequest -Method Get -Path $path -Body $null -AccountSessionFile $AccountSessionFile -OpsSessionFile $OpsSessionFile
  $response | ConvertTo-Json -Depth 20
}

function Remove-RavenReleaseStage {
  param([string]$Version, [string]$Channel, [bool]$Force)
  $context = Get-RavenState -Version $Version -Channel $Channel
  if (($context.State.uploaded -or $context.State.registered) -and -not $Force) {
    throw "This release reached remote state. Use -Force to clean only its local staging data. Remote immutable objects and drafts will remain."
  }
  $stageRoot = Join-Path (Get-RavenRepoRoot) ".release\staging"
  Remove-RavenSafeDirectory -Path $context.Stage -AllowedParent $stageRoot
}

function Invoke-RavenReleaseToolTests {
  $root = Get-RavenRepoRoot
  Invoke-RavenNative -FilePath "powershell" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $root "tools\release\tests\Raven.Release.Tests.ps1")) -WorkingDirectory $root
  Invoke-RavenNative -FilePath "go" -Arguments @("test", "./...") -WorkingDirectory (Join-Path $root "tools\release\s3cmd")
  Invoke-RavenNative -FilePath "cargo" -Arguments @("test", "--locked", "--manifest-path", (Join-Path $root "tools\release\signature-verify\Cargo.toml")) -WorkingDirectory $root
}

function Invoke-RavenRelease {
  param(
    [string]$Command,
    [string]$Version,
    [string]$Channel,
    [string]$Classification,
    [string]$NotesFile,
    [int]$ClientProtocolVersion,
    [string]$MinimumServerVersion,
    [string]$MaximumServerVersion,
    [string[]]$RequiredCapabilities,
    [string]$GraceEndsAt,
    [int]$LocalDataSchemaVersion,
    [bool]$LocalMigrationReversible,
    [bool]$RollbackSafe,
    [string]$SshTarget,
    [string]$S3EnvFile,
    [string]$AccountSessionFile,
    [string]$OpsSessionFile,
    [string]$OpsPasswordFile,
    [string]$ReleaseId,
    [bool]$Force
  )
  $prepare = @{
    Version = $Version
    Channel = $Channel
    Classification = $Classification
    NotesFile = $NotesFile
    ClientProtocolVersion = $ClientProtocolVersion
    MinimumServerVersion = $MinimumServerVersion
    MaximumServerVersion = $MaximumServerVersion
    RequiredCapabilities = $RequiredCapabilities
    GraceEndsAt = $GraceEndsAt
    LocalDataSchemaVersion = $LocalDataSchemaVersion
    LocalMigrationReversible = $LocalMigrationReversible
    RollbackSafe = $RollbackSafe
  }
  switch ($Command.ToLowerInvariant()) {
    "help" {
      Write-Output "Raven release commands: prepare, test, test-release, build-windows, build-linux, build-all, validate, upload, register-draft, inspect, clean, release"
      Write-Output "A full release ends as an inactive draft and never activates rollout."
    }
    "prepare" { New-RavenReleaseStage @prepare }
    "test" { Invoke-RavenReleaseToolTests }
    "test-release" { Invoke-RavenReleaseTests -Version $Version -Channel $Channel }
    "build-windows" { Invoke-RavenWindowsBuild -Version $Version -Channel $Channel }
    "build-linux" { Invoke-RavenLinuxBuild -Version $Version -Channel $Channel -SshTarget $SshTarget }
    "build-all" {
      $context = Get-RavenState -Version $Version -Channel $Channel
      if (-not $context.State.testsCompleted) { Invoke-RavenReleaseTests -Version $Version -Channel $Channel }
      Invoke-RavenWindowsBuild -Version $Version -Channel $Channel
      Invoke-RavenLinuxBuild -Version $Version -Channel $Channel -SshTarget $SshTarget
      Invoke-RavenValidateRelease -Version $Version -Channel $Channel
    }
    "validate" { Invoke-RavenValidateRelease -Version $Version -Channel $Channel }
    "upload" { Invoke-RavenUploadRelease -Version $Version -Channel $Channel -S3EnvFile $S3EnvFile }
    "register-draft" { Invoke-RavenRegisterDraft -Version $Version -Channel $Channel -AccountSessionFile $AccountSessionFile -OpsSessionFile $OpsSessionFile -OpsPasswordFile $OpsPasswordFile }
    "inspect" { Invoke-RavenInspectRelease -Version $Version -Channel $Channel -ReleaseId $ReleaseId -AccountSessionFile $AccountSessionFile -OpsSessionFile $OpsSessionFile }
    "clean" { Remove-RavenReleaseStage -Version $Version -Channel $Channel -Force $Force }
    "release" {
      New-RavenReleaseStage @prepare
      Invoke-RavenReleaseTests -Version $Version -Channel $Channel
      Invoke-RavenWindowsBuild -Version $Version -Channel $Channel
      Invoke-RavenLinuxBuild -Version $Version -Channel $Channel -SshTarget $SshTarget
      Invoke-RavenValidateRelease -Version $Version -Channel $Channel
      Invoke-RavenUploadRelease -Version $Version -Channel $Channel -S3EnvFile $S3EnvFile
      Invoke-RavenRegisterDraft -Version $Version -Channel $Channel -AccountSessionFile $AccountSessionFile -OpsSessionFile $OpsSessionFile -OpsPasswordFile $OpsPasswordFile
    }
    default { throw "Unknown release command. Use help, prepare, test, test-release, build-windows, build-linux, build-all, validate, upload, register-draft, inspect, clean, or release." }
  }
}

Export-ModuleMember -Function Invoke-RavenRelease, Test-RavenSemanticVersion, Assert-RavenReleaseIdentity, Get-RavenStagePath, Unprotect-RavenDpapiSecret, Get-RavenFileHash, Invoke-RavenSignArtifact, Invoke-RavenVerifySignature, New-RavenDraftRequest, Assert-RavenRecoveredDraft
