# Post-publish smoke for Windows. See run-registry.sh for details.
$ErrorActionPreference = 'Stop'

if (-not $env:DUROXIDE_VERSION) { throw "DUROXIDE_VERSION must be set" }
if (-not $env:SMOKE_SCRIPT)     { throw "SMOKE_SCRIPT must be set" }

$workdir = Join-Path $env:RUNNER_TEMP ("duroxide-smoke-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $workdir | Out-Null
Write-Host "[smoke] workdir=$workdir"
Write-Host "[smoke] version=$env:DUROXIDE_VERSION"

Push-Location $workdir
try {
  npm init -y | Out-Null

  $attempts = 6
  for ($i = 1; $i -le $attempts; $i++) {
    npm install --no-audit --no-fund "duroxide@$env:DUROXIDE_VERSION"
    if ($LASTEXITCODE -eq 0) { break }
    if ($i -eq $attempts) { throw "npm install failed after $attempts attempts" }
    $sleep = $i * 10
    Write-Host "[smoke] install attempt $i failed; sleeping ${sleep}s"
    Start-Sleep -Seconds $sleep
  }

  Copy-Item $env:SMOKE_SCRIPT ./smoke.mjs
  node ./smoke.mjs
  if ($LASTEXITCODE -ne 0) { throw "node smoke.mjs failed ($LASTEXITCODE)" }
  Write-Host "[smoke] registry smoke OK"
} finally {
  Pop-Location
}
