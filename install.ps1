[CmdletBinding()]
param(
  [string]$Server = 'https://remcp.site', [string]$Code = '',
  [switch]$TrustRuntime, [switch]$RePair, [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$officialOrigin = 'https://remcp.site'
# Keep the Windows execution engine reproducible for the lifetime of this ReMCP release. An upstream Node point release must never change the bytes installed by an already-reviewed ReMCP release.
$pinnedNodeVersion = '22.23.3'
$pinnedNodeSha256 = @{
  x64 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'; arm64 = '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535'
  x86 = '1e07ac00e61b41b7ecf242de8e38883d237d5ad3fdcad7c16f2dd3a88670e2b6'
}
if ($env:OS -ne 'Windows_NT') { throw 'This installer is for Windows PowerShell only.' }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
if ([string]::IsNullOrWhiteSpace($localAppData)) { throw 'Could not resolve LOCALAPPDATA for this Windows account.' }
# The batch launchers below intentionally use %LOCALAPPDATA% (ASCII-only script text). Normalize this process environment to the OS known-folder path for the initial launch. A future shell gets its own Windows LOCALAPPDATA, independent of display language.
$env:LOCALAPPDATA = $localAppData
$root = Join-Path $localAppData 'ReMCP'
$runtimeDir = Join-Path $root 'runtime'
$binDir = Join-Path $root 'bin'
$wrapper = Join-Path $binDir 'remcp.cmd'
$staged = "$runtimeDir.stage-" + [Guid]::NewGuid().ToString('N')
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
function Invoke-ReMCPVersionRequest {
  param([string]$Uri, [int]$TimeoutMilliseconds)
  $requestTimer = [Diagnostics.Stopwatch]::StartNew()
  $handler = $null; $client = $null
  $cancel = $null; $reply = $null
  try {
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.MaxResponseContentBufferSize = 4096
    $cancel = New-Object System.Threading.CancellationTokenSource
    $client.DefaultRequestHeaders.Add('Cache-Control', 'no-cache')
    $remaining = $TimeoutMilliseconds - $requestTimer.ElapsedMilliseconds
    if ($remaining -lt 1) { throw 'Version request setup exceeded its deadline' }
    $client.Timeout = [TimeSpan]::FromMilliseconds($remaining)
    $cancel.CancelAfter($remaining)
    $request = $client.GetAsync($Uri, $cancel.Token)
    $remaining = $TimeoutMilliseconds - $requestTimer.ElapsedMilliseconds
    if ($remaining -lt 1 -or !$request.Wait([int]$remaining)) { throw 'Version request timed out' }
    $reply = $request.GetAwaiter().GetResult()
# GetAsync buffers at most 4096 bytes before completing, so this is local.
    $content = $reply.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $retry = if ($reply.Headers.RetryAfter) { $reply.Headers.RetryAfter.ToString() } else { '' }
    return [pscustomobject]@{ StatusCode=[int]$reply.StatusCode; Content=$content; RetryAfter=$retry }
  } catch {
    if ($_.Exception -is [System.Management.Automation.PipelineStoppedException]) { throw }
    throw 'ReMCP version request failed or timed out. Try again later.'
  } finally {
    if ($cancel) { $cancel.Cancel() }
    if ($reply) { $reply.Dispose() }
    if ($client) { $client.Dispose() } elseif ($handler) { $handler.Dispose() }
    if ($cancel) { $cancel.Dispose() }
  }
}
function Get-ReMCPRelease {
  param(
    [scriptblock]$Clock,
    [scriptblock]$Sleep = { param($seconds) Start-Sleep -Milliseconds ([int][Math]::Floor($seconds * 1000)) },
    [ValidateRange(1, 600)][int]$MaximumWaitSeconds = 180
  )
# The bootstrap itself always comes from remcp.site, so bootstrap code is never delegated to a custom relay. The official version endpoint also prevents an npm @latest race during rollout: Windows installs the exact client/runtime pair production currently advertises.
  $versionUrl = "$officialOrigin/api/agent/version"
# Only the explicit rollout gate is retryable. Other conflicts, redirects, malformed responses and service failures fail closed without exposing bodies.
  $response = $null
  if (!$Clock) {
    $started = [DateTime]::UtcNow; $timer = [Diagnostics.Stopwatch]::StartNew()
    $Clock = { $started.AddMilliseconds($timer.Elapsed.TotalMilliseconds) }.GetNewClosure()
  }
  $deadline = (& $Clock).AddSeconds($MaximumWaitSeconds)
  while ((& $Clock) -lt $deadline) {
    $remaining = [Math]::Floor(($deadline - (& $Clock)).TotalMilliseconds)
    if ($remaining -lt 1) { break }
    $reply = Invoke-ReMCPVersionRequest -Uri $versionUrl -TimeoutMilliseconds ([int][Math]::Min(15000, $remaining))
    if ((& $Clock) -ge $deadline) { break }
    if ($reply.StatusCode -eq 200) { $response = $reply; break }
    $paused = $false
    if ($reply.StatusCode -eq 409 -and $reply.Content.Length -le 4096) {
      try { $paused = ([string](ConvertFrom-Json -InputObject $reply.Content).error -ceq 'agent_update_paused') } catch {}
    }
    if (!$paused) { throw "ReMCP version discovery failed (HTTP $($reply.StatusCode)). Try again later." }
    $retry = 5
    if ($reply.RetryAfter -match '^\d{1,4}$') { $retry = [int]$reply.RetryAfter }
    $remaining = ($deadline - (& $Clock)).TotalSeconds
    if ($remaining -le 0) { break }
    $delaySeconds = [Math]::Min($remaining, [Math]::Max(1, [Math]::Min(30, $retry)))
    Write-Warning 'ReMCP updates are temporarily paused during deployment; retrying.'
    & $Sleep $delaySeconds
  }
  if ($null -eq $response) { throw 'ReMCP updates are still paused; try again after deployment completes.' }
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
  $node = Join-Path $Directory 'node.exe'; $npm = Join-Path $Directory 'npm.cmd'
  $cli = Join-Path $Directory 'remcp.cmd'; $cliEntry = Join-Path $Directory 'node_modules\@remcp\remcp\bin\remcp.mjs'
  $clientManifest = Join-Path $Directory 'node_modules\@remcp\remcp\package.json'; $runtimeManifest = Join-Path $Directory 'node_modules\@remcp\runtime\package.json'
  $runtimeEntry = Join-Path $Directory 'node_modules\@remcp\runtime\src\index.mjs'
  foreach ($file in @($node, $npm, $cli, $cliEntry, $clientManifest, $runtimeManifest, $runtimeEntry)) {
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
# Windows PowerShell 5.1 can report LASTEXITCODE=-1 for an npm-generated .cmd shim even when the shim successfully prints the version. Verify the actual CLI entry with the private Node executable instead; the public Windows E2E separately executes both remcp.cmd and our wrapper. Do not pipe a native process through Select-Object in Windows PowerShell 5.1: stopping the pipeline after the first object can leave LASTEXITCODE=-1 even when Node completed successfully.
    $reported = [string](& $node $cliEntry --version 2>$null)
    $cliExit = $LASTEXITCODE
    if ($cliExit -ne 0 -or $reported.Trim() -ne $expectedVersion) {
      if ($Explain) { Write-Host "ReMCP verification failed: CLI version expected=$expectedVersion actual='$reported' exit=$cliExit." }
      return $false
    }
    if ($client.remcpWindowsInterop -eq 1) { $verified = [string](& $node $cliEntry doctor --integrity-only 2>$null); if ($LASTEXITCODE -ne 0 -or $verified.Trim() -ne 'verified') { return $false } }
    return $true
  } catch {
    if ($Explain) { Write-Host ("ReMCP verification failed: " + [string]$_.Exception.Message) }
    return $false
  }
}
function Remove-ReMCPNpmPowerShellShadow {
  param([Parameter(Mandatory=$true)][string]$Directory, [switch]$CheckOnly)
  $ps1 = Join-Path $Directory 'remcp.ps1'
  if (!(Test-Path -LiteralPath $ps1)) { return }
  $item = Get-Item -LiteralPath $ps1 -ErrorAction Stop
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw 'ReMCP refuses to remove an unknown PowerShell launcher.'
  }
  $body = [IO.File]::ReadAllText($ps1)
  $normalized = $body.Replace("`r`n", "`n").Trim()
  # npm's shim formatting differs between npm versions (the pwsh header and the
  # two-line node.exe comment are not stable). Accept only a shim that still runs
  # this package's CLI through the adjacent node binary, and refuse anything that
  # downloads or starts other code.
  # A header plus a few expected substrings is not an ownership proof: a user
  # could add an arbitrary command before/after "exit $ret" and lose their
  # customized launcher. Refuse anything beyond the known npm cmd-shim command
  # sequence, while tolerating npm's harmless whitespace/comment variations.
  $expectedStatements = @(
    '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent', '$exe=""', 'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {', '$exe=".exe"',
    '}', '$ret=0', 'if (Test-Path "$basedir/node$exe") {', 'if ($MyInvocation.ExpectingInput) {',
    '$input | & "$basedir/node$exe" "$basedir/node_modules/@remcp/remcp/bin/remcp.mjs" $args', '} else {', '& "$basedir/node$exe" "$basedir/node_modules/@remcp/remcp/bin/remcp.mjs" $args', '}',
    '$ret=$LASTEXITCODE', '} else {', 'if ($MyInvocation.ExpectingInput) {', '$input | & "node$exe" "$basedir/node_modules/@remcp/remcp/bin/remcp.mjs" $args',
    '} else {', '& "node$exe" "$basedir/node_modules/@remcp/remcp/bin/remcp.mjs" $args', '}', '$ret=$LASTEXITCODE',
    '}', 'exit $ret'
  )
  $actualStatements = @($normalized -split "\n" |
    Where-Object { $_.Trim() -and $_.Trim() -notmatch '^#' } |
    ForEach-Object { $_.Trim() -replace '\s+', ' ' })
  # A user-added comment is also a customization. Permit only the two known
  # npm cmd-shim comment families (including their documented wording variants).
  $unknownComments = @($normalized -split "\n" |
    Where-Object {
      $line = $_.Trim()
      $line -match '^#' -and
      $line -notmatch '^#[ \t]*!?[ \t]*/usr/bin/env pwsh$' -and
      $line -notmatch '^#[ \t]*Fix case when both (?:the )?Windows and Linux (?:builds of )?Node are installed in (?:the )?same directory$' -and
      $line -notmatch '^#[ \t]*Fix case when both the Windows and Linux builds of Node$' -and
      $line -notmatch '^#[ \t]*are installed in the same directory$' -and
      $line -notmatch '^#[ \t]*Support pipeline input$'
    })
  $isNpmShim = $body.Length -le 16000 -and
    $normalized -match '\A#[ \t]*!?[ \t]*/usr/bin/env pwsh[ \t]*\n' -and
    $normalized -notmatch '(?i)(invoke-webrequest|invoke-restmethod|invoke-expression|start-process|start-job|downloadstring|bitsadmin|certutil|curl(\.exe)?|wget)' -and
    $unknownComments.Count -eq 0 -and
    $actualStatements.Count -eq $expectedStatements.Count
  if ($isNpmShim) {
    for ($i = 0; $i -lt $expectedStatements.Count; $i++) {
      if ($actualStatements[$i] -cne $expectedStatements[$i]) { $isNpmShim = $false; break }
    }
  }
  if (!$isNpmShim) { throw 'ReMCP refuses to remove a non-npm PowerShell launcher.' }
  if ($CheckOnly) { return }
  if (!(Test-Path -LiteralPath (Join-Path $Directory 'remcp.cmd') -PathType Leaf)) { throw 'ReMCP cannot prefer the cmd launcher: remcp.cmd is missing.' }
# With Restricted execution policy PowerShell resolves remcp.ps1 before remcp.cmd. Remove only npm's generated private-prefix shim; never change ExecutionPolicy.
  Remove-Item -LiteralPath $ps1 -Force -ErrorAction Stop
}
# Do not allocate a console during installation or legacy task cleanup.
function Invoke-ReMCPQuietNative {
  param([string]$Binary, [string]$Arguments)
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $Binary; $start.Arguments = $Arguments
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $child = New-Object System.Diagnostics.Process
  $child.StartInfo = $start
  try {
    if (!$child.Start()) { throw 'ReMCP could not start a hidden native process.' }
    $child.WaitForExit(); return $child.ExitCode
  } finally { $child.Dispose() }
}
function Invoke-ReMCPStagedNpm {
  param([Parameter(Mandatory=$true)][string]$Node, [Parameter(Mandatory=$true)][string]$NpmCli,
        [Parameter(Mandatory=$true)][string]$ClientSpec, [Parameter(Mandatory=$true)][string]$RuntimeSpec)
  if (!(Test-Path -LiteralPath $Node -PathType Leaf) -or
      !(Test-Path -LiteralPath $NpmCli -PathType Leaf) -or $NpmCli.Contains('"')) {
    throw ("The staged ReMCP Node/npm executable is missing or invalid. Node={0} Npm={1}" -f $Node, $NpmCli)
  }
  if ($ClientSpec -notmatch '^@remcp/remcp@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or
      $RuntimeSpec -notmatch '^@remcp/runtime@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw 'ReMCP refused an invalid package spec before launching npm.'
  }
  $npmArguments = '"' + $NpmCli + '" install --global ' + $ClientSpec + ' ' + $RuntimeSpec +
    ' --no-audit --no-fund --ignore-scripts --loglevel=error'
  $exitCode = Invoke-ReMCPQuietNative -Binary $Node -Arguments $npmArguments
  if ($exitCode -ne 0) { throw "ReMCP installation failed with exit code $exitCode." }
}
function Invoke-ReMCPLegacyTask {
  param([ValidateSet('End','Run')][string]$Action)
  $exe = Join-Path $env:SystemRoot 'System32\schtasks.exe'
  if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Windows Task Scheduler utility is missing.' }
  $null = Invoke-ReMCPQuietNative -Binary $exe -Arguments ('/' + $Action + ' /TN "ReMCP Agent"')
}
function Get-ReMCPExistingPairing {
  $configDir = if ([string]::IsNullOrWhiteSpace($env:REMCP_CONFIG_DIR)) {
    Join-Path $env:USERPROFILE '.config\remcp'
  } else { $env:REMCP_CONFIG_DIR }
  $configFile = Join-Path $configDir 'config.json'
  try {
    $config = Get-Content -LiteralPath $configFile -Raw -ErrorAction Stop | ConvertFrom-Json
    return (![string]::IsNullOrWhiteSpace([string]$config.deviceId) -and
            ![string]::IsNullOrWhiteSpace([string]$config.deviceToken))
  } catch { return $false }
}

# A ReMCP-owned Node/launcher process may hold its runtime files open after
# Task Scheduler /End. Never kill an unrelated script merely because it uses
# the bundled node.exe: a foreign process must cause a safe swap refusal instead.
function Stop-ReMCPRuntimeProcesses {
  $prefix = $runtimeDir.TrimEnd('\') + '\'
  $packageRoot = Join-Path $runtimeDir 'node_modules\@remcp\'
  $runtimeLauncher = Join-Path $runtimeDir 'remcp.cmd'
  try { $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) }
  catch { return }
  foreach ($process in $processes) {
    if (!$process -or !$process.ProcessId -or $process.ProcessId -eq $PID) { continue }
    $exe = [string]$process.ExecutablePath
    $command = ([string]$process.CommandLine).Replace('/', '\')
    $name = [string]$process.Name
    $nodeOwned = $name -ieq 'node.exe' -and
      $exe.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
      $command.IndexOf($packageRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $launcherOwned = ($name -ieq 'cmd.exe' -or $name -ieq 'wscript.exe') -and
      ($command.IndexOf($wrapper, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
       $command.IndexOf($runtimeLauncher, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    if (!$nodeOwned -and !$launcherOwned) { continue }
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      Write-Host ("Stopped existing ReMCP process {0}." -f $process.ProcessId)
    } catch {}
  }
}
function Initialize-ReMCPStage {
  param([Parameter(Mandatory=$true)][string]$Destination, [Parameter(Mandatory=$true)]$Release)
  $arch = Get-ReMCPArchitecture
  Write-Host 'Preparing ReMCP...'
  $nodeVersion = $pinnedNodeVersion
  $sha256 = [string]$pinnedNodeSha256[$arch]
  if ($nodeVersion -notmatch '^\d+\.\d+\.\d+$' -or $sha256 -notmatch '^[a-f0-9]{64}$') {
    throw "ReMCP has no valid pinned Windows runtime for $arch."
  }
  $archiveName = "node-v$nodeVersion-win-$arch.zip"
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
      $npmCli = Join-Path $Destination 'node_modules\npm\bin\npm-cli.js'
      $clientSpec = [string]$Release.cli
      $runtimeSpec = [string]$Release.runtime
      Invoke-ReMCPStagedNpm -Node (Join-Path $Destination 'node.exe') -NpmCli $npmCli `
        -ClientSpec $clientSpec -RuntimeSpec $runtimeSpec
    } finally {
      $env:NPM_CONFIG_PREFIX = $oldPrefix
      $env:Path = $oldPath
    }
    if (!(Test-ReMCPRelease -Directory $Destination -Release $Release -Explain)) {
      throw 'The staged ReMCP release failed verification.'
    }
    Remove-ReMCPNpmPowerShellShadow -Directory $Destination
  } catch {
    Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
    throw
  } finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
function Write-ReMCPWrapper {
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
# cmd.exe does not reliably decode Unicode absolute paths from UTF-8 .cmd files. Expand Windows' own per-user known folder at runtime, using ASCII-only script bytes.
  $escapedRuntime = '%LOCALAPPDATA%\ReMCP\runtime'
  $escapedCli = '%LOCALAPPDATA%\ReMCP\runtime\remcp.cmd'
  $content = @(
    '@echo off', 'setlocal DisableDelayedExpansion',
    "set `"NPM_CONFIG_PREFIX=$escapedRuntime`"", "set `"PATH=$escapedRuntime;%PATH%`"",
    "call `"$escapedCli`" %*", 'exit /b %ERRORLEVEL%',
    ''
  ) -join "`r`n"
  [IO.File]::WriteAllText($wrapper, $content, (New-Object Text.UTF8Encoding($false)))
# Persisting PATH is convenient, not required for pairing or for the service. Managed user/enterprise profiles can deny this registry write to standard users.
  try {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($userPath -split ';' | Where-Object { ![string]::IsNullOrWhiteSpace($_) })
    if (!($entries | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) {
      [Environment]::SetEnvironmentVariable('Path', (($entries + $binDir) -join ';'), 'User')
    }
  } catch {
    Write-Warning 'ReMCP installed, but this account cannot change its user PATH. Use the ReMCP shortcut in LocalAppData.'
  }
}
function Restore-ReMCPBackup {
  param([string]$Snapshot = $backup)
  if (!(Test-Path -LiteralPath $Snapshot -PathType Container)) { return $false }
  try { Invoke-ReMCPLegacyTask -Action End } catch {}
  Remove-Item -LiteralPath $runtimeDir -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $Snapshot -Destination $runtimeDir -Force
  Write-ReMCPWrapper
  try { Invoke-ReMCPLegacyTask -Action Run } catch {}
  $node = Join-Path $runtimeDir 'node.exe'
  $entry = Join-Path $runtimeDir 'node_modules\@remcp\remcp\bin\remcp.mjs'
  if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $entry)) {
    try { & $node $entry install | Out-Null } catch { Write-Warning 'ReMCP rollback restored files, but agent restart failed.' }
  }
  return $true
}
if ($ValidateOnly) { Write-Output ("ReMCP Windows installer validation OK ({0})." -f (Get-ReMCPArchitecture)); exit 0 }
# If a previous process died between the directory swap and its final cleanup, prefer the active runtime when it exists; otherwise restore the rollback copy before attempting another install.
New-Item -ItemType Directory -Force -Path $root | Out-Null
if (!(Test-Path -LiteralPath $runtimeDir -PathType Container) -and (Test-Path -LiteralPath $backup -PathType Container)) { Move-Item -LiteralPath $backup -Destination $runtimeDir -Force }
$release = Get-ReMCPRelease
$swapped = $false
# Never discard a previous rollback after an interrupted upgrade. Give this attempt its
# own uniquely named recovery snapshot instead of overwriting runtime.old.
$priorRecoveryBackup = Test-Path -LiteralPath $backup
$attemptSnapshot = if ($priorRecoveryBackup) { "$runtimeDir.recovery-$([Guid]::NewGuid().ToString('N'))" } else { $backup }
if (!(Test-ReMCPRelease -Directory $runtimeDir -Release $release)) {
# A successful swap deletes its rollback copy. Refuse user launchers before staging or moving the old runtime; validation must not remove its npm shim.
  Remove-ReMCPNpmPowerShellShadow -Directory $runtimeDir -CheckOnly
  # Each attempt uses its own staging path. A previous interrupted installer may have
  # left a complete runtime.new; copy and re-verify those bytes instead of moving them
  # or allowing two simultaneous installers to overwrite each other's stage.
  $legacyStaged = "$runtimeDir.new"
  if ((Test-ReMCPRelease -Directory $legacyStaged -Release $release) -and
      (Test-Path -LiteralPath (Join-Path $legacyStaged 'remcp.cmd') -PathType Leaf)) {
    Copy-Item -LiteralPath $legacyStaged -Destination $staged -Recurse -ErrorAction Stop
    if (Test-ReMCPRelease -Directory $staged -Release $release) {
      Remove-ReMCPNpmPowerShellShadow -Directory $staged
      Write-Host 'Reusing an already verified staged ReMCP release from the interrupted update.'
    } else {
      Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue
      Initialize-ReMCPStage -Destination $staged -Release $release
    }
  } else {
    Initialize-ReMCPStage -Destination $staged -Release $release
  }
  if ($priorRecoveryBackup) { Write-Warning 'A previous ReMCP rollback is present. This upgrade will preserve it unchanged.' }

  # Only stop a running agent after the complete replacement has downloaded, installed and passed
  # verification. The offline window is therefore just two local directory moves.
  try { Invoke-ReMCPLegacyTask -Action End } catch {}
  Stop-ReMCPRuntimeProcesses
  Start-Sleep -Milliseconds 250
  if (Test-Path -LiteralPath $runtimeDir -PathType Container) {
    $moved = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
      try {
        Move-Item -LiteralPath $runtimeDir -Destination $attemptSnapshot -ErrorAction Stop
        $moved = $true
        break
      } catch {
        if ($attempt -eq 11) { throw ('ReMCP could not replace the runtime because a file is still in use. Close any ReMCP terminal/agent window and rerun the installer. ' + $_.Exception.Message) }
        Stop-ReMCPRuntimeProcesses
        Start-Sleep -Milliseconds 500
      }
    }
    if (!$moved) { throw 'ReMCP could not replace the runtime directory.' }
  }
  try {
    Move-Item -LiteralPath $staged -Destination $runtimeDir -Force
    if (!(Test-ReMCPRelease -Directory $runtimeDir -Release $release)) { throw 'The promoted ReMCP release failed verification.' }
    $swapped = $true
  } catch {
    Restore-ReMCPBackup -Snapshot $attemptSnapshot | Out-Null
    throw
  }
} else {
# A verified current release may still contain an npm .ps1 shadow created by an older installer or update; repair it without changing installed bytes.
  Remove-ReMCPNpmPowerShellShadow -Directory $runtimeDir
  # Never discard an existing recovery copy without an explicit verified recovery.
  if (Test-Path -LiteralPath $backup) { Write-Warning 'Preserving an existing ReMCP recovery backup.' }
}
Write-ReMCPWrapper
$env:NPM_CONFIG_PREFIX = $runtimeDir
$env:Path = "$binDir;$runtimeDir;$env:Path"
$node = Join-Path $runtimeDir 'node.exe'
$cliEntry = Join-Path $runtimeDir 'node_modules\@remcp\remcp\bin\remcp.mjs'
$existingPairing = Get-ReMCPExistingPairing
$arguments = @('connect')
if ($existingPairing -and !$RePair) {
# Reinstalling after an uninstall must repair the local CLI/service, not require the missing remcp command or silently consume a new code.
  Write-Host 'Existing ReMCP pairing found; repairing the local installation without changing credentials.'
  $arguments = @('install')
} else {
  if ($RePair) { $arguments += '--re-pair' }
# A previous run may have completed browser pairing before Task Scheduler denied startup. Repair that existing device without requesting another approval or rotating its token.
  if ([string]::IsNullOrWhiteSpace($Code) -and !$RePair) { $arguments += '--repair-if-paired' }
  if (![string]::IsNullOrWhiteSpace($Server) -and $Server.TrimEnd('/') -ne $officialOrigin) { $arguments += @('--server', $Server.TrimEnd('/')) }
  if (![string]::IsNullOrWhiteSpace($Code)) { $arguments += @('--code', ($Code -replace '\s+', '').ToUpperInvariant(), '--install') }
  if ($TrustRuntime) { $arguments += '--trust-runtime' }
}
if ($arguments[0] -eq 'install') { Write-Host 'Repairing ReMCP with the existing pairing...' }
else { Write-Host 'Starting ReMCP pairing...' }
& $node $cliEntry @arguments
$pairingExit = $LASTEXITCODE
if ($pairingExit -ne 0) {
  # Keep a fresh first install available for a simple retry. On an upgrade, however, restore the
  # already-working agent if pairing/service setup failed after the atomic swap.
  if ($swapped -and (Test-Path -LiteralPath $attemptSnapshot -PathType Container)) { Restore-ReMCPBackup -Snapshot $attemptSnapshot | Out-Null }
  throw "ReMCP pairing failed with exit code $pairingExit."
}

if ($priorRecoveryBackup) { Write-Warning 'Preserved the earlier rollback and this upgrade recovery snapshot for safe inspection.' }
else { Remove-Item -LiteralPath $attemptSnapshot -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host ("ReMCP {0} is ready." -f [string]$release.cliVersion)
