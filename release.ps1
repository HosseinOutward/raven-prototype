param(
  [Parameter(Position = 0)]
  [string]$Command = "help",
  [string]$Version,
  [ValidateSet("alpha", "stable")]
  [string]$Channel = "alpha",
  [ValidateSet("optional", "recommended", "required")]
  [string]$Classification = "optional",
  [string]$NotesFile,
  [int]$ClientProtocolVersion = 1,
  [string]$MinimumServerVersion,
  [string]$MaximumServerVersion,
  [string[]]$RequiredCapabilities = @(),
  [string]$GraceEndsAt,
  [int]$LocalDataSchemaVersion = 1,
  [switch]$LocalMigrationReversible,
  [switch]$RollbackSafe,
  [string]$SshTarget = "soroush@homelab",
  [string]$S3EnvFile,
  [string]$AccountSessionFile,
  [string]$OpsSessionFile,
  [string]$OpsPasswordFile,
  [string]$ReleaseId,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$module = Join-Path $PSScriptRoot "tools\release\Raven.Release.psm1"
Import-Module $module -Force

$parameters = @{
  Command = $Command
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
  LocalMigrationReversible = $LocalMigrationReversible.IsPresent
  RollbackSafe = $RollbackSafe.IsPresent
  SshTarget = $SshTarget
  S3EnvFile = $S3EnvFile
  AccountSessionFile = $AccountSessionFile
  OpsSessionFile = $OpsSessionFile
  OpsPasswordFile = $OpsPasswordFile
  ReleaseId = $ReleaseId
  Force = $Force.IsPresent
}

Invoke-RavenRelease @parameters
