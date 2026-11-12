import { windowsInteropLoad } from './windows-interop.mjs';
// Windows 10+: assign the child to an unnamed job during CreateProcess itself.
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
// Only the helper holds the job handle. Neither child nor descendants inherit it.
export const windowsOwnedJobScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$job = $null
try {
${windowsInteropLoad('owned-job')}
$job = New-Object ReMcpOwnedJob
  [Console]::WriteLine('{"ready":true}')
  $line = [Console]::ReadLine()
  if (!$line) { throw 'Job owner disconnected before start' }
  $request = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)))
  $childId = $job.Start($request.application, $request.command, $request.cwd, $request.log)
  [Console]::WriteLine(('{"started":true,"pid":' + $childId + '}'))
  $code = $job.Wait()
  [Console]::WriteLine(('{"empty":true,"exitCode":' + $code + '}'))
} catch {
  if ($_.Exception.Message -like '*REMCP_WINDOWS_PAYLOAD_BLOCKED*') { [Console]::Error.WriteLine('REMCP_WINDOWS_PAYLOAD_BLOCKED') }
  $cause = $_.Exception.GetBaseException()
  [Console]::Error.WriteLine(('Windows owned job failed (' + $cause.GetType().Name + '; code=' + $cause.NativeErrorCode + ').'))
  exit 1
} finally { if ($job) { $job.Dispose() } }
`;
