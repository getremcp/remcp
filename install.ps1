[CmdletBinding()]
param(
  [string]$Server = 'https://remcp.site',
  [string]$Code = '',
  [switch]$TrustRuntime,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$officialOrigin = 'https://remcp.site'

if ($env:OS -ne 'Windows_NT') {
  throw 'This installer is for Windows PowerShell only.'
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {}

$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
if ([string]::IsNullOrWhiteSpace($localAppData)) {
  throw 'Could not resolve LOCALAPPDATA for this Windows account.'
}

$root = Join-Path $localAppData 'ReMCP'
$runtimeDir = Join-Path $root 'runtime'
$binDir = Join-Path $root 'bin'
$wrapper = Join-Path $binDir 'remcp.cmd'
$staged = "$runtimeDir.new"
$backup = "$runtimeDir.old"

function Get-ReMCPArchitecture {
  $value = [string]$env:PROCESSOR_ARCHITEW6432
  if ([string]::IsNullOrWhiteSpace($value)) { $value = [string]$env:PROCESSOR_ARCHITECTURE }
  switch -Regex ($value) {
    '^(AMD64|x86_64)$' { return 'x64' }
    '^(ARM64|AARCH64)$' { return 'arm64' }
    '^(x86|X86)$' { return 'x86' }
    default { throw "Unsupported Windows architecture: $value" }
  }
}

function Get-ReMCPRelease {
  # The bootstrap itself always comes from remcp.site, so bootstrap code is never delegated to a
  # custom relay. The official version endpoint also prevents an npm @latest race during rollout:
  # Windows installs the exact client/runtime pair production currently advertises.
  $versionUrl = "$officialOrigin/api/agent/version"
  $response = Invoke-WebRequest -UseBasicParsing -Uri $versionUrl -Headers @{ 'Cache-Control' = 'no-cache' }
  $release = $response.Content | ConvertFrom-Json
  $version = [string]$release.cliVersion
  $clientSpec = [string]$release.cli
  $runtimeSpec = [string]$release.runtime
  $runtimePackageName = [string]$release.runtimePackageName

  if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw 'ReMCP release metadata contains an invalid client version.'
  }
  if ($clientSpec -ne "@remcp/remcp@$version") {
    throw 'ReMCP release metadata does not contain the expected exact client package.'
  }
  if ($runtimePackageName -ne '@remcp/runtime' -or $runtimeSpec -ne "@remcp/runtime@$version") {
    throw 'ReMCP release metadata does not contain the expected exact first-party runtime package.'
  }
  return $release
}

function Test-ReMCPRelease {
  param(
    [Parameter(Mandatory=$true)][string]$Directory,
    [Parameter(Mandatory=$true)]$Release,
    [switch]$Explain
  )

  $node = Join-Path $Directory 'node.exe'
  $npm = Join-Path $Directory 'npm.cmd'
  $cli = Join-Path $Directory 'remcp.cmd'
  $cliEntry = Join-Path $Directory 'node_modules\@remcp\remcp\bin\remcp.mjs'
  $clientManifest = Join-Path $Directory 'node_modules\@remcp\remcp\package.json'
  $runtimeManifest = Join-Path $Directory 'node_modules\@remcp\runtime\package.json'
  foreach ($file in @($node, $npm, $cli, $cliEntry, $clientManifest, $runtimeManifest)) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) {
      if ($Explain) { Write-Host "ReMCP verification failed: missing $file" }
      return $false
    }
  }

  try {
    $nodeVersion = (& $node -p "process.versions.node" 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
      if ($Explain) { Write-Host "ReMCP verification failed: node version '$nodeVersion' is invalid." }
      return $false
    }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
      if ($Explain) { Write-Host "ReMCP verification failed: node $nodeVersion is too old." }
      return $false
    }

    $client = Get-Content -LiteralPath $clientManifest -Raw | ConvertFrom-Json
    $runtime = Get-Content -LiteralPath $runtimeManifest -Raw | ConvertFrom-Json
    $expectedVersion = [string]$Release.cliVersion
    $clientVersion = [string]$client.version
    $runtimeVersion = [string]$runtime.version
    if ($clientVersion -ne $expectedVersion) {
      if ($Explain) { Write-Host "ReMCP verification failed: client version expected=$expectedVersion actual=$clientVersion." }
      return $false
    }
    if ($runtimeVersion -ne $expectedVersion) {
      if ($Explain) { Write-Host "ReMCP verification failed: runtime version expected=$expectedVersion actual=$runtimeVersion." }
      return $false
    }

    # Windows PowerShell 5.1 can report LASTEXITCODE=-1 for an npm-generated .cmd shim even when
    # the shim successfully prints the version. Verify the actual CLI entry with the private Node
    # executable instead; the public Windows E2E separately executes both remcp.cmd and our wrapper.
    $reported = [string](& $node $cliEntry --version 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $reported.Trim() -ne $expectedVersion) {
      if ($Explain) { Write-Host "ReMCP verification failed: CLI version expected=$expectedVersion actual='$reported' exit=$LASTEXITCODE." }
      return $false
    }
    return $true
  } catch {
    if ($Explain) { Write-Host ("ReMCP verification failed: " + [string]$_.Exception.Message) }
    return $false
  }
}

function Initialize-ReMCPStage {
  param(
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)]$Release
  )

  $arch = Get-ReMCPArchitecture
  $manifestUrl = 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt'
  Write-Host 'Preparing ReMCP...'
  $manifest = (Invoke-WebRequest -UseBasicParsing -Uri $manifestUrl).Content
  $escapedArch = [Regex]::Escape($arch)
  $pattern = '(?m)^([a-fA-F0-9]{64})\s+(node-v([0-9]+\.[0-9]+\.[0-9]+)-win-' + $escapedArch + '\.zip)$'
  $match = [Regex]::Match($manifest, $pattern)
  if (!$match.Success) {
    throw "No matching Windows runtime archive was found for $arch."
  }

  $sha256 = $match.Groups[1].Value.ToLowerInvariant()
  $archiveName = $match.Groups[2].Value
  $nodeVersion = $match.Groups[3].Value
  $downloadUrl = "https://nodejs.org/dist/v$nodeVersion/$archiveName"
  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("remcp-install-" + [Guid]::NewGuid().ToString('N'))
  $archive = Join-Path $tempRoot $archiveName
  $expanded = Join-Path $tempRoot 'expanded'

  Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $tempRoot, $expanded | Out-Null
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archive
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    if ($actual -ne $sha256) {
      throw 'The downloaded ReMCP runtime failed its SHA-256 integrity check.'
    }

    Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
    $source = Get-ChildItem -LiteralPath $expanded -Directory | Select-Object -First 1
    if ($null -eq $source -or !(Test-Path -LiteralPath (Join-Path $source.FullName 'node.exe'))) {
      throw 'The downloaded ReMCP runtime archive has an unexpected layout.'
    }

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-Item -Path (Join-Path $source.FullName '*') -Destination $Destination -Recurse -Force

    $oldPrefix = $env:NPM_CONFIG_PREFIX
    $oldPath = $env:Path
    try {
      $env:NPM_CONFIG_PREFIX = $Destination
      $env:Path = "$Destination;$oldPath"
      $npm = Join-Path $Destination 'npm.cmd'
      $clientSpec = [string]$Release.cli
      $runtimeSpec = [string]$Release.runtime
      & $npm install --global $clientSpec $runtimeSpec --no-audit --no-fund --ignore-scripts --loglevel=error
      if ($LASTEXITCODE -ne 0) {
        throw "ReMCP installation failed with exit code $LASTEXITCODE."
      }
    } finally {
      $env:NPM_CONFIG_PREFIX = $oldPrefix
      $env:Path = $oldPath
    }

    if (!(Test-ReMCPRelease -Directory $Destination -Release $Release -Explain)) {
      throw 'The staged ReMCP release failed verification.'
    }
  } catch {
    Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
    throw
  } finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Write-ReMCPWrapper {
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $escapedRuntime = $runtimeDir.Replace('%', '%%')
  $escapedCli = (Join-Path $runtimeDir 'remcp.cmd').Replace('%', '%%')
  $content = @(
    '@echo off',
    'setlocal DisableDelayedExpansion',
    "set `"NPM_CONFIG_PREFIX=$escapedRuntime`"",
    "set `"PATH=$escapedRuntime;%PATH%`"",
    "call `"$escapedCli`" %*",
    'exit /b %ERRORLEVEL%',
    ''
  ) -join "`r`n"
  [IO.File]::WriteAllText($wrapper, $content, (New-Object Text.UTF8Encoding($false)))

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($userPath -split ';' | Where-Object { ![string]::IsNullOrWhiteSpace($_) })
  if (!($entries | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $binDir) -join ';'), 'User')
  }
}

function Restore-ReMCPBackup {
  if (!(Test-Path -LiteralPath $backup -PathType Container)) { return $false }
  try { schtasks.exe /End /TN 'ReMCP Agent' 2>$null | Out-Null } catch {}
  Remove-Item -LiteralPath $runtimeDir -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $backup -Destination $runtimeDir -Force
  Write-ReMCPWrapper
  try { schtasks.exe /Run /TN 'ReMCP Agent' 2>$null | Out-Null } catch {}
  return $true
}

if ($ValidateOnly) {
  Write-Output ("ReMCP Windows installer validation OK ({0})." -f (Get-ReMCPArchitecture))
  exit 0
}

# If a previous process died between the directory swap and its final cleanup, prefer the active
# runtime when it exists; otherwise restore the rollback copy before attempting another install.
New-Item -ItemType Directory -Force -Path $root | Out-Null
if (!(Test-Path -LiteralPath $runtimeDir -PathType Container) -and (Test-Path -LiteralPath $backup -PathType Container)) {
  Move-Item -LiteralPath $backup -Destination $runtimeDir -Force
}

$release = Get-ReMCPRelease
$swapped = $false
if (!(Test-ReMCPRelease -Directory $runtimeDir -Release $release)) {
  Initialize-ReMCPStage -Destination $staged -Release $release

  # Only stop a running agent after the complete replacement has downloaded, installed and passed
  # verification. The offline window is therefore just two local directory moves.
  try { schtasks.exe /End /TN 'ReMCP Agent' 2>$null | Out-Null } catch {}
  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $runtimeDir -PathType Container) {
    Move-Item -LiteralPath $runtimeDir -Destination $backup -Force
  }

  try {
    Move-Item -LiteralPath $staged -Destination $runtimeDir -Force
    if (!(Test-ReMCPRelease -Directory $runtimeDir -Release $release)) {
      throw 'The promoted ReMCP release failed verification.'
    }
    $swapped = $true
  } catch {
    Restore-ReMCPBackup | Out-Null
    throw
  }
} else {
  # A verified current release makes any leftover rollback directory stale.
  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
}

Write-ReMCPWrapper
$env:NPM_CONFIG_PREFIX = $runtimeDir
$env:Path = "$binDir;$runtimeDir;$env:Path"
$cli = Join-Path $runtimeDir 'remcp.cmd'

$arguments = @('connect')
if (![string]::IsNullOrWhiteSpace($Server) -and $Server.TrimEnd('/') -ne $officialOrigin) {
  $arguments += @('--server', $Server.TrimEnd('/'))
}
if (![string]::IsNullOrWhiteSpace($Code)) {
  $arguments += @('--code', ($Code -replace '\s+', '').ToUpperInvariant(), '--install')
}
if ($TrustRuntime) { $arguments += '--trust-runtime' }

Write-Host 'Starting ReMCP pairing...'
& $cli @arguments
if ($LASTEXITCODE -ne 0) {
  # Keep a fresh first install available for a simple retry. On an upgrade, however, restore the
  # already-working agent if pairing/service setup failed after the atomic swap.
  if ($swapped -and (Test-Path -LiteralPath $backup -PathType Container)) {
    Restore-ReMCPBackup | Out-Null
  }
  throw "ReMCP pairing failed with exit code $LASTEXITCODE."
}

Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ("ReMCP {0} is ready." -f [string]$release.cliVersion)
