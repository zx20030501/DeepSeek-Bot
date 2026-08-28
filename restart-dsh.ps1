$ErrorActionPreference = 'Continue'
$log = 'E:\projects\repos\DeepSeek-Bot\restart-dsh.log'
"=== restart at $(Get-Date -Format o) ===" | Out-File $log

# 1. Kill the current DSH web process (listener on 3080)
$old = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($old) {
  $oldPid = $old.OwningProcess
  "killing old pid $oldPid" | Out-File $log -Append
  Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
} else {
  "no listener found" | Out-File $log -Append
}

# 2. Wait for the port to free up
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $still = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
  if (-not $still) { break }
  Start-Sleep -Seconds 1
}

# 3. Start the new DSH web process
$node = 'C:\Program Files\nodejs\node.exe'
$bin = 'E:\projects\repos\deepseek-harness-dev\apps\cli\lib\bin.js'
$p = Start-Process -FilePath $node -ArgumentList @($bin, 'web', '--port', '3080') -WorkingDirectory 'E:\projects\repos\deepseek-harness-dev' -WindowStyle Hidden -PassThru
"started new pid $($p.Id)" | Out-File $log -Append

# 4. Verify it comes up
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  $listener = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    "listening on 3080 pid $($listener.OwningProcess)" | Out-File $log -Append
    exit 0
  }
  if ($p.HasExited) {
    "new process exited code $($p.ExitCode)" | Out-File $log -Append
    exit 1
  }
  Start-Sleep -Seconds 2
}
"timeout waiting for listener" | Out-File $log -Append
exit 2
