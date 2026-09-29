[CmdletBinding()]
param(
  [string]$Server = 'https://remcp.site',
  [string]$Code = '',
  [switch]$TrustRuntime,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

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

function Test-ReMCPRuntime {
  $node = Join-Path $runtimeDir 'node.exe'
  $npm = Join-Path $runtimeDir 'npm.cmd'
  if (!(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $npm -PathType Leaf)) {
    return $false
  }
  try {
    $version = (& $node -p "process.versions.node" 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^(\d+)\.(\d+)\.(\d+)$') { return $false }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    return ($major -gt 22) -or ($major -eq 22 -and $minor -ge 5)
  } catch {
    return $false
  }
}

function Install-ReMCPRuntime {
  $arch = Get-ReMCPArchitecture
  $manifestUrl = 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt'
  Write-Host 'Preparing the private ReMCP runtime...'
  $manifest = (Invoke-WebRequest -UseBasicParsing -Uri $manifestUrl).Content
  $escapedArch = [Regex]::Escape($arch)
  $pattern = '(?m)^([a-fA-F0-9]{64})\s+(node-v([0-9]+\.[0-9]+\.[0-9]+)-win-' + $escapedArch + '\.zip)$'
  $match = [Regex]::Match($manifest, $pattern)
  if (!$match.Success) {
    throw "No matching Windows runtime archive was found for $arch."
  }

  $sha256 = $match.Groups[1].Value.ToLowerInvariant()
  $archiveName = $match.Groups[2].Value
  $version = $match.Groups[3].Value
  $downloadUrl = "https://nodejs.org/dist/v$version/$archiveName"
  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("remcp-install-" + [Guid]::NewGuid().ToString('N'))
  $archive = Join-Path $tempRoot $archiveName
  $expanded = Join-Path $tempRoot 'expanded'
  $staged = "$runtimeDir.new"
  $backup = "$runtimeDir.old"

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

    if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $staged | Out-Null
    Copy-Item -Path (Join-Path $source.FullName '*') -Destination $staged -Recurse -Force

    try { schtasks.exe /End /TN 'ReMCP Agent' 2>$null | Out-Null } catch {}
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
    if (Test-Path -LiteralPath $runtimeDir) { Move-Item -LiteralPath $runtimeDir -Destination $backup -Force }
    try {
      # Keep the previous runtime until npm has installed and verified the ReMCP command below.
      # A registry outage must not turn an already connected machine into a broken installation.
      Move-Item -LiteralPath $staged -Destination $runtimeDir -Force
    } catch {
      if (Test-Path -LiteralPath $runtimeDir) { Remove-Item -LiteralPath $runtimeDir -Recurse -Force }
      if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $runtimeDir -Force }
      throw
    }
  } finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue
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
    $next = (($entries + $binDir) -join ';')
    [Environment]::SetEnvironmentVariable('Path', $next, 'User')
  }
}

if ($ValidateOnly) {
  Write-Output ("ReMCP Windows installer validation OK ({0})." -f (Get-ReMCPArchitecture))
  exit 0
}

New-Item -ItemType Directory -Force -Path $root | Out-Null
if (!(Test-ReMCPRuntime)) {
  Install-ReMCPRuntime
}

$env:NPM_CONFIG_PREFIX = $runtimeDir
$env:Path = "$runtimeDir;$env:Path"
$npm = Join-Path $runtimeDir 'npm.cmd'

$backup = "$runtimeDir.old"
$cli = Join-Path $runtimeDir 'remcp.cmd'
try {
  Write-Host 'Installing ReMCP...'
  & $npm install --global '@remcp/remcp@latest' --no-audit --no-fund --ignore-scripts --loglevel=error
  if ($LASTEXITCODE -ne 0) {
    throw "ReMCP installation failed with exit code $LASTEXITCODE."
  }
  if (!(Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw 'ReMCP command was not created by the package installation.'
  }
} catch {
  if (Test-Path -LiteralPath $backup) {
    Remove-Item -LiteralPath $runtimeDir -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $backup -Destination $runtimeDir -Force
    try { schtasks.exe /Run /TN 'ReMCP Agent' 2>$null | Out-Null } catch {}
  }
  throw
}
if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }

Write-ReMCPWrapper
$env:Path = "$binDir;$runtimeDir;$env:Path"

$arguments = @('connect')
if (![string]::IsNullOrWhiteSpace($Server) -and $Server.TrimEnd('/') -ne 'https://remcp.site') {
  $arguments += @('--server', $Server.TrimEnd('/'))
}
if (![string]::IsNullOrWhiteSpace($Code)) {
  $arguments += @('--code', ($Code -replace '\s+', '').ToUpperInvariant(), '--install')
}
if ($TrustRuntime) { $arguments += '--trust-runtime' }

Write-Host 'Starting ReMCP pairing...'
& $cli @arguments
if ($LASTEXITCODE -ne 0) {
  throw "ReMCP pairing failed with exit code $LASTEXITCODE."
}
