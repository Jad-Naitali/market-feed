<#
  install-schedule.ps1 — registers (or removes) the Windows Task Scheduler tasks that
  run the briefs automatically on weekdays.

    Morning brief    8:00 AM            Mon-Fri
    Evening recap    5:00 PM            Mon-Fri

  The machine is on Eastern time, so these local times already equal ET. The brief tasks
  wake the computer.

  Intraday coverage moved to the cloud live feed (GitHub Pages + Actions cron) — see the
  live-market-feed setup; the old desktop-toast intraday task was retired 2026-06-18.

  Usage:
    powershell -ExecutionPolicy Bypass -File ".\install-schedule.ps1"            # install/update
    powershell -ExecutionPolicy Bypass -File ".\install-schedule.ps1" -Remove    # delete both tasks

  Re-running install is safe — it overwrites the existing tasks.
#>

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$briefsDir   = $PSScriptRoot
$wrapper     = Join-Path $briefsDir 'run-scheduled-brief.ps1'

$tasks = @(
  @{ Name = 'TDV Morning Brief'; Mode = 'morning'; Time = '08:00' },
  @{ Name = 'TDV Evening Recap'; Mode = 'evening'; Time = '17:00' }
)

if ($Remove) {
  # also clears the retired 'TDV Intraday Watch' if a stale copy lingers
  foreach ($name in (@($tasks.Name) + 'TDV Intraday Watch')) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Output "Removed: $name"
    } else {
      Write-Output "Not present: $name"
    }
  }
  return
}

if (-not (Test-Path $wrapper)) { throw "Wrapper not found: $wrapper" }

foreach ($t in $tasks) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ("-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`" -Mode $($t.Mode)")

  $trigger = New-ScheduledTaskTrigger -Weekly `
    -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday `
    -At $t.Time

  $settings = New-ScheduledTaskSettingsSet `
    -WakeToRun `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

  # run as the logged-in user, only when logged on (needs the desktop session for TradingView + browser)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $t.Name `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Auto-generates the $($t.Mode) market brief and opens it in the browser." `
    -Force | Out-Null

  Write-Output "Installed: $($t.Name)  ($($t.Time) weekdays, $($t.Mode))"
}

# Intraday coverage is the cloud live feed now (GitHub Pages + Actions cron), not a desktop
# toast task — no intraday task is installed here anymore.

Write-Output ""
Write-Output "Done. Test a task now with:  Start-ScheduledTask -TaskName 'TDV Morning Brief'"
Write-Output "Remove later with:           install-schedule.ps1 -Remove"
