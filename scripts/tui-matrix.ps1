# Terminal matrix for the Terminal Workbench (Phase 9 S5).
#
# Opens the workbench in real terminal windows - Windows Terminal, Windows PowerShell in the classic console host and
# cmd in the classic console host - at each width, against a home folder (read only use), and records for each run:
#   - the size the workbench saw, whether it used Unicode glyphs, the widest line it drew;
#   - time from process start to the first painted frame and to the first frame with data (startup report);
#   - that it quit through the normal path and restored the terminal, and that no process of the run is left.
# A screenshot of only the window it opened is saved per run (PrintWindow on that window; nothing else on screen is
# captured). Usage:
#   powershell -NoProfile -File scripts/tui-matrix.ps1 [-Home .synaptome-dev] [-Out .tmp/tui-matrix]
param(
  [string]$DataHome = '.synaptome-dev',
  [string]$Out = '.tmp/tui-matrix',
  [int[]]$Widths = @(80, 120, 200),
  [string[]]$Hosts = @('wt', 'powershell', 'cmd'),
  [int]$Rows = 30,
  [int]$ExitAfterMs = 2500,
  # The launcher to run: the development launcher (TypeScript through tsx) or a built bundle.
  [string]$Launcher = 'apps\cli\bin\synaptome.mjs',
  # For screenshots: a Claude root to use instead of the real one, and a PATH holding only Node and Windows, so no
  # program location under the user folder appears on screen.
  [string]$ClaudeRoot = '',
  [switch]$MinimalPath
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root $Launcher
$dataHome = if ([IO.Path]::IsPathRooted($DataHome)) { (Resolve-Path $DataHome).Path } else { (Resolve-Path (Join-Path $root $DataHome)).Path }
$outDir = Join-Path $root $Out
New-Item -ItemType Directory -Force $outDir | Out-Null
$node = (Get-Command node).Source

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class TuiShot {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static bool Exists(string title) { return FindWindow(null, title) != IntPtr.Zero; }
  public static bool Save(string title, string path) {
    SetProcessDPIAware();
    IntPtr h = FindWindow(null, title);
    if (h == IntPtr.Zero) return false;
    RECT r; GetWindowRect(h, out r);
    using (var bmp = new Bitmap(Math.Max(1, r.R - r.L), Math.Max(1, r.B - r.T))) {
      using (var g = Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
      bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    }
    return true;
  }
}
'@

function Wait-Until([scriptblock]$cond, [int]$ms) {
  $end = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 100 }
  return $false
}
function Read-Report($file) { if (Test-Path $file) { try { return Get-Content $file -Raw | ConvertFrom-Json } catch { return $null } }; return $null }

$results = @()
foreach ($h in $Hosts) {
  foreach ($w in $Widths) {
    $id = "$h-$w"
    $title = "synaptome-tui-matrix-$id"
    $report = Join-Path $outDir "$id.json"
    $shot = Join-Path $outDir "$id.png"
    Remove-Item $report, $shot -ErrorAction SilentlyContinue
    $envs = "set SYNAPTOME_TUI_REPORT=$report&& set SYNAPTOME_TUI_EXIT_AFTER_MS=$ExitAfterMs&& set WT_SESSION="
    $run = "`"$node`" `"$bin`" --home `"$dataHome`" tui"
    $t0 = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    switch ($h) {
      'wt' {
        $cmdFile = Join-Path $outDir "$id.cmd"
        # WT_SESSION is set by Windows Terminal itself; the line above only clears an inherited value.
        $extra = $(if ($ClaudeRoot) { "set SYNAPTOME_CLAUDE_ROOT=$ClaudeRoot`r`n" }) + $(if ($MinimalPath) { "set PATH=$(Split-Path -Parent $node);$env:SystemRoot\System32`r`n" })
        Set-Content -Encoding ascii $cmdFile "@echo off`r`nset SYNAPTOME_TUI_REPORT=$report`r`nset SYNAPTOME_TUI_EXIT_AFTER_MS=$ExitAfterMs`r`n$extra$run`r`n"
        Start-Process wt.exe -ArgumentList @('-w', 'new', '--size', "$w,$Rows", 'new-tab', '--title', $title, '--suppressApplicationTitle', 'cmd', '/c', $cmdFile) | Out-Null
      }
      'cmd' {
        $cmdFile = Join-Path $outDir "$id.cmd"
        Set-Content -Encoding ascii $cmdFile "@echo off`r`ntitle $title`r`nmode con: cols=$w lines=$Rows`r`n$envs`r`n$run`r`n"
        Start-Process conhost.exe -ArgumentList @('cmd.exe', '/c', $cmdFile) | Out-Null
      }
      'powershell' {
        $ps = "`$Host.UI.RawUI.WindowTitle = '$title'; mode con: cols=$w lines=$Rows; `$env:SYNAPTOME_TUI_REPORT = '$report'; `$env:SYNAPTOME_TUI_EXIT_AFTER_MS = '$ExitAfterMs'; Remove-Item Env:WT_SESSION -ErrorAction SilentlyContinue; & '$node' '$bin' --home '$dataHome' tui"
        $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ps))
        Start-Process conhost.exe -ArgumentList @('powershell.exe', '-NoProfile', '-EncodedCommand', $enc) | Out-Null
      }
    }
    $ready = Wait-Until { $r = Read-Report $report; $r -and $r.frame } 20000
    $r = Read-Report $report
    $shotSaved = $false
    if ($ready) { Start-Sleep -Milliseconds 400; $shotSaved = [TuiShot]::Save($title, $shot) }
    $restored = Wait-Until { $x = Read-Report $report; $x -and $x.restoredMs } 15000
    $r = Read-Report $report
    $gone = $false
    if ($r -and $r.pid) { $gone = Wait-Until { -not (Get-Process -Id $r.pid -ErrorAction SilentlyContinue) } 5000 }
    $windowGone = Wait-Until { -not [TuiShot]::Exists($title) } 5000
    $left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$dataHome*" -and $_.CommandLine -like '*tui*' })
    $results += [pscustomobject]@{
      host = $h; width = $w; rows = $Rows
      seenColumns = $r.terminal.columns; seenRows = $r.terminal.rows; unicodeGlyphs = $r.terminal.unicodeGlyphs; windowsTerminal = $r.terminal.windowsTerminal
      widestLine = $r.widestLine; frameRows = $r.frameRows
      firstPaintMs = $r.firstPaintMs; firstDataMs = $r.readyMs; launchToDataMs = if ($r.readyAt) { $r.readyAt - $t0 } else { $null }
      quitAndRestored = [bool]$restored; processExited = [bool]$gone; windowClosed = [bool]$windowGone; leftoverProcesses = $left.Count
      screenshot = if ($shotSaved) { Split-Path -Leaf $shot } else { $null }
    }
    Write-Host ("{0,-11} {1,4} cols  seen {2}x{3}  widest {4}  paint {5} ms  data {6} ms  restored {7}  exited {8}  leftovers {9}" -f $h, $w, $r.terminal.columns, $r.terminal.rows, $r.widestLine, $r.firstPaintMs, $r.readyMs, [bool]$restored, [bool]$gone, $left.Count)
  }
}
$results | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $outDir 'matrix.json')
