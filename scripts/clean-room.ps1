# Clean-room check (Phase 10 S6): the 15 steps of docs/QUICKSTART.md, run from the package file in a disposable profile.
#
# What "clean" means here: a new folder stands in for the user profile (USERPROFILE, HOME, APPDATA, LOCALAPPDATA, TEMP
# all point into it), the environment has no SYNAPTOME_*, DRELQAVO_*, TSX*, NODE_OPTIONS or GitHub credentials, PATH
# holds only Node and the Windows system folders, the working folder is outside the repository, and the package is
# installed globally into a prefix inside the profile (never into the real npm global folder). This is not a separate
# Windows account or Windows Sandbox (Windows 11 Home has no Sandbox; a new local account needs the owner's approval).
#
#   powershell -NoProfile -File scripts/clean-room.ps1 -Package dist\synaptome-0.2.0.tgz [-Out .tmp/clean-room]
param(
  [Parameter(Mandatory = $true)][string]$Package,
  [string]$Out = '.tmp/clean-room'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pkg = (Resolve-Path $Package).Path
$outDir = Join-Path $root $Out
New-Item -ItemType Directory -Force $outDir | Out-Null
$box = Join-Path ([IO.Path]::GetTempPath()) ("synaptome-clean-room-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$profileDir = Join-Path $box 'user'
$prefix = Join-Path $profileDir 'AppData\Roaming\npm'
$project = Join-Path $profileDir 'projects\demo'
foreach ($d in @("$profileDir\AppData\Roaming", "$profileDir\AppData\Local\Temp", $prefix, $project)) { New-Item -ItemType Directory -Force $d | Out-Null }
Set-Content -Encoding ascii (Join-Path $project 'README.md') '# demo project (the user''s own file)'
$nodeDir = Split-Path -Parent (Get-Command node).Source
$realHome = Join-Path $env:LOCALAPPDATA 'synaptome'
$realHomeBefore = if (Test-Path $realHome) { (Get-Item $realHome).LastWriteTimeUtc.Ticks } else { 'absent' }

# A clean environment for every step.
$clean = @{}
foreach ($k in @('SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS')) { $v = [Environment]::GetEnvironmentVariable($k); if ($v) { $clean[$k] = $v } }
$clean['USERPROFILE'] = $profileDir; $clean['HOME'] = $profileDir
$clean['APPDATA'] = "$profileDir\AppData\Roaming"; $clean['LOCALAPPDATA'] = "$profileDir\AppData\Local"
$clean['TEMP'] = "$profileDir\AppData\Local\Temp"; $clean['TMP'] = $clean['TEMP']
$clean['USERNAME'] = 'cleanroom'; $clean['HOMEDRIVE'] = (Split-Path -Qualifier $profileDir); $clean['HOMEPATH'] = (Split-Path -NoQualifier $profileDir)
$clean['PATH'] = "$prefix;$nodeDir;$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
$clean['npm_config_update_notifier'] = 'false'; $clean['npm_config_fund'] = 'false'; $clean['npm_config_audit'] = 'false'

function Invoke-Step([int]$n, [string]$title, [string]$exe, [string[]]$argv, [scriptblock]$check) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  # cmd.exe gets its command line as written (S builds it); other programs get each argument quoted when needed.
  $psi.Arguments = if ($exe -eq $cmd) { $argv -join ' ' } else { ($argv | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ' }
  $psi.WorkingDirectory = $profileDir
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.EnvironmentVariables.Clear()
  foreach ($k in $clean.Keys) { $psi.EnvironmentVariables[$k] = $clean[$k] }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = [Diagnostics.Process]::Start($psi)
  $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  $p.WaitForExit(); $sw.Stop()
  $stdout = $so.Result; $stderr = $se.Result
  $json = $null; try { $json = $stdout | ConvertFrom-Json } catch {}
  $verdict = 'pass'; $note = ''
  try { $note = & $check $p.ExitCode $stdout $json } catch { $verdict = 'fail'; $note = $_.Exception.Message }
  $script:results += [pscustomobject]@{ step = $n; title = $title; command = ((Split-Path -Leaf $exe) + ' ' + ($argv -join ' ')).Replace($box, '<clean-room>').Replace($root, '<repository>'); exit = $p.ExitCode; ms = $sw.ElapsedMilliseconds; verdict = $verdict; note = "$note".Replace($box, '<clean-room>'); stderr = $stderr.Trim().Replace($box, '<clean-room>') }
  Write-Host ("{0,2} {1,-5} {2,6} ms  {3}  {4}" -f $n, $verdict, $sw.ElapsedMilliseconds, $title, "$note".Replace($box, '<clean-room>'))
  return $json
}
function Need([bool]$ok, [string]$why) { if (-not $ok) { throw $why } }

$results = @()
$syn = Join-Path $prefix 'synaptome.cmd'
$cmd = "$env:SystemRoot\System32\cmd.exe"
$npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
$node = Join-Path $nodeDir 'node.exe'
# cmd /d /s /c ""<synaptome.cmd>" args"  (with /s, cmd removes the outer quotes and runs the rest as typed)
function S([string[]]$a) { return @('/d', '/s', '/c', ('""' + $syn + '" ' + (($a | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_ + '"' } else { $_ } }) -join ' ') + '"')) }

Invoke-Step 1 'Node.js 24 or later' $node @('--version') { param($c, $o) Need ($o -match '^v(2[4-9]|[3-9]\d)\.') "node is $o"; $o.Trim() } | Out-Null
Invoke-Step 2 'Install from the package file' $node @($npmCli, 'install', '-g', '--prefix', $prefix, $pkg, '--offline') { param($c, $o) Need ($c -eq 0) "npm exit $c"; Need (Test-Path $syn) 'no synaptome command in the prefix'; 'installed into the profile''s npm prefix' } | Out-Null
Invoke-Step 3 'It runs' $cmd (S @('--version')) { param($c, $o) Need ($c -eq 0 -and $o.Trim() -match '^\d+\.\d+\.\d+') "got '$o'"; $o.Trim() } | Out-Null
$init = Invoke-Step 4 'Set up' $cmd (S @('--json', 'init')) { param($c, $o, $j) Need ($c -eq 0 -and $j.ok) "init exit $c"; Need ($j.firstTime) 'not first time'; Need ($j.home -like "$profileDir*") "home outside the profile: $($j.home)"; "home $($j.home); $(@($j.checks).Count) checks" }
Invoke-Step 5 'Checks' $cmd (S @('--json', 'doctor')) { param($c, $o, $j) Need ($c -eq 0) "doctor exit $c"; "$(@($j.checks | Where-Object { $_.status -eq 'ok' }).Count) ok, $(@($j.checks | Where-Object { $_.status -eq 'warn' }).Count) notices" } | Out-Null
Invoke-Step 6 'Existing skills (read only)' $cmd (S @('--json', 'inventory')) { param($c, $o, $j) Need ($c -eq 0) "exit $c"; "$($j.indexed) indexed (new profile: none expected)" } | Out-Null
Invoke-Step 7 'Discover' $cmd (S @('--json', 'scan', '--repo', 'anthropics/skills', '--limit', '3')) { param($c, $o, $j) Need ($c -eq 0) "exit $c"; $r = @($j.reports)[0]; Need ($r.found -gt 0) "nothing found: $($r.status) $($r.error)"; "$($r.found) found, $($r.added) new, status $($r.status)" } | Out-Null
$cap = $null
foreach ($i in 1..6) {
  $ev = Invoke-Step 8 "Evaluate (attempt $i)" $cmd (S @('--json', 'evaluate', '--next', '1')) { param($c, $o, $j) Need ($c -eq 0) "exit $c"; $r = @($j.reports)[0]; Need (-not $r.error) "$($r.candidateId): $($r.error)"; "$($r.candidateId) -> $($r.capabilityId) state=$($r.state) tier=$($r.tier) licence=$($r.licence.spdx) gate=$($r.gate.decision)" }
  $r = @($ev.reports)[0]
  if ($r.error) { break }
  if ($r.capabilityId -and $r.state -eq 'registered' -and $r.tier -ne 'C') { $cap = $r; break }
}
if (-not $cap) { throw 'no candidate reached the registry in six evaluations' }
$approveArgs = @('--json', 'approve', $cap.capabilityId)
if ($cap.licence.compatible -ne 'yes') { $approveArgs += @('--accept-licence', 'clean-room check: local evaluation only') }
Invoke-Step 9 'Decide' $cmd (S $approveArgs) { param($c, $o, $j) Need ($c -eq 0) "exit $c $o"; "$($cap.capabilityId) approved" } | Out-Null
$inst = Invoke-Step 10 'Install into the sandbox host' $cmd (S @('--json', 'install', $cap.capabilityId)) { param($c, $o, $j) Need ($c -eq 0) "exit $c $o"; Need ($j.installation.scope -eq 'sandbox') 'not a sandbox install'; Need ($j.installation.targetPath -like "$profileDir*") 'target outside the profile'; "$($j.installation.id) verified: $($j.installation.verifyDetail)" }
Invoke-Step 11 'Undo' $cmd (S @('--json', 'rollback', $inst.installation.id)) { param($c, $o, $j) Need ($c -eq 0) "exit $c"; Need (-not (Test-Path $inst.installation.targetPath)) 'target still there'; 'sandbox back to what it was' } | Out-Null
Invoke-Step 12 'Route a task' $cmd (S @('--json', 'route', 'write release notes from the merged changes')) { param($c, $o, $j) Need ($c -eq 0) "exit $c"; "decision $($j.id): $(@($j.selected).Count) selected" } | Out-Null
Invoke-Step 13 'Connect a project' $cmd (S @('--json', 'init', '--project', $project)) { param($c, $o, $j) Need ($c -eq 0) "exit $c"; foreach ($f in @('.mcp.json', '.claude\skills\synaptome\SKILL.md', '.claude\settings.local.json', '.synaptome-bridge.json')) { Need (Test-Path (Join-Path $project $f)) "missing $f" }; 'MCP entry, bridge skill, hook and record in the project only' } | Out-Null

# 14. Interfaces: the dashboard serves its page; the workbench opens in a real console window on Get started and quits.
$dash = New-Object System.Diagnostics.ProcessStartInfo
$dash.FileName = $cmd; $dash.Arguments = (S @('--json', 'dashboard', '--port', '0', '--no-open')) -join ' '
$dash.UseShellExecute = $false; $dash.RedirectStandardOutput = $true; $dash.RedirectStandardError = $true; $dash.WorkingDirectory = $profileDir
$dash.EnvironmentVariables.Clear(); foreach ($k in $clean.Keys) { $dash.EnvironmentVariables[$k] = $clean[$k] }
$sw = [Diagnostics.Stopwatch]::StartNew(); $dp = [Diagnostics.Process]::Start($dash); $line = $dp.StandardOutput.ReadLine()
$verdict = 'pass'; $note = ''
try { $u = ($line | ConvertFrom-Json).url; $page = Invoke-WebRequest -UseBasicParsing $u; Need ($page.Content -match 'Synaptome Command Center') 'page title missing'; $note = "dashboard served its page at $u" } catch { $verdict = 'fail'; $note = $_.Exception.Message }
Get-CimInstance Win32_Process -Filter "ParentProcessId=$($dp.Id)" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Stop-Process -Id $dp.Id -Force -ErrorAction SilentlyContinue
$results += [pscustomobject]@{ step = 14; title = 'Web Command Center'; command = 'synaptome dashboard'; exit = 0; ms = $sw.ElapsedMilliseconds; verdict = $verdict; note = $note; stderr = '' }
Write-Host ("14 {0,-5} {1,6} ms  Web Command Center  {2}" -f $verdict, $sw.ElapsedMilliseconds, $note)
$report = Join-Path $box 'tui-report.json'
$tuiCmd = Join-Path $box 'tui.cmd'
$lines = @('@echo off') + ($clean.Keys | ForEach-Object { "set `"$_=$($clean[$_])`"" }) + @("set `"SYNAPTOME_TUI_REPORT=$report`"", 'set "SYNAPTOME_TUI_EXIT_AFTER_MS=1500"', "cd /d `"$profileDir`"", "call `"$syn`"")
Set-Content -Encoding ascii $tuiCmd $lines
$sw = [Diagnostics.Stopwatch]::StartNew()
$tp = Start-Process conhost.exe -ArgumentList @('cmd.exe', '/c', $tuiCmd) -PassThru
$deadline = (Get-Date).AddSeconds(30); while ((Get-Date) -lt $deadline -and -not ((Test-Path $report) -and (Get-Content $report -Raw) -match 'restoredMs')) { Start-Sleep -Milliseconds 200 }
$verdict = 'pass'; $note = ''
try { $t = Get-Content $report -Raw | ConvertFrom-Json; Need ($t.restoredMs -gt 0) 'did not quit cleanly'; Need ((@($t.frame) -join "`n") -match 'Get started') 'did not open on Get started'; $note = "opened on Get started at $($t.terminal.columns)x$($t.terminal.rows), first data at $($t.readyMs) ms, quit and restored the terminal" } catch { $verdict = 'fail'; $note = $_.Exception.Message }
$results += [pscustomobject]@{ step = 14; title = 'Terminal Workbench'; command = 'synaptome'; exit = 0; ms = $sw.ElapsedMilliseconds; verdict = $verdict; note = $note; stderr = '' }
Write-Host ("14 {0,-5} {1,6} ms  Terminal Workbench  {2}" -f $verdict, $sw.ElapsedMilliseconds, $note)

# 15. Remove everything, then look for anything left.
Invoke-Step 15 'Undo everything and delete the data' $cmd (S @('--json', 'uninstall', '--everything', '--yes', '--delete-data')) { param($c, $o, $j) Need ($c -eq 0) "exit $c $o"; Need ($j.dataDeleted) 'data kept'; "$(@($j.installs).Count) install(s), $(@($j.projects).Count) project(s) undone; data deleted" } | Out-Null
Invoke-Step 15 'Remove the program' $node @($npmCli, 'uninstall', '-g', '--prefix', $prefix, 'synaptome') { param($c, $o) Need ($c -eq 0) "npm exit $c"; Need (-not (Test-Path $syn)) 'command still there'; 'program removed' } | Out-Null
# Only the part of each path inside the profile is looked at (the clean-room folder's own name contains the product name).
$left = Get-ChildItem -Recurse -Force $profileDir -ErrorAction SilentlyContinue | Where-Object { $rel = $_.FullName.Substring($profileDir.Length); $rel -match 'synaptome' -and $rel -notmatch '\\npm-cache\\' }
$projectLeft = @(Get-ChildItem -Recurse -Force $project | ForEach-Object { $_.Name })
$realHomeAfter = if (Test-Path $realHome) { (Get-Item $realHome).LastWriteTimeUtc.Ticks } else { 'absent' }
$verdict = if (-not $left -and ($projectLeft -join ',') -eq 'README.md' -and $realHomeBefore -eq $realHomeAfter) { 'pass' } else { 'fail' }
$note = "files named synaptome left in the profile (npm's own download cache excluded): $(@($left).Count); project holds: $($projectLeft -join ', '); real data folder unchanged: $($realHomeBefore -eq $realHomeAfter)"
$results += [pscustomobject]@{ step = 15; title = 'Nothing left behind'; command = '(inspection)'; exit = 0; ms = 0; verdict = $verdict; note = $note; stderr = (@($left | ForEach-Object { $_.FullName.Replace($box, '<clean-room>') }) -join '; ') }
Write-Host ("15 {0,-5}        Nothing left behind  {1}" -f $verdict, $note)

[IO.File]::WriteAllText((Join-Path $outDir 'clean-room.json'), ($results | ConvertTo-Json -Depth 4))
Remove-Item -Recurse -Force $box -ErrorAction SilentlyContinue
$failed = @($results | Where-Object { $_.verdict -ne 'pass' }).Count
Write-Host "`n$($results.Count) checks, $failed failed. Report: $(Join-Path $outDir 'clean-room.json')"
if ($failed) { exit 1 }
