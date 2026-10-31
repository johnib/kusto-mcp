# Windows A/B: run each auth scenario against the baseline and patched builds.
# Results land in $env:AB_RESULTS (JSON lines). Run from the workspace root.
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
$stubs = Join-Path $root 'stubs'
$env:AB_RESULTS = Join-Path $root 'results.jsonl'
if (Test-Path $env:AB_RESULTS) { Remove-Item $env:AB_RESULTS }
$driver = Join-Path $root 'patched\.windows-ab\drive.mjs'

$realAz = (Get-Command az.cmd -ErrorAction SilentlyContinue).Source
Write-Host "real az: $realAz"
$cleanPath = ($env:PATH -split ';' | Where-Object { $_ -and ($_ -notmatch 'CLI2') }) -join ';'

# A fake token: tid/oid only, valid for an hour. The cluster rejects it (401).
$exp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 3600
function B64($s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)).TrimEnd('=').Replace('+','-').Replace('/','_') }
$jwt = (B64 '{"alg":"none"}') + '.' + (B64 '{"tid":"00000000-0000-0000-0000-000000000001","oid":"00000000-0000-0000-0000-000000000002"}') + '.sig'

New-Item -ItemType Directory -Force -Path "$stubs\hang","$stubs\slow","$stubs\wrap" | Out-Null
# hang: never answers, and starts a child (the tree a timeout must kill).
Set-Content "$stubs\hang\az.cmd" "@echo off`r`necho %* >> `"%AZ_LOG%`"`r`nstart /b ping -n 120 127.0.0.1 >nul`r`nping -n 120 127.0.0.1 >nul`r`n" -Encoding ascii
# slow: answers after ~3s with a token (a cold az on Windows).
Set-Content "$stubs\slow\az.cmd" "@echo off`r`necho %* >> `"%AZ_LOG%`"`r`nping -n 4 127.0.0.1 >nul`r`necho {`"accessToken`": `"$jwt`", `"expires_on`": $exp}`r`n" -Encoding ascii
# wrap: the runner's real az (logged out), counting runs.
Set-Content "$stubs\wrap\az.cmd" "@echo off`r`necho %* >> `"%AZ_LOG%`"`r`ncall `"$realAz`" %*`r`n" -Encoding ascii

function Run($impl, $label, $pathPrefix, $vars) {
  $saved = @{}
  foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
  $env:PATH = if ($pathPrefix) { "$pathPrefix;$cleanPath" } else { $cleanPath }
  $env:AZ_LOG = Join-Path $root "az-$impl-$label.log"
  node $driver (Join-Path $root $impl) "$impl/$label"
  foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
}

foreach ($impl in 'baseline', 'patched') {
  foreach ($mode in 'azure-cli', 'azure-identity') {
    $base = @{ KUSTO_AUTH_METHOD = $mode; AZURE_TOKEN_CREDENTIALS = 'dev' }

    # 1. hung az: bounded? labelled? any process left behind?
    Run $impl "$mode/hang" "$stubs\hang" ($base + @{ KUSTO_CONNECTION_TIMEOUT = '6000' })
    Start-Sleep -Seconds 3
    $left = @(Get-Process ping -ErrorAction SilentlyContinue).Count
    Add-Content $env:AB_RESULTS (@{ label = "$impl/$mode/hang-survivors"; survivors = $left } | ConvertTo-Json -Compress)
    Get-Process ping -ErrorAction SilentlyContinue | Stop-Process -Force

    # 2. slow az that answers: how many az runs, how long until the cluster's 401?
    Run $impl "$mode/slow" "$stubs\slow" ($base + @{ KUSTO_CONNECTION_TIMEOUT = '20000'; AZURE_TENANT_ID = 'contoso.onmicrosoft.com' })

    # 3. no az on PATH
    Run $impl "$mode/no-az" $null $base

    # 4. the real az, not logged in
    if ($realAz) { Run $impl "$mode/real-logged-out" "$stubs\wrap" $base }
  }
  # 5. the real default chain (no AZURE_TOKEN_CREDENTIALS), real az logged out
  if ($realAz) { Run $impl 'azure-identity/full-chain' "$stubs\wrap" @{ KUSTO_AUTH_METHOD = 'azure-identity'; AZURE_TOKEN_CREDENTIALS = '' } }
}
Write-Host '--- results ---'
Get-Content $env:AB_RESULTS
