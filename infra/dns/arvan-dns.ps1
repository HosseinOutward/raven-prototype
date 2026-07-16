param(
  [ValidateSet("Inspect", "Snapshot", "Apply", "Restore")]
  [string]$Action = "Inspect",
  [string]$SnapshotPath,
  [string]$SecretPath
)

$ErrorActionPreference = "Stop"
$zone = "bluehour.cloud"
$origin = "84.241.5.42"
$recordNames = @("updates.rvn", "downloads.rvn", "ops.rvn")
$apiBase = "https://napi.arvancloud.ir/cdn/4.0/domains/$zone"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")

if (-not $SecretPath) {
  $SecretPath = Join-Path $repoRoot "arvan.secret"
}
if (-not (Test-Path -LiteralPath $SecretPath -PathType Leaf)) {
  throw "Arvan API secret file is missing."
}

$token = (Get-Content -Raw -LiteralPath $SecretPath).Trim()
if (-not $token) {
  throw "Arvan API secret file is empty."
}
if ($token -notmatch "^(?i:Apikey)\s+") {
  $token = "Apikey $token"
}
$headers = @{ Authorization = $token; Accept = "application/json" }

function Invoke-Arvan {
  param(
    [string]$Method,
    [string]$Path,
    [object]$Body
  )
  $parameters = @{
    Method = $Method
    Uri = "$apiBase$Path"
    Headers = $headers
    TimeoutSec = 30
  }
  if ($null -ne $Body) {
    $parameters.ContentType = "application/json"
    $parameters.Body = $Body | ConvertTo-Json -Depth 10 -Compress
  }
  try {
    Invoke-RestMethod @parameters
  }
  catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    throw "Arvan API request failed with status $status."
  }
}

function Get-Records {
  $all = @()
  foreach ($name in $recordNames) {
    $escaped = [Uri]::EscapeDataString($name)
    $response = Invoke-Arvan -Method Get -Path "/dns-records?search=$escaped&per_page=100" -Body $null
    $all += @($response.data | Where-Object { $_.name -eq $name })
  }
  $all
}

function Get-RecordIp {
  param([object]$Record)
  $values = @($Record.value)
  if ($values.Count -eq 0) {
    return ""
  }
  [string]$values[0].ip
}

function New-RecordPayload {
  param([string]$Name)
  [ordered]@{
    type = "a"
    name = $Name
    value = @(
      [ordered]@{
        ip = $origin
        port = $null
        weight = 100
        country = ""
      }
    )
    ttl = 120
    cloud = $true
    upstream_https = "http"
    ip_filter_mode = [ordered]@{
      count = "single"
      order = "none"
      geo_filter = "none"
    }
  }
}

function Get-Ssl {
  (Invoke-Arvan -Method Get -Path "/ssl" -Body $null).data
}

function New-Snapshot {
  $records = @(Get-Records)
  foreach ($name in $recordNames) {
    if (@($records | Where-Object { $_.name -eq $name }).Count -gt 1) {
      throw "Duplicate Raven DNS records exist for $name."
    }
  }
  $ssl = Get-Ssl
  [ordered]@{
    schemaVersion = 1
    zone = $zone
    capturedAt = [DateTime]::UtcNow.ToString("o")
    recordNames = $recordNames
    records = @($records | ForEach-Object {
      [ordered]@{
        id = $_.id
        type = $_.type
        name = $_.name
        value = $_.value
        ttl = $_.ttl
        cloud = $_.cloud
        upstream_https = $_.upstream_https
        ip_filter_mode = $_.ip_filter_mode
      }
    })
    ssl = [ordered]@{
      ssl_status = [bool]$ssl.ssl_status
      certificate_mode = $ssl.certificate_mode
      certificate_key_type = $ssl.certificate_key_type
      https_redirect = [bool]$ssl.https_redirect
      hsts_status = [bool]$ssl.hsts_status
      replace_http = [bool]$ssl.replace_http
    }
  }
}

function Save-Snapshot {
  param([object]$Snapshot, [string]$Path)
  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $Snapshot | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Assert-ManagedCertificate {
  param([object]$Ssl)
  $covered = $false
  foreach ($certificate in @($Ssl.certificates)) {
    if (-not $certificate.active) {
      continue
    }
    if (@($certificate.domain_names) -contains "*.rvn.bluehour.cloud") {
      $covered = $true
    }
  }
  if (-not $covered) {
    throw "No active Arvan-managed certificate covers *.rvn.bluehour.cloud."
  }
}

function Show-State {
  $records = @(Get-Records)
  $ssl = Get-Ssl
  $items = @()
  foreach ($name in $recordNames) {
    $matches = @($records | Where-Object { $_.name -eq $name })
    if ($matches.Count -eq 0) {
      $items += [ordered]@{ name = $name; present = $false; type = $null; origin = $null; proxied = $null; ttl = $null }
      continue
    }
    foreach ($record in $matches) {
      $items += [ordered]@{
        name = $record.name
        present = $true
        type = $record.type
        origin = Get-RecordIp -Record $record
        proxied = [bool]$record.cloud
        ttl = $record.ttl
      }
    }
  }
  [ordered]@{
    zone = $zone
    records = $items
    edgeTls = [ordered]@{
      enabled = [bool]$ssl.ssl_status
      certificateMode = $ssl.certificate_mode
      httpsRedirect = [bool]$ssl.https_redirect
      hsts = [bool]$ssl.hsts_status
      replaceHttp = [bool]$ssl.replace_http
    }
  } | ConvertTo-Json -Depth 8
}

try {
  switch ($Action) {
    "Inspect" {
      Show-State
    }
    "Snapshot" {
      if (-not $SnapshotPath) {
        throw "SnapshotPath is required for Snapshot."
      }
      $snapshot = New-Snapshot
      Save-Snapshot -Snapshot $snapshot -Path $SnapshotPath
      [ordered]@{ saved = $true; path = (Resolve-Path -LiteralPath $SnapshotPath).Path } | ConvertTo-Json
    }
    "Apply" {
      $ssl = Get-Ssl
      Assert-ManagedCertificate -Ssl $ssl
      if (-not $SnapshotPath) {
        $stamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
        $SnapshotPath = Join-Path $repoRoot ".release\dns-snapshots\$stamp-before.json"
      }
      Save-Snapshot -Snapshot (New-Snapshot) -Path $SnapshotPath
      $records = @(Get-Records)
      foreach ($name in $recordNames) {
        $matches = @($records | Where-Object { $_.name -eq $name })
        if ($matches.Count -gt 1) {
          throw "Duplicate Raven DNS records exist for $name."
        }
        $payload = New-RecordPayload -Name $name
        if ($matches.Count -eq 0) {
          Invoke-Arvan -Method Post -Path "/dns-records" -Body $payload | Out-Null
          continue
        }
        $record = $matches[0]
        if ($record.type -ne "a") {
          throw "Existing record $name is not an A record."
        }
        $needsUpdate = (Get-RecordIp -Record $record) -ne $origin -or -not [bool]$record.cloud -or [int]$record.ttl -ne 120 -or $record.upstream_https -ne "http"
        if ($needsUpdate) {
          Invoke-Arvan -Method Put -Path "/dns-records/$($record.id)" -Body $payload | Out-Null
        }
      }
      if (-not [bool]$ssl.ssl_status) {
        Invoke-Arvan -Method Patch -Path "/ssl" -Body ([ordered]@{ ssl_status = $true }) | Out-Null
      }
      Show-State
    }
    "Restore" {
      if (-not $SnapshotPath -or -not (Test-Path -LiteralPath $SnapshotPath -PathType Leaf)) {
        throw "A valid SnapshotPath is required for Restore."
      }
      $snapshot = Get-Content -Raw -LiteralPath $SnapshotPath | ConvertFrom-Json
      if ($snapshot.schemaVersion -ne 1 -or $snapshot.zone -ne $zone -or (Compare-Object @($snapshot.recordNames) $recordNames)) {
        throw "Snapshot does not match the Raven DNS boundary."
      }
      $current = @(Get-Records)
      foreach ($name in $recordNames) {
        $before = @($snapshot.records | Where-Object { $_.name -eq $name })
        $now = @($current | Where-Object { $_.name -eq $name })
        if ($before.Count -gt 1 -or $now.Count -gt 1) {
          throw "Restore refuses duplicate records for $name."
        }
        if ($before.Count -eq 0 -and $now.Count -eq 1) {
          Invoke-Arvan -Method Delete -Path "/dns-records/$($now[0].id)" -Body $null | Out-Null
          continue
        }
        if ($before.Count -eq 1) {
          $body = [ordered]@{
            type = $before[0].type
            name = $before[0].name
            value = @($before[0].value)
            ttl = $before[0].ttl
            cloud = [bool]$before[0].cloud
            upstream_https = $before[0].upstream_https
            ip_filter_mode = $before[0].ip_filter_mode
          }
          if ($now.Count -eq 0) {
            Invoke-Arvan -Method Post -Path "/dns-records" -Body $body | Out-Null
          } else {
            Invoke-Arvan -Method Put -Path "/dns-records/$($now[0].id)" -Body $body | Out-Null
          }
        }
      }
      Show-State
    }
  }
}
finally {
  $token = $null
  $headers = $null
}
