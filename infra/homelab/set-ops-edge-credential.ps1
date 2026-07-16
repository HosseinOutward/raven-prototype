param(
  [ValidateSet("Ensure", "Rotate", "CopyPassword", "Status")]
  [string]$Action = "Ensure",
  [string]$SshTarget = "soroush@homelab",
  [string]$SecretPath = (Join-Path $env:USERPROFILE ".raven\ops-edge\raven-ops.password.dpapi")
)

$ErrorActionPreference = "Stop"
$remotePath = "/home/soroush/services/raven/config/nginx/.ops.htpasswd"
$image = "httpd:2.4-alpine@sha256:1b766f17b84026429b7cb243317b142921b24432336e798bc881c43f45ed9567"

function Protect-Password {
  param([string]$Value)
  $secure = ConvertTo-SecureString -String $Value -AsPlainText -Force
  $secure | ConvertFrom-SecureString
}

function Unprotect-Password {
  if (-not (Test-Path -LiteralPath $SecretPath -PathType Leaf)) {
    throw "The local operations edge password does not exist."
  }
  $secure = ConvertTo-SecureString -String ((Get-Content -Raw -LiteralPath $SecretPath).Trim())
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function New-Password {
  $bytes = New-Object byte[] 48
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $random.GetBytes($bytes)
  }
  finally {
    $random.Dispose()
  }
  [Convert]::ToBase64String($bytes)
}

function Save-Password {
  param([string]$Value)
  $directory = Split-Path -Parent $SecretPath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $blob = Protect-Password -Value $Value
  [IO.File]::WriteAllText($SecretPath, $blob, (New-Object Text.UTF8Encoding($false)))
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $directory /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not restrict the local operations secret directory."
  }
}

function Write-RemoteHash {
  param([string]$Value)
  $command = "set -eu; umask 077; mkdir -p /home/soroush/services/raven/config/nginx; tmp='$remotePath.tmp'; docker run --rm -i '$image' htpasswd -nis raven-ops > `$tmp; test -s `$tmp; chmod 600 `$tmp; mv `$tmp '$remotePath'; if test -f /opt/nginx/conf.d/raven/raven.conf; then install -m 600 '$remotePath' /opt/nginx/conf.d/raven/.ops.htpasswd; setfacl -m u:101:r-- /opt/nginx/conf.d/raven/.ops.htpasswd; docker exec edge-nginx nginx -t; docker exec edge-nginx nginx -s reload; fi; stat -c 'remote_htpasswd_mode=%a remote_htpasswd_bytes=%s' '$remotePath'"
  $inputPath = Join-Path $env:TEMP ("raven-ops-" + [guid]::NewGuid().ToString("N") + ".stdin")
  try {
    [IO.File]::WriteAllText($inputPath, $Value + "`n", (New-Object Text.UTF8Encoding($false)))
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $inputPath /inheritance:r /grant:r "${identity}:F" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Could not restrict the operations credential transport file."
    }
    $arguments = "-o BatchMode=yes $SshTarget `"$command`""
    $process = Start-Process -FilePath "ssh" -ArgumentList $arguments -NoNewWindow -Wait -PassThru -RedirectStandardInput $inputPath
    if ($process.ExitCode -ne 0) {
      throw "Could not install the Raven operations edge credential."
    }
  }
  finally {
    if (Test-Path -LiteralPath $inputPath) {
      Remove-Item -LiteralPath $inputPath -Force
    }
  }
}

switch ($Action) {
  "Ensure" {
    if (Test-Path -LiteralPath $SecretPath -PathType Leaf) {
      $password = Unprotect-Password
    } else {
      $password = New-Password
      Save-Password -Value $password
    }
    try {
      Write-RemoteHash -Value $password
    }
    finally {
      $password = $null
    }
  }
  "Rotate" {
    $password = New-Password
    try {
      Save-Password -Value $password
      Write-RemoteHash -Value $password
    }
    finally {
      $password = $null
    }
  }
  "CopyPassword" {
    $password = Unprotect-Password
    try {
      Set-Clipboard -Value $password
      Write-Output "The Raven operations edge password was copied to the clipboard."
    }
    finally {
      $password = $null
    }
  }
  "Status" {
    $local = Test-Path -LiteralPath $SecretPath -PathType Leaf
    Write-Output "local_dpapi_password=$local"
    & ssh -o BatchMode=yes $SshTarget "if test -f '$remotePath'; then stat -c 'remote_htpasswd=true mode=%a bytes=%s' '$remotePath'; else echo 'remote_htpasswd=false'; fi"
    if ($LASTEXITCODE -ne 0) {
      throw "Could not inspect the remote credential."
    }
  }
}
