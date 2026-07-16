$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
Import-Module (Join-Path $root "tools\release\Raven.Release.psm1") -Force
$count = 0

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) {
    throw $Message
  }
  $script:count++
}

function Assert-Throws {
  param([scriptblock]$Action, [string]$Message)
  $threw = $false
  try {
    & $Action
  }
  catch {
    $threw = $true
  }
  Assert-True -Condition $threw -Message $Message
}

foreach ($version in @("0.1.0", "1.0.0-alpha.1", "12.4.9+build.7")) {
  Assert-True -Condition (Test-RavenSemanticVersion $version) -Message "Valid semantic version was rejected."
}
foreach ($version in @("v1.0.0", "01.0.0", "1.0", "1.0.0-")) {
  Assert-True -Condition (-not (Test-RavenSemanticVersion $version)) -Message "Invalid semantic version was accepted."
}
Assert-Throws -Action { Assert-RavenReleaseIdentity -Version "1.0.0-alpha.1" -Channel "stable" -Classification "optional" } -Message "Stable prerelease was accepted."

$nginx = Get-Content -Raw -LiteralPath (Join-Path $root "infra\homelab\nginx\raven.conf")
Assert-True -Condition ($nginx -match '(?s)server_name ops\.rvn\.bluehour\.cloud;.*auth_basic "Raven operations";.*auth_basic_user_file') -Message "Operations UI and API are not behind Basic Auth."
Assert-True -Condition ($nginx -match '(?s)server_name downloads\.rvn\.bluehour\.cloud;.*location \^~ /v1/updates/artifacts/ \{.*access_log off;.*limit_except GET') -Message "Download grants are not GET-only with access logging disabled."
Assert-True -Condition ($nginx -match '(?s)server_name updates\.rvn\.bluehour\.cloud;.*location \^~ /v1/updates/artifacts/ \{.*return 404;') -Message "Update host exposes tokenized artifact downloads."
$mimir = Get-Content -Raw -LiteralPath (Join-Path $root "infra\homelab\nginx\mimir.conf")
Assert-True -Condition ($mimir -match '(?s)location = /v1/ops/session \{.*return 404;.*location \^~ /v1/ops/ \{.*return 404;') -Message "Normal API can bypass operations infrastructure protection."
$dns = Get-Content -Raw -LiteralPath (Join-Path $root "infra\dns\arvan-dns.ps1")
Assert-True -Condition ($dns -match 'upstream_https = "http"' -and $dns -match 'Invoke-Arvan -Method Put -Path "/dns-records/') -Message "Arvan DNS helper does not pin HTTP origin or use the accepted update method."
$s3 = Get-Content -Raw -LiteralPath (Join-Path $root "tools\release\s3cmd\main.go")
Assert-True -Condition ($s3 -match 'github.com/aws/aws-sdk-go-v2/service/s3' -and $s3 -match 'IfNoneMatch:' -and $s3 -match '\.GetObject\(' -and $s3 -notmatch 'hmac\.New') -Message "S3 helper is not using the official SDK immutable verification flow."

$stage = Get-RavenStagePath -Version "1.2.3" -Channel "alpha"
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $root ".release\staging"))
Assert-True -Condition $stage.StartsWith($expectedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -Message "Stage path escaped the release root."

$temporary = Join-Path $env:TEMP ("raven-release-tests-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $temporary | Out-Null
try {
  $secretPath = Join-Path $temporary "secret.dpapi"
  $secure = ConvertTo-SecureString -String "raven-test-secret" -AsPlainText -Force
  $blob = ConvertFrom-SecureString -SecureString $secure
  [IO.File]::WriteAllText($secretPath, $blob, (New-Object Text.UTF8Encoding($false)))
  Assert-True -Condition ((Unprotect-RavenDpapiSecret $secretPath) -eq "raven-test-secret") -Message "DPAPI secret could not be recovered."

  $hashPath = Join-Path $temporary "hash.txt"
  [IO.File]::WriteAllText($hashPath, "abc", (New-Object Text.UTF8Encoding($false)))
  Assert-True -Condition ((Get-RavenFileHash $hashPath) -eq "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") -Message "SHA-256 result was incorrect."

  $signaturePath = Join-Path $temporary "fixture.sig"
  [IO.File]::WriteAllText($signaturePath, "public-signature", (New-Object Text.UTF8Encoding($false)))
  $fixtureHash = "a" * 64
  $fixtureArtifacts = @()
  foreach ($platform in @("windows", "linux")) {
    $fixtureArtifacts += [pscustomobject]@{
      platform = $platform
      architecture = "x86_64"
      format = if ($platform -eq "windows") { "nsis" } else { "appimage" }
      objectKey = "desktop/alpha/1.2.3/$platform/x86_64/artifact"
      signaturePath = $signaturePath
      sha256 = $fixtureHash
      size = 10
      checksumObjectKey = "desktop/alpha/1.2.3/$platform/x86_64/artifact.sha256"
      checksumSha256 = $fixtureHash
      sbomObjectKey = "desktop/alpha/1.2.3/$platform/x86_64/artifact.cdx.json"
      sbomSha256 = $fixtureHash
      provenanceObjectKey = "desktop/alpha/1.2.3/$platform/x86_64/artifact.provenance.json"
      provenanceSha256 = $fixtureHash
    }
  }
  $fixtureState = [pscustomobject]@{
    version = "1.2.3"
    channel = "alpha"
    classification = "optional"
    notes = "Fixture"
    commit = "b" * 40
    clientProtocolVersion = 1
    minimumServerVersion = $null
    maximumServerVersion = $null
    requiredCapabilities = @()
    graceEndsAt = $null
    localDataSchemaVersion = 2
    localMigrationReversible = $true
    rollbackSafe = $true
    artifacts = $fixtureArtifacts
  }
  $draft = New-RavenDraftRequest -State $fixtureState
  Assert-True -Condition ($draft.artifacts.Count -eq 2) -Message "Draft did not contain both target artifacts."
  Assert-True -Condition ($draft.artifacts[0].checksumObjectKey -and $draft.artifacts[0].checksumSha256) -Message "Draft omitted checksum metadata."
  Assert-True -Condition ($draft.localDataSchemaVersion -eq 2 -and $draft.localMigrationReversible -and $draft.rollbackSafe) -Message "Draft omitted rollback metadata."

  $recovered = $draft | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $recovered | Add-Member -NotePropertyName id -NotePropertyValue "release-fixture"
  $recovered | Add-Member -NotePropertyName state -NotePropertyValue "draft"
  Assert-RavenRecoveredDraft -Release $recovered -Request $draft
  Assert-True -Condition $true -Message "Matching inactive draft was not recoverable."
  $recovered.artifacts[0].sha256 = "c" * 64
  Assert-Throws -Action { Assert-RavenRecoveredDraft -Release $recovered -Request $draft } -Message "Conflicting draft artifact metadata was accepted."

  $artifact = Join-Path $temporary "artifact.bin"
  [IO.File]::WriteAllText($artifact, "raven updater signature test", (New-Object Text.UTF8Encoding($false)))
  Invoke-RavenSignArtifact -Artifact $artifact
  Invoke-RavenVerifySignature -Artifact $artifact -Signature "$artifact.sig"
  Assert-True -Condition (Test-Path -LiteralPath "$artifact.sig" -PathType Leaf) -Message "Updater signature was not created."

  $changed = Join-Path $temporary "changed.bin"
  [IO.File]::WriteAllText($changed, "changed", (New-Object Text.UTF8Encoding($false)))
  Assert-Throws -Action { Invoke-RavenVerifySignature -Artifact $changed -Signature "$artifact.sig" } -Message "Invalid updater signature was accepted."
}
finally {
  if (Test-Path -LiteralPath $temporary) {
    $resolved = [IO.Path]::GetFullPath($temporary)
    $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($resolved.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolved -Recurse -Force
    }
  }
}

Write-Output "Raven release tooling tests passed: $count assertions."
